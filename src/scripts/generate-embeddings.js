/**
 * Embedding Generation Script
 * ============================
 * Generates text embeddings for all assets in the database.
 * Run after ingestion to enable vector similarity search.
 *
 * Usage:
 *   node src/scripts/generate-embeddings.js              # all un-embedded assets
 *   node src/scripts/generate-embeddings.js --limit=500  # first 500
 *   node src/scripts/generate-embeddings.js --force       # re-embed everything
 *   node src/scripts/generate-embeddings.js --status      # show stats
 */

require("dotenv").config();
const supabase = require("../db/supabase");
const EmbeddingService = require("../services/embedding");

async function main() {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || null;
  const force = args.includes("--force");
  const statusOnly = args.includes("--status");

  // Show stats
  if (statusOnly) {
    const { count: totalAssets } = await supabase
      .from("assets")
      .select("*", { count: "exact", head: true });

    const { count: embedded } = await supabase
      .from("asset_embeddings")
      .select("*", { count: "exact", head: true });

    console.log(`\n📊 Embedding Status:`);
    console.log(`   Total assets:   ${totalAssets}`);
    console.log(`   With embedding: ${embedded}`);
    console.log(`   Missing:        ${totalAssets - embedded}`);
    console.log(`   Coverage:       ${((embedded / totalAssets) * 100).toFixed(1)}%\n`);
    return;
  }

  console.log("🧠 Initializing Embedding Service...");
  const embedder = new EmbeddingService();
  await embedder.init();

  // Get assets that need embeddings
  let query = supabase
    .from("assets")
    .select("id, title, artist, style, mood, palette, subject, era, ratio_class, description, ai_tags");

  if (!force) {
    // Only assets without embeddings
    // Use a left join approach
    const { data: alreadyEmbedded } = await supabase
      .from("asset_embeddings")
      .select("asset_id");

    const embeddedIds = (alreadyEmbedded || []).map((e) => e.asset_id);
    if (embeddedIds.length > 0) {
      // Filter by NOT IN — Supabase doesn't have NOT IN directly for large sets
      // So we fetch all assets and filter in JS
      query = query.order("created_at", { ascending: true });
    }
  }

  if (limit) {
    query = query.limit(limit);
  } else {
    query = query.limit(10000); // Process in batches
  }

  const { data: assets, error } = await query;

  if (error) {
    console.error("❌ Error fetching assets:", error.message);
    process.exit(1);
  }

  // Filter out already embedded if not force mode
  let toEmbed = assets;
  if (!force) {
    const { data: alreadyEmbedded } = await supabase
      .from("asset_embeddings")
      .select("asset_id");

    const embeddedSet = new Set((alreadyEmbedded || []).map((e) => e.asset_id));
    toEmbed = assets.filter((a) => !embeddedSet.has(a.id));
  }

  if (toEmbed.length === 0) {
    console.log("✅ All assets already have embeddings!");
    return;
  }

  console.log(`\n🔄 Generating embeddings for ${toEmbed.length} assets...\n`);
  const startTime = Date.now();

  const { processed, errors } = await embedder.embedAssets(toEmbed, {
    onProgress: (done, errs, total) => {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = done / elapsed;
      const eta = ((total - done) / rate).toFixed(0);
      process.stdout.write(
        `\r   ✅ ${done}/${total} embedded (${errors} errors) | ${rate.toFixed(1)}/s | ETA: ${eta}s`
      );
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n🏁 Done! ${processed} embedded, ${errors} errors in ${elapsed}s\n`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
