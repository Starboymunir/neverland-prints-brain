// Quick concurrent delete test
require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = "2024-10";
const BASE = `https://${STORE}/admin/api/${API}`;

function req(method, urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: { "X-Shopify-Access-Token": TOKEN } },
      (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          const [used, max] = (res.headers["x-shopify-shop-api-call-limit"] || "0/40").split("/").map(Number);
          resolve({ status: res.statusCode, body: d, avail: max - used });
        });
      }
    );
    r.on("error", reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error("timeout")); });
    r.end();
  });
}

async function main() {
  // Get 50 IDs
  console.log("Fetching 50 product IDs...");
  const res = await req("GET", `${BASE}/products.json?limit=50&fields=id`);
  const ids = JSON.parse(res.body).products.map(p => p.id);
  console.log(`Got ${ids.length} IDs`);

  // Delete 10 at a time
  const t0 = Date.now();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    console.log(`Deleting chunk [${i}-${i + chunk.length - 1}]...`);
    const results = await Promise.all(chunk.map(async (id) => {
      const r = await req("DELETE", `${BASE}/products/${id}.json`);
      return { id, status: r.status, avail: r.avail };
    }));
    results.forEach(r => console.log(`  ${r.id}: ${r.status} (bucket: ${r.avail})`));
    
    const minAvail = Math.min(...results.map(r => r.avail));
    if (minAvail < 10) {
      console.log(`  Pausing (bucket low: ${minAvail})...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDeleted ${ids.length} in ${elapsed}s (${(ids.length / elapsed * 60).toFixed(0)}/min)`);
}

main().catch(e => console.error("ERROR:", e));
