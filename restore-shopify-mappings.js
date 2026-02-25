#!/usr/bin/env node
/**
 * restore-shopify-mappings.js
 * Fetches all Shopify products with their neverland.drive_file_id metafield
 * and restores shopify_product_id mappings in Supabase.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

async function main() {
  console.log("\n  Fetching all Shopify products with metafields...");

  const products = [];
  let cursor = null;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `{
      products(first: 250${afterClause}) {
        edges {
          node {
            legacyResourceId
            id
            title
            driveFileId: metafield(namespace: "neverland", key: "drive_file_id") {
              value
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`;

    const res = await fetch(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query }),
    });

    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));

    const edges = json.data.products.edges;
    for (const e of edges) {
      const driveFileId = e.node.driveFileId?.value;
      if (driveFileId) {
        products.push({
          shopifyId: e.node.legacyResourceId,
          shopifyGid: e.node.id,
          driveFileId,
        });
      }
    }

    if (products.length % 2500 < 250) {
      process.stdout.write(`\r  Fetched ${products.length} products with metafields...`);
    }

    if (!json.data.products.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  console.log(`\n  Total products with drive_file_id: ${products.length}`);

  // Now match to Supabase assets and restore
  let restored = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < products.length; i += 50) {
    const batch = products.slice(i, i + 50);
    const driveIds = batch.map(p => p.driveFileId);

    // Fetch matching assets
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, drive_file_id")
      .in("drive_file_id", driveIds);

    if (error) { errors++; continue; }

    // Build lookup
    const assetMap = {};
    for (const a of assets) {
      assetMap[a.drive_file_id] = a.id;
    }

    // Update each match
    const updates = [];
    for (const p of batch) {
      const assetId = assetMap[p.driveFileId];
      if (!assetId) { notFound++; continue; }

      updates.push(
        supabase
          .from("assets")
          .update({
            shopify_product_id: parseInt(p.shopifyId),
            shopify_product_gid: p.shopifyGid,
            shopify_status: "synced",
          })
          .eq("id", assetId)
          .then(({ error }) => {
            if (error) errors++;
            else restored++;
          })
      );
    }

    await Promise.all(updates);
    process.stdout.write(`\r  Restored ${restored} | Not found: ${notFound} | Errors: ${errors} | ${i + batch.length}/${products.length}`);
  }

  console.log(`\n\n  ✅ Done!`);
  console.log(`  Restored: ${restored}`);
  console.log(`  Not found in DB: ${notFound}`);
  console.log(`  Errors: ${errors}`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
