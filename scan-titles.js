// Scan the ENTIRE product catalog for titles with leaked pixel dimensions
// ("4038x3091") or duplicate suffixes ("(1)"). Writes bad-titles.json.
require("dotenv").config();
const https = require("https");
const fs = require("fs");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const VER = process.env.SHOPIFY_API_VERSION || "2024-10";

const BAD = [/\d{3,}\s*[xX×]\s*\d{3,}/, /\(\d+\)\s*$/];

function gql(query) {
  return new Promise((resolve) => {
    const b = JSON.stringify({ query });
    const rq = https.request(
      {
        hostname: SHOP,
        path: `/admin/api/${VER}/graphql.json`,
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(b),
        },
      },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); }
    );
    rq.on("error", () => resolve(null));
    rq.write(b);
    rq.end();
  });
}

(async () => {
  let after = null, total = 0, pages = 0;
  const bad = [];

  for (;;) {
    const q = `{ products(first:250${after ? `, after:"${after}"` : ""}){ pageInfo{hasNextPage endCursor} edges{ node{ id title } } } }`;
    const j = await gql(q);

    if (!j || !j.data) {
      // Most likely a throttle — back off and retry the same cursor.
      const msg = j && j.errors ? JSON.stringify(j.errors).slice(0, 120) : "no data";
      console.log(`  retrying after: ${msg}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const es = j.data.products.edges;
    total += es.length;
    es.forEach((e) => {
      const t = e.node.title;
      if (BAD.some((re) => re.test(t))) bad.push({ t, id: e.node.id });
    });

    pages++;
    if (pages % 40 === 0) console.log(`  scanned ${total} products, ${bad.length} malformed so far...`);

    if (!j.data.products.pageInfo.hasNextPage) break;
    after = j.data.products.pageInfo.endCursor;
    await new Promise((r) => setTimeout(r, 120));
  }

  fs.writeFileSync("bad-titles.json", JSON.stringify(bad, null, 1));
  console.log(`\nDONE. total products=${total}  malformed titles=${bad.length}`);
})();
