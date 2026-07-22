// Clean malformed product titles: strip leaked pixel dimensions ("4038x3091")
// and duplicate-suffixes ("(1)"). Conservative on purpose — it does NOT try to
// re-punctuate dates or fix capitalisation, only removes junk that leaked in
// from the source filenames.
//
//   node fix-titles.js          # dry run, writes title-fixes.json
//   node fix-titles.js --apply  # actually update Shopify
require("dotenv").config();
const https = require("https");
const fs = require("fs");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const APPLY = process.argv.includes("--apply");

function clean(t) {
  return t
    .replace(/\s*\d{3,}\s*[xX×]\s*\d{3,}\s*/g, " ") // pixel dimensions
    .replace(/\s*\(\d+\)\s*$/, "")                        // trailing (1) / (2)
    .replace(/\s+\d\s*$/, "")                             // bare trailing digit
    .replace(/\s{2,}/g, " ")
    .trim();
}

function gql(query, variables) {
  return new Promise((resolve) => {
    const b = JSON.stringify({ query, variables });
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
  const bad = JSON.parse(fs.readFileSync("bad-titles.json", "utf8"));
  const fixes = bad
    .map((b) => ({ id: b.id, from: b.t, to: clean(b.t) }))
    .filter((f) => f.to && f.to !== f.from);

  fs.writeFileSync("title-fixes.json", JSON.stringify(fixes, null, 1));

  console.log(`${bad.length} malformed -> ${fixes.length} will be cleaned`);
  console.log("\nSAMPLE:");
  fixes.slice(0, 10).forEach((f) => console.log(`  ${JSON.stringify(f.from)}\n    -> ${JSON.stringify(f.to)}`));

  // Flag artworks that collapse to the same title — these are genuine duplicates
  // in the catalog, not a titling problem.
  const counts = {};
  fixes.forEach((f) => { counts[f.to] = (counts[f.to] || 0) + 1; });
  const dupes = Object.entries(counts).filter(([, v]) => v > 1);
  if (dupes.length) {
    console.log(`\nDUPLICATE artworks (same title after cleaning) — ${dupes.length}:`);
    dupes.forEach(([k, v]) => console.log(`   ${v}x  ${k}`));
  }

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to update Shopify.");
    return;
  }

  console.log("\nApplying...");
  let ok = 0, fail = 0;
  for (const f of fixes) {
    const r = await gql(
      `mutation($input: ProductInput!){ productUpdate(input:$input){ product{ id title } userErrors{ field message } } }`,
      { input: { id: f.id, title: f.to } }
    );
    const errs = r && r.data && r.data.productUpdate && r.data.productUpdate.userErrors;
    if (r && r.data && r.data.productUpdate && r.data.productUpdate.product && (!errs || !errs.length)) {
      ok++;
    } else {
      fail++;
      console.log("  FAILED:", f.from, JSON.stringify(errs || (r && r.errors) || "unknown").slice(0, 160));
    }
    await new Promise((r2) => setTimeout(r2, 220)); // stay under API rate limit
  }
  console.log(`\nDone. updated=${ok} failed=${fail}`);
})();
