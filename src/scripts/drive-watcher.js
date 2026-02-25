/**
 * Neverland Prints — Drive Auto-Sync Watcher
 * =============================================
 * Monitors Google Drive for new files and automatically syncs them to Supabase.
 *
 * How it works:
 *   1. On first run: does a full scan (like ingest-fast.js) and stores a "change token"
 *   2. On subsequent runs: uses Google Drive Changes API to detect ONLY new/modified files
 *   3. New files are processed (title/dimension parsing, resolution engine) and batch-inserted
 *   4. Runs as a persistent worker inside the Express server, polling every 5 minutes
 *   5. Can also be triggered manually via API endpoint
 *
 * The change token is stored in Supabase `sync_state` table so it persists across restarts.
 *
 * Usage (standalone):
 *   node src/scripts/drive-watcher.js                 # run once (detect + sync new files)
 *   node src/scripts/drive-watcher.js --full           # full re-scan (ignore change token)
 *   node src/scripts/drive-watcher.js --watch          # persistent polling mode
 *   node src/scripts/drive-watcher.js --interval=300   # poll every 300 seconds (default: 300)
 *
 * Usage (as module in server):
 *   const { startWatcher, runOnce, getWatcherStatus } = require('./drive-watcher');
 *   startWatcher();  // starts polling loop
 *   await runOnce(); // single sync run
 */

require("dotenv").config();
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const pLimit = require("p-limit");

// ── Shared or standalone Supabase client ──────────────
let supabase;
try {
  supabase = require("../db/supabase");
} catch {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const config = require("../config");
const { analyzeArtwork } = require("../services/resolution-engine");

// ── CLI args ─────────────────────────────────────────
const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(`--${n}`);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };

const FULL_SCAN = hasFlag("full");
const WATCH_MODE = hasFlag("watch");
const POLL_INTERVAL = parseInt(getArg("interval") || "300", 10); // seconds
const BATCH_SIZE = 500;

// ── State ────────────────────────────────────────────
let isRunning = false;
let watcherInterval = null;
let lastRunTime = null;
let lastRunResult = null;
let totalSynced = 0;
let runCount = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Retry wrapper ────────────────────────────────────
async function withRetry(fn, maxRetries = 5, label = "") {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || "";
      const status = err.response?.status || err.status || 0;
      const retryable = ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code)
        || [429, 500, 503].includes(status);
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
      console.warn(`   ⚠️  ${label} attempt ${attempt} failed, retrying in ${Math.round(delay/1000)}s...`);
      await sleep(delay);
    }
  }
}

// ── Initialize Drive API ─────────────────────────────
async function initDrive() {
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  } else {
    const keyPath = path.resolve(config.google.serviceAccountKeyPath);
    if (!fs.existsSync(keyPath)) throw new Error(`Service account key not found at: ${keyPath}`);
    auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  }
  return google.drive({ version: "v3", auth });
}

// ── Sync state persistence (file-based, works everywhere) ──
const TOKEN_FILE = path.join(__dirname, "..", "..", ".drive-sync-token.json");

function getSavedPageToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      return data.pageToken || null;
    }
  } catch {}
  return null;
}

function savePageToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      pageToken: token,
      savedAt: new Date().toISOString(),
    }), "utf8");
  } catch (e) {
    console.warn(`   ⚠️  Could not save page token: ${e.message}`);
  }
}

// ── Parse filename for title + dimensions ────────────
function parseFilename(filename) {
  const nameWithoutExt = path.basename(filename, path.extname(filename));
  const match = nameWithoutExt.match(/^(.+?)_(\d+)x(\d+)$/);
  if (match) {
    return { title: match[1].replace(/[-_]+/g, " ").trim(), width: parseInt(match[2], 10), height: parseInt(match[3], 10) };
  }
  return { title: nameWithoutExt.replace(/[-_]+/g, " ").trim(), width: 0, height: 0 };
}

function isImageFile(file) {
  const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/tiff", "image/bmp", "image/gif"];
  if (imageTypes.includes(file.mimeType)) return true;
  const ext = path.extname(file.name || "").toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".tif", ".bmp", ".gif"].includes(ext);
}

// ── Resolve folder path to get artist + tier ─────────
async function resolveAncestry(drive, fileId, cache = {}) {
  // Walk up parents to find artist name and quality tier
  // Structure: Root > ArtistName > Above/Below 2900x4060 > file
  const ancestry = [];
  let currentId = fileId;
  let depth = 0;

  while (currentId && depth < 5) {
    if (cache[currentId]) {
      ancestry.unshift(cache[currentId]);
      currentId = cache[currentId].parentId;
      depth++;
      continue;
    }

    try {
      const res = await withRetry(() => drive.files.get({
        fileId: currentId,
        fields: "id, name, parents",
      }), 3, `get parent ${currentId}`);

      const parentId = res.data.parents?.[0] || null;
      const info = { id: currentId, name: res.data.name, parentId };
      cache[currentId] = info;
      ancestry.unshift(info);
      currentId = parentId;
      depth++;
    } catch {
      break;
    }
  }

  // Parse ancestry: [Root, Artist, Tier, File] or similar
  const rootId = config.google.driveFolderId;
  let artist = "";
  let qualityTier = "";
  let filePath = "";

  for (let i = 0; i < ancestry.length; i++) {
    const node = ancestry[i];
    if (node.id === rootId) continue;
    if (node.parentId === rootId) {
      artist = node.name;
    } else if (artist && !qualityTier && node.name.toLowerCase().includes("above")) {
      qualityTier = "high";
    } else if (artist && !qualityTier) {
      qualityTier = "standard";
    }
    filePath = filePath ? `${filePath}/${node.name}` : node.name;
  }

  return { artist, qualityTier, filePath };
}

// ══════════════════════════════════════════════════════
// APPROACH 1: Full scan (same as ingest-fast.js logic)
// ══════════════════════════════════════════════════════
async function fullScan(drive) {
  console.log("\n📂 Full Drive scan starting...");
  const ROOT = config.google.driveFolderId;
  const limit = pLimit(30);
  const collected = [];

  // Fetch all artist folders
  console.log("   🔍 Fetching artist folders...");
  const allArtistFolders = [];
  let folderPageToken = null;
  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${ROOT}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken: folderPageToken,
    }), 5, "list artist folders");
    allArtistFolders.push(...(res.data.files || []));
    folderPageToken = res.data.nextPageToken;
    if (allArtistFolders.length % 5000 === 0) {
      console.log(`   📁 ${allArtistFolders.length} artist folders...`);
    }
  } while (folderPageToken);
  console.log(`   ✅ ${allArtistFolders.length} artist folders found`);

  // Scan all artists concurrently
  let artistsDone = 0;
  const startScan = Date.now();

  const tasks = allArtistFolders.map(artist => limit(async () => {
    try {
      const subRes = await withRetry(() => drive.files.list({
        q: `'${artist.id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: "files(id, name)",
        pageSize: 10,
      }), 5, `subfolders ${artist.name}`);

      for (const tier of (subRes.data.files || [])) {
        const qualityTier = tier.name.toLowerCase().includes("above") ? "high" : "standard";
        let imgPageToken = null;

        do {
          const imgRes = await withRetry(() => drive.files.list({
            q: `'${tier.id}' in parents and trashed = false`,
            fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum)",
            pageSize: 1000,
            pageToken: imgPageToken,
          }), 5, `images ${artist.name}/${tier.name}`);

          for (const file of (imgRes.data.files || [])) {
            if (file.name.startsWith("._")) continue;
            if (file.name.toLowerCase().endsWith(".csv")) continue;
            if (!isImageFile(file)) continue;

            const parsed = parseFilename(file.name);
            collected.push({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: parseInt(file.size || "0", 10),
              md5: file.md5Checksum || null,
              path: `${artist.name}/${tier.name}/${file.name}`,
              artist: artist.name,
              qualityTier,
              parsedTitle: parsed.title,
              parsedWidth: parsed.width,
              parsedHeight: parsed.height,
            });
          }
          imgPageToken = imgRes.data.nextPageToken;
        } while (imgPageToken);
      }
    } catch (err) {
      console.error(`   ⚠️  ${artist.name}: ${err.message}`);
    }

    artistsDone++;
    if (artistsDone % 1000 === 0) {
      const elapsed = ((Date.now() - startScan) / 1000).toFixed(0);
      console.log(`   📊 ${artistsDone}/${allArtistFolders.length} artists | ${collected.length} images | ${elapsed}s`);
    }
  }));

  await Promise.all(tasks);
  console.log(`   ✅ Full scan: ${collected.length} images from ${artistsDone} artists in ${((Date.now() - startScan)/1000).toFixed(0)}s`);

  // Get a fresh start page token for future delta syncs
  const tokenRes = await drive.changes.getStartPageToken();
  const startPageToken = tokenRes.data.startPageToken;

  return { files: collected, pageToken: startPageToken };
}

// ══════════════════════════════════════════════════════
// APPROACH 2: Delta sync using Changes API
// ══════════════════════════════════════════════════════
async function deltaScan(drive, savedPageToken) {
  console.log(`\n🔄 Delta scan (changes since token ${savedPageToken})...`);
  const ROOT = config.google.driveFolderId;
  const newFiles = [];
  let pageToken = savedPageToken;
  let changesChecked = 0;
  const parentCache = {};

  while (pageToken) {
    const res = await withRetry(() => drive.changes.list({
      pageToken,
      fields: "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, size, md5Checksum, parents, trashed))",
      pageSize: 1000,
      includeRemoved: false,
      spaces: "drive",
    }), 5, "list changes");

    for (const change of (res.data.changes || [])) {
      changesChecked++;
      if (change.removed || !change.file) continue;
      const file = change.file;
      if (file.trashed) continue;
      if (!isImageFile(file)) continue;
      if (file.name.startsWith("._")) continue;
      if (file.name.toLowerCase().endsWith(".csv")) continue;

      // Check if this file is inside our root folder tree
      // We'll resolve its ancestry to determine artist + tier
      const ancestry = await resolveAncestry(drive, file.id, parentCache);
      if (!ancestry.artist) continue; // Not in our folder structure

      const parsed = parseFilename(file.name);
      newFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: parseInt(file.size || "0", 10),
        md5: file.md5Checksum || null,
        path: ancestry.filePath,
        artist: ancestry.artist,
        qualityTier: ancestry.qualityTier,
        parsedTitle: parsed.title,
        parsedWidth: parsed.width,
        parsedHeight: parsed.height,
      });
    }

    pageToken = res.data.nextPageToken || null;
    if (!pageToken) {
      // Save the new start page token
      pageToken = null;
      const newToken = res.data.newStartPageToken;
      if (newToken) {
        savePageToken(newToken);
      }
    }
  }

  console.log(`   ✅ Delta scan: ${changesChecked} changes checked, ${newFiles.length} new images found`);
  return { files: newFiles };
}

// ══════════════════════════════════════════════════════
// Deduplicate + Insert
// ══════════════════════════════════════════════════════
async function deduplicateAndInsert(files) {
  if (files.length === 0) {
    console.log("   ✅ No new files to insert.");
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  console.log(`\n🔍 Deduplicating ${files.length} files against Supabase...`);

  // Check which drive_file_ids already exist
  const existingIds = new Set();
  const CHECK_BATCH = 500;
  for (let i = 0; i < files.length; i += CHECK_BATCH) {
    const batch = files.slice(i, i + CHECK_BATCH).map(f => f.id);
    const { data: existing } = await supabase
      .from("assets")
      .select("drive_file_id")
      .in("drive_file_id", batch);
    (existing || []).forEach(e => existingIds.add(e.drive_file_id));
  }

  const newFiles = files.filter(f => !existingIds.has(f.id));
  const skipped = files.length - newFiles.length;
  console.log(`   ${existingIds.size} already in DB, ${newFiles.length} new files to insert`);

  if (newFiles.length === 0) {
    return { inserted: 0, skipped, errors: 0 };
  }

  // Process files → records
  const records = [];
  let noDimensions = 0;

  for (const file of newFiles) {
    let widthPx = file.parsedWidth || 0;
    let heightPx = file.parsedHeight || 0;

    if (widthPx === 0 || heightPx === 0) {
      noDimensions++;
      records.push({
        drive_file_id: file.id,
        filename: file.name,
        filepath: file.path,
        mime_type: file.mimeType,
        file_size_bytes: file.size,
        width_px: null,
        height_px: null,
        aspect_ratio: null,
        ratio_class: null,
        max_print_width_cm: null,
        max_print_height_cm: null,
        title: file.parsedTitle || file.name.replace(/\.\w+$/, ""),
        artist: file.artist || null,
        quality_tier: file.qualityTier || null,
        shopify_status: "pending",
        ingestion_status: "analyzed",
        ingestion_error: "No dimensions in filename",
      });
      continue;
    }

    const res = analyzeArtwork(widthPx, heightPx);
    records.push({
      drive_file_id: file.id,
      filename: file.name,
      filepath: file.path,
      mime_type: file.mimeType,
      file_size_bytes: file.size,
      width_px: widthPx,
      height_px: heightPx,
      aspect_ratio: res.aspectRatio || null,
      ratio_class: res.ratioClass || null,
      max_print_width_cm: res.maxPrint?.widthCm || null,
      max_print_height_cm: res.maxPrint?.heightCm || null,
      title: file.parsedTitle || file.name.replace(/\.\w+$/, ""),
      artist: file.artist || null,
      quality_tier: file.qualityTier || null,
      shopify_status: "pending",
      ingestion_status: "analyzed",
    });
  }

  // Batch upsert
  console.log(`\n🚀 Inserting ${records.length} records (batches of ${BATCH_SIZE})...`);
  const insertStart = Date.now();
  let inserted = 0;
  let insertErrors = 0;
  const concurrency = pLimit(5);

  const batchTasks = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    batchTasks.push(concurrency(async () => {
      try {
        const { error } = await supabase
          .from("assets")
          .upsert(batch, { onConflict: "drive_file_id", ignoreDuplicates: true });
        if (error) {
          console.error(`   ❌ Batch: ${error.message.slice(0, 100)}`);
          insertErrors += batch.length;
        } else {
          inserted += batch.length;
        }
      } catch (err) {
        console.error(`   ❌ Batch: ${err.message.slice(0, 100)}`);
        insertErrors += batch.length;
      }
    }));
  }

  await Promise.all(batchTasks);

  const elapsed = ((Date.now() - insertStart) / 1000).toFixed(1);
  console.log(`   ✅ Inserted ${inserted} | Errors: ${insertErrors} | Skipped (existing): ${skipped} | ${elapsed}s`);

  return { inserted, skipped, errors: insertErrors, noDimensions };
}

// ══════════════════════════════════════════════════════
// Main sync function (single run)
// ══════════════════════════════════════════════════════
async function runOnce(forceFullScan = false) {
  if (isRunning) {
    console.log("⚠️  Sync already running, skipping...");
    return { status: "already_running" };
  }

  isRunning = true;
  const startTime = Date.now();
  runCount++;

  try {
    console.log("\n" + "═".repeat(60));
    console.log("📂 NEVERLAND PRINTS — Drive Auto-Sync");
    console.log(`   Run #${runCount} | ${new Date().toISOString()}`);
    console.log("═".repeat(60));

    const drive = await initDrive();
    let files;

    // Check for saved page token (file-based)
    const savedToken = !forceFullScan ? getSavedPageToken() : null;

    if (savedToken && !forceFullScan) {
      // Delta sync — only check changes since last sync
      const delta = await deltaScan(drive, savedToken);
      files = delta.files;
    } else {
      // Full scan — scan everything, then save token for future deltas
      const full = await fullScan(drive);
      files = full.files;
      if (full.pageToken) {
        savePageToken(full.pageToken);
        console.log(`   💾 Saved page token for future delta syncs`);
      }
    }

    // Deduplicate and insert
    const result = await deduplicateAndInsert(files);

    // Get total count
    const { count } = await supabase
      .from("assets")
      .select("*", { count: "exact", head: true });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    totalSynced += result.inserted;
    lastRunTime = new Date().toISOString();
    lastRunResult = {
      ...result,
      totalInDb: count,
      elapsed: `${elapsed}s`,
      mode: savedToken && !forceFullScan ? "delta" : "full",
    };

    console.log("\n" + "═".repeat(60));
    console.log("✅ Drive sync complete!");
    console.log(`   New: ${result.inserted} | Skipped: ${result.skipped} | Errors: ${result.errors}`);
    console.log(`   Total in DB: ${count} | Time: ${elapsed}s`);
    console.log("═".repeat(60) + "\n");

    return lastRunResult;
  } catch (err) {
    console.error("💥 Drive sync error:", err.message);
    lastRunResult = { error: err.message };
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

// ══════════════════════════════════════════════════════
// Persistent watcher (polling loop)
// ══════════════════════════════════════════════════════
async function startWatcher(intervalSec = POLL_INTERVAL) {
  console.log(`\n👁️  Drive watcher starting (polling every ${intervalSec}s)...`);

  // Do an initial run
  await runOnce(false);

  // Then poll at the interval
  watcherInterval = setInterval(async () => {
    try {
      await runOnce(false);
    } catch (e) {
      console.error("❌ Watcher run failed:", e.message);
    }
  }, intervalSec * 1000);

  return watcherInterval;
}

function stopWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    console.log("👁️  Drive watcher stopped.");
  }
}

function getWatcherStatus() {
  return {
    running: isRunning,
    watching: !!watcherInterval,
    pollIntervalSec: POLL_INTERVAL,
    runCount,
    totalSynced,
    lastRunTime,
    lastRunResult,
  };
}

// ══════════════════════════════════════════════════════
// Exports for server integration
// ══════════════════════════════════════════════════════
module.exports = { runOnce, startWatcher, stopWatcher, getWatcherStatus };

// ══════════════════════════════════════════════════════
// Standalone execution
// ══════════════════════════════════════════════════════
if (require.main === module) {
  if (WATCH_MODE) {
    startWatcher(POLL_INTERVAL);
    // Keep process alive
    setInterval(() => {}, 60000);
  } else {
    runOnce(FULL_SCAN).then(() => process.exit(0)).catch(e => {
      console.error("💥", e);
      process.exit(1);
    });
  }
}
