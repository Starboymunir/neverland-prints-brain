/**
 * Publish All Products to Online Store
 * =====================================
 * Fixes products that are "active" but not published to the
 * Online Store sales channel (published_at = null).
 *
 * Usage:
 *   node src/scripts/publish-products.js
 */

require("dotenv").config();
const config = require("../config");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopifyREST(method, endpoint, body = null, retries = 5) {
  const url = `${BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      const wait = parseFloat(res.headers.get("Retry-After") || "4") * 1000;
      console.log(`  ⏳ Rate limited, waiting ${wait}ms...`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      if (attempt === retries) throw new Error(`${method} ${endpoint}: ${res.status} — ${txt}`);
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Publish All Products to Online Store");
  console.log("═══════════════════════════════════════\n");

  if (!SHOP || !TOKEN) {
    console.error("Missing env vars");
    process.exit(1);
  }

  let published = 0;
  let skipped = 0;
  let failed = 0;
  let page = 0;
  let nextPageInfo = null;

  while (true) {
    page++;
    let endpoint = "/products.json?limit=250&fields=id,title,published_at,status";
    if (nextPageInfo) {
      endpoint = `/products.json?limit=250&page_info=${nextPageInfo}`;
    }

    // Use link-based pagination
    let url = `${BASE}/products.json?limit=250&fields=id,title,published_at,status`;
    if (nextPageInfo) {
      url = nextPageInfo; // nextPageInfo is the full URL
    }

    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": TOKEN },
    });

    if (!res.ok) {
      console.error("Failed to fetch products:", res.status, await res.text());
      break;
    }

    const data = await res.json();
    const products = data.products || [];

    if (products.length === 0) break;

    console.log(`\n📦 Page ${page}: ${products.length} products`);

    // Process batch
    const unpublished = products.filter((p) => !p.published_at && p.status === "active");
    const alreadyPublished = products.length - unpublished.length;
    skipped += alreadyPublished;

    if (unpublished.length > 0) {
      console.log(`  Publishing ${unpublished.length} unpublished products...`);
    }

    for (const p of unpublished) {
      try {
        await shopifyREST("PUT", `/products/${p.id}.json`, {
          product: { id: p.id, published: true },
        });
        published++;
        if (published % 50 === 0) {
          console.log(`  ✅ Published ${published} so far...`);
        }
        // Small delay to avoid rate limits
        await sleep(80);
      } catch (err) {
        console.error(`  ❌ Failed ${p.id}: ${err.message}`);
        failed++;
      }
    }

    // Check for next page via Link header
    const linkHeader = res.headers.get("Link");
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        nextPageInfo = match[1];
      } else {
        break;
      }
    } else {
      break;
    }
  }

  console.log("\n═══════════════════════════════════════");
  console.log(`  ✅ Published: ${published}`);
  console.log(`  ⏭️  Already published: ${skipped}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log("═══════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
