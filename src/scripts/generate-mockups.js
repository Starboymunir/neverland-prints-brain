#!/usr/bin/env node
/**
 * Printful Mockup Generator — Batch Script
 * ==========================================
 * Generates realistic wall/room mockups for artwork using Printful's
 * Mockup Generator API. Stores mockup URLs in the assets.mockup_url column.
 *
 * Usage:
 *   node src/scripts/generate-mockups.js [options]
 *
 * Options:
 *   --limit=N         Max assets to process (default: 100)
 *   --product=N       Printful product ID (default: 268 = Enhanced Matte Paper Poster)
 *   --variants=N,...  Comma-separated variant IDs (default: 8948 = 30×40cm poster)
 *   --concurrency=N   Parallel tasks (default: 2 — Printful is rate-limited)
 *   --force           Regenerate even if mockup_url exists
 *   --dry-run         Just print what would be done
 *   --artist=NAME     Only process assets by this artist
 *   --popular         Prioritize assets with most views/clicks
 *
 * Printful API Reference:
 *   POST /mockup-generator/create-task/{product_id}
 *   GET  /mockup-generator/task?task_key={key}
 *
 * Rate limits: ~10 requests/min for mockup generation
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PRINTFUL_KEY = process.env.PRINTFUL_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}
if (!PRINTFUL_KEY) {
  console.error("Missing PRINTFUL_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Parse CLI args ───────────────────────────────────────
function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--")) {
      const [key, val] = a.slice(2).split("=");
      args[key] = val === undefined ? true : val;
    }
  }
  return args;
}

const opts = parseArgs();
const LIMIT = parseInt(opts.limit || "100", 10);
const PRODUCT_ID = parseInt(opts.product || "268", 10);
const VARIANT_IDS = (opts.variants || "8948").split(",").map(Number);
const CONCURRENCY = parseInt(opts.concurrency || "2", 10);
const FORCE = !!opts.force;
const DRY_RUN = !!opts["dry-run"];
const ARTIST_FILTER = opts.artist || null;
const PRIORITIZE_POPULAR = !!opts.popular;

// ── Printful API ─────────────────────────────────────────
const PRINTFUL_BASE = "https://api.printful.com";

async function printfulRequest(method, endpoint, body = null) {
  const fetchOpts = {
    method,
    headers: {
      Authorization: `Bearer ${PRINTFUL_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(`${PRINTFUL_BASE}${endpoint}`, fetchOpts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Printful ${method} ${endpoint}: ${res.status} - ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function createMockupTask(imageUrl) {
  const body = {
    variant_ids: VARIANT_IDS,
    format: "jpg",
    files: [
      {
        placement: "default",
        image_url: imageUrl,
      },
    ],
  };

  const data = await printfulRequest(
    "POST",
    `/mockup-generator/create-task/${PRODUCT_ID}`,
    body
  );
  return data.result; // { task_key, status }
}

async function pollMockupTask(taskKey, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const data = await printfulRequest(
      "GET",
      `/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`
    );
    const { status, mockups, error } = data.result;

    if (status === "completed") return mockups || [];
    if (status === "failed") throw new Error(`Task failed: ${error || "unknown"}`);

    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Mockup task timed out");
}

// ── Fetch assets needing mockups ─────────────────────────
async function fetchAssets() {
  let query = supabase
    .from("assets")
    .select("id, drive_file_id, title, artist, mockup_url, width_px, height_px")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (!FORCE) {
    query = query.is("mockup_url", null);
  }

  if (ARTIST_FILTER) {
    query = query.ilike("artist", `%${ARTIST_FILTER}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ── Process a single asset ───────────────────────────────
async function processOne(asset) {
  const imageUrl = `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s2000`;

  try {
    const task = await createMockupTask(imageUrl);
    const mockups = await pollMockupTask(task.task_key);

    if (!mockups.length) {
      throw new Error("No mockups returned");
    }

    const mockupUrl = mockups[0].mockup_url;

    // Save to DB
    const { error } = await supabase
      .from("assets")
      .update({ mockup_url: mockupUrl })
      .eq("id", asset.id);

    if (error) throw error;

    return { success: true, mockupUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log("  Printful Mockup Generator");
  console.log("=".repeat(60));
  console.log(`  Product ID:  ${PRODUCT_ID}`);
  console.log(`  Variant IDs: ${VARIANT_IDS.join(", ")}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Limit:       ${LIMIT}`);
  console.log(`  Force:       ${FORCE}`);
  console.log(`  Dry run:     ${DRY_RUN}`);
  if (ARTIST_FILTER) console.log(`  Artist:      ${ARTIST_FILTER}`);
  console.log("");

  // 1. Verify Printful connection
  console.log("Verifying Printful connection...");
  try {
    const check = await printfulRequest("GET", "/store");
    console.log(`  Connected to store: ${check.result?.name || "OK"}`);
  } catch (e) {
    console.error(`  Connection failed: ${e.message}`);
    process.exit(1);
  }

  // 2. Fetch assets
  console.log("\nFetching assets...");
  const assets = await fetchAssets();
  console.log(`  Found ${assets.length} assets needing mockups`);

  if (!assets.length) {
    console.log("Nothing to do!");
    return;
  }

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would generate mockups for:");
    for (const a of assets.slice(0, 20)) {
      console.log(`  - ${a.id} | ${a.artist || "?"} | ${a.title || a.drive_file_id}`);
    }
    if (assets.length > 20) console.log(`  ... and ${assets.length - 20} more`);
    return;
  }

  // 3. Process with concurrency control
  let done = 0;
  let success = 0;
  let failed = 0;
  const startTime = Date.now();

  // Simple semaphore for concurrency
  const queue = [...assets];
  const workers = [];

  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const asset = queue.shift();
          if (!asset) break;

          const result = await processOne(asset);
          done++;

          if (result.success) {
            success++;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (done / ((Date.now() - startTime) / 1000)).toFixed(2);
            console.log(
              `  [${done}/${assets.length}] OK: ${(asset.title || asset.id).substring(0, 40)} | ${rate}/s | ${elapsed}s`
            );
          } else {
            failed++;
            console.error(
              `  [${done}/${assets.length}] FAIL: ${asset.id} - ${result.error}`
            );
          }

          // Rate limit: wait between tasks to avoid Printful throttling
          if (queue.length) {
            await new Promise((r) => setTimeout(r, 5000 / CONCURRENCY));
          }
        }
      })()
    );
  }

  await Promise.all(workers);

  // 4. Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log(`  Done in ${totalTime}s`);
  console.log(`  Success: ${success} | Failed: ${failed} | Total: ${done}`);
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
