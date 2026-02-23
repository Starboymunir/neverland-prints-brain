/**
 * Neverland Prints — Auto-Drip Shopify Sync
 * ==========================================
 * Runs as a background worker inside the Express server on Render.
 * Creates Shopify products at ~1/sec via REST API.
 * When it hits the daily variant limit (429 + VARIANT_THROTTLE), it sleeps
 * until midnight Lagos time (UTC+1) and auto-resumes.
 *
 * Fully autonomous — zero human intervention needed.
 *
 * Expected timeline at ~1/s:
 *   ~50k variants/day → with daily limit ~1k variants/day on Basic plan,
 *   this is limited by Shopify's quota. Each product = 1 default variant.
 *   Basic plan limit: ~1,000 variants/day → ~1,000 products/day → ~100 days.
 *   BUT: The limit appears higher in practice (~10k-50k/day).
 *   We'll push as fast as possible and sleep on throttle.
 *
 * Can also run standalone:
 *   node src/scripts/sync-drip.js
 */

// ── Config ───────────────────────────────────────────────
// When loaded as a module from server.js, dotenv is already loaded via config.js
// When run standalone, we load it ourselves
let supabase;
if (require.main === module) {
  require("dotenv").config();
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
} else {
  supabase = require("../db/supabase");
}

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── State ────────────────────────────────────────────────
let isRunning = false;
let isPaused = false;
let stats = {
  synced: 0,
  errors: 0,
  throttled: 0,
  startedAt: null,
  lastSyncAt: null,
  lastError: null,
  sleepUntil: null,
  remaining: 0,
};

function getStatus() {
  return {
    running: isRunning,
    paused: isPaused,
    ...stats,
    rate: stats.synced > 0 && stats.startedAt
      ? (stats.synced / ((Date.now() - new Date(stats.startedAt).getTime()) / 3600000)).toFixed(0) + "/hr"
      : "0/hr",
  };
}

// ── Shopify REST ─────────────────────────────────────────
let bucketUsed = 0;
let bucketMax = 40;
let lastReqTime = Date.now();

async function waitForBucket() {
  const now = Date.now();
  const elapsed = (now - lastReqTime) / 1000;
  bucketUsed = Math.max(0, bucketUsed - elapsed * 2);
  while (bucketUsed >= bucketMax - 2) {
    await sleep(500);
    const now2 = Date.now();
    bucketUsed = Math.max(0, bucketUsed - (now2 - lastReqTime) / 1000 * 2);
  }
  bucketUsed++;
  lastReqTime = Date.now();
}

async function shopifyPost(endpoint, body) {
  await waitForBucket();

  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify(body),
  });

  const limit = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
  if (limit) {
    const [u, m] = limit.split("/").map(Number);
    bucketUsed = u;
    bucketMax = m;
  }

  if (res.status === 429) {
    const txt = await res.text();
    if (txt.includes("variant creation limit") || txt.includes("Daily variant")) {
      throw new ThrottleError("Daily variant limit reached");
    }
    // Normal rate limit — just wait and retry
    const wait = parseFloat(res.headers.get("Retry-After") || "4");
    bucketUsed = bucketMax;
    await sleep(wait * 1000 + 1000);
    return shopifyPost(endpoint, body); // retry once
  }

  if (res.status === 502 || res.status === 503) {
    await sleep(3000);
    return shopifyPost(endpoint, body);
  }

  if (!res.ok) {
    const txt = await res.text();
    if (txt.includes("variant creation limit") || txt.includes("Daily variant")) {
      throw new ThrottleError("Daily variant limit reached");
    }
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  return res.json();
}

class ThrottleError extends Error {
  constructor(msg) { super(msg); this.name = "ThrottleError"; }
}

// ── Build Product Payload ────────────────────────────────
// Single default variant — sizes served from Supabase by the theme
function buildProduct(asset) {
  const title = (asset.title || "Untitled").slice(0, 255);
  const artist = asset.artist || "Unknown Artist";

  const desc = asset.description || "";
  const body_html = desc
    ? `<div class="np-desc"><p class="np-ai">${desc}</p><p>Museum-quality fine art print by <strong>${artist}</strong>.</p><p>Premium 310gsm cotton-rag archival paper, 200+ year lightfast inks.</p></div>`
    : `<p>Museum-quality fine art print by <strong>${artist}</strong>.</p><p>Premium 310gsm cotton-rag archival paper.</p>`;

  const tags = [
    asset.ratio_class?.replace(/_/g, " "),
    asset.quality_tier === "high" ? "museum grade" : "gallery grade",
    asset.style, asset.era, asset.mood, asset.subject, asset.palette,
    "art print", "fine art", "wall art",
    ...(asset.ai_tags || []),
  ].filter(Boolean);

  return {
    product: {
      title,
      body_html,
      vendor: artist,
      product_type: "Art Print",
      tags: tags.join(", "),
      status: "active",
      metafields: [
        { namespace: "neverland", key: "drive_file_id", value: asset.drive_file_id, type: "single_line_text_field" },
        { namespace: "neverland", key: "ratio_class", value: asset.ratio_class || "", type: "single_line_text_field" },
        { namespace: "neverland", key: "quality_tier", value: asset.quality_tier || "", type: "single_line_text_field" },
        { namespace: "neverland", key: "max_print_cm", value: `${asset.max_print_width_cm || 0}×${asset.max_print_height_cm || 0}`, type: "single_line_text_field" },
        { namespace: "neverland", key: "aspect_ratio", value: String(asset.aspect_ratio || ""), type: "single_line_text_field" },
      ],
    },
  };
}

// ── Sleep until midnight Lagos (UTC+1) ───────────────────
function msUntilMidnightLagos() {
  const now = new Date();
  // Lagos = UTC+1
  const lagosNow = new Date(now.getTime() + 1 * 3600000);
  const lagosHours = lagosNow.getUTCHours();
  const lagosMinutes = lagosNow.getUTCMinutes();

  // Hours until next midnight Lagos
  let hoursUntilMidnight = 24 - lagosHours;
  if (lagosMinutes === 0 && lagosHours === 0) hoursUntilMidnight = 24; // already midnight, wait full day

  const msRemaining = (hoursUntilMidnight * 3600 - lagosMinutes * 60) * 1000;
  // Add 5 minute buffer after midnight
  return msRemaining + 5 * 60 * 1000;
}

// ── Process one batch ────────────────────────────────────
async function processBatch() {
  const BATCH = 50;

  const { data: assets, error } = await supabase
    .from("assets")
    .select("id, title, artist, description, drive_file_id, width_px, height_px, aspect_ratio, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, style, era, mood, subject, palette, ai_tags")
    .is("shopify_product_id", null)
    .neq("shopify_status", "error") // skip permanently errored
    .order("id")
    .limit(BATCH);

  if (error) throw error;
  if (!assets?.length) return 0;

  let created = 0;
  for (const asset of assets) {
    if (!isRunning || isPaused) break;

    try {
      const payload = buildProduct(asset);
      const result = await shopifyPost("/products.json", payload);
      const product = result?.product;

      if (!product?.id) {
        throw new Error(`No product in response: ${JSON.stringify(result).slice(0, 200)}`);
      }

      await supabase.from("assets").update({
        shopify_product_id: String(product.id),
        shopify_product_gid: `gid://shopify/Product/${product.id}`,
        shopify_status: "synced",
        shopify_synced_at: new Date().toISOString(),
        ingestion_status: "ready",
      }).eq("id", asset.id);

      stats.synced++;
      stats.lastSyncAt = new Date().toISOString();
      created++;

      // ~1 product/sec to stay within rate limits
      await sleep(1000);

    } catch (err) {
      if (err instanceof ThrottleError) {
        throw err; // bubble up to trigger sleep
      }
      stats.errors++;
      stats.lastError = `${(asset.title || "").slice(0, 30)}: ${err.message.slice(0, 100)}`;

      await supabase.from("assets").update({
        shopify_status: "error",
        ingestion_error: err.message.slice(0, 500),
      }).eq("id", asset.id);

      await sleep(1000);
    }
  }

  return created;
}

// ── Main loop ────────────────────────────────────────────
async function startDrip() {
  if (isRunning) return;
  isRunning = true;
  isPaused = false;
  stats.startedAt = new Date().toISOString();

  console.log(`\n🚰 [${new Date().toISOString()}] Drip sync STARTED`);

  // Get initial count
  const { count } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .is("shopify_product_id", null);
  stats.remaining = count || 0;

  console.log(`   📦 ${stats.remaining} products to sync`);

  while (isRunning) {
    if (isPaused) {
      await sleep(30000);
      continue;
    }

    try {
      const created = await processBatch();

      if (created === 0) {
        // Check if truly done
        const { count: rem } = await supabase
          .from("assets")
          .select("id", { count: "exact", head: true })
          .is("shopify_product_id", null);
        stats.remaining = rem || 0;

        if (stats.remaining === 0) {
          console.log(`\n✅ [${new Date().toISOString()}] All products synced! (${stats.synced} total)`);
          isRunning = false;
          break;
        }

        // Remaining are all errors — wait and retry tomorrow
        console.log(`   ⚠️  ${stats.remaining} remaining but none processable. Sleeping 1h.`);
        await sleep(3600000);
      }

      // Update remaining count every 100 syncs
      if (stats.synced % 100 === 0 && stats.synced > 0) {
        const { count: rem } = await supabase
          .from("assets")
          .select("id", { count: "exact", head: true })
          .is("shopify_product_id", null);
        stats.remaining = rem || 0;
        console.log(
          `   📊 [${new Date().toISOString()}] ${stats.synced} synced | ${stats.errors} err | ${stats.remaining} left`
        );
      }

    } catch (err) {
      if (err instanceof ThrottleError) {
        stats.throttled++;
        const waitMs = msUntilMidnightLagos();
        const hours = (waitMs / 3600000).toFixed(1);
        const resumeAt = new Date(Date.now() + waitMs).toISOString();
        stats.sleepUntil = resumeAt;

        console.log(`\n⏸️  [${new Date().toISOString()}] Daily variant limit hit!`);
        console.log(`   💤 Sleeping ${hours}h — resume at ${resumeAt}`);
        console.log(`   📊 Today: ${stats.synced} synced | ${stats.errors} err`);

        await sleep(waitMs);
        stats.sleepUntil = null;
        console.log(`\n▶️  [${new Date().toISOString()}] Waking up — resuming sync`);
      } else {
        console.error(`   ❌ Unexpected: ${err.message.slice(0, 200)}`);
        stats.lastError = err.message.slice(0, 200);
        await sleep(10000); // wait 10s on unknown errors
      }
    }
  }
}

function stopDrip() {
  isRunning = false;
  isPaused = false;
  console.log(`\n⏹️  [${new Date().toISOString()}] Drip sync STOPPED`);
}

function pauseDrip() {
  isPaused = true;
  console.log(`\n⏸️  [${new Date().toISOString()}] Drip sync PAUSED`);
}

function resumeDrip() {
  isPaused = false;
  console.log(`\n▶️  [${new Date().toISOString()}] Drip sync RESUMED`);
}

module.exports = { startDrip, stopDrip, pauseDrip, resumeDrip, getStatus };

// Standalone mode
if (require.main === module) {
  require("dotenv").config();
  startDrip().catch((e) => {
    console.error("💥 Fatal:", e);
    process.exit(1);
  });
}
