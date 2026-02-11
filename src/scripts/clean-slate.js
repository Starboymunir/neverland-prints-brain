/**
 * Neverland Prints — Clean Slate
 * Deletes ALL products from Shopify and resets DB.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const BASE = `https://${SHOP}/admin/api/2024-10`;

async function api(method, ep) {
  const r = await fetch(`${BASE}${ep}`, { method, headers: { "X-Shopify-Access-Token": TOKEN } });
  if (r.status === 429) { await new Promise(r => setTimeout(r, 2000)); return api(method, ep); }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : null;
}

async function main() {
  // Delete all products
  let deleted = 0;
  while (true) {
    const { products } = await api("GET", "/products.json?limit=250");
    if (!products || products.length === 0) break;
    for (const p of products) {
      await api("DELETE", `/products/${p.id}.json`);
      deleted++;
      process.stdout.write(`\rDeleted ${deleted} products...`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(`\n✅ Deleted ${deleted} products`);

  // Delete custom collections (except Home page)
  const { custom_collections } = await api("GET", "/custom_collections.json?limit=250");
  for (const c of (custom_collections || [])) {
    if (c.handle !== "frontpage") {
      await api("DELETE", `/custom_collections/${c.id}.json`);
      console.log(`Deleted collection: ${c.title}`);
    }
  }

  // Delete smart collections
  const { smart_collections } = await api("GET", "/smart_collections.json?limit=250");
  for (const c of (smart_collections || [])) {
    await api("DELETE", `/smart_collections/${c.id}.json`);
    console.log(`Deleted smart collection: ${c.title}`);
  }

  // Reset DB
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  await sb.from("assets").update({
    shopify_status: "pending",
    shopify_product_id: null,
    shopify_product_gid: null,
    shopify_synced_at: null,
    ingestion_error: null,
  }).neq("id", "00000000-0000-0000-0000-000000000000"); // match all
  
  await sb.from("asset_variants").update({
    shopify_variant_id: null,
    shopify_variant_gid: null,
    base_price: null,
  }).neq("id", "00000000-0000-0000-0000-000000000000");

  console.log("✅ Database reset");
  const { count } = await sb.from("assets").select("*", { count: "exact", head: true });
  console.log(`📦 ${count} assets ready for fresh sync`);
}

main().catch(e => { console.error(e); process.exit(1); });
