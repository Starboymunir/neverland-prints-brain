#!/usr/bin/env node
/**
 * Fix DB mappings by matching JSONL drive_file_id to Shopify result lineNumbers.
 * The fast-db-update may have mapped wrong assets because some were already synced.
 */
require("dotenv").config();
const fs = require("fs");
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
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data).data));
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
  // Step 1: Read the saved JSONL file to get drive_file_ids in order
  const jsonlPath = "bulk-sync-batch-1.jsonl";
  if (!fs.existsSync(jsonlPath)) {
    console.error("JSONL file not found:", jsonlPath);
    process.exit(1);
  }

  console.log("📄 Reading saved JSONL file...");
  const jsonlLines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n");
  console.log(`   ${jsonlLines.length} JSONL lines`);

  // Extract drive_file_id from each JSONL line's metafields
  const driveFileIds = jsonlLines.map((line, i) => {
    try {
      const obj = JSON.parse(line);
      const mf = obj.input?.metafields?.find(m => m.key === "drive_file_id");
      return mf?.value || null;
    } catch {
      return null;
    }
  });

  console.log(`   Extracted ${driveFileIds.filter(Boolean).length} drive_file_ids`);

  // Step 2: Download Shopify results
  console.log("\n📋 Getting bulk operation result...");
  const opData = await graphql(`{
    currentBulkOperation(type: MUTATION) { id status objectCount url }
  }`);
  const op = opData.currentBulkOperation;
  console.log(`   ${op.id} — ${op.status} — ${op.objectCount} objects`);

  if (!op.url) {
    console.error("No result URL");
    process.exit(1);
  }

  console.log("\n📥 Downloading results...");
  const resultData = await downloadUrl(op.url);
  const resultLines = resultData.trim().split("\n").filter(l => l.trim());
  console.log(`   ${resultLines.length} result lines`);

  // Parse results
  const resultMap = new Map(); // lineNumber -> { shopifyGid, shopifyId, variants }
  let parseErrors = 0;
  for (const line of resultLines) {
    try {
      const obj = JSON.parse(line);
      const result = obj.data?.productSet || obj.data?.productCreate;
      if (!result) continue;
      if (result.userErrors?.length > 0) { parseErrors++; continue; }
      const product = result.product;
      if (!product?.id) continue;

      const variantNodes = product.variants?.nodes || [];
      resultMap.set(obj.__lineNumber, {
        shopifyGid: product.id,
        shopifyId: product.id.split("/").pop(),
        title: product.title,
        variants: variantNodes.map(v => ({
          shopifyGid: v.id,
          shopifyId: v.id.split("/").pop(),
          sku: v.sku || "",
        })),
      });
    } catch { parseErrors++; }
  }

  console.log(`   ${resultMap.size} successful products, ${parseErrors} errors`);

  // Step 3: Build the correct mapping: drive_file_id -> Shopify IDs
  const correctMappings = [];
  for (const [lineNum, shopifyData] of resultMap) {
    const driveFileId = driveFileIds[lineNum];
    if (!driveFileId) continue;
    correctMappings.push({ driveFileId, ...shopifyData });
  }
  console.log(`\n🔗 ${correctMappings.length} correct mappings built`);

  // Step 4: First, reset ALL shopify fields for assets that were incorrectly mapped
  console.log("\n🧹 Resetting ALL synced assets from batch 1...");
  
  // Get all drive_file_ids from the JSONL (these are the only assets we should update)
  const validDriveIds = driveFileIds.filter(Boolean);
  
  // Reset in chunks
  for (let i = 0; i < validDriveIds.length; i += 200) {
    const chunk = validDriveIds.slice(i, i + 200);
    await supabase
      .from("assets")
      .update({
        shopify_product_id: null,
        shopify_product_gid: null,
        shopify_status: "pending",
        shopify_synced_at: null,
      })
      .in("drive_file_id", chunk);
    
    if (i % 2000 === 0) console.log(`   Reset ${i}/${validDriveIds.length}`);
  }
  console.log(`   Reset complete`);

  // Also reset variants
  console.log("   Resetting variant Shopify IDs...");
  // Get asset IDs for these drive_file_ids
  const assetIdMap = new Map();
  for (let i = 0; i < validDriveIds.length; i += 200) {
    const chunk = validDriveIds.slice(i, i + 200);
    const { data } = await supabase
      .from("assets")
      .select("id, drive_file_id")
      .in("drive_file_id", chunk);
    if (data) data.forEach(a => assetIdMap.set(a.drive_file_id, a.id));
  }
  console.log(`   Found ${assetIdMap.size} asset IDs`);

  // Step 5: Apply correct mappings in parallel
  console.log(`\n🔧 Applying ${correctMappings.length} correct mappings (concurrency=${CONCURRENCY})...`);
  let synced = 0;
  let errors = 0;
  const startTime = Date.now();

  const chunks = [];
  for (let i = 0; i < correctMappings.length; i += CONCURRENCY) {
    chunks.push(correctMappings.slice(i, i + CONCURRENCY));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (ci % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`   [${elapsed}s] ${ci * CONCURRENCY}/${correctMappings.length}`);
    }

    await Promise.all(chunk.map(async (mapping) => {
      const assetId = assetIdMap.get(mapping.driveFileId);
      if (!assetId) return;

      try {
        // Update asset
        await supabase
          .from("assets")
          .update({
            shopify_product_id: mapping.shopifyId,
            shopify_product_gid: mapping.shopifyGid,
            shopify_status: "synced",
            shopify_synced_at: new Date().toISOString(),
            ingestion_status: "ready",
          })
          .eq("id", assetId);

        // Update variants
        const { data: dbVariants } = await supabase
          .from("asset_variants")
          .select("id, width_cm, height_cm")
          .eq("asset_id", assetId)
          .order("width_cm", { ascending: true });

        if (dbVariants && mapping.variants.length > 0) {
          await Promise.all(
            dbVariants.slice(0, mapping.variants.length).map((dbv, j) => {
              const pricing = calcPrice(dbv);
              return supabase
                .from("asset_variants")
                .update({
                  shopify_variant_id: mapping.variants[j].shopifyId,
                  shopify_variant_gid: mapping.variants[j].shopifyGid,
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

  const { count } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .not("shopify_product_id", "is", null);
  console.log(`   Total correctly synced: ${count}`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
