/**
 * AI Tagging Script (standalone)
 * ------------------------------
 * Run AI tagging on assets that have been downloaded/analyzed
 * but not yet tagged.
 *
 * Usage:
 *   npm run tag:ai
 *   node src/scripts/run-ai-tagging.js --limit=100
 */
const path = require("path");
const fs = require("fs");
const pLimit = require("p-limit");
const supabase = require("../db/supabase");
const AiTagger = require("../services/ai-tagger");

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 100;

const concurrency = pLimit(3); // Gemini rate limits

async function main() {
  console.log("=".repeat(60));
  console.log("🤖 Neverland Prints — AI Tagging");
  console.log(`   Batch size: ${limit}`);
  console.log("=".repeat(60));

  const tagger = await new AiTagger().init();

  // Fetch assets that need tagging
  const { data: assets, error } = await supabase
    .from("assets")
    .select("*")
    .in("ingestion_status", ["downloaded", "analyzed"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  if (!assets || assets.length === 0) {
    console.log("\n✅ No assets need tagging.");
    return;
  }

  console.log(`\n🏷️  Found ${assets.length} assets to tag\n`);

  let tagged = 0;
  let errors = 0;

  const tasks = assets.map((asset) =>
    concurrency(async () => {
      try {
        // Find the downloaded file
        const downloadDir = path.join(process.cwd(), "downloads");
        const localPath = path.join(downloadDir, asset.drive_file_id + "_" + asset.filename);

        if (!fs.existsSync(localPath)) {
          console.log(`   ⏭️  File not found locally: ${asset.filename} — skipping`);
          return;
        }

        console.log(`[${tagged + 1}/${assets.length}] Tagging: ${asset.filename}`);
        const metadata = await tagger.tagImage(localPath, asset.filename);

        await supabase
          .from("assets")
          .update({
            title: metadata.title,
            description: metadata.description,
            style: metadata.style,
            era: metadata.era,
            palette: metadata.palette,
            mood: metadata.mood,
            subject: metadata.subject,
            ai_tags: metadata.tags,
            ingestion_status: "tagged",
            updated_at: new Date().toISOString(),
          })
          .eq("id", asset.id);

        tagged++;
        console.log(`   🏷️  "${metadata.title}" | ${metadata.style} | ${metadata.era}`);
      } catch (err) {
        errors++;
        console.error(`   ❌ Error tagging ${asset.filename}: ${err.message}`);
      }
    })
  );

  await Promise.all(tasks);

  console.log("\n" + "=".repeat(60));
  console.log(`✅ Tagging complete!  Tagged: ${tagged}  |  Errors: ${errors}`);
  console.log("=".repeat(60));
}

main().catch(console.error);
