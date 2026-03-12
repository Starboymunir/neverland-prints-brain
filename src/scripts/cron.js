/**
 * Daily Cron Jobs
 * ===============
 * Runs automated tasks on a schedule:
 *   - Daily Google Drive scan + ingestion (new art → Supabase)
 *   - Daily Shopify sync (processes queued assets at ~900 variants/day)
 *   - Health checks
 *
 * Integrated into the main server.js — no separate process needed.
 *
 * To run standalone:
 *   node src/scripts/cron.js
 */

const cron = require("node-cron");
const { execSync, exec } = require("child_process");
const path = require("path");
const { startDrip, getStatus } = require("./sync-drip");
const { startWatcher: startDriveWatcher } = require("./drive-watcher");

const ROOT = path.join(__dirname, "..", "..");

/**
 * Start all cron jobs.
 */
function startCronJobs() {
  console.log("⏰ Starting cron jobs...\n");

  // ── Daily Google Drive scan + ingestion at 1:00 AM ──
  // Scans Drive for new images, gets dimensions, runs AI tagging, stores in Supabase
  // Uses --limit=1000 to process in daily batches (the pipeline skips already-ingested files)
  cron.schedule("0 1 * * *", () => {
    console.log(`\n⏰ [${new Date().toISOString()}] Running daily Drive ingestion...`);
    exec(
      `node ${path.join(ROOT, "src/scripts/ingest-v2.js")} --limit=1000 --concurrency=5`,
      { cwd: ROOT, timeout: 60 * 60 * 1000 }, // 60 min timeout (AI tagging can be slow)
      (error, stdout, stderr) => {
        if (error) {
          console.error("❌ Drive ingestion failed:", error.message);
          if (stderr) console.error(stderr);
        }
        if (stdout) console.log(stdout);
        console.log(`⏰ [${new Date().toISOString()}] Drive ingestion finished.`);
      }
    );
  });

  // ── Daily Shopify sync at 3:00 AM (server time) ──
  // Processes up to 900 variants per run to stay under the 1k/day limit
  cron.schedule("0 3 * * *", () => {
    console.log(`\n⏰ [${new Date().toISOString()}] Running daily Shopify sync...`);
    exec(
      `node ${path.join(ROOT, "src/scripts/sync-queue.js")} --max-variants=900 --collections`,
      { cwd: ROOT, timeout: 30 * 60 * 1000 }, // 30 min timeout
      (error, stdout, stderr) => {
        if (error) {
          console.error("❌ Daily sync failed:", error.message);
          if (stderr) console.error(stderr);
        }
        if (stdout) console.log(stdout);
        console.log(`⏰ [${new Date().toISOString()}] Daily sync finished.`);
      }
    );
  });

  // Health check log every 6 hours
  cron.schedule("0 */6 * * *", async () => {
    console.log(`\n⏰ [${new Date().toISOString()}] Health check...`);
    try {
      const res = await fetch("http://localhost:" + (process.env.PORT || 3000) + "/api/health");
      const data = await res.json();
      console.log("   Server:", data.server);
      console.log("   Supabase:", data.supabase, `(${data.assetCount} assets)`);
      console.log("   Drive:", data.drive);
      if (data.imageCache) console.log("   Cache:", JSON.stringify(data.imageCache));
    } catch (e) {
      console.log("   ⚠️  Health check failed:", e.message);
    }
  });

  // ── Keep-alive self-ping (prevents Render free tier spin-down) ──
  // Render free tier spins down after 15min of no inbound HTTP requests.
  // Internal localhost pings don't count — must hit the external URL
  // so the request goes through the load balancer as "inbound traffic".
  const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  setInterval(async () => {
    try {
      await fetch(`${EXTERNAL_URL}/api/health`);
    } catch {
      // ignore — server might not be ready yet
    }
  }, 5 * 60 * 1000); // every 5 minutes

  console.log("   📂 Drive ingest:  1:00 AM daily");
  console.log("   📅 Shopify sync:  3:00 AM daily");
  console.log("   🏥 Health check:  every 6h");
  console.log("   💓 Keep-alive:    external ping every 5min");

  // ── Auto-start drip sync (runs continuously, self-heals on throttle) ──
  console.log("   🚰 Drip sync:     starting now (auto-sleep on throttle)");
  startDrip().catch((e) => {
    console.error("❌ Drip sync fatal:", e.message);
  });

  // ── Auto-start Drive watcher (polls every 5 minutes for new files) ──
  console.log("   👁️  Drive watcher: polling every 5 minutes\n");
  startDriveWatcher(300).catch((e) => {
    console.error("❌ Drive watcher fatal:", e.message);
  });
}

module.exports = { startCronJobs };

// Run standalone
if (require.main === module) {
  require("dotenv").config({ path: path.join(ROOT, ".env") });
  console.log("Running cron jobs standalone...");
  startCronJobs();
  // Keep process alive
  setInterval(() => {}, 60000);
}
