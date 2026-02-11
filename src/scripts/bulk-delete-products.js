#!/usr/bin/env node
/**
 * Bulk Delete All Products
 * ========================
 * Deletes ALL products from Shopify using REST API.
 * Sequential with rate-limit pacing. ~120 deletes/min.
 *
 * Run: node src/scripts/bulk-delete-products.js
 */

process.on("unhandledRejection", (err) => { console.error("UNHANDLED:", err); process.exit(1); });
process.on("uncaughtException", (err) => { console.error("UNCAUGHT:", err); process.exit(1); });

require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || "2024-10";
const BASE = `https://${STORE}/admin/api/${API}`;

const CONCURRENCY = 4; // 4 parallel deletes — safe with 40-bucket, 2/sec refill

let deleted = 0, skipped = 0, errors = 0;

function request(method, urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: { "X-Shopify-Access-Token": TOKEN },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        const limit = res.headers["x-shopify-shop-api-call-limit"] || "";
        const [used, max] = limit.split("/").map(Number);
        resolve({ status: res.statusCode, body: d, available: (max || 40) - (used || 0), retryAfter: res.headers["retry-after"] });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function gql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const u = new URL(`${BASE}/graphql.json`);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("gql timeout")); });
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listIds() {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await request("GET", `${BASE}/products.json?limit=250&fields=id`);
      if (res.status === 429) { await sleep(2000); continue; }
      return JSON.parse(res.body).products.map((p) => p.id);
    } catch (e) {
      console.log("  list error:", e.message);
      await sleep(2000);
    }
  }
  return [];
}

async function del(id) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await request("DELETE", `${BASE}/products/${id}.json`);
      if (res.status === 429) {
        await sleep(parseFloat(res.retryAfter || "2") * 1000);
        continue;
      }
      if (res.status === 200) { deleted++; return res.available; }
      if (res.status === 404) { skipped++; return res.available; }
      errors++;
      return 40;
    } catch (e) {
      if (i === 2) errors++;
      else await sleep(1000);
    }
  }
  return 40;
}

async function main() {
  console.log("=== BULK DELETE ALL PRODUCTS ===");
  console.log("Store:", STORE);

  const cnt = await gql("{ productsCount { count } }");
  const total = cnt.data?.productsCount?.count || 0;
  console.log("Products:", total);
  if (total === 0) { console.log("Done!"); return; }

  const t0 = Date.now();
  let batch = 0;

  while (true) {
    batch++;
    const ids = await listIds();
    if (ids.length === 0) break;

    // Delete in concurrent chunks
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map((id) => del(id)));

      // Pace based on worst bucket level in this chunk
      const minAvail = Math.min(...results);
      if (minAvail < 3) await sleep(2000);
      else if (minAvail < 6) await sleep(800);
      else if (minAvail < 12) await sleep(300);
      else if (minAvail < 20) await sleep(100);

      // Progress every ~50 deletes
      const done = deleted + skipped;
      if (done > 0 && done % 50 < CONCURRENCY) {
        const sec = (Date.now() - t0) / 1000;
        const rate = (done / sec * 60).toFixed(0);
        const eta = ((total - done) / (done / sec) / 60).toFixed(1);
        console.log(`[${done}/${total}] ${deleted} del ${skipped} skip ${errors} err | ${rate}/min | ~${eta}min left`);
      }
    }
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nDONE in ${sec}s. Deleted: ${deleted}, Skipped: ${skipped}, Errors: ${errors}`);

  const final = await gql("{ productsCount { count } }");
  const rem = final.data?.productsCount?.count || 0;
  console.log("Remaining:", rem);
  if (rem === 0) console.log("All clear! Run: node src/scripts/create-skeleton-products.js");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
