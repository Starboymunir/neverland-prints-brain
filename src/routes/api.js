/**
 * API Routes
 * ----------
 * Express routes for:
 *   - Verification dashboard (/api/stats, /api/assets)
 *   - Image proxy (/api/img/:driveFileId)
 *   - Storefront helpers (/api/storefront/*)
 *   - Catalog browsing (/api/storefront/catalog, /api/storefront/asset/:id)
 *   - Vector search (/api/storefront/search, /api/storefront/similar-v2)
 *   - Analytics (/api/storefront/events)
 *   - Price map (/api/storefront/price-map)
 *   - Pipeline monitoring
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const supabase = require("../db/supabase");
const { analyzeArtwork, PRINT_SIZE_CATALOG } = require("../services/resolution-engine");
const { generatePrintSpec, DEFAULT_PROFILES } = require("../services/print-spec");
const ImageProxy = require("../services/image-proxy");
const EmbeddingService = require("../services/embedding");
const PrintfulService = require("../services/printful");
const printful = new PrintfulService();
const printfulCache = require("../services/printful-cache");
const FinerWorksService = require("../services/finerworks");
const finerworks = new FinerWorksService();
const pricing = require("../services/pricing");

// Price-ladder variant map (price string -> { variantId, ... }), written by
// create-price-anchors.js. Loaded once at boot.
let PRICE_LADDER_MAP = {};
try {
  PRICE_LADDER_MAP = require("../config/price-ladder-map.json").ladder || {};
} catch (e) {
  console.warn("⚠️  price-ladder-map.json not found — dynamic pricing disabled");
}

// Flat skeleton "From" price (small unframed). Used for card "From $X" labels
// while dynamic pricing is off, so home / catalog / detail / cart all agree.
let FLAT_FROM_PRICE = "33.99";
try {
  FLAT_FROM_PRICE = require("../config/skeleton-price-map.json").small_unframed.price || "33.99";
} catch (e) {}

/**
 * Per-artwork price map keyed by `${tier}_${frame}`, each entry carrying the
 * matching price-ladder variant. Returns {} if the artwork can't be priced or
 * the ladder isn't loaded (callers then fall back to the flat skeleton map).
 */
function buildDynamicPriceMap(maxWidthCm, maxHeightCm) {
  if (!maxWidthCm || !maxHeightCm || !Object.keys(PRICE_LADDER_MAP).length) return {};
  const raw = pricing.computePriceMap(maxWidthCm, maxHeightCm);
  const out = {};
  for (const [key, info] of Object.entries(raw)) {
    if (!info) continue;
    const ladder = PRICE_LADDER_MAP[info.price.toFixed(2)];
    if (!ladder) continue; // computed price outside ladder range — skip, don't mis-charge
    out[key] = {
      variantId: ladder.variantId,
      variantGid: ladder.variantGid,
      price: info.price.toFixed(2),
      tier: key.replace(/_(framed|unframed)$/, ""),
      framed: key.endsWith("_framed"),
      size: `${info.dims.widthCm} × ${info.dims.heightCm} cm`,
      productCode: info.productCode,
    };
  }
  return out;
}

/**
 * "From $X" price for cards. With dynamic pricing OFF (empty ladder) every
 * artwork's cheapest option is the flat skeleton small tier — return that so the
 * home page, catalog cards, detail page, and cart all show the same number.
 * With dynamic pricing ON, return the per-artwork small-tier price.
 */
function cheapestPrice(maxWidthCm, maxHeightCm) {
  if (!Object.keys(PRICE_LADDER_MAP).length) return FLAT_FROM_PRICE;
  const p = pricing.computePrice(maxWidthCm, maxHeightCm, "small", false);
  return p ? p.price.toFixed(2) : null;
}

const router = express.Router();

// ── In-memory cache for expensive aggregation queries ──
const _cache = {};
function getCached(key, ttlMs) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

function isSupabaseFetchFailure(err) {
  const msg = (err && err.message) ? String(err.message) : "";
  return /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(msg);
}

function toPriceTierFromAmount(amount) {
  const n = parseFloat(amount || 0);
  if (n >= 119) return "extra_large";
  if (n >= 79) return "large";
  if (n >= 49) return "medium";
  return "small";
}

function imageSetFromSrc(src) {
  if (!src) return { s400: "", s600: "", s800: "", s1200: "", s1600: "", s2000: "" };
  return { s400: src, s600: src, s800: src, s1200: src, s1600: src, s2000: src };
}

async function shopifyAdminGet(resource, params = {}) {
  const domain = config.shopify.storeDomain;
  const token = config.shopify.adminApiToken;
  if (!domain || !token) throw new Error("Shopify admin credentials not configured");

  const url = new URL(`https://${domain}/admin/api/${config.shopify.apiVersion}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify ${resource} ${res.status}: ${text.slice(0, 220)}`);
  return JSON.parse(text);
}

async function storefrontCatalogFromShopify(req) {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page || "24", 10)));
  const artist = (req.query.artist || "").toLowerCase();
  const subject = (req.query.subject || "").toLowerCase();
  const search = (req.query.q || req.query.search || "").toLowerCase();

  const data = await shopifyAdminGet("products.json", {
    status: "active",
    limit: 250,
    fields: "id,title,handle,vendor,product_type,tags,image,variants,created_at",
  });
  const products = data.products || [];

  let filtered = products.filter((p) => {
    const vendor = (p.vendor || "").toLowerCase();
    const type = (p.product_type || "").toLowerCase();
    const tags = (p.tags || "").toLowerCase();
    const title = (p.title || "").toLowerCase();
    if (artist && vendor !== artist) return false;
    if (subject && type !== subject) return false;
    if (search && !(`${title} ${vendor} ${type} ${tags}`).includes(search)) return false;
    return true;
  });

  const totalBeforeDisplayFilter = filtered.length;
  const from = (page - 1) * perPage;
  const to = from + perPage;
  filtered = filtered.slice(from, to);

  const items = filtered.map((p) => {
    const firstVariant = Array.isArray(p.variants) && p.variants.length ? p.variants[0] : null;
    const price = firstVariant?.price || "33.99";
    const comparePrice = firstVariant?.compare_at_price || null;
    const src = p.image?.src || "";
    return {
      id: String(p.id),
      title: p.title,
      artist: p.vendor || "Unknown Artist",
      style: null,
      mood: null,
      era: null,
      subject: p.product_type || null,
      country: null,
      continent: null,
      orientation: "landscape",
      quality: "standard",
      image: src,
      imageSrcset: { s400: src, s600: src, s800: src, s1200: src, s1600: src },
      driveFileId: null,
      priceTier: toPriceTierFromAmount(price),
      price,
      comparePrice,
      maxPrint: "",
    };
  }).filter((item) => item.image && parseFloat(item.price || 0) > 0);

  const total = totalBeforeDisplayFilter;

  return {
    items,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    filters: {
      artist: req.query.artist || null,
      style: req.query.style || null,
      mood: req.query.mood || null,
      orientation: req.query.orientation || null,
      era: req.query.era || null,
      subject: req.query.subject || null,
      country: req.query.country || null,
      continent: req.query.continent || null,
      sort: req.query.sort || "newest",
      q: req.query.q || req.query.search || null,
      tag: req.query.tag || null,
    },
    fallback: "shopify",
  };
}

async function storefrontArtistsFromShopify(req) {
  const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10)) : 0;
  const searchQ = (req.query.q || req.query.search || "").trim().toLowerCase();
  const sortBy = req.query.sort || "count";

  const data = await shopifyAdminGet("products.json", {
    status: "active",
    limit: 250,
    fields: "vendor",
  });

  const counts = {};
  for (const p of data.products || []) {
    const name = (p.vendor || "Unknown Artist").trim();
    counts[name] = (counts[name] || 0) + 1;
  }

  let artists = Object.entries(counts).map(([name, count]) => ({ artist: name, name, count }));
  if (searchQ) artists = artists.filter((a) => a.name.toLowerCase().includes(searchQ));
  if (sortBy === "alpha") artists.sort((a, b) => a.name.localeCompare(b.name));
  else artists.sort((a, b) => b.count - a.count);

  const limited = limit > 0 ? artists.slice(0, limit) : artists;
  return { artists: limited, total: artists.length, fallback: "shopify" };
}

async function storefrontAssetFromShopify(assetId) {
  let product = null;

  if (/^\d+$/.test(String(assetId))) {
    const data = await shopifyAdminGet(`products/${assetId}.json`, {
      fields: "id,title,handle,vendor,body_html,product_type,tags,image,images,variants",
    });
    product = data.product || null;
  } else {
    const data = await shopifyAdminGet("products.json", {
      handle: assetId,
      limit: 1,
      fields: "id,title,handle,vendor,body_html,product_type,tags,image,images,variants",
    });
    product = (data.products || [])[0] || null;
  }

  if (!product) return null;

  let priceMap = {};
  try {
    const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
    priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
  } catch (e) {}

  const src = product.image?.src || (product.images && product.images[0] && product.images[0].src) || "";
  const firstVariant = Array.isArray(product.variants) && product.variants.length ? product.variants[0] : null;
  const basePrice = firstVariant?.price || "33.99";
  const comparePrice = firstVariant?.compare_at_price || null;

  const variants = (product.variants || []).map((v) => {
    const pTier = toPriceTierFromAmount(v.price);
    return {
      id: v.id,
      label: v.option1 || v.title,
      size: v.option1 || v.title,
      widthCm: null,
      heightCm: null,
      dpi: null,
      quality: "standard",
      priceTier: pTier,
    };
  });

  return {
    id: product.handle || String(product.id),
    title: product.title,
    artist: product.vendor || "Unknown Artist",
    description: product.body_html || "",
    style: null,
    mood: null,
    palette: null,
    subject: product.product_type || null,
    orientation: "landscape",
    quality: "standard",
    maxPrint: "",
    widthPx: null,
    heightPx: null,
    driveFileId: null,
    images: imageSetFromSrc(src),
    mockup_url: null,
    priceTier: toPriceTierFromAmount(basePrice),
    basePrice,
    comparePrice,
    variants,
    priceMap,
    shopifyProductId: product.id,
    tags: product.tags ? String(product.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
    fallback: "shopify",
  };
}

async function storefrontFiltersFromShopify() {
  const data = await shopifyAdminGet("products.json", {
    status: "active",
    limit: 250,
    fields: "vendor,product_type,tags",
  });
  const products = data.products || [];

  const countMap = (arr) => {
    const m = {};
    for (const v of arr) {
      const key = (v || "").trim();
      if (!key) continue;
      m[key] = (m[key] || 0) + 1;
    }
    return Object.entries(m).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };

  const styles = countMap(products.map((p) => p.product_type || ""));
  const subjects = styles;
  const artists = countMap(products.map((p) => p.vendor || ""));

  return {
    styles,
    moods: [],
    orientations: [],
    eras: [],
    subjects,
    countries: [],
    continents: [],
    artists,
    priceTiers: [
      { tier: "small", label: "Small", price: "$33.99", framedPrice: "$44.99" },
      { tier: "medium", label: "Medium", price: "$69.99", framedPrice: "$90.99" },
      { tier: "large", label: "Large", price: "$159.99", framedPrice: "$209.99" },
      { tier: "extra_large", label: "Extra Large", price: "$319.99", framedPrice: "$419.99" },
    ],
    fallback: "shopify",
  };
}

/**
 * Paginate through ALL rows for a Supabase query (bypasses 1000-row limit).
 * @param {string} table - table name
 * @param {string} selectCols - columns to select
 * @param {function} filterFn - function(query) that applies .in(), .not() etc.
 * @param {number} batchSize - rows per request (max 1000)
 * @returns {Promise<Array>} all rows
 */
async function fetchAllRows(table, selectCols, filterFn, batchSize = 1000) {
  const allRows = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(selectCols);
    if (filterFn) q = filterFn(q);
    q = q.range(from, from + batchSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return allRows;
}

// ── Generate a rich description from AI metadata when description is null ──
function generateDescriptionFromMeta(asset) {
  const title = asset.title || "Untitled";
  const artist = asset.artist || "Unknown Artist";
  const style = asset.style;
  const mood = asset.mood;
  const subject = asset.subject;
  const era = asset.era;
  const palette = asset.palette;
  const an = (w) => /^[aeiou]/i.test(w) ? "An" : "A";

  // Build a natural-language description from available metadata
  const parts = [];

  // Opening line
  if (style && subject) {
    parts.push(`${an(style)} ${style.toLowerCase()} ${subject.toLowerCase()} by ${artist}.`);
  } else if (style) {
    parts.push(`${an(style)} ${style.toLowerCase()} work by ${artist}.`);
  } else if (subject) {
    parts.push(`${an(subject)} ${subject.toLowerCase()} by ${artist}.`);
  } else {
    parts.push(`A work by ${artist}.`);
  }

  // Era context
  if (era && era !== "Unknown") {
    parts.push(`Created during the ${era.toLowerCase()} period.`);
  }

  // Mood & palette
  if (mood && palette) {
    parts.push(`This piece evokes a ${mood.toLowerCase()} atmosphere with ${palette.toLowerCase()}.`);
  } else if (mood) {
    parts.push(`This piece evokes a ${mood.toLowerCase()} atmosphere.`);
  } else if (palette) {
    parts.push(`Featuring ${palette.toLowerCase()}.`);
  }

  // Print quality callout
  parts.push("Printed on premium museum-quality archival paper with vivid, lightfast inks.");

  return parts.join(" ");
}

// Initialize image proxy (lazy)
let imageProxy = null;
async function getImageProxy() {
  if (!imageProxy) {
    imageProxy = await new ImageProxy().init();
  }
  return imageProxy;
}

// Initialize embedding service (lazy)
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    try {
      embedder = await new EmbeddingService().init();
    } catch (e) {
      console.warn("Embedding service not available:", e.message);
      return null;
    }
  }
  return embedder;
}

// ──────────────────────────────────────
// Image Proxy Endpoint
// ──────────────────────────────────────

/**
 * GET /api/img/:driveFileId
 * Serves images from Google Drive with caching headers.
 * Query params:
 *   ?w=800      — width (longest edge)
 *   ?redirect=1 — redirect to lh3 URL instead of proxying
 */
router.get("/img/:driveFileId", async (req, res) => {
  try {
    const { driveFileId } = req.params;
    const width = parseInt(req.query.w || req.query.width || "800", 10);
    const redirect = req.query.redirect === "1";

    const proxy = await getImageProxy();

    if (redirect) {
      // Just redirect to lh3 URL (fastest, no proxy overhead)
      const url = proxy.getImageUrl(driveFileId, width);
      res.redirect(301, url);
      return;
    }

    // Proxy the image through our server (enables caching, fallback)
    const image = await proxy.getImageBuffer(driveFileId, width);

    res.set({
      "Content-Type": image.contentType,
      "Cache-Control": "public, max-age=31536000, immutable", // 1 year cache
      "X-Image-Source": "neverland-proxy",
    });

    res.send(image.buffer);
  } catch (err) {
    res.status(404).json({ error: "Image not found", message: err.message });
  }
});

/**
 * GET /api/img/:driveFileId/urls
 * Returns responsive image URLs for a given Drive file.
 */
router.get("/img/:driveFileId/urls", async (req, res) => {
  try {
    const proxy = await getImageProxy();
    const urls = proxy.getResponsiveUrls(req.params.driveFileId);
    res.json(urls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────
// Storefront Catalog API (Skeleton Product Architecture)
// Full 101k catalog served from Supabase — no Shopify products needed
// ──────────────────────────────────────

/**
 * GET /api/storefront/price-map
 * Returns the skeleton product variant IDs for each price tier.
 * The theme uses these to add the correct variant to cart.
 */
router.get("/storefront/price-map", (req, res) => {
  try {
    const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
    const priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    res.set("Cache-Control", "public, max-age=3600");
    res.json(priceMap);
  } catch (err) {
    res.status(500).json({ error: "Price map not configured", message: err.message });
  }
});

/**
 * GET /api/storefront/from-prices?drive_ids=a,b,c
 * Returns the "From $X" (cheapest tier) price per Google Drive file id, so
 * server-rendered product cards (homepage carousels) can show the same
 * per-artwork price as the catalog/detail pages. -> { driveId: "54.99", ... }
 */
router.get("/storefront/from-prices", async (req, res) => {
  try {
    const ids = String(req.query.drive_ids || "")
      .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!ids.length) return res.json({});
    const { data } = await supabase
      .from("assets")
      .select("drive_file_id, max_print_width_cm, max_print_height_cm")
      .in("drive_file_id", ids);
    const out = {};
    for (const a of data || []) {
      const p = cheapestPrice(a.max_print_width_cm, a.max_print_height_cm);
      if (p) out[a.drive_file_id] = p;
    }
    res.set("Cache-Control", "public, max-age=300");
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/catalog
 * Paginated catalog browse with filtering.
 * This is the main endpoint that replaces Shopify collections.
 *
 * Query params:
 *   ?page=1           — page number (default 1)
 *   ?per_page=24      — items per page (default 24, max 100)
 *   ?artist=          — filter by artist name
 *   ?style=           — filter by style (abstract, landscape, etc.)
 *   ?mood=            — filter by mood
 *   ?orientation=     — filter by ratio_class (landscape, portrait, square, panoramic)
 *   ?sort=newest      — sort: newest, oldest, title_asc, title_desc, price_asc, price_desc, random
 *   ?q=               — text search within catalog
 *   ?tag=             — filter by AI tag
 *   ?min_price=       — min price tier
 *   ?max_price=       — max price tier
 */
router.get("/storefront/catalog", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page || "24", 10)));
    const artist = req.query.artist;
    const style = req.query.style;
    const mood = req.query.mood;
    const orientation = req.query.orientation;
    const era = req.query.era;
    const subject = req.query.subject;
    const country = req.query.country;
    const continent = req.query.continent;
    const sort = req.query.sort || "newest";
    const search = req.query.q || req.query.search;
    const tag = req.query.tag;

    // ── POPULAR SORT: fetch trending asset IDs from analytics ──
    let popularAssetIds = null;
    if (sort === "popular") {
      try {
        // Try trending_products materialized view first
        const { data: trending } = await supabase
          .from("trending_products")
          .select("product_id, trending_score")
          .order("trending_score", { ascending: false })
          .limit(500);

        if (trending && trending.length > 0) {
          // Map shopify product IDs to asset IDs
          const productIds = trending.map(t => t.product_id);
          const { data: assets } = await supabase
            .from("assets")
            .select("id, shopify_product_id")
            .in("shopify_product_id", productIds);
          if (assets && assets.length > 0) {
            const pidToScore = {};
            trending.forEach(t => pidToScore[t.product_id] = t.trending_score);
            popularAssetIds = assets
              .map(a => ({ id: a.id, score: pidToScore[a.shopify_product_id] || 0 }))
              .sort((a, b) => b.score - a.score)
              .map(a => a.id);
          }
        }

        // Fallback: query analytics_events directly by asset_id
        if (!popularAssetIds || popularAssetIds.length === 0) {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const { data: events } = await supabase
            .from("analytics_events")
            .select("asset_id, event_type")
            .not("asset_id", "is", null)
            .gte("created_at", thirtyDaysAgo)
            .in("event_type", ["view", "add_to_cart", "purchase"])
            .limit(5000);

          if (events && events.length > 0) {
            const scores = {};
            const weights = { purchase: 10, add_to_cart: 5, view: 1 };
            events.forEach(e => {
              if (!scores[e.asset_id]) scores[e.asset_id] = 0;
              scores[e.asset_id] += weights[e.event_type] || 0;
            });
            popularAssetIds = Object.entries(scores)
              .sort((a, b) => b[1] - a[1])
              .map(([id]) => id);
          }
        }
      } catch (e) {
        // trending_products view may not exist yet — fall through to quality-based popular
      }
    }

    let query = supabase
      .from("assets")
      .select(
        "id, title, drive_file_id, artist, style, mood, era, subject, ai_tags, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, width_px, height_px, created_at",
        { count: "exact" }
      )
      .in("ingestion_status", ["ready", "analyzed"])
      .not("drive_file_id", "is", null);

    // Filters
    if (artist) query = query.eq("artist", artist);
    if (style) query = query.eq("style", style);
    if (mood) query = query.eq("mood", mood);
    if (orientation) query = query.eq("ratio_class", orientation);
    if (era) query = query.eq("era", era);
    if (subject) query = query.eq("subject", subject);
    if (country) query = query.filter("ai_tags", "cs", JSON.stringify([country]));
    if (continent) query = query.filter("ai_tags", "cs", JSON.stringify([continent]));
    if (tag) query = query.filter("ai_tags", "cs", JSON.stringify([tag]));
    if (search) {
      // Enhanced search: split into words and match each word against any field
      const words = search.trim().split(/\s+/).filter(w => w.length > 1);
      if (words.length > 1) {
        // Multi-word: each word must match at least one field (AND logic)
        for (const word of words) {
          query = query.or(
            `title.ilike.%${word}%,style.ilike.%${word}%,mood.ilike.%${word}%,artist.ilike.%${word}%,era.ilike.%${word}%,subject.ilike.%${word}%`
          );
        }
      } else {
        query = query.or(
          `title.ilike.%${search}%,style.ilike.%${search}%,mood.ilike.%${search}%,artist.ilike.%${search}%,era.ilike.%${search}%,subject.ilike.%${search}%`
        );
      }
    }

    // Sort
    if (sort === "popular" && popularAssetIds && popularAssetIds.length > 0) {
      // For popular sort with analytics data, fetch by those IDs
      query = query.in("id", popularAssetIds);
    }

    switch (sort) {
      case "oldest":
        query = query.order("created_at", { ascending: true });
        break;
      case "title_asc":
        query = query.order("title", { ascending: true });
        break;
      case "title_desc":
        query = query.order("title", { ascending: false });
        break;
      case "random":
        // Supabase doesn't support random, so fetch extra and shuffle client-side
        query = query.order("created_at", { ascending: false });
        break;
      case "popular":
        // If we have trending data, we'll re-sort after fetch
        // Otherwise fall back to quality_tier (best quality first) + newest
        query = query.order("quality_tier", { ascending: true }).order("created_at", { ascending: false });
        break;
      case "newest":
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }
    // Stable tiebreaker so artworks don't reshuffle / repeat across paginated pages
    // when many rows share the same created_at / quality_tier / title.
    query = query.order("id", { ascending: true });

    // Pagination
    const from = (page - 1) * perPage;
    const to = from + perPage - 1;
    query = query.range(from, to);

    const { data, count, error } = await query;
    if (error) throw error;

    // Compute price tier for each asset
    const KNOWN_CONTINENTS = ["Europe", "Asia", "North America", "South America", "Africa", "Oceania"];
    let items = (data || []).map((a) => {
      const tier = computePriceTier(a.max_print_width_cm, a.max_print_height_cm);
      const tags = Array.isArray(a.ai_tags) ? a.ai_tags : [];
      const itemContinent = tags.find(t => KNOWN_CONTINENTS.includes(t)) || null;
      const itemCountry = tags.find(t => !KNOWN_CONTINENTS.includes(t) && t !== "Unknown" && typeof t === "string" && t.length > 1) || null;
      return {
        id: a.id,
        title: a.title,
        artist: a.artist,
        style: a.style,
        mood: a.mood,
        era: a.era,
        subject: a.subject,
        country: itemCountry,
        continent: itemContinent,
        orientation: a.ratio_class,
        quality: a.quality_tier,
        image: `https://lh3.googleusercontent.com/d/${a.drive_file_id}=s600`,
        imageSrcset: {
          s400: `https://lh3.googleusercontent.com/d/${a.drive_file_id}=s400`,
          s600: `https://lh3.googleusercontent.com/d/${a.drive_file_id}=s600`,
          s800: `https://lh3.googleusercontent.com/d/${a.drive_file_id}=s800`,
        },
        driveFileId: a.drive_file_id,
        priceTier: tier.tier,
        price: cheapestPrice(a.max_print_width_cm, a.max_print_height_cm) || tier.price,
        comparePrice: tier.comparePrice,
        maxPrint: `${Math.round(a.max_print_width_cm || 0)} × ${Math.round(a.max_print_height_cm || 0)} cm`,
      };
    });

    // Re-sort by trending score if popular sort with analytics data
    if (sort === "popular" && popularAssetIds && popularAssetIds.length > 0) {
      const idOrder = {};
      popularAssetIds.forEach((id, i) => idOrder[id] = i);
      items.sort((a, b) => (idOrder[a.id] ?? 9999) - (idOrder[b.id] ?? 9999));
    }

    // Shuffle if random sort
    if (sort === "random") {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }

    // NOTE: A previous per-page artist-diversity cap was removed because it
    // ran AFTER pagination — it dropped items from the current page without
    // reducing `count`, which made the page count + total artwork count
    // contradict each other and produced uneven page sizes.

    res.set("Cache-Control", "public, max-age=60");
    res.json({
      items,
      total: count || 0,
      page,
      perPage,
      totalPages: Math.ceil((count || 0) / perPage),
      filters: { artist, style, mood, orientation, era, subject, country, continent, sort, q: search, tag },
    });
  } catch (err) {
    try {
      const fallback = await storefrontCatalogFromShopify(req);
      return res.json(fallback);
    } catch (fbErr) {
      return res.status(500).json({ error: `${err.message} | fallback failed: ${fbErr.message}` });
    }
  }
});

/**
 * GET /api/storefront/asset/:assetId
 * Full asset detail by Supabase asset ID.
 * This replaces the Shopify product page — theme fetches this data.
 */
router.get("/storefront/asset/:assetId", async (req, res) => {
  try {
    const { data: asset, error } = await supabase
      .from("assets")
      .select("*, asset_variants(*)")
      .eq("id", req.params.assetId)
      .single();

    if (error || !asset) {
      if (error && isSupabaseFetchFailure(error)) {
        const fallback = await storefrontAssetFromShopify(req.params.assetId);
        if (fallback) return res.json(fallback);
      }
      return res.status(404).json({ error: "Asset not found" });
    }

    const tier = computePriceTier(asset.max_print_width_cm, asset.max_print_height_cm);

    // Hard DPI floor at API boundary (existing DB rows may have been generated
    // under the old 150 minimum). Bumped to 200 per client: rather print
    // smaller-and-sharp than larger-and-soft.
    const DPI_FLOOR = parseInt(process.env.MIN_PRINT_DPI, 10) || 200;

    // Build variant options with price tiers
    const variants = (asset.asset_variants || [])
      .filter((v) => (v.effective_dpi || 0) >= DPI_FLOOR)
      .map((v) => {
      const area = (v.width_cm || 0) * (v.height_cm || 0);
      let vTier;
      if (area <= 600) vTier = "small";
      else if (area <= 1800) vTier = "medium";
      else if (area <= 4000) vTier = "large";
      else vTier = "extra_large";

      return {
        id: v.id,
        label: v.label,
        size: `${v.width_cm} × ${v.height_cm} cm`,
        widthCm: v.width_cm,
        heightCm: v.height_cm,
        dpi: v.effective_dpi,
        quality: v.quality_grade,
        priceTier: vTier,
      };
    });

    // Per-artwork dynamic price map (variant per ladder price point). Falls
    // back to the flat skeleton map only if the artwork can't be priced.
    let priceMap = buildDynamicPriceMap(asset.max_print_width_cm, asset.max_print_height_cm);
    let dynamicPricing = Object.keys(priceMap).length > 0;
    if (!dynamicPricing) {
      try {
        const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
        priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
      } catch (e) {}
    }

    // Use stored description, or generate one from AI metadata
    const description = asset.description || generateDescriptionFromMeta(asset);

    res.set("Cache-Control", "public, max-age=300");
    res.json({
      id: asset.id,
      title: asset.title,
      artist: asset.artist,
      description,
      style: asset.style,
      mood: asset.mood,
      palette: asset.palette,
      subject: asset.subject,
      orientation: asset.ratio_class,
      quality: asset.quality_tier,
      maxPrint: `${Math.round(asset.max_print_width_cm || 0)} × ${Math.round(asset.max_print_height_cm || 0)} cm`,
      widthPx: asset.width_px,
      heightPx: asset.height_px,
      driveFileId: asset.drive_file_id,
      images: {
        s400: `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s400`,
        s800: `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s800`,
        s1200: `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s1200`,
        s1600: `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s1600`,
        s2000: `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s2000`,
      },
      mockup_url: asset.mockup_url || null,
      priceTier: tier.tier,
      basePrice: dynamicPricing ? (priceMap[`${tier.tier}_unframed`]?.price || tier.price) : tier.price,
      comparePrice: tier.comparePrice,
      // When dynamic pricing is active, drive the size list from priceMap (all
      // priced tiers) rather than the DPI-filtered asset_variants.
      variants: dynamicPricing ? [] : variants,
      priceMap,
      dynamicPricing,
      shopifyProductId: asset.shopify_product_id || null,
      tags: asset.tags || [],
    });
  } catch (err) {
    try {
      const fallback = await storefrontAssetFromShopify(req.params.assetId);
      if (!fallback) return res.status(404).json({ error: "Asset not found" });
      return res.json(fallback);
    } catch (fbErr) {
      return res.status(500).json({ error: `${err.message} | fallback failed: ${fbErr.message}` });
    }
  }
});

/**
 * GET /api/storefront/artists
 * List all artists with counts. Paginates through ALL rows (bypasses 1000-row limit).
 * Cached for 30 minutes.
 */
router.get("/storefront/artists", async (req, res) => {
  try {
    const limitParam = req.query.limit;
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : 0; // 0 = no limit
    const searchQ = (req.query.q || req.query.search || "").trim().toLowerCase();
    const sortBy = req.query.sort || "count"; // count | alpha

    // Check cache (30 min TTL)
    let artists = getCached("artists_list", 30 * 60 * 1000);
    if (!artists) {
      // Use database-side GROUP BY via RPC (avoids loading 135k rows into Node.js)
      const { data, error } = await supabase.rpc("get_artist_counts");
      if (error) {
        // Fallback: paginated counting if RPC not available
        console.warn("RPC get_artist_counts not available, using fallback:", error.message);
        const counts = {};
        let from = 0;
        while (true) {
          const { data: batch, error: bErr } = await supabase
            .from("assets")
            .select("artist")
            .in("ingestion_status", ["ready", "analyzed"])
            .not("artist", "is", null)
            .range(from, from + 999);
          if (bErr) throw bErr;
          if (!batch || batch.length === 0) break;
          batch.forEach((a) => { counts[a.artist] = (counts[a.artist] || 0) + 1; });
          if (batch.length < 1000) break;
          from += 1000;
        }
        artists = Object.entries(counts).map(([name, count]) => ({ artist: name, name, count }));
      } else {
        artists = (data || []).map((r) => ({ artist: r.artist, name: r.artist, count: r.count }));
      }
      setCache("artists_list", artists);
    }

    // Sort
    let sorted;
    if (sortBy === "alpha") {
      sorted = [...artists].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      sorted = [...artists].sort((a, b) => b.count - a.count);
    }

    // Search filter
    if (searchQ) {
      sorted = sorted.filter((a) => a.name.toLowerCase().includes(searchQ));
    }

    const limited = limit > 0 ? sorted.slice(0, limit) : sorted;

    res.set("Cache-Control", "public, max-age=3600");
    res.json({ artists: limited, total: artists.length });
  } catch (err) {
    try {
      const fallback = await storefrontArtistsFromShopify(req);
      return res.json(fallback);
    } catch (fbErr) {
      return res.status(500).json({ error: `${err.message} | fallback failed: ${fbErr.message}` });
    }
  }
});

/**
 * GET /api/storefront/filters
 * Returns available filter values (styles, moods, orientations, eras, subjects, countries, continents).
 * Paginates through ALL rows (bypasses 1000-row limit). Cached for 30 minutes.
 */
router.get("/storefront/filters", async (req, res) => {
  try {
    // Check cache (30 min TTL)
    let cached = getCached("filter_values", 30 * 60 * 1000);
    if (!cached) {
      // Database-side aggregation — one simple query per dimension
      // instead of loading 135k rows into Node.js memory
      const KNOWN_CONTINENTS = ["Europe", "Asia", "North America", "South America", "Africa", "Oceania"];

      async function countColumn(col) {
        const counts = {};
        let from = 0;
        while (true) {
          const { data, error } = await supabase
            .from("assets")
            .select(col)
            .in("ingestion_status", ["ready", "analyzed"])
            .not(col, "is", null)
            .range(from, from + 999);
          if (error) throw error;
          if (!data || data.length === 0) break;
          data.forEach((r) => { counts[r[col]] = (counts[r[col]] || 0) + 1; });
          if (data.length < 1000) break;
          from += 1000;
        }
        return Object.entries(counts)
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count);
      }

      // Run dimension queries in parallel (each only fetches one column)
      const [styles, moods, orientations, eras, subjects] = await Promise.all([
        countColumn("style"),
        countColumn("mood"),
        countColumn("ratio_class"),
        countColumn("era"),
        countColumn("subject"),
      ]);

      // ai_tags needs special handling (it's an array column with countries+continents)
      const countryCounts = {};
      const continentCounts = {};
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("assets")
          .select("ai_tags")
          .in("ingestion_status", ["ready", "analyzed"])
          .not("ai_tags", "is", null)
          .range(from, from + 999);
        if (error) throw error;
        if (!data || data.length === 0) break;
        data.forEach((r) => {
          const tags = Array.isArray(r.ai_tags) ? r.ai_tags : [];
          tags.forEach((tag) => {
            if (KNOWN_CONTINENTS.includes(tag)) {
              continentCounts[tag] = (continentCounts[tag] || 0) + 1;
            } else if (typeof tag === "string" && tag.length > 1 && tag !== "Unknown") {
              countryCounts[tag] = (countryCounts[tag] || 0) + 1;
            }
          });
        });
        if (data.length < 1000) break;
        from += 1000;
      }

      const toSortedArr = (counts) =>
        Object.entries(counts)
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count);

      const cap = (arr, n) => Array.isArray(arr) ? arr.slice(0, n) : [];
      cached = {
        styles: cap(styles, 150),
        moods: cap(moods, 150),
        orientations: cap(orientations, 40),
        eras: cap(eras, 120),
        subjects: cap(subjects, 200),
        countries: cap(toSortedArr(countryCounts), 250),
        continents: cap(toSortedArr(continentCounts), 10),
      };

      setCache("filter_values", cached);
    }

    res.set("Cache-Control", "public, max-age=3600");
    res.json({
      ...cached,
      priceTiers: [
        { tier: "small", label: "Small (≤24×17cm)", price: "$33.99", framedPrice: "$44.99" },
        { tier: "medium", label: "Medium (≤42×30cm)", price: "$69.99", framedPrice: "$90.99" },
        { tier: "large", label: "Large (≤63×45cm)", price: "$159.99", framedPrice: "$209.99" },
        { tier: "extra_large", label: "Extra Large (>63×45cm)", price: "$319.99", framedPrice: "$419.99" },
      ],
    });
  } catch (err) {
    try {
      const fallback = await storefrontFiltersFromShopify();
      return res.json(fallback);
    } catch (fbErr) {
      return res.status(500).json({ error: `${err.message} | fallback failed: ${fbErr.message}` });
    }
  }
});

/**
 * GET /api/storefront/collections
 * Returns curated collections for the homepage bento grid.
 * Each collection has a title, filter URL, product count, and sample image.
 */
router.get("/storefront/collections", async (req, res) => {
  try {
    // ── Client-curated collection definitions ──
    // Subject-based collections
    const subjectCollections = [
      { handle: "vintage-posters-advertising", title: "Vintage Posters & Advertising", filter: { subjects: ["Advertising", "Commercial Art"] }, featured: true },
      { handle: "flora-fauna", title: "Botanical & Zoology", filter: { subjects: ["Botanical", "Animal", "Nature"] }, featured: true },
      { handle: "landscapes-seascapes", title: "Landscapes & Seascapes", filter: { subjects: ["Landscape", "Seascape", "Cityscape"] } },
      { handle: "portraits-figures", title: "Portraits & Figures", filter: { subjects: ["Portrait", "Figure Study", "Self-Portrait"] } },
      { handle: "mythology-history-religion", title: "Mythology, History & Religion", filter: { subjects: ["Mythology", "Allegory", "Religious", "Historical"] }, featured: true },
      { handle: "japanese-art-ukiyo-e", title: "Japanese Woodblock Prints", filter: { styles: ["Ukiyo-e"] } },
    ];

    // Era & movement collections
    const eraCollections = [
      { handle: "renaissance", title: "Renaissance", filter: { styles: ["Renaissance"] }, featured: true },
      { handle: "baroque", title: "Baroque", filter: { styles: ["Baroque", "Flemish Baroque"] } },
      { handle: "romanticism", title: "Romanticism", filter: { styles: ["Romanticism"] } },
      { handle: "impressionism", title: "Impressionism", filter: { styles: ["Impressionism"] } },
      { handle: "post-impressionism", title: "Post-Impressionism", filter: { styles: ["Post-Impressionism"] } },
      { handle: "art-nouveau", title: "Art Nouveau", filter: { styles: ["Art Nouveau"] } },
      { handle: "fauvism-expressionism", title: "Fauvism & Expressionism", filter: { styles: ["Fauvism", "Expressionism"] } },
    ];

    // Lifestyle & marketing collections
    const lifestyleCollections = [
      { handle: "the-paper-anniversary", title: "The Paper Anniversary", filter: { moods: ["Romantic", "Elegant", "Warm"] } },
      { handle: "the-nursery-new-arrival", title: "The Nursery & New Arrival", filter: { subjects: ["Child", "Animal", "Nature", "Botanical"], moods: ["Joyful", "Whimsical"] }, orMode: true },
      { handle: "the-housewarming-collection", title: "The Housewarming Collection", filter: { styles: ["Impressionism", "Post-Impressionism", "Realism", "Romanticism"] } },
      { handle: "the-stoics-office", title: "The Stoic's Office", filter: { moods: ["Contemplative", "Powerful", "Philosophical"] } },
      { handle: "dark-academia", title: "Dark Academia", filter: { moods: ["Dark", "Melancholic", "Mysterious"] }, featured: true },
      { handle: "quiet-luxury", title: "Quiet Luxury", filter: { palettes: ["Muted Pastels", "Monochrome", "Light & Airy"] } },
      { handle: "the-kitchen-curator", title: "The Kitchen Curator", filter: { subjects: ["Still Life", "Botanical"] } },
      { handle: "the-focus-state", title: "The Focus State", filter: { moods: ["Serene", "Contemplative", "Peaceful"] } },
      { handle: "the-conversation-starter", title: "The Conversation Starter", filter: { moods: ["Dramatic", "Dynamic", "Powerful"] } },
      { handle: "spring-refresh", title: "The Spring Refresh", filter: { subjects: ["Botanical", "Nature"], palettes: ["Green & Natural", "Vibrant Multi-Color"] }, orMode: true },
      { handle: "the-macabre-mystical", title: "The Macabre & Mystical", filter: { moods: ["Dark", "Mysterious", "Ethereal"] } },
      { handle: "the-wanderlust-collection", title: "The Wanderlust Collection", filter: { subjects: ["Landscape", "Seascape", "Cityscape"] }, featured: true },
    ];

    const collectionDefs = [...subjectCollections, ...eraCollections, ...lifestyleCollections];

    // Helper: apply Supabase filters to a query
    function applyFilters(q, filter, orMode) {
      if (orMode) {
        // OR mode: combine filters from different columns with OR logic
        const orClauses = [];
        if (filter.subjects) orClauses.push(`subject.in.(${filter.subjects.join(",")})`);
        if (filter.moods) orClauses.push(`mood.in.(${filter.moods.join(",")})`);
        if (filter.styles) orClauses.push(`style.in.(${filter.styles.join(",")})`);
        if (filter.palettes) orClauses.push(`palette.in.(${filter.palettes.join(",")})`);
        if (filter.eras) orClauses.push(`era.in.(${filter.eras.join(",")})`);
        if (orClauses.length > 0) q = q.or(orClauses.join(","));
      } else {
        // AND mode: each filter narrows results
        if (filter.subjects) q = q.in("subject", filter.subjects);
        if (filter.moods) q = q.in("mood", filter.moods);
        if (filter.styles) q = q.in("style", filter.styles);
        if (filter.palettes) q = q.in("palette", filter.palettes);
        if (filter.eras) q = q.in("era", filter.eras);
      }
      if (filter.orientation) q = q.ilike("ratio_class", `${filter.orientation}%`);
      if (filter.quality_tier) q = q.eq("quality_tier", filter.quality_tier);
      return q;
    }

    // Fetch counts and a sample image for each collection in parallel
    const results = await Promise.all(
      collectionDefs.map(async (col) => {
        // Count query
        let countQ = supabase
          .from("assets")
          .select("id", { count: "exact", head: true })
          .in("ingestion_status", ["ready", "analyzed"])
          .not("style", "is", null)
          .not("drive_file_id", "is", null);
        countQ = applyFilters(countQ, col.filter, col.orMode);
        const { count: total } = await countQ;

        // Sample image query (random offset for variety)
        let sampleQ = supabase
          .from("assets")
          .select("id, drive_file_id, title")
          .in("ingestion_status", ["ready", "analyzed"])
          .not("style", "is", null)
          .not("drive_file_id", "is", null);
        sampleQ = applyFilters(sampleQ, col.filter, col.orMode);
        const offset = Math.floor(Math.random() * Math.max(1, (total || 1) - 1));
        sampleQ = sampleQ.range(offset, offset).limit(1);
        const { data } = await sampleQ;
        const sample = data?.[0];

        return {
          handle: col.handle,
          title: col.title,
          url: `/collections/${col.handle}`,
          count: total || 0,
          featured: col.featured || false,
          image: sample ? `https://lh3.googleusercontent.com/d/${sample.drive_file_id}=s800` : null,
        };
      })
    );

    res.set("Cache-Control", "public, max-age=1800"); // 30 min cache
    res.json({ collections: results });
  } catch (err) {
    console.error("Collections endpoint error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/similar-asset/:assetId
 * Similar artworks by Supabase asset ID (not Shopify product ID).
 */
router.get("/storefront/similar-asset/:assetId", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "8", 10);

    const { data: asset } = await supabase
      .from("assets")
      .select("id, style, mood, palette, subject, artist, ratio_class")
      .eq("id", req.params.assetId)
      .single();

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    // Try vector similarity first
    const emb = await getEmbedder();
    if (emb) {
      try {
        const similar = await emb.findSimilar(asset.id, limit);
        if (similar.length > 0) {
          const items = similar.map((r) => {
            const t = computePriceTier(r.max_print_width_cm, r.max_print_height_cm);
            return {
              id: r.id || r.asset_id,
              title: r.title,
              artist: r.artist,
              image: `https://lh3.googleusercontent.com/d/${r.drive_file_id}=s400`,
              style: r.style,
              priceTier: t.tier,
              price: cheapestPrice(r.max_print_width_cm, r.max_print_height_cm) || t.price,
              similarity: r.similarity,
            };
          });
          res.set("Cache-Control", "public, max-age=3600");
          return res.json({ similar: items, method: "vector" });
        }
      } catch (e) {
        console.warn("Vector similar failed:", e.message);
      }
    }

    // Fallback: tag-based similarity
    // Build a filter on any matching dimension (style OR mood OR subject) so
    // we don't always return the same first-N rows for assets that share no
    // style with anything (which made the "Recommended for you" section look
    // identical on every product page).
    let query = supabase
      .from("assets")
      .select("id, title, drive_file_id, artist, style, mood, subject, ratio_class, max_print_width_cm, max_print_height_cm")
      .neq("id", req.params.assetId)
      .in("ingestion_status", ["ready", "analyzed"]);

    const orParts = [];
    if (asset.style)   orParts.push(`style.eq.${asset.style}`);
    if (asset.mood)    orParts.push(`mood.eq.${asset.mood}`);
    if (asset.subject) orParts.push(`subject.eq.${asset.subject}`);
    if (asset.artist)  orParts.push(`artist.eq.${asset.artist}`);
    if (orParts.length > 0) {
      query = query.or(orParts.join(","));
    }

    // Over-fetch and shuffle so different visits surface different similar items
    const { data: similar } = await query.limit(limit * 8);

    const scored = (similar || []).map((s) => {
      let score = 0;
      if (s.style   === asset.style)        score += 3;
      if (s.mood    === asset.mood)         score += 2;
      if (s.subject === asset.subject)      score += 2;
      if (s.ratio_class === asset.ratio_class) score += 1;
      if (s.artist  !== asset.artist)       score += 1; // diversity bonus
      return { ...s, _score: score + Math.random() * 0.5 }; // jitter for variety
    });

    scored.sort((a, b) => b._score - a._score);
    const top = scored.slice(0, limit).map((s) => {
      const t = computePriceTier(s.max_print_width_cm, s.max_print_height_cm);
      return {
        id: s.id,
        title: s.title,
        artist: s.artist,
        image: `https://lh3.googleusercontent.com/d/${s.drive_file_id}=s400`,
        style: s.style,
        priceTier: t.tier,
        price: cheapestPrice(s.max_print_width_cm, s.max_print_height_cm) || t.price,
      };
    });

    res.set("Cache-Control", "public, max-age=3600");
    res.json({ similar: top, method: "tag" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Compute price tier from max print dimensions
 */
function computePriceTier(maxWidthCm, maxHeightCm) {
  const area = (maxWidthCm || 0) * (maxHeightCm || 0);
  // Prices: FW base cost / (1 - 0.70 margin), charm-rounded. See sync-prices.js.
  if (area <= 600) return { tier: "small", price: "33.99", comparePrice: "44.99" };
  if (area <= 1800) return { tier: "medium", price: "69.99", comparePrice: "90.99" };
  if (area <= 4000) return { tier: "large", price: "159.99", comparePrice: "209.99" };
  return { tier: "extra_large", price: "319.99", comparePrice: "419.99" };
}

// ──────────────────────────────────────
// Storefront API (legacy — for existing synced products)
// ──────────────────────────────────────

/**
 * GET /api/storefront/product/:shopifyProductId
 * Returns Drive image URLs + print spec for a product.
 * Used by theme JavaScript for dynamic image loading.
 */
router.get("/storefront/product/:shopifyProductId", async (req, res) => {
  try {
    const { data: asset } = await supabase
      .from("assets")
      .select("*, asset_variants(*)")
      .eq("shopify_product_id", req.params.shopifyProductId)
      .single();

    if (!asset) {
      return res.status(404).json({ error: "Product not found" });
    }

    const proxy = await getImageProxy();
    const urls = proxy.getResponsiveUrls(asset.drive_file_id);

    res.set("Cache-Control", "public, max-age=3600"); // 1 hour
    res.json({
      driveFileId: asset.drive_file_id,
      images: urls,
      artist: asset.artist,
      ratioClass: asset.ratio_class,
      qualityTier: asset.quality_tier,
      maxPrint: `${asset.max_print_width_cm} × ${asset.max_print_height_cm} cm`,
      variants: (asset.asset_variants || [])
        .filter((v) => (v.effective_dpi || 0) >= (parseInt(process.env.MIN_PRINT_DPI, 10) || 200))
        .map(v => ({
        label: v.label,
        size: `${v.width_cm} × ${v.height_cm} cm`,
        dpi: v.effective_dpi,
        quality: v.quality_grade,
        price: v.base_price,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/similar/:shopifyProductId
 * Returns similar products based on shared tags/style/mood.
 * Lightweight similarity without embeddings — good enough for launch.
 */
router.get("/storefront/similar/:shopifyProductId", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "8", 10);

    const { data: asset } = await supabase
      .from("assets")
      .select("style, mood, palette, subject, artist, ratio_class")
      .eq("shopify_product_id", req.params.shopifyProductId)
      .single();

    if (!asset) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Find similar by style + mood (most important), then palette + subject
    let query = supabase
      .from("assets")
      .select("shopify_product_id, title, drive_file_id, artist, style, mood, ratio_class")
      .neq("shopify_product_id", req.params.shopifyProductId)
      .eq("shopify_status", "synced")
      .not("shopify_product_id", "is", null);

    // Prefer same style
    if (asset.style) query = query.eq("style", asset.style);

    const { data: similar } = await query.limit(limit * 3); // over-fetch for ranking

    // Score and sort
    const scored = (similar || []).map(s => {
      let score = 0;
      if (s.style === asset.style) score += 3;
      if (s.mood === asset.mood) score += 2;
      if (s.palette === asset.palette) score += 1;
      if (s.subject === asset.subject) score += 2;
      if (s.ratio_class === asset.ratio_class) score += 1;
      if (s.artist !== asset.artist) score += 1; // diversity bonus
      return { ...s, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);
    const top = scored.slice(0, limit).map(s => ({
      productId: s.shopify_product_id,
      title: s.title,
      artist: s.artist,
      image: `https://lh3.googleusercontent.com/d/${s.drive_file_id}=s400`,
    }));

    res.set("Cache-Control", "public, max-age=3600");
    res.json({ similar: top });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────
// Analytics & Event Tracking
// ──────────────────────────────────────

/**
 * POST /api/storefront/events
 * Track user events (impressions, clicks, ATC, purchases).
 * Called by theme JavaScript for the analytics feedback loop.
 *
 * Body: { event_type, product_id, session_id, metadata }
 * Or array: [{ event_type, product_id }, ...]
 */
router.post("/storefront/events", async (req, res) => {
  try {
    let events = Array.isArray(req.body) ? req.body : [req.body];

    // Validate and sanitize
    const validTypes = ["impression", "click", "view", "add_to_cart", "purchase", "search"];
    const rows = events
      .filter((e) => e.event_type && validTypes.includes(e.event_type))
      .map((e) => ({
        event_type: e.event_type,
        product_id: e.product_id ? parseInt(e.product_id) : null,
        asset_id: e.asset_id || null,
        collection_id: e.collection_id ? parseInt(e.collection_id) : null,
        search_query: e.search_query || null,
        session_id: e.session_id || req.ip,
        metadata: e.metadata || {},
      }));

    if (rows.length === 0) {
      return res.status(400).json({ error: "No valid events" });
    }

    const { error } = await supabase.from("analytics_events").insert(rows);
    if (error) throw error;

    res.json({ tracked: rows.length });
  } catch (err) {
    // Don't fail silently — but don't crash either
    console.error("Analytics error:", err.message);
    res.status(200).json({ tracked: 0, error: err.message });
  }
});

/**
 * Helper: download image from URL into a Buffer (works on all Node versions).
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Helper: generate mockup via Printful, upload to Supabase Storage, save permanent URL.
 * @param {Object} asset - { id, drive_file_id, title, width_px, height_px }
 * @param {Object} [variant] - { productId, variantId } from PrintfulService.resolveVariant()
 */
async function generateAndStoreMockup(asset, variant) {
  const productId = variant?.productId || 268;
  const variantId = variant?.variantId || 8948;

  // Compute image aspect ratio from stored dimensions
  const imageAspectRatio = (asset.width_px && asset.height_px)
    ? asset.width_px / asset.height_px
    : null;

  const imageUrl = `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s2000`;
  const result = await printful.generateMockup(imageUrl, {
    productId,
    variantIds: [variantId],
    imageAspectRatio,
  });

  console.log(`[Mockup] Generated for ${asset.id} (product ${productId}, variant ${variantId}), downloading from Printful...`);

  // Download the Printful image and upload to Supabase Storage for permanence
  const buffer = await downloadImage(result.mockup_url);
  console.log(`[Mockup] Downloaded ${buffer.length} bytes, uploading to storage...`);

  // Use composite key: assetId_variantId.jpg (supports multiple mockups per asset)
  const storagePath = `${asset.id}_${variantId}.jpg`;
  const { error: uploadErr } = await supabase.storage
    .from("mockups")
    .upload(storagePath, buffer, {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

  // Build permanent public URL
  const { data: urlData } = supabase.storage
    .from("mockups")
    .getPublicUrl(storagePath);
  const permanentUrl = urlData.publicUrl;
  console.log(`[Mockup] Stored permanently: ${permanentUrl}`);

  return permanentUrl;
}

/**
 * GET /api/storefront/mockup/:assetId
 * On-demand mockup generation with size + frame support.
 * Query params: tier (small|medium|large|extra_large), frame (none|black|white|natural|walnut)
 * Returns stored URL if cached in Supabase Storage, otherwise generates via Printful.
 */
router.get("/storefront/mockup/:assetId", async (req, res) => {
  try {
    const { assetId } = req.params;
    const tier = req.query.tier || "medium";
    const frame = req.query.frame || "none";

    const variant = PrintfulService.resolveVariant(tier, frame);

    // Check Supabase Storage cache first
    const storagePath = `${assetId}_${variant.variantId}.jpg`;
    const { data: urlData } = supabase.storage.from("mockups").getPublicUrl(storagePath);
    const cachedUrl = urlData.publicUrl;

    // Verify the file actually exists in storage
    const { data: listData } = await supabase.storage.from("mockups").list("", {
      search: storagePath,
    });
    const fileExists = listData && listData.some(f => f.name === storagePath);

    if (fileExists) {
      return res.json({ mockup_url: cachedUrl, cached: true });
    }

    // Not cached — fetch asset and generate
    const { data: asset, error } = await supabase
      .from("assets")
      .select("id, drive_file_id, title, width_px, height_px")
      .eq("id", assetId)
      .single();

    if (error || !asset) return res.status(404).json({ error: "Asset not found" });

    const mockupUrl = await generateAndStoreMockup(asset, variant);
    res.json({ mockup_url: mockupUrl, cached: false });
  } catch (e) {
    console.error(`[Mockup] On-demand error:`, e.message);
    res.status(500).json({ error: "Mockup generation failed" });
  }
});

/**
 * GET /api/storefront/mockup-by-drive/:driveFileId
 * Same as above but looks up asset by Google Drive file ID.
 * Query params: tier, frame (same as above)
 */
router.get("/storefront/mockup-by-drive/:driveFileId", async (req, res) => {
  try {
    const { driveFileId } = req.params;
    const tier = req.query.tier || "medium";
    const frame = req.query.frame || "none";

    const variant = PrintfulService.resolveVariant(tier, frame);

    const { data: asset, error } = await supabase
      .from("assets")
      .select("id, drive_file_id, title, width_px, height_px")
      .eq("drive_file_id", driveFileId)
      .single();

    if (error || !asset) return res.status(404).json({ error: "Asset not found" });

    // Check Supabase Storage cache
    const storagePath = `${asset.id}_${variant.variantId}.jpg`;
    const { data: listData } = await supabase.storage.from("mockups").list("", {
      search: storagePath,
    });
    const fileExists = listData && listData.some(f => f.name === storagePath);

    if (fileExists) {
      const { data: urlData } = supabase.storage.from("mockups").getPublicUrl(storagePath);
      return res.json({ mockup_url: urlData.publicUrl, cached: true });
    }

    const mockupUrl = await generateAndStoreMockup(asset, variant);
    res.json({ mockup_url: mockupUrl, cached: false });
  } catch (e) {
    console.error(`[Mockup] On-demand (drive) error:`, e.message);
    res.status(500).json({ error: "Mockup generation failed" });
  }
});

/**
 * GET /api/storefront/trending
 * Returns trending/popular products.
 * Uses analytics_events weighted score if available,
 * falls back to newest products with diversity.
 */
router.get("/storefront/trending", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "12", 10);

    // Try analytics-based trending first
    let trendingProducts = [];
    try {
      const { data: trending } = await supabase
        .from("trending_products")
        .select("product_id, trending_score, views, clicks, adds_to_cart")
        .order("trending_score", { ascending: false })
        .limit(limit);

      if (trending && trending.length > 0) {
        // Enrich with asset data
        const productIds = trending.map((t) => t.product_id);
        const { data: assets } = await supabase
          .from("assets")
          .select("shopify_product_id, title, drive_file_id, artist, style, ratio_class")
          .in("shopify_product_id", productIds)
          .eq("shopify_status", "synced");

        const assetMap = {};
        (assets || []).forEach((a) => (assetMap[a.shopify_product_id] = a));

        trendingProducts = trending
          .filter((t) => assetMap[t.product_id])
          .map((t) => {
            const a = assetMap[t.product_id];
            return {
              productId: a.shopify_product_id,
              title: a.title,
              artist: a.artist,
              image: `https://lh3.googleusercontent.com/d/${a.drive_file_id}=s400`,
              style: a.style,
              trendingScore: t.trending_score,
            };
          });
      }
    } catch (e) {
      // trending_products materialized view might not exist yet — fall through
    }

    // Fallback: newest with diversity
    if (trendingProducts.length === 0) {
      const { data: assets } = await supabase
        .from("assets")
        .select("shopify_product_id, title, drive_file_id, artist, style, ratio_class")
        .eq("shopify_status", "synced")
        .not("shopify_product_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(limit * 2);

      const artistCount = {};
      trendingProducts = (assets || [])
        .filter((a) => {
          const count = artistCount[a.artist] || 0;
          if (count >= 2) return false;
          artistCount[a.artist] = count + 1;
          return true;
        })
        .slice(0, limit)
        .map((a) => ({
          productId: a.shopify_product_id,
          title: a.title,
          artist: a.artist,
          image: `https://lh3.googleusercontent.com/d/${a.drive_file_id}=s400`,
          style: a.style,
        }));
    }

    res.set("Cache-Control", "public, max-age=1800");
    res.json({ trending: trendingProducts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/analytics
 * Dashboard: return analytics summary for last N days.
 */
router.get("/storefront/analytics", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "7", 10);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: events } = await supabase
      .from("analytics_events")
      .select("event_type, product_id, created_at")
      .gte("created_at", since);

    const summary = {
      period: `${days} days`,
      total_events: (events || []).length,
      by_type: {},
      top_products: {},
    };

    (events || []).forEach((e) => {
      summary.by_type[e.event_type] = (summary.by_type[e.event_type] || 0) + 1;
      if (e.product_id) {
        const key = String(e.product_id);
        if (!summary.top_products[key]) summary.top_products[key] = { views: 0, clicks: 0, atc: 0 };
        if (e.event_type === "view") summary.top_products[key].views++;
        if (e.event_type === "click") summary.top_products[key].clicks++;
        if (e.event_type === "add_to_cart") summary.top_products[key].atc++;
      }
    });

    // Sort top products by engagement
    const sorted = Object.entries(summary.top_products)
      .map(([id, stats]) => ({ product_id: id, ...stats, score: stats.atc * 5 + stats.clicks * 2 + stats.views }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    summary.top_products = sorted;

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────
// Vector Search Endpoints
// ──────────────────────────────────────

/**
 * GET /api/storefront/search?q=warm+abstract+landscape
 * Semantic search using text embeddings.
 * Falls back to Supabase ILIKE if embeddings aren't set up.
 */
router.get("/storefront/search", async (req, res) => {
  try {
    const query = req.query.q || req.query.query || "";
    const limit = parseInt(req.query.limit || "12", 10);

    if (!query) {
      return res.status(400).json({ error: "Missing query parameter ?q=" });
    }

    // Track search event
    supabase.from("analytics_events").insert({
      event_type: "search",
      search_query: query,
      session_id: req.ip,
    }).then(() => {}).catch(() => {});

    // Try vector search first
    const emb = await getEmbedder();
    if (emb) {
      try {
        const results = await emb.searchByText(query, limit);
        if (results.length > 0) {
          res.set("Cache-Control", "public, max-age=300");
          return res.json({
            results: results.map((r) => {
              const t = computePriceTier(r.max_print_width_cm, r.max_print_height_cm);
              return {
                id: r.id || r.asset_id,
                productId: r.shopify_product_id,
                title: r.title,
                artist: r.artist,
                style: r.style,
                image: `https://lh3.googleusercontent.com/d/${r.drive_file_id}=s400`,
                similarity: r.similarity,
                priceTier: t.tier,
                price: cheapestPrice(r.max_print_width_cm, r.max_print_height_cm) || t.price,
              };
            }),
            method: "vector",
          });
        }
      } catch (e) {
        console.warn("Vector search failed, falling back:", e.message);
      }
    }

    // Fallback: ILIKE text search — enhanced multi-word support
    let searchQuery = supabase
      .from("assets")
      .select("id, title, drive_file_id, artist, style, mood, era, subject, max_print_width_cm, max_print_height_cm")
      .in("ingestion_status", ["ready", "analyzed"])
      .not("drive_file_id", "is", null);

    const words = query.trim().split(/\s+/).filter(w => w.length > 1);
    if (words.length > 1) {
      // Multi-word: each word must match at least one field
      for (const word of words) {
        searchQuery = searchQuery.or(
          `title.ilike.%${word}%,style.ilike.%${word}%,mood.ilike.%${word}%,artist.ilike.%${word}%,era.ilike.%${word}%,subject.ilike.%${word}%`
        );
      }
    } else {
      searchQuery = searchQuery.or(
        `title.ilike.%${query}%,style.ilike.%${query}%,mood.ilike.%${query}%,artist.ilike.%${query}%,era.ilike.%${query}%,subject.ilike.%${query}%`
      );
    }

    const { data: results } = await searchQuery.limit(limit);

    res.set("Cache-Control", "public, max-age=300");
    res.json({
      results: (results || []).map((r) => {
        const t = computePriceTier(r.max_print_width_cm, r.max_print_height_cm);
        return {
          id: r.id,
          title: r.title,
          artist: r.artist,
          style: r.style,
          image: `https://lh3.googleusercontent.com/d/${r.drive_file_id}=s400`,
          priceTier: t.tier,
          price: cheapestPrice(r.max_print_width_cm, r.max_print_height_cm) || t.price,
        };
      }),
      method: "text",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/similar-v2/:shopifyProductId
 * Vector-powered similar products. Falls back to tag matching.
 */
router.get("/storefront/similar-v2/:shopifyProductId", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "8", 10);

    // Get asset_id from shopify product id
    const { data: asset } = await supabase
      .from("assets")
      .select("id, style, mood, palette, subject, artist, ratio_class")
      .eq("shopify_product_id", req.params.shopifyProductId)
      .single();

    if (!asset) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Try vector similarity
    const emb = await getEmbedder();
    if (emb) {
      try {
        const similar = await emb.findSimilar(asset.id, limit);
        if (similar.length > 0) {
          res.set("Cache-Control", "public, max-age=3600");
          return res.json({
            similar: similar.map((r) => ({
              productId: r.shopify_product_id,
              title: r.title,
              artist: r.artist,
              image: `https://lh3.googleusercontent.com/d/${r.drive_file_id}=s400`,
              similarity: r.similarity,
            })),
            method: "vector",
          });
        }
      } catch (e) {
        console.warn("Vector similar failed:", e.message);
      }
    }

    // Fallback to existing tag-based similarity
    res.redirect(`/api/storefront/similar/${req.params.shopifyProductId}?limit=${limit}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────
// Dashboard data endpoints
// ──────────────────────────────────────

/**
 * GET /api/stats
 * Overall pipeline statistics.
 */
router.get("/stats", async (req, res) => {
  try {
    // Total assets
    const { count: totalAssets } = await supabase
      .from("assets")
      .select("*", { count: "exact", head: true });

    // By ingestion status
    const byStatus = {};
    for (const status of ["pending", "downloaded", "analyzed", "tagged", "ready", "error"]) {
      const { count } = await supabase
        .from("assets")
        .select("*", { count: "exact", head: true })
        .eq("ingestion_status", status);
      byStatus[status] = count || 0;
    }

    // By Shopify status
    const shopifyStatus = {};
    for (const status of ["pending", "synced", "error"]) {
      const { count } = await supabase
        .from("assets")
        .select("*", { count: "exact", head: true })
        .eq("shopify_status", status);
      shopifyStatus[status] = count || 0;
    }

    // Total variants
    const { count: totalVariants } = await supabase
      .from("asset_variants")
      .select("*", { count: "exact", head: true });

    // By ratio class
    const { data: ratioData } = await supabase
      .from("assets")
      .select("ratio_class")
      .not("ratio_class", "is", null);
    const ratioDistribution = {};
    (ratioData || []).forEach((r) => {
      ratioDistribution[r.ratio_class] = (ratioDistribution[r.ratio_class] || 0) + 1;
    });

    // By style
    const { data: styleData } = await supabase
      .from("assets")
      .select("style")
      .not("style", "is", null);
    const styleDistribution = {};
    (styleData || []).forEach((r) => {
      styleDistribution[r.style] = (styleDistribution[r.style] || 0) + 1;
    });

    // By artist
    const { data: artistData } = await supabase
      .from("assets")
      .select("artist")
      .not("artist", "is", null);
    const artistCounts = {};
    (artistData || []).forEach((r) => {
      artistCounts[r.artist] = (artistCounts[r.artist] || 0) + 1;
    });

    // Recent pipeline runs
    const { data: recentRuns } = await supabase
      .from("pipeline_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(10);

    // Image proxy stats
    let proxyStats = null;
    try {
      const proxy = await getImageProxy();
      proxyStats = proxy.getCacheStats();
    } catch (e) {}

    res.json({
      totalAssets: totalAssets || 0,
      totalVariants: totalVariants || 0,
      totalArtists: Object.keys(artistCounts).length,
      ingestionStatus: byStatus,
      shopifyStatus,
      ratioDistribution,
      styleDistribution,
      artistCounts,
      recentRuns: recentRuns || [],
      imageProxy: proxyStats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/assets
 * List assets with pagination + filtering.
 */
router.get("/assets", async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const perPage = parseInt(req.query.per_page || "50", 10);
    const status = req.query.status;
    const ratioClass = req.query.ratio_class;
    const style = req.query.style;
    const artist = req.query.artist;
    const search = req.query.search;

    let query = supabase
      .from("assets")
      .select("*, asset_variants(*)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * perPage, page * perPage - 1);

    if (status) query = query.eq("ingestion_status", status);
    if (ratioClass) query = query.eq("ratio_class", ratioClass);
    if (style) query = query.eq("style", style);
    if (artist) query = query.eq("artist", artist);
    if (search) query = query.ilike("title", `%${search}%`);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({
      assets: data || [],
      total: count || 0,
      page,
      perPage,
      totalPages: Math.ceil((count || 0) / perPage),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/assets/:id
 * Single asset detail with variants and print spec.
 */
router.get("/assets/:id", async (req, res) => {
  try {
    const { data: asset, error } = await supabase
      .from("assets")
      .select("*, asset_variants(*)")
      .eq("id", req.params.id)
      .single();

    if (error || !asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    // Generate print specs for each variant
    const printSpecs = (asset.asset_variants || []).map((v) =>
      generatePrintSpec(asset, v, "matte_paper")
    );

    // Add image URLs
    const proxy = await getImageProxy();
    const imageUrls = proxy.getResponsiveUrls(asset.drive_file_id);

    res.json({ asset, printSpecs, imageUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/assets/:id/analyze
 * Re-run the resolution engine on an asset.
 */
router.get("/assets/:id/analyze", async (req, res) => {
  try {
    const { data: asset, error } = await supabase
      .from("assets")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error || !asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    if (!asset.width_px || !asset.height_px) {
      return res.status(400).json({ error: "Asset has no dimension data" });
    }

    const analysis = analyzeArtwork(asset.width_px, asset.height_px);
    res.json({ asset: { id: asset.id, filename: asset.filename }, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pipeline-runs
 * List recent pipeline runs.
 */
router.get("/pipeline-runs", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pipeline_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ runs: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/print-profiles
 * List available print material profiles.
 */
router.get("/print-profiles", (req, res) => {
  res.json({ profiles: DEFAULT_PROFILES });
});

/**
 * GET /api/size-catalog
 * List the full print size catalog.
 */
router.get("/size-catalog", (req, res) => {
  res.json({ catalog: PRINT_SIZE_CATALOG });
});

/**
 * GET /api/health
 * Health check endpoint.
 */
router.get("/health", async (req, res) => {
  const checks = { server: "ok", version: "2026-03-12a-oom-fix", supabase: "unknown", drive: "unknown" };

  try {
    const { count, error } = await supabase.from("assets").select("*", { count: "exact", head: true });
    if (error) {
      checks.supabase = `error: ${error.message}`;
    } else {
      checks.supabase = "ok";
      checks.assetCount = count;
    }
  } catch (e) {
    checks.supabase = `error: ${e.message}`;
  }

  try {
    const proxy = await getImageProxy();
    checks.drive = proxy.drive ? "ok" : "no-api-key";
    checks.imageCache = proxy.getCacheStats();
  } catch (e) {
    checks.drive = `error: ${e.message}`;
  }

  const allOk = checks.supabase === "ok";
  res.status(allOk ? 200 : 503).json(checks);
});

// ═══════════════════════════════════════════════════════════
// DRIP SYNC CONTROL — monitor and control the auto-drip
// ═══════════════════════════════════════════════════════════
const drip = require("../scripts/sync-drip");

// GET /api/sync/status — see drip sync state
router.get("/sync/status", (req, res) => {
  res.json(drip.getStatus());
});

// POST /api/sync/start — start drip if not running
router.post("/sync/start", (req, res) => {
  drip.startDrip().catch((e) => console.error("Drip fatal:", e.message));
  res.json({ message: "Drip sync started", status: drip.getStatus() });
});

// POST /api/sync/stop — stop drip
router.post("/sync/stop", (req, res) => {
  drip.stopDrip();
  res.json({ message: "Drip sync stopped", status: drip.getStatus() });
});

// POST /api/sync/pause — pause drip
router.post("/sync/pause", (req, res) => {
  drip.pauseDrip();
  res.json({ message: "Drip sync paused", status: drip.getStatus() });
});

// POST /api/sync/resume — resume drip
router.post("/sync/resume", (req, res) => {
  drip.resumeDrip();
  res.json({ message: "Drip sync resumed", status: drip.getStatus() });
});

// ═══════════════════════════════════════════════════════════
// DRIVE AUTO-SYNC — monitor Drive for new files
// ═══════════════════════════════════════════════════════════
const driveWatcher = require("../scripts/drive-watcher");

// GET /api/drive/status — get watcher state
router.get("/drive/status", (req, res) => {
  res.json(driveWatcher.getWatcherStatus());
});

// POST /api/drive/sync — trigger an immediate Drive→Supabase sync
router.post("/drive/sync", async (req, res) => {
  const fullScan = req.body?.full === true;
  res.json({ message: fullScan ? "Full scan started" : "Delta sync started", starting: true });
  // Run async (don't block the response)
  driveWatcher.runOnce(fullScan).catch(e => console.error("Drive sync error:", e.message));
});

// POST /api/drive/start-watcher — start the persistent polling watcher
router.post("/drive/start-watcher", (req, res) => {
  const interval = parseInt(req.body?.interval || "300", 10);
  driveWatcher.startWatcher(interval).catch(e => console.error("Watcher error:", e.message));
  res.json({ message: `Drive watcher started (polling every ${interval}s)`, status: driveWatcher.getWatcherStatus() });
});

// POST /api/drive/stop-watcher — stop the persistent polling watcher
router.post("/drive/stop-watcher", (req, res) => {
  driveWatcher.stopWatcher();
  res.json({ message: "Drive watcher stopped", status: driveWatcher.getWatcherStatus() });
});

// ═══════════════════════════════════════════════════════════
// PRINTFUL — print provider status & orders
// ═══════════════════════════════════════════════════════════

// GET /api/printful/status — from background cache (instant)
router.get("/printful/status", (req, res) => {
  res.json(printfulCache.getStatus());
});

// GET /api/printful/products — from background cache (instant)
router.get("/printful/products", (req, res) => {
  const products = printfulCache.getProducts();
  res.json({ count: products.length, products });
});

// GET /api/printful/orders — from background cache (instant)
router.get("/printful/orders", (req, res) => {
  const orders = printfulCache.getOrders();
  res.json(orders);
});

// POST /api/printful/sync — trigger a manual background re-sync
router.post("/printful/sync", async (req, res) => {
  printfulCache.sync(); // fire-and-forget
  res.json({ message: "Sync started", meta: printfulCache.getMeta() });
});

// GET /api/printful/cache-meta — check cache health
router.get("/printful/cache-meta", (req, res) => {
  res.json(printfulCache.getMeta());
});

// POST /api/printful/estimate — estimate cost for a print
router.post("/printful/estimate", async (req, res) => {
  try {
    const est = await printful.estimateCost(req.body);
    res.json(est);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PRINTFUL MOCKUP GENERATOR — on-demand wall mockups
// ═══════════════════════════════════════════════════════════

// In-memory mockup cache (taskKey -> result) to avoid re-polling
const mockupCache = new Map();

/**
 * GET /api/printful/mockup/:assetId
 * Generate a Printful wall mockup for a given asset.
 * If the asset already has a cached mockup_url in DB, returns it instantly.
 * Otherwise creates a Printful task, polls, stores result, and returns.
 *
 * Query params:
 *   ?product_id=268  — Printful product (default: 268 = poster)
 *   ?variant_ids=8948 — comma-separated variant IDs (default: 8948 = 30×40cm)
 *   ?force=1         — regenerate even if cached
 */
router.get("/printful/mockup/:assetId", async (req, res) => {
  try {
    const { assetId } = req.params;
    const force = req.query.force === "1";
    const productId = parseInt(req.query.product_id || "268", 10);
    const variantIds = (req.query.variant_ids || "8948")
      .split(",")
      .map((v) => parseInt(v.trim(), 10));

    // 1. Look up asset
    let asset;
    try {
      const { data, error } = await supabase
        .from("assets")
        .select("id, drive_file_id, title, mockup_url, width_px, height_px")
        .eq("id", assetId)
        .single();
      if (error || !data) return res.status(404).json({ error: "Asset not found" });
      asset = data;
    } catch (e) {
      // mockup_url column might not exist yet — try without it
      const { data, error } = await supabase
        .from("assets")
        .select("id, drive_file_id, title, width_px, height_px")
        .eq("id", assetId)
        .single();
      if (error || !data) return res.status(404).json({ error: "Asset not found" });
      asset = data;
    }

    // 2. Return cached mockup if available
    if (asset.mockup_url && !force) {
      return res.json({
        assetId,
        mockup_url: asset.mockup_url,
        cached: true,
      });
    }

    // 3. Build the image URL — use high-res for Printful
    const imageUrl = `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s2000`;

    // 4. Generate mockup
    console.log(`[Mockup] Generating for asset ${assetId} (${asset.title || "untitled"})...`);
    const result = await printful.generateMockup(imageUrl, {
      productId,
      variantIds,
    });

    // 5. Try to store in database (column may not exist yet)
    try {
      await supabase
        .from("assets")
        .update({ mockup_url: result.mockup_url })
        .eq("id", assetId);
    } catch (e) {
      console.log(`[Mockup] Could not cache in DB (column may not exist): ${e.message}`);
    }

    res.json({
      assetId,
      mockup_url: result.mockup_url,
      extra: result.extra,
      cached: false,
    });
  } catch (e) {
    console.error(`[Mockup] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/printful/mockup/batch
 * Generate mockups for multiple assets at once.
 * Body: { assetIds: [uuid, ...], product_id?: number, variant_ids?: number[] }
 * Returns immediately with task status; results stored in DB.
 */
router.post("/printful/mockup/batch", async (req, res) => {
  try {
    const { assetIds = [], product_id = 268, variant_ids = [8948] } = req.body;
    if (!assetIds.length) {
      return res.status(400).json({ error: "assetIds required" });
    }
    if (assetIds.length > 50) {
      return res.status(400).json({ error: "Max 50 assets per batch" });
    }

    // Fetch assets
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, drive_file_id, title, mockup_url")
      .in("id", assetIds);

    if (error) throw error;

    // Filter to those without mockups
    const needMockup = assets.filter((a) => !a.mockup_url);
    const alreadyDone = assets.filter((a) => a.mockup_url);

    // Process in background (don't block response)
    const results = { queued: needMockup.length, skipped: alreadyDone.length, results: [] };

    // Fire off mockup generation asynchronously
    (async () => {
      for (const asset of needMockup) {
        try {
          const imageUrl = `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s2000`;
          const result = await printful.generateMockup(imageUrl, {
            productId: product_id,
            variantIds: variant_ids,
          });
          await supabase
            .from("assets")
            .update({ mockup_url: result.mockup_url })
            .eq("id", asset.id);
          console.log(`[Mockup] Done: ${asset.id} (${asset.title || "untitled"})`);
        } catch (e) {
          console.error(`[Mockup] Failed: ${asset.id} — ${e.message}`);
        }
        // Rate limit: ~1 per 3s (Printful is rate-limited)
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();

    res.json({
      message: `Generating ${needMockup.length} mockups (${alreadyDone.length} already cached)`,
      ...results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────
// Bulk Price Editor
// ──────────────────────────────────────

/**
 * GET /api/prices — Get current price map
 * Returns the skeleton price map (all size tiers and their prices).
 */
router.get("/prices", (req, res) => {
  try {
    const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
    const priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    res.json({
      prices: priceMap,
      tiers: Object.keys(priceMap).map(key => ({
        key,
        price: priceMap[key].price,
        sku: priceMap[key].sku,
        tier: priceMap[key].tier,
        framed: priceMap[key].framed,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/prices — Update price map (local config)
 * Body: { prices: { "small_unframed": "34.99", "medium_unframed": "54.99", ... } }
 * Only updates the price fields provided.
 */
router.put("/prices", async (req, res) => {
  try {
    const { prices } = req.body;
    if (!prices || typeof prices !== "object") {
      return res.status(400).json({ error: "Provide { prices: { tier_key: new_price } }" });
    }

    const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
    const priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));

    const updated = [];
    for (const [key, newPrice] of Object.entries(prices)) {
      if (!priceMap[key]) {
        continue; // skip unknown keys
      }
      const price = parseFloat(newPrice);
      if (isNaN(price) || price < 0) continue;
      priceMap[key].price = price.toFixed(2);
      updated.push({ key, price: priceMap[key].price });
    }

    fs.writeFileSync(mapPath, JSON.stringify(priceMap, null, 2));

    res.json({
      message: `Updated ${updated.length} price tiers`,
      updated,
      currentPrices: priceMap,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/prices/apply-shopify — Push updated prices to all synced Shopify products
 * This updates variant prices on Shopify products based on their metafield data.
 * 
 * Body (optional): 
 *   { tier: "small_unframed" }   — only update one tier
 *   { limit: 100 }               — process N products at a time
 *   { dryRun: true }             — preview without changes
 *
 * Since we use single-variant products with price determined by quality_tier,
 * this updates the default variant price on each Shopify product.
 */
router.post("/prices/apply-shopify", async (req, res) => {
  const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const API_VER = process.env.SHOPIFY_API_VERSION || "2024-10";
  const BASE_URL = `https://${SHOP}/admin/api/${API_VER}`;
  
  const dryRun = req.body?.dryRun === true;
  const limit = parseInt(req.body?.limit || "500", 10);

  try {
    const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
    const priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));

    // Get synced products from Supabase
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, shopify_product_id, quality_tier, ratio_class")
      .not("shopify_product_id", "is", null)
      .limit(limit);

    if (error) throw error;

    // Price determination logic (same as sync scripts)
    function getPrice(asset) {
      // For now, all products use the small_unframed tier price
      // since we create single-variant products
      return priceMap.small_unframed?.price || "33.99";
    }

    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const results = [];

    for (const asset of assets) {
      const newPrice = getPrice(asset);
      
      if (dryRun) {
        results.push({
          shopify_product_id: asset.shopify_product_id,
          newPrice,
          status: "dry-run",
        });
        updated++;
        continue;
      }

      try {
        // Get product to find variant ID
        const prodRes = await fetch(`${BASE_URL}/products/${asset.shopify_product_id}.json?fields=id,variants`, {
          headers: { "X-Shopify-Access-Token": TOKEN },
        });
        
        if (prodRes.status === 429) {
          await new Promise(r => setTimeout(r, 2000));
          skipped++;
          continue;
        }
        if (!prodRes.ok) { skipped++; continue; }
        
        const prodData = await prodRes.json();
        const variant = prodData.product?.variants?.[0];
        if (!variant) { skipped++; continue; }

        // Update variant price
        const updateRes = await fetch(`${BASE_URL}/variants/${variant.id}.json`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": TOKEN,
          },
          body: JSON.stringify({
            variant: {
              id: variant.id,
              price: newPrice,
            },
          }),
        });

        if (updateRes.ok) {
          updated++;
        } else if (updateRes.status === 429) {
          await new Promise(r => setTimeout(r, 2000));
          skipped++;
        } else {
          errors++;
        }

        // Rate limit: ~2 req/sec (each product = 2 calls)
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        errors++;
      }
    }

    res.json({
      message: dryRun ? "Dry run complete" : `Price update complete`,
      total: assets.length,
      updated,
      skipped,
      errors,
      dryRun,
      ...(dryRun && results.length <= 20 ? { preview: results.slice(0, 20) } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/prices/bulk-update-tags — Push enriched tags to all synced Shopify products
 * Reads updated tags from Supabase and pushes them to Shopify.
 *
 * Body (optional):
 *   { limit: 500 }    — process N products at a time
 *   { dryRun: true }  — preview without changes
 */
router.post("/prices/bulk-update-tags", async (req, res) => {
  const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const API_VER = process.env.SHOPIFY_API_VERSION || "2024-10";
  const BASE_URL = `https://${SHOP}/admin/api/${API_VER}`;

  const dryRun = req.body?.dryRun === true;
  const limit = parseInt(req.body?.limit || "500", 10);

  try {
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, shopify_product_id, ratio_class, quality_tier, style, era, mood, subject, palette, ai_tags")
      .not("shopify_product_id", "is", null)
      .not("style", "is", null)
      .limit(limit);

    if (error) throw error;

    let updated = 0;
    let errors = 0;

    for (const asset of assets) {
      const tags = [
        asset.ratio_class?.replace(/_/g, " "),
        asset.quality_tier === "high" ? "museum grade" : "gallery grade",
        asset.style, asset.era, asset.mood, asset.subject, asset.palette,
        "art print", "fine art", "wall art",
        ...(asset.ai_tags || []),
      ].filter(Boolean);

      if (dryRun) { updated++; continue; }

      try {
        const updateRes = await fetch(`${BASE_URL}/products/${asset.shopify_product_id}.json`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": TOKEN,
          },
          body: JSON.stringify({
            product: { id: parseInt(asset.shopify_product_id), tags: tags.join(", ") },
          }),
        });

        if (updateRes.ok) {
          updated++;
        } else if (updateRes.status === 429) {
          await new Promise(r => setTimeout(r, 2000));
        } else {
          errors++;
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        errors++;
      }
    }

    res.json({
      message: dryRun ? "Dry run complete" : "Tag push complete",
      total: assets.length,
      updated,
      errors,
      dryRun,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SHIPPING MANAGEMENT — View & update Shopify shipping rates
// ═══════════════════════════════════════════════════════════

const SHOPIFY_GQL = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION || "2024-10"}/graphql.json`;
function shopifyGql(query) {
  if (!process.env.SHOPIFY_ADMIN_API_TOKEN) {
    return Promise.resolve({ errors: "SHOPIFY_ADMIN_API_TOKEN not configured" });
  }
  return fetch(SHOPIFY_GQL, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  }).then(r => {
    if (!r.ok) return r.text().then(t => ({ errors: t || `HTTP ${r.status}` }));
    return r.json();
  }).catch(e => ({ errors: e.message }));
}

/**
 * GET /api/shipping/rates — Get current Shopify shipping rates
 */
router.get("/shipping/rates", async (req, res) => {
  try {
    if (!process.env.SHOPIFY_ADMIN_API_TOKEN) {
      return res.status(400).json({ error: "SHOPIFY_ADMIN_API_TOKEN not configured" });
    }
    const data = await shopifyGql(`{
      deliveryProfiles(first: 5) {
        edges { node {
          id name
          profileLocationGroups {
            locationGroup { id }
            locationGroupZones(first: 20) {
              edges { node {
                zone { id name }
                methodDefinitions(first: 10) {
                  edges { node {
                    id name
                    rateProvider {
                      ... on DeliveryRateDefinition {
                        id price { amount currencyCode }
                      }
                    }
                  }}
                }
              }}
            }
          }
        }}
      }
    }`);

    if (data.errors) {
      const errMsg = typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
      const isAuthError = errMsg.toLowerCase().includes('invalid api key') || errMsg.toLowerCase().includes('access token');
      return res.status(isAuthError ? 401 : 400).json({
        error: isAuthError
          ? 'Shopify API token is expired or invalid. Re-install the app or update SHOPIFY_ADMIN_API_TOKEN in Render env vars.'
          : errMsg,
        errors: data.errors,
      });
    }

    const profiles = (data.data.deliveryProfiles.edges || []).map(e => {
      const p = e.node;
      const zones = [];
      for (const lg of p.profileLocationGroups || []) {
        for (const ze of (lg.locationGroupZones?.edges || [])) {
          const z = ze.node;
          const methods = (z.methodDefinitions?.edges || []).map(me => ({
            id: me.node.id,
            name: me.node.name,
            price: me.node.rateProvider?.price?.amount || "0",
            currency: me.node.rateProvider?.price?.currencyCode || "USD",
          }));
          zones.push({
            id: z.zone.id,
            name: z.zone.name,
            methods,
          });
        }
      }
      return {
        id: p.id,
        name: p.name,
        default: p.default,
        locationGroupId: p.profileLocationGroups?.[0]?.locationGroup?.id,
        zones,
      };
    });

    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/shipping/rates — Update a shipping rate
 * Body: { profileId, locationGroupId, zoneId, methodId, name, price }
 */
router.put("/shipping/rates", async (req, res) => {
  try {
    const { profileId, locationGroupId, zoneId, methodId, name, price } = req.body;
    if (!profileId || !locationGroupId || !zoneId || !methodId) {
      return res.status(400).json({ error: "Missing required IDs" });
    }

    const mutation = `mutation {
      deliveryProfileUpdate(id: "${profileId}", profile: {
        locationGroupsToUpdate: [{
          id: "${locationGroupId}",
          zonesToUpdate: [{
            id: "${zoneId}",
            methodDefinitionsToUpdate: [{
              id: "${methodId}",
              ${name ? `name: "${name}",` : ""}
              rateDefinition: { price: { amount: ${parseFloat(price)}, currencyCode: USD } }
            }]
          }]
        }]
      }) {
        profile { id }
        userErrors { field message }
      }
    }`;

    const data = await shopifyGql(mutation);
    if (data.errors) {
      const errMsg = typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
      return res.status(400).json({ error: errMsg, errors: data.errors });
    }

    const errs = data.data?.deliveryProfileUpdate?.userErrors || [];
    if (errs.length) return res.status(400).json({ errors: errs });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/fulfillment-orders — Get fulfillment orders from DB
 */
router.get("/fulfillment-orders", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("fulfillment_orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    res.json({ orders: data || [], error: error?.message });
  } catch (err) {
    res.json({ orders: [], error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CARRIER SERVICE — Real-time FinerWorks shipping rates for Shopify checkout
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/carrier-service/rates
 * Registered as a Shopify CarrierService callback. Shopify hits this at
 * checkout with the cart + destination; we proxy to FinerWorks
 * /v3/list_shipping_options_multiple and return Shopify-formatted rates.
 *
 * Shopify request:  { rate: { origin, destination, items, currency, locale } }
 * Shopify response: { rates: [{ service_name, service_code, total_price (cents string), currency, ... }] }
 */

// Skeleton SKU prefixes → conservative default FW product codes (archival
// matte) when a cart line item has no _finerworks_product_code property.
// Real orders always carry the explicit code from add-to-cart; this is only
// a fallback for rate quoting if properties are missing.
const SKU_TO_FW_CODE = {
  "NP-SMALL":  "5M6M9S8X10",
  "NP-MEDIUM": "5M6M9S12X16",
  "NP-LARGE":  "5M6M9S18X24",
  "NP-XL":     "5M6M9S24X36",
};

function shopifyItemToFwSku(item) {
  // Shopify CarrierService delivers line-item properties in `item.properties`
  // as an object — these are the props we set at add-to-cart in the theme.
  const props = item.properties || {};
  const explicit =
    props._finerworks_product_code ||
    props.finerworks_product_code ||
    props.FinerWorksProductCode;
  if (explicit) return String(explicit);

  // Derive from Size if available, e.g. "40 × 28.57 cm"
  const sizeStr = props.Size || props.size || "";
  const dims = FinerWorksService.parseSizeCm(sizeStr);
  if (dims) {
    return FinerWorksService.buildDefaultProductCode(dims.widthCm, dims.heightCm);
  }

  // Last resort: SKU prefix
  const upper = (item.sku || "").toUpperCase();
  for (const [prefix, code] of Object.entries(SKU_TO_FW_CODE)) {
    if (upper.startsWith(prefix)) return code;
  }
  return SKU_TO_FW_CODE["NP-MEDIUM"];
}

function normalizeFwShippingOptions(fwResp) {
  // FW returns: { status, orders: [{ order_po, options: [{id, rate,
  //   shipping_method, shipping_code, shipping_class_code, transit_time,
  //   carrier, calculated_total}], order_size, preferred_option }] }
  const orders = fwResp?.orders || (Array.isArray(fwResp) ? fwResp : []);
  const opts = [];
  for (const o of orders) {
    const list = o?.options || o?.shipping_options || [];
    for (const s of list) opts.push(s);
  }
  // De-dup by shipping_code, keep cheapest
  const byCode = {};
  for (const s of opts) {
    const code = s.shipping_code || s.code || `OPT${s.id || ""}`;
    const cost = parseFloat(s.rate ?? s.shipping_cost ?? s.cost ?? 0);
    if (!Number.isFinite(cost)) continue;
    if (byCode[code] == null || cost < byCode[code]._cost) {
      byCode[code] = { ...s, _cost: cost, _code: code };
    }
  }
  return Object.values(byCode).sort((a, b) => a._cost - b._cost);
}

// Strip HTML and parse "1-5 biz days" → {min:1, max:5}
function parseTransitDays(transit) {
  if (!transit) return { min: null, max: null };
  const text = String(transit).replace(/<[^>]+>/g, "").trim();
  const m = text.match(/(\d+)\s*(?:-|to|–)\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  const single = text.match(/(\d+)/);
  if (single) {
    const n = parseInt(single[1], 10);
    return { min: n, max: n };
  }
  return { min: null, max: null };
}

router.post("/carrier-service/rates", async (req, res) => {
  try {
    const rateRequest = req.body.rate;
    if (!rateRequest) return res.status(400).json({ rates: [] });

    const dest  = rateRequest.destination;
    const items = rateRequest.items || [];
    if (!dest || !dest.country) return res.status(200).json({ rates: [] });
    if (items.length === 0)      return res.status(200).json({ rates: [] });

    // Build FW recipient (only fields used for rate quoting)
    const recipient = {
      first_name:   dest.first_name || "Customer",
      last_name:    dest.last_name  || "Estimate",
      address1:     dest.address1   || "N/A",
      address2:     dest.address2   || null,
      city:         dest.city       || "N/A",
      state_code:   dest.province   || "",
      zip:          dest.postal_code || "",
      country_code: dest.country,
    };

    // Map every Shopify cart line to a FW order_item (one per quantity row;
    // FW handles per-line quantities natively so we keep the original qty).
    const fwItems = items.map((it) => ({
      product_sku:   shopifyItemToFwSku(it),
      product_qty:   it.quantity || 1,
      product_title: it.name || it.title || "Print",
    }));

    let fwResp;
    try {
      fwResp = await finerworks.listShippingOptions({ recipient, items: fwItems });
    } catch (e) {
      console.error("[CarrierService] FinerWorks rate quote failed:", e.message);
      // Fall through to fallback rates so checkout isn't blocked.
      fwResp = null;
    }

    const opts = fwResp ? normalizeFwShippingOptions(fwResp) : [];

    const currency = rateRequest.currency || "USD";
    const shopifyRates = opts
      .filter((o) => o._cost >= 0)
      .map((o) => {
        const days = parseTransitDays(o.transit_time);
        const carrier = o.carrier ? `${o.carrier} — ` : "";
        const name = `${carrier}${o.shipping_method || o.shipping_name || o.name || "Shipping"}`;
        const code = `FW_${o._code || o.shipping_code || "STD"}`;
        return {
          service_name: name,
          service_code: code,
          total_price:  Math.round(o._cost * 100).toString(),
          currency,
          min_delivery_date: days.min ? new Date(Date.now() + days.min * 86400000).toISOString() : null,
          max_delivery_date: days.max ? new Date(Date.now() + days.max * 86400000).toISOString() : null,
          description: o.transit_time ? String(o.transit_time).replace(/<[^>]+>/g, "").trim() : null,
        };
      });

    // Safety net: if FW returned nothing usable, ship a sane flat default so
    // the checkout still completes. Better a working order than a dead cart.
    if (shopifyRates.length === 0) {
      const country = String(dest.country || "").toUpperCase();
      const isUS = country === "US";
      const isNZAU = country === "NZ" || country === "AU";
      const flat = isUS ? 8.99 : isNZAU ? 14.99 : 22.99;
      shopifyRates.push({
        service_name: "Standard Shipping",
        service_code: "FW_FALLBACK_STD",
        total_price:  Math.round(flat * 100).toString(),
        currency,
        min_delivery_date: new Date(Date.now() + 5 * 86400000).toISOString(),
        max_delivery_date: new Date(Date.now() + 12 * 86400000).toISOString(),
        description: "Estimated rate — live carrier quote unavailable",
      });
      console.warn("[CarrierService] Returning fallback flat rate for country=", country);
    }

    res.json({ rates: shopifyRates });
  } catch (err) {
    console.error("[CarrierService] Error fetching rates:", err.message);
    // Never block checkout — return empty rates on hard failure.
    res.status(200).json({ rates: [] });
  }
});

// ═══════════════════════════════════════════════════════════
// WEBHOOK MANAGEMENT — view & register Shopify webhooks
// ═══════════════════════════════════════════════════════════

const config = require("../config");
const SHOPIFY_BASE = `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}`;
const SHOPIFY_HEADERS = {
  "Content-Type": "application/json",
  "X-Shopify-Access-Token": config.shopify.adminApiToken,
};

// GET /api/webhooks — list registered Shopify webhooks
router.get("/webhooks", async (req, res) => {
  try {
    const r = await fetch(`${SHOPIFY_BASE}/webhooks.json`, { headers: SHOPIFY_HEADERS });
    const data = await r.json();
    const webhooks = (data.webhooks || []).map(w => ({
      id: w.id, topic: w.topic, address: w.address, created_at: w.created_at,
    }));
    res.json({ webhooks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/webhooks/register — register all required webhooks
router.post("/webhooks/register", async (req, res) => {
  const backendUrl = req.body.backendUrl || `https://${req.get("host")}`;
  const required = [
    { topic: "orders/create", path: "/webhooks/order-created" },
    { topic: "orders/paid", path: "/webhooks/order-paid" },
  ];

  // Get existing
  const existing = await fetch(`${SHOPIFY_BASE}/webhooks.json`, { headers: SHOPIFY_HEADERS }).then(r => r.json());
  const existingTopics = (existing.webhooks || []).map(w => w.topic);

  const results = [];
  for (const wh of required) {
    if (existingTopics.includes(wh.topic)) {
      results.push({ topic: wh.topic, status: "already_registered" });
      continue;
    }
    try {
      const r = await fetch(`${SHOPIFY_BASE}/webhooks.json`, {
        method: "POST",
        headers: SHOPIFY_HEADERS,
        body: JSON.stringify({ webhook: { topic: wh.topic, address: backendUrl + wh.path, format: "json" } }),
      });
      const data = await r.json();
      results.push({ topic: wh.topic, status: data.webhook ? "registered" : "error", detail: data.errors });
    } catch (e) {
      results.push({ topic: wh.topic, status: "error", detail: e.message });
    }
  }
  res.json({ results });
});

// GET /api/printful/architecture — explain how fulfillment works
router.get("/printful/architecture", (req, res) => {
  res.json({
    model: "API-based fulfillment via FinerWorks product codes",
    flow: [
      "1. Customer places order on Shopify",
      "2. Shopify sends webhook to our backend",
      "3. Backend reads artwork dimensions + image reference from line item properties",
      "4. Backend uses a FinerWorks product code (or builds one from dimensions)",
      "5. Backend submits order to FinerWorks via submit_orders_v2",
    ],
    provider: "FinerWorks API v3",
    why_finerworks: "Supports product-code based ordering for custom artwork workflows without creating inventory per artwork.",
    webhooks_needed: ["orders/create", "orders/paid"],
  });
});

// ── FinerWorks endpoints ───────────────────────────────────────────────────

/**
 * GET /api/finerworks/status
 * Check FinerWorks API connectivity and show provider info.
 */
router.get("/finerworks/status", async (req, res) => {
  try {
    const result = await finerworks.verifyConnection();
    res.json({
      provider: "FinerWorks",
      ...result,
      configured: !!(process.env.FINERWORKS_WEB_API_KEY && process.env.FINERWORKS_APP_KEY),
      testMode: process.env.FINERWORKS_TEST_MODE !== "false",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/finerworks/prices
 * Get a FinerWorks price list for one or more product codes.
 * Body: { productCodes: string[] }
 */
router.post("/finerworks/prices", async (req, res) => {
  try {
    const { productCodes } = req.body;
    if (!Array.isArray(productCodes) || productCodes.length === 0) {
      return res.status(400).json({ error: "productCodes[] is required" });
    }
    const result = await finerworks.getPrices({ productCodes });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/finerworks/product-code
 * Build a default FinerWorks product code from dimensions.
 * Query: ?widthCm=40&heightCm=28.57
 */
router.get("/finerworks/product-code", (req, res) => {
  const widthCm  = parseFloat(req.query.widthCm);
  const heightCm = parseFloat(req.query.heightCm);
  if (!widthCm || !heightCm) {
    return res.status(400).json({ error: "widthCm and heightCm query params required" });
  }
  const productCode = FinerWorksService.buildDefaultProductCode(widthCm, heightCm);
  res.json({
    requested: { widthCm, heightCm },
    productCode,
    note: "Uses archival-matte default code pattern; replace with your curated product codes where needed.",
  });
});

/**
 * GET /api/finerworks/price-compare
 * Side-by-side: our storefront tier price vs FinerWorks base cost for a
 * grid of common print sizes. Lets the client sanity-check margins.
 *
 * Query (optional): ?sizes=8x10,12x18,16x20,18x24,24x36,30x40
 *   sizes are inches (FW product codes use inches).
 */
router.get("/finerworks/price-compare", async (req, res) => {
  try {
    const defaultSizes = ["8x10", "11x14", "12x18", "16x20", "18x24", "20x30", "24x36", "30x40"];
    const sizesParam = (req.query.sizes || "").trim();
    const sizes = sizesParam ? sizesParam.split(",").map((s) => s.trim()) : defaultSizes;

    // Build FW product codes for each size (archival matte: 5M6M9S{min}X{max})
    const codes = sizes.map((s) => {
      const [w, h] = s.split("x").map(Number);
      if (!w || !h) return null;
      const min = Math.min(w, h);
      const max = Math.max(w, h);
      return { size: s, code: `5M6M9S${min}X${max}`, widthIn: w, heightIn: h };
    }).filter(Boolean);

    const fwResp = await finerworks.getPrices({ productCodes: codes.map((c) => c.code) });
    const fwPriceByCode = {};
    (fwResp.prices || fwResp.product_prices || []).forEach((p) => {
      fwPriceByCode[p.product_code || p.product_sku || p.sku] = p;
    });

    const rows = codes.map((c) => {
      const widthCm = +(c.widthIn * 2.54).toFixed(2);
      const heightCm = +(c.heightIn * 2.54).toFixed(2);
      const ourTier = computePriceTier(widthCm, heightCm);
      const fw = fwPriceByCode[c.code] || null;
      const fwBase = fw ? parseFloat(fw.product_price ?? fw.total_price ?? fw.base_price ?? 0) : null;
      const ourPrice = parseFloat(ourTier.price);
      const margin = fwBase != null ? +(ourPrice - fwBase).toFixed(2) : null;
      const marginPct = fwBase != null && ourPrice > 0 ? +((margin / ourPrice) * 100).toFixed(1) : null;

      return {
        size_in: c.size,
        size_cm: `${widthCm} \u00d7 ${heightCm} cm`,
        product_code: c.code,
        media: fw?.debug?.Description?.Media || "Archival Matte Paper",
        our_tier: ourTier.tier,
        our_price_usd: ourPrice,
        compare_at_usd: parseFloat(ourTier.comparePrice),
        finerworks_cost_usd: fwBase,
        margin_usd: margin,
        margin_pct: marginPct,
      };
    });

    res.json({
      generated_at: new Date().toISOString(),
      note: "FinerWorks costs are base print cost only (paper). Add shipping for true COGS.",
      tier_thresholds: {
        small: "area <= 600 cm^2 \u2192 $29.99",
        medium: "area <= 1800 cm^2 \u2192 $49.99",
        large: "area <= 4000 cm^2 \u2192 $79.99",
        extra_large: "area > 4000 cm^2 \u2192 $119.99",
      },
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
