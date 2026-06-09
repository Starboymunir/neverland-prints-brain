#!/usr/bin/env node
/**
 * Create the price-anchor product on Shopify.
 * ===========================================
 * Dynamic per-artwork pricing needs Shopify to charge many different prices,
 * but Shopify charges a VARIANT's fixed price. So we create one hidden product
 * "Art Print" whose variants ARE the price ladder — one variant per ladder
 * price point. The storefront computes each artwork's price and adds the
 * variant whose price matches (line-item properties carry artwork/size/frame).
 *
 * Writes src/config/price-ladder-map.json:  { "69.99": { variantId, gid, sku }, ... }
 *
 * Idempotent-ish: pass --replace to delete an existing price-anchor product first.
 *
 * Run: node create-price-anchors.js
 */
require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");
const { LADDER } = require("./src/services/pricing");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
const HANDLE = "art-print-dynamic";
const REPLACE = process.argv.includes("--replace");

function graphql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const url = new URL(GQL_URL);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN, "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try { const j = JSON.parse(d); j.errors ? reject(new Error(JSON.stringify(j.errors))) : resolve(j.data); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0, 300)}`)); }
      }); }
    );
    req.on("error", reject); req.write(body); req.end();
  });
}

const cents = (p) => Math.round(p * 100);

async function findExisting() {
  const d = await graphql(`{ products(first: 5, query: "handle:${HANDLE}") { edges { node { id title } } } }`);
  return d.products.edges[0]?.node || null;
}

async function main() {
  if (!STORE || !TOKEN) { console.error("✗ Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_TOKEN"); process.exit(1); }
  console.log(`Store: ${STORE}  |  ladder points: ${LADDER.length}`);

  const existing = await findExisting();
  if (existing && REPLACE) {
    console.log(`Deleting existing ${existing.id} ...`);
    await graphql(`mutation($id: ID!){ productDelete(input:{id:$id}){ deletedProductId userErrors{message} } }`, { id: existing.id });
  } else if (existing) {
    console.error(`✗ Price-anchor product already exists (${existing.id}). Re-run with --replace to recreate.`);
    process.exit(1);
  }

  const mutation = `
    mutation productSet($input: ProductSetInput!) {
      productSet(input: $input) {
        product { id title handle variants(first: 100) { edges { node { id price sku } } } }
        userErrors { field message }
      }
    }`;

  const input = {
    title: "Art Print",
    handle: HANDLE,
    descriptionHtml: "<p>Museum-quality giclée art print on premium 310gsm cotton-rag archival paper. Price reflects the selected size.</p>",
    vendor: "Neverland Prints",
    productType: "Art Print",
    tags: ["price-anchor", "dynamic-pricing", "hidden"],
    status: "ACTIVE",
    productOptions: [
      { name: "Price", values: LADDER.map((p) => ({ name: p.toFixed(2) })) },
    ],
    variants: LADDER.map((p) => ({
      optionValues: [{ optionName: "Price", name: p.toFixed(2) }],
      price: p.toFixed(2),
      sku: `NP-P-${cents(p)}`,
      inventoryPolicy: "CONTINUE",
      taxable: true,
    })),
  };

  console.log(`Creating "Art Print" with ${LADDER.length} price-point variants...`);
  const data = await graphql(mutation, { input });
  const r = data.productSet;
  if (r.userErrors?.length) { console.error("✗ userErrors:", JSON.stringify(r.userErrors, null, 2)); process.exit(1); }

  const product = r.product;
  const map = {};
  for (const e of product.variants.edges) {
    const numericId = e.node.id.replace("gid://shopify/ProductVariant/", "");
    map[parseFloat(e.node.price).toFixed(2)] = { variantId: numericId, variantGid: e.node.id, sku: e.node.sku, price: e.node.price };
  }

  const outPath = path.join(__dirname, "src", "config", "price-ladder-map.json");
  fs.writeFileSync(outPath, JSON.stringify({ productId: product.id, handle: product.handle, count: Object.keys(map).length, ladder: map }, null, 2));

  console.log(`✓ Created ${product.id} with ${Object.keys(map).length} variants`);
  console.log(`✓ Wrote ${outPath}`);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
