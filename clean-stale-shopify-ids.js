#!/usr/bin/env node
/**
 * clean-stale-shopify-ids.js
 * Finds Shopify product IDs in Supabase that no longer exist on Shopify and clears them.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

async function fetchAllShopifyProductIds() {
  const validIds = new Set();
  let cursor = null;
  let page = 0;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `{ products(first: 250${afterClause}) { edges { node { legacyResourceId } cursor } pageInfo { hasNextPage } } }`;

    const res = await fetch(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query }),
    });

    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));

    const edges = json.data.products.edges;
    edges.forEach(e => validIds.add(e.node.legacyResourceId));
    page++;

    if (page % 10 === 0) process.stdout.write(`\r  Fetched ${validIds.size} Shopify products...`);
    if (!json.data.products.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  console.log(`\n  Total valid Shopify products: ${validIds.size}`);
  return validIds;
}

async function main() {
  console.log("\n  Fetching all Shopify product IDs...");
  const validIds = await fetchAllShopifyProductIds();

  const { count } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .not("shopify_product_id", "is", null);
  console.log(`  DB assets with shopify_product_id: ${count}`);

  // Find stale IDs
  const staleIds = [];
  let offset = 0;
  while (offset < count) {
    const { data } = await supabase
      .from("assets")
      .select("id, shopify_product_id")
      .not("shopify_product_id", "is", null)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    for (const a of data) {
      if (!validIds.has(a.shopify_product_id)) staleIds.push(a.id);
    }
    offset += data.length;
    process.stdout.write(`\r  Scanned ${offset}/${count}...`);
  }
  console.log(`\n  Stale IDs to clean: ${staleIds.length}`);

  if (staleIds.length === 0) {
    console.log("  ✅ No stale IDs found!");
    return;
  }

  // Clean in batches
  let cleaned = 0;
  for (let i = 0; i < staleIds.length; i += 500) {
    const batch = staleIds.slice(i, i + 500);
    const { error } = await supabase
      .from("assets")
      .update({ shopify_product_id: null })
      .in("id", batch);
    if (error) console.log(`  Error: ${error.message}`);
    else cleaned += batch.length;
    process.stdout.write(`\r  Cleaned ${cleaned}/${staleIds.length}`);
  }
  console.log(`\n  ✅ Done! Cleaned ${cleaned} stale IDs`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
