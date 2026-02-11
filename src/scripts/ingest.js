/**
 * Ingestion Pipeline
 * ------------------
 * Main script that orchestrates:
 *   1. List images from Google Drive
 *   2. Download each image
 *   3. Extract dimensions + compute variants (Resolution Engine)
 *   4. Run AI tagging (Gemini)
 *   5. Store everything in Supabase
 *   6. (Optionally) sync to Shopify
 *
 * Usage:
 *   npm run ingest            — full run (all images)
 *   npm run ingest:test       — test with 100 images
 *   node src/scripts/ingest.js --test --limit=50
 */
const path = require("path");
const sizeOf = require("image-size");
const pLimit = require("p-limit");

const DriveService = require("../services/drive");
const { analyzeArtwork } = require("../services/resolution-engine");
const AiTagger = require("../services/ai-tagger");
const supabase = require("../db/supabase");

// Parse CLI args
const args = process.argv.slice(2);
const isTest = args.includes("--test");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : isTest ? 100 : Infinity;
const skipAi = args.includes("--skip-ai");
const skipDownload = args.includes("--skip-download");

// Concurrency limiter (be gentle with Drive API)
const concurrency = pLimit(5);

async function main() {
  console.log("=".repeat(60));
  console.log("🚀 Neverland Prints — Ingestion Pipeline");
  console.log(`   Mode: ${isTest ? "TEST" : "FULL"}  |  Limit: ${limit === Infinity ? "none" : limit}`);
  console.log("=".repeat(60));

  // ── Step 0: Create a pipeline run record ──
  const { data: runData } = await supabase
    .from("pipeline_runs")
    .insert({ run_type: "ingestion", status: "running", total_items: 0 })
    .select()
    .single();
  const runId = runData?.id;

  try {
    // ── Step 1: Initialize services ──
    console.log("\n📦 Initializing services...");
    const drive = await new DriveService().init();
    const tagger = skipAi ? null : await new AiTagger().init();

    // ── Step 2: List images from Drive ──
    console.log("\n📂 Listing images from Google Drive...");
    const maxToFetch = limit === Infinity ? 0 : limit;
    let allFiles = await drive.listImagesFast(maxToFetch);
    console.log(`   Found ${allFiles.length} image files`);

    // Apply limit (safety net)
    if (limit !== Infinity && allFiles.length > limit) {
      allFiles = allFiles.slice(0, limit);
      console.log(`   Limited to ${allFiles.length} files for this run`);
    }

    // Update run record
    await supabase
      .from("pipeline_runs")
      .update({ total_items: allFiles.length })
      .eq("id", runId);

    // ── Step 3: Deduplicate by Drive file ID ──
    console.log("\n🔍 Checking for duplicates...");
    const { data: existing } = await supabase
      .from("assets")
      .select("drive_file_id")
      .in(
        "drive_file_id",
        allFiles.map((f) => f.id)
      );
    const existingIds = new Set((existing || []).map((e) => e.drive_file_id));
    const newFiles = allFiles.filter((f) => !existingIds.has(f.id));
    console.log(
      `   ${allFiles.length - newFiles.length} already in DB, ${newFiles.length} new files to process`
    );

    // ── Step 4: Process each file ──
    let processed = 0;
    let errors = 0;

    const tasks = newFiles.map((file) =>
      concurrency(async () => {
        try {
          console.log(`\n🖼️  [${processed + 1}/${newFiles.length}] ${file.name}`);

          // 4a. Try to get dimensions from filename first (faster, no download needed)
          let widthPx = file.parsedWidth || 0;
          let heightPx = file.parsedHeight || 0;
          let localPath = null;
          let contentHash = null;

          if (widthPx > 0 && heightPx > 0) {
            console.log(`   📏 Dimensions from filename: ${widthPx}×${heightPx}px`);
          }

          // 4b. Download only if we need dimensions or AI tagging
          const needsDownload = !skipDownload && (widthPx === 0 || (!skipAi && tagger));
          if (needsDownload) {
            const dl = await drive.downloadFile(file.id, file.name);
            localPath = dl.localPath;
            contentHash = dl.hash;

            // Check for content-level duplicates (same image, different filename)
            if (contentHash) {
              const { data: dupes } = await supabase
                .from("assets")
                .select("id, filename")
                .eq("content_hash", contentHash)
                .limit(1);

              if (dupes && dupes.length > 0) {
                console.log(`   ⏭️  Duplicate of "${dupes[0].filename}" — skipping`);
                processed++;
                return;
              }
            }

            // Get dimensions from actual file if not from filename
            if (widthPx === 0 && localPath) {
              try {
                const dims = sizeOf(localPath);
                widthPx = dims.width;
                heightPx = dims.height;
              } catch (dimErr) {
                console.log(`   ⚠️  Could not read dimensions: ${dimErr.message}`);
              }
            }
          }

          // 4c. Resolution Engine
          let resolutionData = {};
          if (widthPx > 0 && heightPx > 0) {
            resolutionData = analyzeArtwork(widthPx, heightPx);
            console.log(
              `   📐 ${widthPx}×${heightPx}px → ${resolutionData.ratioClass} → ${resolutionData.variants.length} variants`
            );
          }

          // 4d. AI Tagging
          let aiData = {};
          if (tagger && localPath) {
            console.log("   🤖 Running AI tagger...");
            aiData = await tagger.tagImage(localPath, file.name);
            console.log(`   🏷️  "${aiData.title}" | ${aiData.style} | ${aiData.era} | ${aiData.palette}`);
          }

          // 4e. Insert asset into DB
          const assetRecord = {
            drive_file_id: file.id,
            filename: file.name,
            filepath: file.path,
            mime_type: file.mimeType,
            file_size_bytes: file.size,
            width_px: widthPx || null,
            height_px: heightPx || null,
            aspect_ratio: resolutionData.aspectRatio || null,
            ratio_class: resolutionData.ratioClass || null,
            max_print_width_cm: resolutionData.maxPrint?.widthCm || null,
            max_print_height_cm: resolutionData.maxPrint?.heightCm || null,
            title: aiData.title || file.parsedTitle || file.name.replace(/\.[^.]+$/, ""),
            description: aiData.description || null,
            style: aiData.style || null,
            era: aiData.era || null,
            palette: aiData.palette || null,
            mood: aiData.mood || null,
            subject: aiData.subject || null,
            ai_tags: aiData.tags || [],
            content_hash: contentHash,
            artist: file.artist || null,
            quality_tier: file.qualityTier || null,
            ingestion_status: widthPx > 0 ? (tagger ? "tagged" : "analyzed") : "downloaded",
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("assets")
            .insert(assetRecord)
            .select()
            .single();

          if (insertErr) throw insertErr;

          // 4f. Insert variants
          if (resolutionData.variants && resolutionData.variants.length > 0 && inserted) {
            const variantRows = resolutionData.variants.map((v) => ({
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
              console.log(`   ⚠️  Variant insert error: ${varErr.message}`);
            }
          }

          processed++;
          console.log(`   ✅ Done`);
        } catch (err) {
          errors++;
          console.error(`   ❌ Error processing ${file.name}: ${err.message}`);

          // Still record the asset with an error status
          await supabase.from("assets").upsert(
            {
              drive_file_id: file.id,
              filename: file.name,
              filepath: file.path,
              ingestion_status: "error",
              ingestion_error: err.message,
            },
            { onConflict: "drive_file_id" }
          );
        }

        // Update run progress
        await supabase
          .from("pipeline_runs")
          .update({ processed_items: processed, error_count: errors })
          .eq("id", runId);
      })
    );

    await Promise.all(tasks);

    // ── Step 5: Finalize ──
    await supabase
      .from("pipeline_runs")
      .update({
        status: errors > 0 ? "completed_with_errors" : "completed",
        processed_items: processed,
        error_count: errors,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    console.log("\n" + "=".repeat(60));
    console.log(`✅ Ingestion complete!`);
    console.log(`   Processed: ${processed}  |  Errors: ${errors}  |  Skipped (dupes): ${newFiles.length - processed - errors}`);
    console.log("=".repeat(60));
  } catch (fatalErr) {
    console.error("\n💥 Fatal error:", fatalErr);
    if (runId) {
      await supabase
        .from("pipeline_runs")
        .update({ status: "failed", finished_at: new Date().toISOString() })
        .eq("id", runId);
    }
    process.exit(1);
  }
}

main();
