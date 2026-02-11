require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = "2024-10";

function gql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const u = new URL(`https://${STORE}/admin/api/${API}/graphql.json`);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          console.log("GQL status:", res.statusCode);
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("GQL Timeout")); });
    req.write(body);
    req.end();
  });
}

function restDelete(id) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://${STORE}/admin/api/${API}/products/${id}.json`);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "DELETE", headers: { "X-Shopify-Access-Token": TOKEN } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, limit: res.headers["x-shopify-shop-api-call-limit"] }));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("DEL Timeout")); });
    req.end();
  });
}

function restList() {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://${STORE}/admin/api/${API}/products.json?limit=5&fields=id`);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: { "X-Shopify-Access-Token": TOKEN } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d).products.map((p) => p.id)); } catch (e) { resolve([]); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("LIST Timeout")); });
    req.end();
  });
}

async function main() {
  console.log("=== TEST DELETE ===");

  // Step 1: Count
  console.log("1. Counting products...");
  const countRes = await gql("{ productsCount { count } }");
  console.log("   Count:", JSON.stringify(countRes.data));

  // Step 2: List 5
  console.log("2. Listing 5 products...");
  const ids = await restList();
  console.log("   IDs:", ids);

  // Step 3: Delete first one
  if (ids.length > 0) {
    console.log("3. Deleting", ids[0], "...");
    const delRes = await restDelete(ids[0]);
    console.log("   Result:", delRes);
  }

  // Step 4: Delete 3 more sequentially
  for (let i = 1; i < Math.min(4, ids.length); i++) {
    console.log(`4.${i}. Deleting ${ids[i]}...`);
    const delRes = await restDelete(ids[i]);
    console.log("   Result:", delRes);
  }

  console.log("\n=== DONE ===");
}

main().catch((e) => console.error("FATAL:", e));
