#!/usr/bin/env node
/**
 * Fast parallel DB updater for bulk sync results.
 * Downloads results from Shopify's bulk operation and updates Supabase in parallel.
 */
require("dotenv").config();
const https = require("https");
const supabase = require("../db/supabase");
const config = require("../config");

const SHOP = config.shopify.storeDomain;
const TOKEN = config.shopify.adminApiToken;
const API_VERSION = config.shopify.apiVersion || "2024-10";
const CONCURRENCY = 30;

function calcPrice(variant) {
  const area = (variant.width_cm || 0) * (variant.height_cm || 0);
  if (area <= 600) return { price: "29.99", compareAt: "39.99" };
  if (area <= 1800) return { price: "49.99", compareAt: "64.99" };
  if (area <= 4000) return { price: "79.99", compareAt: "99.99" };
  return { price: "119.99", compareAt: "149.99" };
}

async function graphql(query) {
  const body = JSON.stringify({ query });
  return new Promise((resolve, reject) => {
    const url = new URL(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data);
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  console.log("📋 Getting bulk operation result URL...");

  // Get the last bulk operation result
  const opData = await graphql(`{
    currentBulkOperation(type: MUTATION) {
      id status objectCount url
    }
  }`);

  const op = opData.currentBulkOperation;
  console.log(`   Operation: ${op.id}`);
  console.log(`   Status: ${op.status}`);
  console.log(`   Objects: ${op.objectCount}`);

  if (!op.url) {
    console.log("   No result URL available.");
    return;
  }

  console.log("\n📥 Downloading results...");
  const resultData = await downloadUrl(op.url);
  const lines = resultData.trim().split("\n").filter(l => l.trim());
  console.log(`   Got ${lines.length} result lines`);

  // Parse results
  const productResults = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const result = obj.data?.productSet || obj.data?.productCreate;
      if (!result) continue;
      if (result.userErrors?.length > 0) { parseErrors++; continue; }
      const product = result.product;
      if (!product?.id) continue;

      const variantNodes = product.variants?.nodes || product.variants?.edges?.map(e => e.node) || [];
      productResults.push({
        lineNumber: obj.__lineNumber,
        shopifyGid: product.id,
        shopifyId: product.id.split("/").pop(),
        title: product.title,
        variants: variantNodes.map(v => ({
          shopifyGid: v.id,
          shopifyId: v.id.split("/").pop(),
          sku: v.sku || "",
        })),
      });
    } catch (e) { parseErrors++; }
  }

  console.log(`   Parsed ${productResults.length} products (${parseErrors} errors)`);

  // Load ALL pending assets in the same order as JSONL was generated
  console.log("\n📦 Loading assets from DB...");
  let allAssets = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("assets")
      .select("id, drive_file_id")
      .is("shopify_product_id", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    if (!data?.length) break;
    allAssets = allAssets.concat(data);
    offset += 1000;
    if (allAssets.length >= 15000) break; // We only need first batch worth
  }
  console.log(`   Loaded ${allAssets.length} pending assets`);

  // Also check already-synced by checking how many were done partially
  const { count: syncedCount } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .not("shopify_product_id", "is", null);
  console.log(`   Already synced: ${syncedCount}`);

  if (allAssets.length < productResults.length) {
    console.log(`   ⚠️ More results than pending assets — some results may be from already-synced assets`);
    console.log(`   Will match by lineNumber anyway...`);
  }

  // Process DB updates in parallel chunks
  console.log(`\n🔧 Updating DB in parallel (concurrency=${CONCURRENCY})...`);
  let synced = 0;
  let errors = 0;
  const startTime = Date.now();

  const chunks = [];
  for (let i = 0; i < productResults.length; i += CONCURRENCY) {
    chunks.push(productResults.slice(i, i + CONCURRENCY));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (ci % 25 === 0 || ci === chunks.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`   [${elapsed}s] ${ci * CONCURRENCY}/${productResults.length} updated...`);
    }

    await Promise.all(chunk.map(async (product) => {
      const asset = allAssets[product.lineNumber];
      if (!asset) return;

      try {
        await supabase
          .from("assets")
          .update({
            shopify_product_id: product.shopifyId,
            shopify_product_gid: product.shopifyGid,
            shopify_status: "synced",
            shopify_synced_at: new Date().toISOString(),
            ingestion_status: "ready",
          })
          .eq("id", asset.id);

        const { data: dbVariants } = await supabase
          .from("asset_variants")
          .select("id, label, width_cm")
          .eq("asset_id", asset.id)
          .order("width_cm", { ascending: true });

        if (dbVariants) {
          await Promise.all(
            dbVariants.slice(0, product.variants.length).map((dbv, j) => {
              const pricing = calcPrice(dbv);
              return supabase
                .from("asset_variants")
                .update({
                  shopify_variant_id: product.variants[j].shopifyId,
                  shopify_variant_gid: product.variants[j].shopifyGid,
                  base_price: parseFloat(pricing.price),
                })
                .eq("id", dbv.id);
            })
          );
        }

        synced++;
      } catch (err) {
        errors++;
      }
    }));
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done! ${synced} synced, ${errors} errors in ${totalTime}s`);

  // Final check
  const { count: finalSynced } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .not("shopify_product_id", "is", null);
  console.log(`   Total synced in DB: ${finalSynced}`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
