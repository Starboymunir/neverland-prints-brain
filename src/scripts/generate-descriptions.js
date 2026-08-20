/**
 * Neverland Prints — AI Description Generator (OpenAI)
 * =====================================================
 * Generates unique AI descriptions for all products using GPT-4o-mini.
 *
 * Strategy: BATCHED text-only prompts (50 products per API call)
 *   - Reduces 101k individual calls to ~2,020 batch calls
 *   - GPT-4o-mini: ~$2-3 for 101k products
 *   - High concurrency (10 parallel requests) = very fast
 *
 * Pipeline:
 *   Phase 1: GPT-4o-mini generates descriptions → stored in Supabase
 *   Phase 2: Rich HTML built and pushed to Shopify products
 *
 * Usage:
 *   node src/scripts/generate-descriptions.js                    # full run
 *   node src/scripts/generate-descriptions.js --limit=100        # test batch
 *   node src/scripts/generate-descriptions.js --shopify-only     # skip AI, just update Shopify HTML
 *   node src/scripts/generate-descriptions.js --gemini-only      # skip Shopify, just generate descriptions
 *   node src/scripts/generate-descriptions.js --batch-size=30    # custom batch size
 *   node src/scripts/generate-descriptions.js --concurrency=5    # AI request concurrency
 */

require("dotenv").config();
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

// Catch unhandled errors
process.on("unhandledRejection", (err) => { console.error("Unhandled rejection:", err); process.exit(1); });
process.on("uncaughtException", (err) => { console.error("Uncaught exception:", err); process.exit(1); });

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "0", 10); // 0 = all
const BATCH_SIZE = parseInt(getArg("batch-size") || "50", 10);
const AI_CONCURRENCY = parseInt(getArg("concurrency") || "10", 10);
const SHOPIFY_CONCURRENCY = parseInt(getArg("shopify-concurrency") || "8", 10);
const SHOPIFY_ONLY = hasFlag("shopify-only");
const GEMINI_ONLY = hasFlag("gemini-only"); // kept for CLI compat, means "AI only"
const DRY_RUN = hasFlag("dry-run");

// ── Services ──────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── AI Setup ──────────────────────────────────────────────
// Descriptions are a text-only task, so DeepSeek (OpenAI-compatible, much
// cheaper) is used when DEEPSEEK_API_KEY is set; otherwise fall back to OpenAI.
// NOTE: image TAGGING stays on Gemini — DeepSeek has no vision model.
let openai = null;
let AI_MODEL = "gpt-4o-mini";

function initOpenAI() {
  if (process.env.DEEPSEEK_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com" });
    AI_MODEL = "deepseek-chat";
    console.log("✅ DeepSeek (deepseek-chat) initialized — cheaper text generation");
  } else if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    AI_MODEL = "gpt-4o-mini";
    console.log("✅ OpenAI GPT-4o-mini initialized");
  } else {
    throw new Error("Set DEEPSEEK_API_KEY (preferred, cheaper) or OPENAI_API_KEY in .env");
  }
}

// ── Batch Description Generator ───────────────────────────
const SYSTEM_PROMPT = `You write short, vivid product descriptions for "Neverland Prints", a fine-art print store. Each artwork comes with real details (subject, style, mood, era, colors, tags) pulled from the actual image — USE them so every description is specific to THAT piece, never generic filler.

RULES:
- ONE sentence, 90–150 characters. Concrete and specific.
- Lead with what is actually depicted (the scene/subject), then one feeling or a color/light detail.
- Write for someone choosing art for their wall — help them picture it in a room.
- Every description must be distinct — none should be swappable with another.
- Do NOT mention printing, paper, frames, shipping, the title, or the artist's name.
- If details are sparse, infer concretely from the title/subject — stay specific, never vague.
- BANNED (never use these empty phrases): "mesmerizing", "interplay of light and color", "evokes", "captivating", "essence", "meditation on", "dignified", "sublime", "ethereal", "timeless", "invites contemplation", "sense of", "masterful", "striking representation", "rich narrative", "warm earth tones".

Return ONLY JSON: {"items":[{"i":<1-based index>,"d":"<one sentence>"}]}
Example: {"items":[{"i":1,"d":"Snow blankets a quiet monastery courtyard at dusk, its stone walls glowing faint blue as a lone procession files through the gate."}]}`;

/**
 * Generate descriptions for a batch of products via GPT-4o-mini.
 * @param {Array} batch - array of {title, artist} objects
 * @returns {Map<number, string>} - map of 0-based idx → description
 */
async function generateBatch(batch, retries = 3) {
  const artworkList = batch
    .map((b, i) => {
      const bits = [];
      if (b.subject) bits.push(`subject: ${b.subject}`);
      if (b.style) bits.push(`style: ${b.style}`);
      if (b.mood) bits.push(`mood: ${b.mood}`);
      if (b.era) bits.push(`era: ${b.era}`);
      if (b.palette) bits.push(`colors: ${Array.isArray(b.palette) ? b.palette.join(", ") : b.palette}`);
      if (Array.isArray(b.tags) && b.tags.length) bits.push(`tags: ${b.tags.slice(0, 6).join(", ")}`);
      const detail = bits.length ? `  [${bits.join("; ")}]` : "";
      return `${i + 1}. "${b.title}" by ${b.artist}${detail}`;
    })
    .join("\n");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: artworkList },
        ],
        temperature: 0.7,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      });

      const text = response.choices[0]?.message?.content?.trim() || "";

      // Parse JSON response
      let parsed;
      try {
        const obj = JSON.parse(text);
        // Handle: {"items": [...]}, {"descriptions": [...]}, or direct array
        parsed = obj.items || obj.descriptions || obj.results || obj.data || (Array.isArray(obj) ? obj : Object.values(obj).find(v => Array.isArray(v)) || []);
      } catch {
        const cleaned = text
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        const obj = JSON.parse(cleaned);
        parsed = obj.items || obj.descriptions || obj.results || (Array.isArray(obj) ? obj : Object.values(obj).find(v => Array.isArray(v)) || []);
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`Invalid response format: ${text.slice(0, 100)}`);
      }

      // Map results back to batch indices
      const results = new Map();
      for (const item of parsed) {
        const idx = (item.i || item.idx || item.index) - 1; // Convert 1-based to 0-based
        const desc = item.d || item.desc || item.description || "";
        if (idx >= 0 && idx < batch.length && desc) {
          results.set(idx, desc.slice(0, 300)); // Cap at 300 chars
        }
      }

      return results;
    } catch (err) {
      const isRateLimit = err.status === 429 || err.message?.includes("429") || err.message?.includes("rate");
      if (isRateLimit) {
        const waitTime = Math.min(attempt * 10, 60);
        console.log(`   ⏳ Rate limited — waiting ${waitTime}s (attempt ${attempt}/${retries})`);
        await sleep(waitTime * 1000);
        continue;
      }
      if (attempt < retries) {
        console.log(`   ⚠️ OpenAI error (attempt ${attempt}): ${(err.message || "").slice(0, 80)} — retrying...`);
        await sleep(2000 * attempt);
        continue;
      }
      console.error(`   ❌ Batch failed after ${retries} attempts: ${(err.message || "").slice(0, 100)}`);
      return new Map();
    }
  }
  return new Map();
}

// ── Shopify API Helper ────────────────────────────────────
async function shopifyUpdate(productId, bodyHtml, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}/products/${productId}.json`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": TOKEN,
        },
        body: JSON.stringify({ product: { id: productId, body_html: bodyHtml } }),
      });

      if (res.status === 429) {
        const wait = parseFloat(res.headers.get("Retry-After") || "2");
        await sleep(wait * 1000);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`);
      }

      return true;
    } catch (err) {
      if (attempt < retries) {
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
  return false;
}

// ── Build Rich HTML Description ───────────────────────────
function buildProductHtml(asset, variants = []) {
  const artistName = asset.artist || "Unknown Artist";
  const aiDesc = asset.description || "";

  // Size list
  const sizes = variants.length > 0
    ? variants.map(v => `${v.label}: ${v.width_cm}×${v.height_cm} cm`).join(" · ")
    : "";

  // Quality tier text
  const qualityText = asset.quality_tier === "high"
    ? "museum-quality"
    : "gallery-quality";

  let html = `<div class="np-description">`;

  // AI-generated curator note (unique per product)
  if (aiDesc) {
    html += `<p class="np-curator">${aiDesc}</p>`;
  }

  // Print quality section
  html += `<p>This ${qualityText} giclée reproduction by <strong>${artistName}</strong> is printed on premium 310gsm cotton-rag archival paper using 12-colour pigment-based inks rated for 200+ years of lightfastness.</p>`;

  // Available sizes
  if (sizes) {
    html += `<p><strong>Available sizes:</strong> ${sizes}</p>`;
  }

  // Trust signals
  html += `<ul class="np-features">`;
  html += `<li>🎨 Museum-grade archival paper (310gsm cotton rag)</li>`;
  html += `<li>🖨️ 12-colour giclée pigment inks</li>`;
  html += `<li>⏳ 200+ year lightfastness rating</li>`;
  html += `<li>📦 Ships flat in rigid protective packaging</li>`;
  html += `<li>🔄 30-day satisfaction guarantee</li>`;
  html += `</ul>`;

  html += `</div>`;
  return html;
}

// ── Concurrency limiter ───────────────────────────────────
function createPool(concurrency) {
  const queue = [];
  let running = 0;

  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      drain();
    });
  };

  function drain() {
    while (running < concurrency && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      running++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => { running--; drain(); });
    }
  }
}

// ══════════════════════════════════════════════════════════
// PHASE 1: Generate AI Descriptions via OpenAI
// ══════════════════════════════════════════════════════════
async function phase1_generateDescriptions() {
  console.log("\n" + "═".repeat(60));
  console.log("🤖 PHASE 1: Generating AI Descriptions (GPT-4o-mini)");
  console.log("═".repeat(60));

  initOpenAI();

  // Fetch assets without descriptions (cursor-based pagination for large datasets)
  console.log("\n📦 Fetching assets without descriptions...");

  let allAssets = [];
  let lastId = null;
  const PAGE_SIZE = 1000;

  while (true) {
    let query = supabase
      .from("assets")
      .select("id, title, artist, quality_tier, ratio_class, subject, style, mood, era, palette, ai_tags")
      .or("description.is.null,description.eq.")
      .order("id")
      .limit(PAGE_SIZE);

    if (lastId) {
      query = query.gt("id", lastId);
    }

    const { data, error } = await query;

    if (error) throw error;
    if (!data || data.length === 0) break;

    allAssets.push(...data);
    lastId = data[data.length - 1].id;

    if (allAssets.length % 10000 === 0) {
      console.log(`   ... fetched ${allAssets.length} so far`);
    }

    if (data.length < PAGE_SIZE) break;
    if (LIMIT > 0 && allAssets.length >= LIMIT) {
      allAssets = allAssets.slice(0, LIMIT);
      break;
    }
  }

  if (LIMIT > 0 && allAssets.length > LIMIT) {
    allAssets = allAssets.slice(0, LIMIT);
  }

  console.log(`   Found ${allAssets.length} assets needing descriptions`);

  if (allAssets.length === 0) {
    console.log("   ✅ All assets already have descriptions!");
    return;
  }

  if (DRY_RUN) {
    console.log("\n🏃 DRY RUN — would generate descriptions for:");
    allAssets.slice(0, 10).forEach(a => console.log(`   "${a.title}" by ${a.artist}`));
    if (allAssets.length > 10) console.log(`   ... and ${allAssets.length - 10} more`);
    return;
  }

  // Split into batches
  const batches = [];
  for (let i = 0; i < allAssets.length; i += BATCH_SIZE) {
    batches.push(allAssets.slice(i, i + BATCH_SIZE));
  }

  const estTokensIn = allAssets.length * 40;
  const estTokensOut = allAssets.length * 40;
  const estCost = ((estTokensIn * 0.15 + estTokensOut * 0.6) / 1_000_000).toFixed(2);

  console.log(`   Batches: ${batches.length} (${BATCH_SIZE} products each)`);
  console.log(`   Concurrency: ${AI_CONCURRENCY} parallel requests`);
  console.log(`   Est. cost: ~$${estCost} (GPT-4o-mini)`);
  console.log(`   Est. time: ~${Math.ceil(batches.length / AI_CONCURRENCY / 60 * 3)} min\n`);

  let totalGenerated = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  // Process batches with concurrency pool
  const pool = createPool(AI_CONCURRENCY);
  const batchPromises = batches.map((batch, batchIdx) =>
    pool(async () => {
      // Prepare batch data
      const batchData = batch.map((asset) => ({
        title: asset.title || "Untitled",
        artist: asset.artist || "Unknown Artist",
        subject: asset.subject,
        style: asset.style,
        mood: asset.mood,
        era: asset.era,
        palette: asset.palette,
        tags: asset.ai_tags,
      }));

      // Generate descriptions
      const results = await generateBatch(batchData);

      // Update Supabase
      let batchGenerated = 0;
      const updates = [];

      for (let i = 0; i < batch.length; i++) {
        const desc = results.get(i);
        if (desc) {
          updates.push({ id: batch[i].id, description: desc });
          batchGenerated++;
        }
      }

      // Batch update Supabase (individual updates since upsert requires full row)
      if (updates.length > 0) {
        const updatePromises = updates.map(u =>
          supabase.from("assets").update({ description: u.description }).eq("id", u.id)
        );
        const results = await Promise.all(updatePromises);
        const errs = results.filter(r => r.error);
        if (errs.length > 0) console.error(`   ❌ Supabase: ${errs.length} update errors`);
      }

      totalGenerated += batchGenerated;
      totalFailed += batch.length - batchGenerated;

      // Progress every 10 batches
      if ((batchIdx + 1) % 10 === 0 || batchIdx === batches.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = (((batchIdx + 1) / batches.length) * 100).toFixed(1);
        const rate = (totalGenerated / (elapsed || 1)).toFixed(1);
        console.log(
          `   📝 Batch ${batchIdx + 1}/${batches.length} | ` +
          `${totalGenerated} generated | ${totalFailed} failed | ` +
          `${pct}% | ${rate}/s | ${elapsed}s`
        );
      }
    })
  );

  await Promise.all(batchPromises);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n   ✅ Phase 1 complete: ${totalGenerated} descriptions in ${totalTime}s`);
  if (totalFailed > 0) console.log(`   ⚠️ ${totalFailed} failed — re-run to retry`);
}

// ══════════════════════════════════════════════════════════
// PHASE 2: Update Shopify Product HTML
// ══════════════════════════════════════════════════════════
async function phase2_updateShopify() {
  console.log("\n" + "═".repeat(60));
  console.log("🛍️  PHASE 2: Updating Shopify Product Descriptions");
  console.log("═".repeat(60));

  // Fetch all synced assets with descriptions (cursor-based pagination)
  console.log("\n📦 Fetching synced products with descriptions...");

  let assets = [];
  let lastId = null;
  const PAGE_SIZE = 1000;

  while (true) {
    let query = supabase
      .from("assets")
      .select("id, title, artist, description, quality_tier, ratio_class, shopify_product_id")
      .eq("shopify_status", "synced")
      .not("shopify_product_id", "is", null)
      .not("description", "is", null)
      .neq("description", "")
      .order("id")
      .limit(PAGE_SIZE);

    if (lastId) {
      query = query.gt("id", lastId);
    }

    const { data, error } = await query;

    if (error) throw error;
    if (!data || data.length === 0) break;

    assets.push(...data);
    lastId = data[data.length - 1].id;

    if (data.length < PAGE_SIZE) break;
    if (LIMIT > 0 && assets.length >= LIMIT) {
      assets = assets.slice(0, LIMIT);
      break;
    }
  }

  console.log(`   Found ${assets.length} products to update on Shopify`);

  if (assets.length === 0) {
    console.log("   ⚠️ No products with descriptions ready for Shopify update");
    return;
  }

  if (DRY_RUN) {
    const sample = assets[0];
    const html = buildProductHtml(sample);
    console.log("\n🏃 DRY RUN — sample HTML:\n" + html);
    return;
  }

  // Fetch variants for all assets
  console.log("   Loading variant data...");
  const assetIds = assets.map(a => a.id);
  const variantsMap = new Map();

  for (let i = 0; i < assetIds.length; i += 500) {
    const chunk = assetIds.slice(i, i + 500);
    const { data: variants } = await supabase
      .from("asset_variants")
      .select("asset_id, label, width_cm, height_cm")
      .in("asset_id", chunk)
      .order("width_cm", { ascending: true });

    if (variants) {
      for (const v of variants) {
        if (!variantsMap.has(v.asset_id)) variantsMap.set(v.asset_id, []);
        variantsMap.get(v.asset_id).push(v);
      }
    }
  }

  console.log(`   Loaded variants for ${variantsMap.size} products\n`);

  // Update Shopify products with concurrency pool
  let updated = 0;
  let errors = 0;
  const startTime = Date.now();
  const pool = createPool(SHOPIFY_CONCURRENCY);

  const updatePromises = assets.map((asset) =>
    pool(async () => {
      const variants = variantsMap.get(asset.id) || [];
      const html = buildProductHtml(asset, variants);

      try {
        await shopifyUpdate(asset.shopify_product_id, html);
        updated++;
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.error(`   ❌ Product ${asset.shopify_product_id}: ${(err.message || "").slice(0, 80)}`);
        }
      }

      // Progress every 500
      if ((updated + errors) % 500 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (updated / (elapsed || 1)).toFixed(1);
        const pct = (((updated + errors) / assets.length) * 100).toFixed(1);
        console.log(
          `   🛍️  ${updated} updated | ${errors} errors | ${pct}% | ${rate}/s | ${elapsed}s`
        );
      }
    })
  );

  await Promise.all(updatePromises);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n   ✅ Phase 2 complete: ${updated} Shopify products updated in ${totalTime}s`);
  if (errors > 0) console.log(`   ⚠️ ${errors} errors — re-run to retry`);
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🎨 NEVERLAND PRINTS — AI Description Generator");
  console.log("═".repeat(60));
  console.log(`  Engine: OpenAI GPT-4o-mini`);
  console.log(`  Batch size: ${BATCH_SIZE} | AI concurrency: ${AI_CONCURRENCY}`);
  console.log(`  Shopify concurrency: ${SHOPIFY_CONCURRENCY}`);
  console.log(`  Limit: ${LIMIT || "ALL"} | Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log("═".repeat(60));

  const overallStart = Date.now();

  if (!SHOPIFY_ONLY) {
    await phase1_generateDescriptions();
  }

  if (!GEMINI_ONLY) {
    await phase2_updateShopify();
  }

  const totalTime = ((Date.now() - overallStart) / 1000 / 60).toFixed(1);
  console.log("\n" + "═".repeat(60));
  console.log(`🏁 ALL DONE in ${totalTime} minutes`);
  console.log("═".repeat(60) + "\n");
}

main().catch(err => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
