// Upload specific theme section files to the live (main) theme.
//   node upload-sections.js sections/footer.liquid sections/collection-carousel.liquid
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");

const shop = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-10";
const LOCAL_ROOT = path.join(__dirname, "neverland-theme");

function api(method, reqPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request(
      {
        hostname: shop,
        path: `/admin/api/${apiVersion}${reqPath}`,
        method,
        headers: Object.assign(
          { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
          body ? { "Content-Length": Buffer.byteLength(body) } : {}
        ),
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
          catch (e) { resolve({ status: res.statusCode, json: null, raw: d }); }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error("Usage: node upload-sections.js sections/foo.liquid [...]");
    process.exit(1);
  }

  const themes = await api("GET", "/themes.json");
  const live = (themes.json.themes || []).find((t) => t.role === "main");
  if (!live) { console.error("No live theme found"); process.exit(1); }
  console.log(`Live theme: ${live.name} (${live.id})\n`);

  for (const key of targets) {
    const local = path.join(LOCAL_ROOT, key);
    if (!fs.existsSync(local)) { console.log(`  SKIP ${key} (not found locally)`); continue; }
    const value = fs.readFileSync(local, "utf8");
    const r = await api("PUT", `/themes/${live.id}/assets.json`, { asset: { key, value } });
    if (r.status === 200) {
      console.log(`  ✅ ${key} (${value.length} bytes)`);
    } else {
      console.log(`  ❌ ${key} -> HTTP ${r.status}`, JSON.stringify(r.json || r.raw).slice(0, 300));
    }
    await new Promise((res) => setTimeout(res, 600));
  }
})();
