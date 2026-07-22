// Precompute the featured collection's artworks (in collection order) so the
// catalog can pin them even when the backend can't reach the Shopify Admin API.
//   node build-featured.js [collection-handle]
require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const HANDLE = process.argv[2] || process.env.FEATURED_COLLECTION_HANDLE || "iconic-art-prints";
const OUT = path.join(__dirname, "src", "config", "featured-assets.json");

function gql(query) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify({ query });
    const rq = https.request(
      { hostname: SHOP, path: `/admin/api/${VER}/graphql.json`, method: "POST",
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) } },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
    );
    rq.on("error", reject); rq.write(b); rq.end();
  });
}

function supa(qs) {
  return new Promise((resolve) => {
    const u = new URL(SU + qs);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { apikey: SK, Authorization: "Bearer " + SK } },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve([]); } }); }
    ).on("error", () => resolve([])).end();
  });
}

(async () => {
  console.log(`Collection: ${HANDLE}`);

  const productIds = [];
  let after = null;
  for (let i = 0; i < 40; i++) {
    const j = await gql(`{ collectionByHandle(handle: ${JSON.stringify(HANDLE)}) {
      products(first: 250${after ? `, after: ${JSON.stringify(after)}` : ""}) {
        pageInfo { hasNextPage endCursor }
        edges { node { legacyResourceId } } } } }`);
    const col = j && j.data && j.data.collectionByHandle;
    if (!col) { console.error("Collection not found or API error:", JSON.stringify(j).slice(0, 200)); process.exit(1); }
    col.products.edges.forEach((e) => productIds.push(String(e.node.legacyResourceId)));
    if (!col.products.pageInfo.hasNextPage) break;
    after = col.products.pageInfo.endCursor;
  }
  console.log(`  products in collection: ${productIds.length}`);

  // Map to asset ids, preserving the collection's ordering.
  const byProduct = {};
  for (let i = 0; i < productIds.length; i += 150) {
    const chunk = productIds.slice(i, i + 150);
    const rows = await supa(`/rest/v1/assets?select=id,shopify_product_id&shopify_product_id=in.(${chunk.join(",")})`);
    (Array.isArray(rows) ? rows : []).forEach((a) => { byProduct[String(a.shopify_product_id)] = a.id; });
  }
  const assetIds = productIds.map((p) => byProduct[p]).filter(Boolean);
  console.log(`  matched assets: ${assetIds.length}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ handle: HANDLE, count: assetIds.length, assetIds }, null, 1));
  console.log(`  wrote ${OUT}`);
})();
