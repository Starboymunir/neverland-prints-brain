/**
 * Ingestion Pipeline v2 — Zero-Download
 * ======================================
 * Processes Google Drive images WITHOUT downloading them.
 *
 * How it works:
 *   1. List images from Google Drive (recursive folder scan)
 *   2. Get pixel dimensions from:
 *      a) Filename pattern (e.g. "Title_10057x12926.jpg") — instant
 *      b) Drive API imageMediaMetadata — no download needed
 *   3. Run Resolution Engine (ratio classification + variant generation)
 *   4. AI tagging via lh3 preview URL (fetches small 800px preview, NOT full file)
 *   5. Store everything in Supabase
 *
 * Key improvement: NO full-size image downloads for 90k+ assets.
 * Saves ~1.5TB of bandwidth and hours of processing time.
 *
 * Usage:
 *   node src/scripts/ingest-v2.js                           # full run (all images)
 *   node src/scripts/ingest-v2.js --limit=100               # test batch
 *   node src/scripts/ingest-v2.js --limit=100 --skip-ai     # skip AI tagging
 *   node src/scripts/ingest-v2.js --limit=500 --offset=100  # resume from offset
 *   node src/scripts/ingest-v2.js --artist="John Smith"     # single artist
 *   node src/scripts/ingest-v2.js --retag-errors             # re-tag errored assets
 */

require("dotenv").config();
const pLimit = require("p-limit");
const DriveService = require("../services/drive");
const { analyzeArtwork } = require("../services/resolution-engine");
const AiTagger = require("../services/ai-tagger");
const ImageProxy = require("../services/image-proxy");
const supabase = require("../db/supabase");

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "0", 10); // 0 = no limit
const OFFSET = parseInt(getArg("offset") || "0", 10);
const SKIP_AI = hasFlag("skip-ai");
const RETAG_ERRORS = hasFlag("retag-errors");
const ARTIST_FILTER = getArg("artist");
const CONCURRENCY = parseInt(getArg("concurrency") || "10", 10);
const DRY_RUN = hasFlag("dry-run");

// Concurrency limiters
const driveConcurrency = pLimit(CONCURRENCY);
const aiConcurrency = pLimit(3); // Gemini free tier: ~15 RPM, so 3 concurrent is safe

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🚀 NEVERLAND PRINTS — Ingestion v2 (Zero-Download)");
  console.log("═".repeat(60));
  console.log(`  Limit: ${LIMIT || "ALL"} | Offset: ${OFFSET} | AI: ${SKIP_AI ? "SKIP" : "ON"}`);
  console.log(`  Concurrency: ${CONCURRENCY} | Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  if (ARTIST_FILTER) console.log(`  Artist filter: "${ARTIST_FILTER}"`);
  if (RETAG_ERRORS) console.log(`  Re-tagging errored assets`);
  console.log("═".repeat(60) + "\n");

  // ── Handle re-tagging mode ──────────────────────────────
  if (RETAG_ERRORS) {
    return await retagErrors();
  }

  // ── Step 0: Create pipeline run record ──────────────────
  const { data: runData } = await supabase
    .from("pipeline_runs")
    .insert({ run_type: "ingestion_v2", status: "running", total_items: 0 })
    .select()
    .single();
  const runId = runData?.id;

  try {
    // ── Step 1: Initialize services ──────────────────────
    console.log("📦 Initializing services...");
    const drive = await new DriveService().init();
    const imageProxy = await new ImageProxy().init();
    const tagger = SKIP_AI ? null : await new AiTagger().init();

    // ── Step 2: List images from Drive ───────────────────
    console.log("\n📂 Scanning Google Drive...");
    const maxToFetch = LIMIT > 0 ? LIMIT + OFFSET : 0;
    let allFiles = await drive.listImagesFast(maxToFetch);
    console.log(`   Found ${allFiles.length} image files`);

    // Apply artist filter
    if (ARTIST_FILTER) {
      allFiles = allFiles.filter(f => 
        f.artist.toLowerCase().includes(ARTIST_FILTER.toLowerCase())
      );
      console.log(`   Filtered to ${allFiles.length} files for artist "${ARTIST_FILTER}"`);
    }

    // Apply offset and limit
    if (OFFSET > 0) {
      allFiles = allFiles.slice(OFFSET);
      console.log(`   Skipped ${OFFSET} files (offset)`);
    }
    if (LIMIT > 0 && allFiles.length > LIMIT) {
      allFiles = allFiles.slice(0, LIMIT);
      console.log(`   Limited to ${allFiles.length} files`);
    }

    // Deduplicate file list (same Drive ID can appear in multiple artist folders)
    const seenDriveIds = new Set();
    const beforeDedup = allFiles.length;
    allFiles = allFiles.filter(f => {
      if (seenDriveIds.has(f.id)) return false;
      seenDriveIds.add(f.id);
      return true;
    });
    if (beforeDedup !== allFiles.length) {
      console.log(`   Removed ${beforeDedup - allFiles.length} duplicate Drive IDs (same image in multiple folders)`);
    }

    // Update run record
    if (runId) {
      await supabase
        .from("pipeline_runs")
        .update({ total_items: allFiles.length })
        .eq("id", runId);
    }

    // ── Step 3: Deduplicate against DB ───────────────────
    console.log("\n🔍 Checking for duplicates...");
    const batchSize = 500;
    const existingIds = new Set();

    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize).map(f => f.id);
      const { data: existing } = await supabase
        .from("assets")
        .select("drive_file_id")
        .in("drive_file_id", batch);
      (existing || []).forEach(e => existingIds.add(e.drive_file_id));
    }

    const newFiles = allFiles.filter(f => !existingIds.has(f.id));
    const skippedCount = allFiles.length - newFiles.length;
    console.log(`   ${skippedCount} already in DB, ${newFiles.length} new files to process`);

    if (newFiles.length === 0) {
      console.log("\n✅ All files already ingested!");
      if (runId) {
        await supabase.from("pipeline_runs").update({
          status: "completed", processed_items: 0, finished_at: new Date().toISOString()
        }).eq("id", runId);
      }
      return;
    }

    if (DRY_RUN) {
      console.log("\n🏃 DRY RUN — would process these files:");
      newFiles.slice(0, 20).forEach(f => console.log(`   ${f.artist} / ${f.name}`));
      if (newFiles.length > 20) console.log(`   ... and ${newFiles.length - 20} more`);
      return;
    }

    // ── Step 4: Process each file ────────────────────────
    let processed = 0;
    let errors = 0;
    const startTime = Date.now();

    const tasks = newFiles.map((file, idx) =>
      driveConcurrency(async () => {
        const num = idx + 1;
        try {
          // 4a. Get dimensions — from filename first, then Drive API
          let widthPx = file.parsedWidth || 0;
          let heightPx = file.parsedHeight || 0;

          if (widthPx > 0 && heightPx > 0) {
            // Dimensions from filename — fastest path
          } else {
            // Use Drive API imageMediaMetadata — NO download needed
            try {
              const meta = await imageProxy.getImageMetadata(file.id);
              widthPx = meta.width || 0;
              heightPx = meta.height || 0;
            } catch (metaErr) {
              console.log(`   ⚠️  [${num}] Can't get dimensions for "${file.name}": ${metaErr.message}`);
            }
          }

          if (widthPx === 0 || heightPx === 0) {
            console.log(`   ⏭️  [${num}] "${file.name}" — no dimensions, skipping`);
            errors++;
            await supabase.from("assets").upsert({
              drive_file_id: file.id,
              filename: file.name,
              filepath: file.path,
              artist: file.artist || null,
              quality_tier: file.qualityTier || null,
              ingestion_status: "error",
              ingestion_error: "Could not determine image dimensions",
            }, { onConflict: "drive_file_id" });
            return;
          }

          // 4b. Resolution Engine
          const resolutionData = analyzeArtwork(widthPx, heightPx);

          // 4c. AI Tagging (via lh3 preview URL — no download)
          let aiData = {};
          if (tagger) {
            try {
              aiData = await aiConcurrency(() => tagger.tagByDriveId(file.id, file.name));
            } catch (aiErr) {
              console.log(`   ⚠️  [${num}] AI tagging failed: ${aiErr.message}`);
              aiData = tagger._fallbackResult ? tagger._fallbackResult(file.name, aiErr.message) : {};
            }
          }

          // 4d. Insert asset into DB
          const assetRecord = {
            drive_file_id: file.id,
            filename: file.name,
            filepath: file.path,
            mime_type: file.mimeType,
            file_size_bytes: file.size,
            width_px: widthPx,
            height_px: heightPx,
            aspect_ratio: resolutionData.aspectRatio || null,
            ratio_class: resolutionData.ratioClass || null,
            max_print_width_cm: resolutionData.maxPrint?.widthCm || null,
            max_print_height_cm: resolutionData.maxPrint?.heightCm || null,
            title: aiData.title || file.parsedTitle || file.name.replace(/\.\w+$/, ""),
            description: aiData.description || null,
            style: aiData.style || null,
            era: aiData.era || null,
            palette: aiData.palette || null,
            mood: aiData.mood || null,
            subject: aiData.subject || null,
            ai_tags: aiData.tags || [],
            artist: file.artist || null,
            quality_tier: file.qualityTier || null,
            shopify_status: "pending",
            ingestion_status: tagger ? (aiData._error ? "analyzed" : "tagged") : "analyzed",
            ingestion_error: aiData._error || null,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("assets")
            .upsert(assetRecord, { onConflict: "drive_file_id" })
            .select()
            .single();

          if (insertErr) throw insertErr;

          // 4e. Insert variants (delete old ones first if upserting)
          if (resolutionData.variants?.length > 0 && inserted) {
            // Remove existing variants for this asset (in case of upsert)
            await supabase.from("asset_variants").delete().eq("asset_id", inserted.id);
            const variantRows = resolutionData.variants.map(v => ({
              asset_id: inserted.id,
              label: v.label,
              width_cm: v.width_cm,
              height_cm: v.height_cm,
              width_inches: v.width_inches,
              height_inches: v.height_inches,
              effective_dpi: v.effective_dpi,
              quality_grade: v.quality_grade,
            }));

            const { error: varErr } = await supabase
              .from("asset_variants")
              .insert(variantRows);

            if (varErr) {
              console.log(`   ⚠️  [${num}] Variant insert error: ${varErr.message}`);
            }
          }

          processed++;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const rate = (processed / (elapsed || 1)).toFixed(1);
          const variantCount = resolutionData.variants?.length || 0;
          
          if (processed % 10 === 0 || processed === newFiles.length) {
            console.log(`   ✅ [${num}/${newFiles.length}] ${processed} done | ${rate}/s | ${file.artist} — "${assetRecord.title}" (${variantCount} variants)`);
          }
        } catch (err) {
          errors++;
          console.error(`   ❌ [${num}] "${file.name}": ${err.message.slice(0, 100)}`);
          await supabase.from("assets").upsert({
            drive_file_id: file.id,
            filename: file.name,
            filepath: file.path,
            artist: file.artist || null,
            quality_tier: file.qualityTier || null,
            ingestion_status: "error",
            ingestion_error: err.message.slice(0, 500),
          }, { onConflict: "drive_file_id" });
        }

        // Update run progress periodically
        if (runId && (processed + errors) % 25 === 0) {
          await supabase.from("pipeline_runs").update({
            processed_items: processed, error_count: errors
          }).eq("id", runId);
        }
      })
    );

    await Promise.all(tasks);

    // ── Step 5: Finalize ──────────────────────────────────
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    if (runId) {
      await supabase.from("pipeline_runs").update({
        status: errors > 0 ? "completed_with_errors" : "completed",
        processed_items: processed,
        error_count: errors,
        finished_at: new Date().toISOString(),
        metadata: { total_time_seconds: parseFloat(totalTime), skipped_dupes: skippedCount },
      }).eq("id", runId);
    }

    console.log("\n" + "═".repeat(60));
    console.log(`✅ Ingestion complete!`);
    console.log(`   Processed: ${processed} | Errors: ${errors} | Skipped: ${skippedCount}`);
    console.log(`   Time: ${totalTime}s | Rate: ${(processed / (totalTime || 1)).toFixed(1)}/s`);
    if (tagger) console.log(`   AI Stats: ${JSON.stringify(tagger.getStats())}`);
    console.log("═".repeat(60) + "\n");
  } catch (fatalErr) {
    console.error("\n💥 Fatal error:", fatalErr);
    if (runId) {
      await supabase.from("pipeline_runs").update({
        status: "failed", finished_at: new Date().toISOString()
      }).eq("id", runId);
    }
    process.exit(1);
  }
}

/**
 * Re-tag assets that had AI tagging errors.
 */
async function retagErrors() {
  console.log("🔄 Re-tagging errored assets...\n");

  const tagger = await new AiTagger().init();

  const { data: assets, error } = await supabase
    .from("assets")
    .select("*")
    .eq("ingestion_status", "analyzed")
    .not("drive_file_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(LIMIT || 100);

  if (error) throw error;
  if (!assets?.length) {
    console.log("✅ No assets need re-tagging!");
    return;
  }

  console.log(`📦 ${assets.length} assets to re-tag\n`);

  let retagged = 0;
  let errors = 0;

  for (const asset of assets) {
    try {
      const aiData = await tagger.tagByDriveId(asset.drive_file_id, asset.filename);
      if (aiData._error) {
        errors++;
        console.log(`   ❌ "${asset.filename}": ${aiData._error}`);
        continue;
      }

      await supabase.from("assets").update({
        title: aiData.title,
        description: aiData.description,
        style: aiData.style,
        era: aiData.era,
        palette: aiData.palette,
        mood: aiData.mood,
        subject: aiData.subject,
        ai_tags: aiData.tags,
        ingestion_status: "tagged",
        ingestion_error: null,
      }).eq("id", asset.id);

      retagged++;
      console.log(`   ✅ "${aiData.title}" → ${aiData.style} | ${aiData.mood} | ${aiData.palette}`);

      // Respect Gemini rate limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      errors++;
      console.error(`   ❌ "${asset.filename}": ${err.message}`);
    }
  }

  console.log(`\n✅ Re-tagged: ${retagged} | Errors: ${errors}`);
}

main().catch(e => { console.error("💥", e); process.exit(1); });
