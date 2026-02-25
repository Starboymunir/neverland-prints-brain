/**
 * Neverland Prints — AI Tag Enricher
 * ====================================
 * Uses OpenAI GPT-4o-mini to classify every asset with rich SEO tags.
 * Fills: style, mood, subject, era, palette, ai_tags
 *
 * This data powers:
 *   - Smart collections (by style, mood, subject, era)
 *   - SEO product tags on Shopify
 *   - Faceted search/filters on storefront
 *
 * Batches 50 assets per API call for efficiency.
 *
 * Usage:
 *   node src/scripts/enrich-tags.js                  # process all untagged
 *   node src/scripts/enrich-tags.js --limit=500      # partial run
 *   node src/scripts/enrich-tags.js --force           # re-tag everything
 *   node src/scripts/enrich-tags.js --update-shopify  # also push tags to Shopify
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "0", 10);
const FORCE = hasFlag("force");
const UPDATE_SHOPIFY = hasFlag("update-shopify");
const BATCH_SIZE = 50;        // items per OpenAI call
const CONCURRENCY = 20;       // parallel API calls
const DB_CONCURRENCY = 50;    // parallel Supabase updates

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Valid values for structured classification ───────────
const STYLES = [
  "Impressionism", "Post-Impressionism", "Realism", "Romanticism",
  "Baroque", "Renaissance", "Art Nouveau", "Art Deco", "Expressionism",
  "Abstract", "Cubism", "Surrealism", "Symbolism", "Minimalism",
  "Ukiyo-e", "Folk Art", "Gothic", "Neoclassicism", "Rococo",
  "Fauvism", "Pointillism", "Modernism", "Naturalism", "Academic Art",
  "Pre-Raphaelite", "Orientalism", "Hudson River School",
  "Constructivism", "Pop Art", "Naive Art", "Mannerism",
  "Tonalism", "Luminism", "Illustration", "Sketch", "Drawing",
  "Watercolor", "Engraving", "Lithograph", "Photography",
  "Mixed Media", "Other"
];

const MOODS = [
  "Serene", "Dramatic", "Melancholic", "Joyful", "Mysterious",
  "Romantic", "Dark", "Whimsical", "Contemplative", "Vibrant",
  "Peaceful", "Somber", "Ethereal", "Nostalgic", "Powerful",
  "Playful", "Elegant", "Raw", "Spiritual", "Warm"
];

const SUBJECTS = [
  "Landscape", "Portrait", "Still Life", "Seascape", "Cityscape",
  "Abstract", "Mythology", "Religious", "Historical", "Botanical",
  "Animal", "Figure Study", "Interior", "Architecture", "Battle Scene",
  "Genre Scene", "Allegory", "Self-Portrait", "Nude", "Fantasy",
  "Nature", "Maritime", "Rural Life", "Court Life", "Street Scene",
  "Garden", "Winter Scene", "Night Scene", "Celestial", "Map",
  "Fashion", "Children", "Dance", "Music", "Literature",
  "Science", "Travel", "Food & Drink", "Geometric", "Typography",
  "Decorative", "Textile", "Pattern", "Satirical", "Political"
];

const ERAS = [
  "Ancient", "Medieval", "15th Century", "16th Century",
  "17th Century", "18th Century", "Early 19th Century",
  "Late 19th Century", "Early 20th Century", "Mid 20th Century",
  "Late 20th Century", "Contemporary", "Unknown"
];

const PALETTES = [
  "Warm Earth Tones", "Cool Blues", "Vibrant Multi-Color", "Muted Pastels",
  "Monochrome", "Gold & Ochre", "Dark & Moody", "Light & Airy",
  "Rich Jewel Tones", "Black & White", "Sepia", "Green & Natural",
  "Red & Crimson", "Blue & White", "Sunset Colors", "Neutral Tones"
];

// ── Prompt ───────────────────────────────────────────────
function buildPrompt(assets) {
  const items = assets.map((a, i) => 
    `${i}: "${a.title}" by ${a.artist || "Unknown"}${a.description ? ` — ${a.description.slice(0, 100)}` : ""}`
  ).join("\n");

  return `Classify each artwork for an art print e-commerce store. For each numbered item, return a JSON object with:
- "style": one of [${STYLES.slice(0, 20).map(s => `"${s}"`).join(", ")}, ...]
- "mood": one of [${MOODS.slice(0, 10).map(s => `"${s}"`).join(", ")}, ...]  
- "subject": one of [${SUBJECTS.slice(0, 20).map(s => `"${s}"`).join(", ")}, ...]
- "era": one of [${ERAS.map(s => `"${s}"`).join(", ")}]
- "palette": one of [${PALETTES.slice(0, 8).map(s => `"${s}"`).join(", ")}, ...]
- "tags": array of 8-15 specific SEO keywords (room types like "living room wall art", descriptive terms like "moody landscape painting", gift ideas like "gift for art lover", specific descriptors). Be specific and varied — NOT generic.

Return a JSON array of objects, one per artwork, same order.

Artworks:
${items}`;
}

// ── Process a batch ──────────────────────────────────────
async function processBatch(assets, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an art historian and SEO expert. Classify artworks accurately. Return valid JSON only." },
          { role: "user", content: buildPrompt(assets) },
        ],
        temperature: 0.3,
        max_tokens: 16000,
        response_format: { type: "json_object" },
      });

      const text = response.choices[0].message.content;
      let parsed = JSON.parse(text);
      
      // Handle wrapper objects
      if (parsed.results) parsed = parsed.results;
      if (parsed.artworks) parsed = parsed.artworks;
      if (parsed.classifications) parsed = parsed.classifications;
      if (!Array.isArray(parsed)) {
        // Try to find the array in the object
        const arr = Object.values(parsed).find(v => Array.isArray(v));
        if (arr) parsed = arr;
        else throw new Error("Response is not an array");
      }

      return parsed;
    } catch (err) {
      if (attempt < retries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

// ── Update Shopify tags ──────────────────────────────────
async function updateShopifyTags(asset, tags) {
  if (!asset.shopify_product_id) return;
  
  const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const API_VER = process.env.SHOPIFY_API_VERSION || "2024-10";
  
  const tagStr = tags.join(", ");
  
  const res = await fetch(
    `https://${SHOP}/admin/api/${API_VER}/products/${asset.shopify_product_id}.json`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({ product: { id: parseInt(asset.shopify_product_id), tags: tagStr } }),
    }
  );
  
  if (res.status === 429) {
    await sleep(2000);
    return updateShopifyTags(asset, tags);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify PUT ${res.status}: ${txt.slice(0, 150)}`);
  }
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🏷️  NEVERLAND PRINTS — AI Tag Enricher");
  console.log("═".repeat(60));

  // Count untagged
  let query = supabase.from("assets").select("id", { count: "exact", head: true });
  if (!FORCE) {
    query = query.is("style", null);
  }
  const { count: pending } = await query;
  
  const total = LIMIT > 0 ? Math.min(LIMIT, pending) : pending;
  const batches = Math.ceil(total / BATCH_SIZE);
  
  console.log(`  📦 ${pending} assets need tags | Processing: ${total}`);
  console.log(`  🔄 ${batches} batches × ${BATCH_SIZE} | Concurrency: ${CONCURRENCY}`);
  console.log(`  🏷️  Update Shopify: ${UPDATE_SHOPIFY ? "YES" : "NO"}`);
  console.log("═".repeat(60) + "\n");

  if (pending === 0) {
    console.log("✅ All assets already tagged!");
    return;
  }

  const t0 = Date.now();
  let tagged = 0;
  let errors = 0;
  let shopifyUpdated = 0;
  let offset = 0;

  while (tagged + errors < total) {
    const fetchSize = Math.min(BATCH_SIZE * CONCURRENCY, total - tagged - errors);
    
    // Fetch batch
    let fetchQuery = supabase
      .from("assets")
      .select("id, title, artist, description, shopify_product_id, ratio_class, quality_tier")
      .order("id")
      .range(offset, offset + fetchSize - 1);
    
    if (!FORCE) {
      fetchQuery = fetchQuery.is("style", null);
    }
    
    const { data: assets, error } = await fetchQuery;
    if (error) throw error;
    if (!assets?.length) break;

    // Split into batches of BATCH_SIZE and process concurrently
    const chunks = [];
    for (let i = 0; i < assets.length; i += BATCH_SIZE) {
      chunks.push(assets.slice(i, i + BATCH_SIZE));
    }

    // Process all chunks concurrently via OpenAI, collect updates
    const allUpdates = [];
    const apiPromises = chunks.map(async (chunk, ci) => {
      try {
        const results = await processBatch(chunk);
        for (let i = 0; i < Math.min(results.length, chunk.length); i++) {
          allUpdates.push({ asset: chunk[i], result: results[i] });
        }
      } catch (err) {
        errors += chunk.length;
        console.error(`   ❌ Chunk ${ci} (${chunk.length} items): ${err.message.slice(0, 200)}`);
      }
    });
    await Promise.all(apiPromises);

    // Batch DB writes via upsert (much faster than individual updates)
    const UPSERT_BATCH = 500;
    for (let u = 0; u < allUpdates.length; u += UPSERT_BATCH) {
      const slice = allUpdates.slice(u, u + UPSERT_BATCH);
      const rows = slice.map(({ asset, result: r }) => ({
        id: asset.id,
        style: r.style || null,
        mood: r.mood || null,
        subject: r.subject || null,
        era: r.era || null,
        palette: r.palette || null,
        ai_tags: r.tags || [],
      }));

      const { error: uErr } = await supabase.from("assets").upsert(rows, { onConflict: "id" });
      if (uErr) {
        errors += slice.length;
        console.error(`   ⚠️  DB batch: ${uErr.message.slice(0, 120)}`);
      } else {
        tagged += slice.length;
      }
    }

    // Optionally push tags to Shopify
    if (UPDATE_SHOPIFY) {
      const shopifyQueue = allUpdates.filter(u => u.asset.shopify_product_id);
      for (const { asset, result: r } of shopifyQueue) {
        const allTags = [
          asset.ratio_class?.replace(/_/g, " "),
          asset.quality_tier === "high" ? "museum grade" : "gallery grade",
          r.style, r.mood, r.subject, r.palette,
          "art print", "fine art", "wall art",
          ...(r.tags || []),
        ].filter(Boolean);
        try {
          await updateShopifyTags(asset, allTags);
          shopifyUpdated++;
        } catch (e) {
          if (shopifyUpdated < 10) console.error(`   ⚠️  Shopify: ${e.message.slice(0, 80)}`);
        }
        await sleep(300);
      }
    }

    if (!FORCE) {
      // Don't increment offset for non-force mode — query always fetches untagged
      // offset stays at 0
    } else {
      offset += fetchSize;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const rate = (tagged / (elapsed || 1)).toFixed(1);
    const pct = ((tagged + errors) / total * 100).toFixed(1);
    console.log(
      `   🏷️  ${tagged + errors}/${total} | ${tagged} tagged | ${errors} err | ` +
      `${pct}% | ${rate}/s | ${elapsed}s` +
      (UPDATE_SHOPIFY ? ` | ${shopifyUpdated} Shopify` : "")
    );

    if (errors > 500 && errors > tagged) {
      console.error("\n💥 Too many errors — aborting.");
      process.exit(1);
    }
  }

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "═".repeat(60));
  console.log(`✅ Tag enrichment complete!`);
  console.log(`   Tagged: ${tagged} | Errors: ${errors} | Time: ${totalTime}s`);
  if (UPDATE_SHOPIFY) console.log(`   Shopify tags updated: ${shopifyUpdated}`);
  console.log("═".repeat(60) + "\n");
}

main().catch(e => { console.error("💥", e); process.exit(1); });
