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

const router = express.Router();

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
    const sort = req.query.sort || "newest";
    const search = req.query.q || req.query.search;
    const tag = req.query.tag;

    let query = supabase
      .from("assets")
      .select(
        "id, title, drive_file_id, artist, style, mood, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, width_px, height_px, created_at",
        { count: "exact" }
      )
      .in("ingestion_status", ["ready", "analyzed"])
      .not("drive_file_id", "is", null);

    // Filters
    if (artist) query = query.eq("artist", artist);
    if (style) query = query.eq("style", style);
    if (mood) query = query.eq("mood", mood);
    if (orientation) query = query.eq("ratio_class", orientation);
    if (tag) query = query.contains("tags", [tag]);
    if (search) {
      query = query.or(
        `title.ilike.%${search}%,style.ilike.%${search}%,mood.ilike.%${search}%,artist.ilike.%${search}%`
      );
    }

    // Sort
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
      case "newest":
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }

    // Pagination
    const from = (page - 1) * perPage;
    const to = from + perPage - 1;
    query = query.range(from, to);

    const { data, count, error } = await query;
    if (error) throw error;

    // Compute price tier for each asset
    const items = (data || []).map((a) => {
      const tier = computePriceTier(a.max_print_width_cm, a.max_print_height_cm);
      return {
        id: a.id,
        title: a.title,
        artist: a.artist,
        style: a.style,
        mood: a.mood,
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
        price: tier.price,
        comparePrice: tier.comparePrice,
        maxPrint: `${a.max_print_width_cm || 0} × ${a.max_print_height_cm || 0} cm`,
      };
    });

    // Shuffle if random sort
    if (sort === "random") {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }

    res.set("Cache-Control", "public, max-age=60");
    res.json({
      items,
      total: count || 0,
      page,
      perPage,
      totalPages: Math.ceil((count || 0) / perPage),
      filters: { artist, style, mood, orientation, sort, q: search, tag },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      return res.status(404).json({ error: "Asset not found" });
    }

    const tier = computePriceTier(asset.max_print_width_cm, asset.max_print_height_cm);

    // Build variant options with price tiers
    const variants = (asset.asset_variants || []).map((v) => {
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

    // Load the price map
    let priceMap = {};
    try {
      const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
      priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    } catch (e) {}

    res.set("Cache-Control", "public, max-age=300");
    res.json({
      id: asset.id,
      title: asset.title,
      artist: asset.artist,
      description: asset.description || "",
      style: asset.style,
      mood: asset.mood,
      palette: asset.palette,
      subject: asset.subject,
      orientation: asset.ratio_class,
      quality: asset.quality_tier,
      maxPrint: `${asset.max_print_width_cm || 0} × ${asset.max_print_height_cm || 0} cm`,
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
      priceTier: tier.tier,
      basePrice: tier.price,
      comparePrice: tier.comparePrice,
      variants,
      priceMap,
      tags: asset.tags || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/artists
 * List all artists with counts.
 */
router.get("/storefront/artists", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "200", 10)));

    const { data, error } = await supabase
      .from("assets")
      .select("artist")
      .in("ingestion_status", ["ready", "analyzed"])
      .not("artist", "is", null);

    if (error) throw error;

    const counts = {};
    (data || []).forEach((a) => {
      counts[a.artist] = (counts[a.artist] || 0) + 1;
    });

    const artists = Object.entries(counts)
      .map(([name, count]) => ({ artist: name, name, count }))
      .sort((a, b) => b.count - a.count);

    const limited = limit ? artists.slice(0, limit) : artists;

    res.set("Cache-Control", "public, max-age=3600");
    res.json({ artists: limited, total: artists.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storefront/filters
 * Returns available filter values (styles, moods, orientations).
 */
router.get("/storefront/filters", async (req, res) => {
  try {
    // Fetch distinct values in parallel
    const [stylesRes, moodsRes, orientRes] = await Promise.all([
      supabase.from("assets").select("style").in("ingestion_status", ["ready", "analyzed"]).not("style", "is", null),
      supabase.from("assets").select("mood").in("ingestion_status", ["ready", "analyzed"]).not("mood", "is", null),
      supabase.from("assets").select("ratio_class").in("ingestion_status", ["ready", "analyzed"]).not("ratio_class", "is", null),
    ]);

    const unique = (data, key) => {
      const counts = {};
      (data || []).forEach((r) => {
        counts[r[key]] = (counts[r[key]] || 0) + 1;
      });
      return Object.entries(counts)
        .map(([val, count]) => ({ value: val, count }))
        .sort((a, b) => b.count - a.count);
    };

    res.set("Cache-Control", "public, max-age=3600");
    res.json({
      styles: unique(stylesRes.data, "style"),
      moods: unique(moodsRes.data, "mood"),
      orientations: unique(orientRes.data, "ratio_class"),
      priceTiers: [
        { tier: "small", label: "Small (≤24×17cm)", price: "$29.99", framedPrice: "$39.99" },
        { tier: "medium", label: "Medium (≤42×30cm)", price: "$49.99", framedPrice: "$64.99" },
        { tier: "large", label: "Large (≤63×45cm)", price: "$79.99", framedPrice: "$99.99" },
        { tier: "extra_large", label: "Extra Large (>63×45cm)", price: "$119.99", framedPrice: "$149.99" },
      ],
    });
  } catch (err) {
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
              price: t.price,
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
    let query = supabase
      .from("assets")
      .select("id, title, drive_file_id, artist, style, mood, ratio_class, max_print_width_cm, max_print_height_cm")
      .neq("id", req.params.assetId)
      .in("ingestion_status", ["ready", "analyzed"]);

    if (asset.style) query = query.eq("style", asset.style);

    const { data: similar } = await query.limit(limit * 3);

    const scored = (similar || []).map((s) => {
      let score = 0;
      if (s.style === asset.style) score += 3;
      if (s.mood === asset.mood) score += 2;
      if (s.ratio_class === asset.ratio_class) score += 1;
      if (s.artist !== asset.artist) score += 1;
      return { ...s, _score: score };
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
        price: t.price,
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
  if (area <= 600) return { tier: "small", price: "29.99", comparePrice: "39.99" };
  if (area <= 1800) return { tier: "medium", price: "49.99", comparePrice: "64.99" };
  if (area <= 4000) return { tier: "large", price: "79.99", comparePrice: "99.99" };
  return { tier: "extra_large", price: "119.99", comparePrice: "149.99" };
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
      variants: (asset.asset_variants || []).map(v => ({
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
                price: t.price,
              };
            }),
            method: "vector",
          });
        }
      } catch (e) {
        console.warn("Vector search failed, falling back:", e.message);
      }
    }

    // Fallback: ILIKE text search — no longer requires shopify_product_id
    const { data: results } = await supabase
      .from("assets")
      .select("id, title, drive_file_id, artist, style, mood, max_print_width_cm, max_print_height_cm")
      .in("ingestion_status", ["ready", "analyzed"])
      .not("drive_file_id", "is", null)
      .or(`title.ilike.%${query}%,style.ilike.%${query}%,mood.ilike.%${query}%,artist.ilike.%${query}%`)
      .limit(limit);

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
          price: t.price,
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
  const checks = { server: "ok", supabase: "unknown", drive: "unknown" };

  try {
    const { count } = await supabase.from("assets").select("*", { count: "exact", head: true });
    checks.supabase = "ok";
    checks.assetCount = count;
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

module.exports = router;
