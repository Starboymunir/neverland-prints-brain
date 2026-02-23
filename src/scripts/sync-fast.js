/**
 * Neverland Prints — FAST Shopify Sync (REST + Concurrency)
 * ==========================================================
 * Creates Shopify products for all unsynced assets using REST API
 * with intelligent rate-limit tracking for maximum throughput.
 *
 * Key optimizations:
 *   - Variants computed on-the-fly (no DB lookup)
 *   - Concurrent requests with leaky-bucket rate tracking
 *   - Batch Supabase updates
 *   - Auto-resume on restart (only syncs assets without shopify_product_id)
 *
 * Usage:
 *   node src/scripts/sync-fast.js                    # sync all pending
 *   node src/scripts/sync-fast.js --limit=100        # test batch
 *   node src/scripts/sync-fast.js --concurrency=3    # adjust concurrency
 *   node src/scripts/sync-fast.js --dry-run          # preview only
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { analyzeArtwork } = require("../services/resolution-engine");
const config = require("../config");

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "0", 10);
const CONCURRENCY = parseInt(getArg("concurrency") || "3", 10);
const DRY_RUN = hasFlag("dry-run");
const SUPABASE_BATCH = 100;

// ── Services ──────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Rate limiter (leaky bucket tracker) ───────────────────
let bucketUsed = 0;
let bucketMax = 40;
let lastRequestTime = Date.now();

async function waitForBucket() {
  // Estimate bucket drain since last request
  const now = Date.now();
  const elapsed = (now - lastRequestTime) / 1000;
  bucketUsed = Math.max(0, bucketUsed - elapsed * 2); // 2 req/s drain

  // If bucket is nearly full, wait
  while (bucketUsed >= bucketMax - CONCURRENCY) {
    await sleep(500);
    const now2 = Date.now();
    const elapsed2 = (now2 - lastRequestTime) / 1000;
    bucketUsed = Math.max(0, bucketUsed - elapsed2 * 2);
  }

  bucketUsed++;
  lastRequestTime = Date.now();
}

// ── Shopify REST helper ──────────────────────────────────
async function shopifyPost(endpoint, body, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await waitForBucket();

    try {
      const res = await fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": TOKEN,
        },
        body: JSON.stringify(body),
      });

      // Update rate limit from response header
      const callLimit = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
      if (callLimit) {
        const [used, max] = callLimit.split("/").map(Number);
        bucketUsed = used;
        bucketMax = max;
      }

      if (res.status === 429) {
        const wait = parseFloat(res.headers.get("Retry-After") || "4");
        bucketUsed = bucketMax; // Mark bucket as full
        if (attempt < retries) {
          await sleep(wait * 1000 + 1000);
          continue;
        }
        throw new Error(`Rate limited after ${retries} attempts`);
      }

      if ((res.status === 502 || res.status === 503) && attempt < retries) {
        await sleep(2000 * attempt);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt < retries && (err.message.includes("ECONNRESET") || err.message.includes("fetch failed") || err.message.includes("ETIMEDOUT"))) {
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`shopifyPost failed after ${retries} attempts`);
}

// ── Pricing ──────────────────────────────────────────────
function price(widthCm, heightCm) {
  const area = widthCm * heightCm;
  if (area <= 600) return "29.99";
  if (area <= 1800) return "49.99";
  if (area <= 4000) return "79.99";
  return "119.99";
}
function comparePrice(widthCm, heightCm) {
  const area = widthCm * heightCm;
  if (area <= 600) return "39.99";
  if (area <= 1800) return "64.99";
  if (area <= 4000) return "99.99";
  return "149.99";
}

// ── Build Product Payload ────────────────────────────────
function buildProduct(asset) {
  const title = asset.title || "Untitled";
  const artistName = asset.artist || "Unknown Artist";

  // Compute variants on-the-fly from dimensions
  let variants = [];
  if (asset.width_px && asset.height_px) {
    const analysis = analyzeArtwork(asset.width_px, asset.height_px);
    variants = analysis.variants || [];
  }
  if (variants.length === 0) {
    variants = [{ label: "Standard", width_cm: 30, height_cm: 40 }];
  }

  const shopVariants = variants.map(v => ({
    option1: `${v.label} — ${v.width_cm}×${v.height_cm} cm`,
    price: price(v.width_cm, v.height_cm),
    compare_at_price: comparePrice(v.width_cm, v.height_cm),
    sku: `NP-${asset.id.slice(0, 8)}-${v.label.toLowerCase()}`,
    requires_shipping: true,
    inventory_management: null,
    taxable: true,
    weight: Math.round(v.width_cm * v.height_cm * 0.15 + 50),
    weight_unit: "g",
  }));

  const tags = [
    asset.ratio_class?.replace(/_/g, " "),
    asset.quality_tier === "high" ? "museum grade" : "gallery grade",
    asset.style, asset.era, asset.mood, asset.subject, asset.palette,
    "art print", "fine art", "wall art",
    ...(asset.ai_tags || []),
  ].filter(Boolean);

  const aiDesc = asset.description || "";
  const sizes = variants.map(v => `${v.label}: ${v.width_cm}×${v.height_cm} cm`).join(" · ");
  const body_html = aiDesc
    ? `<div class="np-desc"><p class="np-ai">${aiDesc}</p><p>A museum-quality fine art print by <strong>${artistName}</strong>.</p><p><strong>Available sizes:</strong> ${sizes}</p><p>Printed on premium 310gsm cotton-rag archival paper with pigment-based inks rated for 200+ years lightfastness.</p></div>`
    : `<p>A museum-quality fine art print by <strong>${artistName}</strong>.</p><p><strong>Available sizes:</strong> ${sizes}</p><p>Printed on premium 310gsm cotton-rag archival paper with pigment-based inks rated for 200+ years lightfastness.</p>`;

  return {
    product: {
      title,
      body_html,
      vendor: artistName,
      product_type: "Art Print",
      tags: tags.join(", "),
      status: "active",
      options: [{ name: "Size" }],
      variants: shopVariants,
      metafields: [
        { namespace: "neverland", key: "drive_file_id", value: asset.drive_file_id, type: "single_line_text_field" },
        { namespace: "neverland", key: "ratio_class", value: asset.ratio_class || "", type: "single_line_text_field" },
        { namespace: "neverland", key: "quality_tier", value: asset.quality_tier || "", type: "single_line_text_field" },
        { namespace: "neverland", key: "max_print_cm", value: `${asset.max_print_width_cm || 0} × ${asset.max_print_height_cm || 0}`, type: "single_line_text_field" },
        { namespace: "neverland", key: "aspect_ratio", value: String(asset.aspect_ratio || ""), type: "single_line_text_field" },
      ],
    },
  };
}

// ── Concurrency Pool ─────────────────────────────────────
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
      fn().then(resolve).catch(reject).finally(() => { running--; drain(); });
    }
  }
}

// ── Process a single asset ────────────────────────────────
async function syncOneAsset(asset) {
  const payload = buildProduct(asset);
  const result = await shopifyPost("/products.json", payload);
  if (!result || typeof result !== 'object') throw new Error(`Unexpected response: ${JSON.stringify(result).slice(0, 200)}`);
  const product = result.product;
  if (!product?.id) throw new Error(`No product in response: ${JSON.stringify(result).slice(0, 200)}`);
  return {
    id: asset.id,
    shopify_product_id: String(product.id),
    shopify_product_gid: `gid://shopify/Product/${product.id}`,
    shopify_status: "synced",
    shopify_synced_at: new Date().toISOString(),
    ingestion_status: "ready",
  };
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("⚡ NEVERLAND PRINTS — FAST Shopify Sync (REST)");
  console.log("═".repeat(60));
  console.log(`  Concurrency: ${CONCURRENCY} | Limit: ${LIMIT || "ALL"} | Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log("═".repeat(60) + "\n");

  // ── Count total unsynced ───────────────────────────────
  const { count: totalPending } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .is("shopify_product_id", null);

  const totalToSync = LIMIT > 0 ? Math.min(LIMIT, totalPending) : totalPending;
  console.log(`📦 ${totalPending} assets need Shopify products`);

  if (totalPending === 0) {
    console.log("   ✅ All assets already synced to Shopify!");
    return;
  }

  const estRate = 2;
  const estHours = (totalToSync / estRate / 3600).toFixed(1);
  console.log(`⏱️  Estimated time: ~${estHours} hours at ~${estRate}/s sustained`);
  console.log(`   Streaming in chunks of 200, concurrency ${CONCURRENCY}\n`);

  if (DRY_RUN) {
    console.log("🏃 DRY RUN — would create products. Exiting.");
    return;
  }

  // ── Stream & process in chunks ─────────────────────────
  let synced = 0;
  let errors = 0;
  let totalProcessed = 0;
  const startTime = Date.now();
  const CHUNK_SIZE = 200;

  while (true) {
    // Fetch next chunk of unsynced assets
    const { data: chunk, error } = await supabase
      .from("assets")
      .select("id, title, artist, description, drive_file_id, width_px, height_px, aspect_ratio, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, style, era, mood, subject, palette, ai_tags")
      .is("shopify_product_id", null)
      .order("id")
      .limit(CHUNK_SIZE);

    if (error) throw error;
    if (!chunk || chunk.length === 0) break;

    // Process chunk with concurrency
    const pool = createPool(CONCURRENCY);
    const chunkUpdates = [];

    const chunkPromises = chunk.map((asset) =>
      pool(async () => {
        try {
          const update = await syncOneAsset(asset);
          chunkUpdates.push(update);
          synced++;
        } catch (err) {
          errors++;
          if (errors <= 20) {
            console.error(`   ❌ "${(asset.title || '').slice(0, 30)}": ${err.message.slice(0, 100)}`);
          } else if (errors === 21) {
            console.log(`   ... suppressing further error messages`);
          }
          chunkUpdates.push({
            id: asset.id,
            shopify_status: "error",
            ingestion_error: err.message.slice(0, 500),
          });
        }
      })
    );

    await Promise.all(chunkPromises);

    // Flush all updates for this chunk
    if (chunkUpdates.length > 0) {
      await flushUpdates(chunkUpdates);
    }

    totalProcessed += chunk.length;

    // Progress log
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (synced / (elapsed || 1)).toFixed(1);
    const pct = ((totalProcessed / totalToSync) * 100).toFixed(1);
    const remSec = Math.round((totalToSync - totalProcessed) / (parseFloat(rate) || 1));
    console.log(
      `   🛍️  ${totalProcessed}/${totalToSync} | ` +
      `${synced} synced | ${errors} err | ` +
      `${pct}% | ${rate}/s | ${elapsed}s | ETA: ${formatTime(remSec)}`
    );

    // Check limits
    if (LIMIT > 0 && totalProcessed >= LIMIT) break;

    // Safety: abort on too many errors
    if (errors > 500 && errors > synced) {
      console.error("\n💥 Too many errors — aborting. Fix issues and re-run.");
      process.exit(1);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalRate = (synced / (totalTime || 1)).toFixed(1);

  console.log("\n" + "═".repeat(60));
  console.log(`✅ FAST Sync Complete!`);
  console.log(`   Synced: ${synced} | Errors: ${errors}`);
  console.log(`   Time: ${formatTime(Math.round(totalTime))} | Rate: ${totalRate}/s`);
  console.log("═".repeat(60) + "\n");
}

async function flushUpdates(batch) {
  const promises = batch.map(u => {
    const { id, ...data } = u;
    return supabase.from("assets").update(data).eq("id", id);
  });
  try {
    await Promise.all(promises);
  } catch (e) {
    console.error(`   ⚠️ Supabase flush: ${e.message.slice(0, 80)}`);
  }
}

function formatTime(seconds) {
  const s = Math.round(Number(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

main().catch(e => { console.error("💥", e); process.exit(1); });
