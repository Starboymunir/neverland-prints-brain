#!/usr/bin/env node
/**
 * push-tags-shopify.js
 * Push enriched AI tags from Supabase → Shopify product tags
 * so that smart collections can match products.
 *
 * Usage:
 *   node src/scripts/push-tags-shopify.js               # push all enriched
 *   node src/scripts/push-tags-shopify.js --limit=500   # push first 500
 *   node src/scripts/push-tags-shopify.js --dry-run      # preview only
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const BASE_URL = `https://${SHOP}/admin/api/${API_VER}`;

// ── Config ───────────────────────────────────────────────
const CONCURRENCY = 4;       // parallel Shopify API calls (stay under rate limit)
const DELAY_MS = 300;         // delay between calls to respect rate limits
const PAGE_SIZE = 1000;       // Supabase page size

const args = process.argv.slice(2);
const LIMIT = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "0", 10);
const DRY_RUN = args.includes("--dry-run");

// ── Helpers ──────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildTags(asset) {
  return [
    asset.ratio_class?.replace(/_/g, " "),
    asset.quality_tier === "high" ? "museum grade" : "gallery grade",
    asset.style,
    asset.era,
    asset.mood,
    asset.subject,
    asset.palette,
    "art print",
    "fine art",
    "wall art",
    ...(asset.ai_tags || []),
  ].filter(Boolean);
}

async function pushToShopify(asset, retries = 3) {
  const tags = buildTags(asset);
  const tagStr = tags.join(", ");

  const res = await fetch(`${BASE_URL}/products/${asset.shopify_product_id}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({
      product: { id: parseInt(asset.shopify_product_id), tags: tagStr },
    }),
  });

  if (res.status === 429) {
    // Rate limited — wait and retry
    const retryAfter = parseFloat(res.headers.get("Retry-After") || "2") * 1000;
    await sleep(retryAfter);
    return pushToShopify(asset);
  }

  if (res.status === 404) {
    // Product deleted from Shopify — clear stale ID
    await supabase.from("assets").update({ shopify_product_id: null }).eq("id", asset.id);
    return "stale";
  }

  if (res.status === 502 || res.status === 503) {
    // Temporary Shopify issue — wait and retry once
    await sleep(3000);
    return pushToShopify(asset);
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify PUT ${res.status}: ${txt.slice(0, 200)}`);
  }

  return tags.length;
}

// ── Process chunk with concurrency ───────────────────────
async function processChunk(assets, stats) {
  const tasks = [];

  for (let i = 0; i < assets.length; i += CONCURRENCY) {
    const slice = assets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map(async (asset) => {
        if (DRY_RUN) return buildTags(asset).length;
        return pushToShopify(asset);
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value === "stale") {
          stats.stale++;
        } else {
          stats.updated++;
        }
      } else {
        stats.errors++;
        if (stats.errors <= 5) console.log(`   ⚠️  ${r.reason?.message?.slice(0, 120)}`);
      }
    }

    stats.processed += slice.length;
    const pct = ((stats.processed / stats.total) * 100).toFixed(1);
    const elapsed = ((Date.now() - stats.t0) / 1000).toFixed(0);
    const rate = (stats.processed / (elapsed || 1)).toFixed(1);
    process.stdout.write(`\r   🏷️  ${stats.processed}/${stats.total} | ${stats.updated} pushed | ${stats.stale} stale | ${stats.errors} err | ${pct}% | ${rate}/s | ${elapsed}s`);

    if (!DRY_RUN) await sleep(DELAY_MS);
  }
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🏷️  NEVERLAND PRINTS — Push Tags to Shopify");
  console.log("═".repeat(60));

  // Count eligible: has shopify_product_id AND has style (enriched)
  const { count: eligible } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .not("shopify_product_id", "is", null)
    .not("style", "is", null);

  const total = LIMIT > 0 ? Math.min(LIMIT, eligible) : eligible;

  console.log(`  📦 ${eligible} enriched products with Shopify IDs`);
  console.log(`  🔄 Processing: ${total} | Concurrency: ${CONCURRENCY}`);
  console.log(`  ${DRY_RUN ? "🧪 DRY RUN — no Shopify updates" : "🚀 LIVE — pushing to Shopify"}`);
  console.log("═".repeat(60) + "\n");

  if (eligible === 0) {
    console.log("ℹ️  No enriched products found with Shopify IDs. Run the enricher first.");
    return;
  }

  const stats = { processed: 0, updated: 0, stale: 0, errors: 0, total, t0: Date.now() };
  let offset = 0;

  while (stats.processed < total) {
    const pageSize = Math.min(PAGE_SIZE, total - stats.processed);
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, shopify_product_id, ratio_class, quality_tier, style, era, mood, subject, palette, ai_tags")
      .not("shopify_product_id", "is", null)
      .not("style", "is", null)
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    if (!assets || assets.length === 0) break;

    await processChunk(assets, stats);
    offset += assets.length;
  }

  const elapsed = ((Date.now() - stats.t0) / 1000).toFixed(1);
  console.log("\n\n" + "═".repeat(60));
  console.log(`✅ ${DRY_RUN ? "Dry run" : "Tag push"} complete!`);
  console.log(`   Pushed: ${stats.updated} | Stale (cleaned): ${stats.stale} | Errors: ${stats.errors} | Time: ${elapsed}s`);
  console.log("═".repeat(60) + "\n");
}

main().catch(err => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
