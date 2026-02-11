/**
 * Shopify Sync Script
 * -------------------
 * Takes assets that have been ingested + tagged in the DB
 * and creates corresponding products in Shopify.
 *
 * Handles:
 *   - 1,000 variants/day limit (after 50k)
 *   - Rate limiting (Shopify 429s)
 *   - Idempotent (safe to re-run)
 *
 * Usage:
 *   npm run sync:shopify
 *   node src/scripts/sync-to-shopify.js --limit=50
 */
const supabase = require("../db/supabase");
const ShopifyService = require("../services/shopify");

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 50;

async function main() {
  console.log("=".repeat(60));
  console.log("🛍️  Neverland Prints — Shopify Sync");
  console.log(`   Batch size: ${limit}`);
  console.log("=".repeat(60));

  const shopify = new ShopifyService();

  // Create pipeline run
  const { data: runData } = await supabase
    .from("pipeline_runs")
    .insert({ run_type: "shopify_sync", status: "running" })
    .select()
    .single();
  const runId = runData?.id;

  try {
    // Fetch assets that are tagged but not yet synced to Shopify
    const { data: assets, error: fetchErr } = await supabase
      .from("assets")
      .select("*")
      .in("ingestion_status", ["tagged", "analyzed", "ready"])
      .eq("shopify_status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (fetchErr) throw fetchErr;

    if (!assets || assets.length === 0) {
      console.log("\n✅ No assets to sync — everything is up to date!");
      return;
    }

    console.log(`\n📦 Found ${assets.length} assets to sync to Shopify\n`);

    let synced = 0;
    let errors = 0;

    for (const asset of assets) {
      try {
        console.log(`[${synced + 1}/${assets.length}] Syncing: "${asset.title || asset.filename}"`);

        // Get variants for this asset
        const { data: variants } = await supabase
          .from("asset_variants")
          .select("*")
          .eq("asset_id", asset.id);

        if (!variants || variants.length === 0) {
          console.log("   ⏭️  No variants — skipping");
          continue;
        }

        // Build a public image URL from Google Drive
        const imageUrl = `https://drive.google.com/uc?export=view&id=${asset.drive_file_id}`;

        // Create product in Shopify
        const product = await shopify.createProduct(asset, variants, imageUrl);

        // Update asset in DB with Shopify IDs
        await supabase
          .from("assets")
          .update({
            shopify_product_id: product.id,
            shopify_product_gid: `gid://shopify/Product/${product.id}`,
            shopify_status: "synced",
            shopify_synced_at: new Date().toISOString(),
            ingestion_status: "ready",
          })
          .eq("id", asset.id);

        // Map Shopify variant IDs back to our variant records
        if (product.variants) {
          for (let i = 0; i < product.variants.length && i < variants.length; i++) {
            await supabase
              .from("asset_variants")
              .update({
                shopify_variant_id: product.variants[i].id,
                shopify_variant_gid: `gid://shopify/ProductVariant/${product.variants[i].id}`,
              })
              .eq("id", variants[i].id);
          }
        }

        synced++;
        console.log(`   ✅ Product #${product.id} created with ${product.variants?.length || 0} variants`);

        // Small delay to stay within rate limits
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        errors++;
        console.error(`   ❌ Error: ${err.message}`);
        await supabase
          .from("assets")
          .update({ shopify_status: "error" })
          .eq("id", asset.id);
      }
    }

    // Finalize
    await supabase
      .from("pipeline_runs")
      .update({
        status: "completed",
        total_items: assets.length,
        processed_items: synced,
        error_count: errors,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    console.log("\n" + "=".repeat(60));
    console.log(`✅ Shopify sync complete!  Synced: ${synced}  |  Errors: ${errors}`);
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
