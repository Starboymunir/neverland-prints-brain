/**
 * FAST Ingestion Pipeline — Bulk Insert
 * ======================================
 * Processes Google Drive images at maximum speed by:
 *   1. Scanning all Drive files (uses optimized fast scanner)
 *   2. Deduplicating against existing DB records
 *   3. Processing files locally (filename parsing, resolution engine)
 *   4. BATCH upserting to Supabase (500 at a time) instead of 1-by-1
 *   5. Skipping variants and Drive API metadata calls for speed
 *
 * Speed: ~500-1000 files/sec vs old ~10/sec (50-100x faster)
 *
 * Usage:
 *   node src/scripts/ingest-fast.js              # full run
 *   node src/scripts/ingest-fast.js --limit=100  # test batch
 *   node src/scripts/ingest-fast.js --dry-run    # preview only
 */

require("dotenv").config();
const pLimit = require("p-limit");
const DriveService = require("../services/drive");
const { analyzeArtwork } = require("../services/resolution-engine");
const supabase = require("../db/supabase");

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "0", 10);
const DRY_RUN = hasFlag("dry-run");
const BATCH_SIZE = parseInt(getArg("batch-size") || "500", 10);

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("⚡ NEVERLAND PRINTS — FAST Ingestion (Bulk Insert)");
  console.log("═".repeat(60));
  console.log(`  Batch size: ${BATCH_SIZE} | Limit: ${LIMIT || "ALL"} | Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log("═".repeat(60) + "\n");

  // ── Step 1: Initialize Drive ───────────────────────────
  console.log("📦 Initializing...");
  const drive = await new DriveService().init();

  // ── Step 2: Scan Drive ─────────────────────────────────
  console.log("\n📂 Scanning Google Drive...");
  const maxToFetch = LIMIT > 0 ? LIMIT : 0;
  let allFiles = await drive.listImagesFast(maxToFetch);
  console.log(`   Found ${allFiles.length} image files in Drive`);

  // Deduplicate file list
  const seenDriveIds = new Set();
  allFiles = allFiles.filter(f => {
    if (seenDriveIds.has(f.id)) return false;
    seenDriveIds.add(f.id);
    return true;
  });

  if (LIMIT > 0 && allFiles.length > LIMIT) {
    allFiles = allFiles.slice(0, LIMIT);
  }

  // ── Step 3: Deduplicate against DB ─────────────────────
  console.log("\n🔍 Checking for existing records...");
  const existingIds = new Set();
  const checkBatchSize = 500;

  for (let i = 0; i < allFiles.length; i += checkBatchSize) {
    const batch = allFiles.slice(i, i + checkBatchSize).map(f => f.id);
    const { data: existing } = await supabase
      .from("assets")
      .select("drive_file_id")
      .in("drive_file_id", batch);
    (existing || []).forEach(e => existingIds.add(e.drive_file_id));

    if ((i / checkBatchSize) % 50 === 0 && i > 0) {
      console.log(`   ... checked ${i} files (${existingIds.size} already in DB)`);
    }
  }

  const newFiles = allFiles.filter(f => !existingIds.has(f.id));
  console.log(`   ${existingIds.size} already in DB, ${newFiles.length} NEW files to ingest`);

  if (newFiles.length === 0) {
    console.log("\n✅ All files already ingested!");
    return;
  }

  if (DRY_RUN) {
    console.log("\n🏃 DRY RUN — would process these files:");
    newFiles.slice(0, 20).forEach(f => console.log(`   ${f.artist} / ${f.name}`));
    if (newFiles.length > 20) console.log(`   ... and ${newFiles.length - 20} more`);
    return;
  }

  // ── Step 4: Pre-process all files locally ──────────────
  console.log("\n⚙️  Pre-processing files (resolution engine)...");
  const startTime = Date.now();
  let noDimensions = 0;

  const records = [];
  for (const file of newFiles) {
    let widthPx = file.parsedWidth || 0;
    let heightPx = file.parsedHeight || 0;

    if (widthPx === 0 || heightPx === 0) {
      noDimensions++;
      // Still insert — just without resolution data
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

  const prepTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   Pre-processed ${records.length} records in ${prepTime}s (${noDimensions} without dimensions)`);

  // ── Step 5: Batch upsert to Supabase ──────────────────
  console.log(`\n🚀 Bulk inserting ${records.length} records (batches of ${BATCH_SIZE})...`);
  const insertStart = Date.now();
  let inserted = 0;
  let insertErrors = 0;
  const totalBatches = Math.ceil(records.length / BATCH_SIZE);
  const concurrency = pLimit(5); // 5 concurrent batch inserts

  const batchTasks = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = records.slice(i, i + BATCH_SIZE);
    
    batchTasks.push(concurrency(async () => {
      try {
        const { data, error } = await supabase
          .from("assets")
          .upsert(batch, { onConflict: "drive_file_id", ignoreDuplicates: true });

        if (error) {
          console.error(`   ❌ Batch ${batchNum}/${totalBatches}: ${error.message.slice(0, 100)}`);
          insertErrors += batch.length;
        } else {
          inserted += batch.length;
        }
      } catch (err) {
        console.error(`   ❌ Batch ${batchNum}/${totalBatches}: ${err.message.slice(0, 100)}`);
        insertErrors += batch.length;
      }

      if (batchNum % 10 === 0 || batchNum === totalBatches) {
        const elapsed = ((Date.now() - insertStart) / 1000).toFixed(0);
        const rate = (inserted / (elapsed || 1)).toFixed(0);
        const pct = ((batchNum / totalBatches) * 100).toFixed(1);
        console.log(`   📦 Batch ${batchNum}/${totalBatches} | ${inserted} inserted | ${insertErrors} errors | ${pct}% | ${rate}/s | ${elapsed}s`);
      }
    }));
  }

  await Promise.all(batchTasks);

  const insertTime = ((Date.now() - insertStart) / 1000).toFixed(1);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "═".repeat(60));
  console.log("✅ FAST Ingestion Complete!");
  console.log(`   Inserted: ${inserted} | Errors: ${insertErrors} | Skipped: ${existingIds.size}`);
  console.log(`   No dimensions: ${noDimensions}`);
  console.log(`   Insert time: ${insertTime}s | Total time: ${totalTime}s`);
  console.log(`   Rate: ${(inserted / (insertTime || 1)).toFixed(0)} records/sec`);
  console.log("═".repeat(60) + "\n");

  // Verify final count
  const { count } = await supabase
    .from("assets")
    .select("*", { count: "exact", head: true });
  console.log(`📊 Total assets in Supabase: ${count}`);
}

main().catch(e => { console.error("💥 Fatal:", e); process.exit(1); });
