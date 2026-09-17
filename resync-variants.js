/**
 * resync-variants.js — align every product's "Size" variants (price + size label)
 * to the dynamic pricing engine, IN PLACE (no variant creation → no daily cap).
 * Fixes the divergence where bypass checkouts (Shop Pay / channels) sold the old,
 * underpriced Size variants while the JS storefront sold the dynamic price.
 * Only touches products whose first option is "Size"; single-variant "Title"
 * skeletons are handled by normalize-product-prices.js and are skipped here.
 *
 *   node resync-variants.js --apply --limit=500 [--after-id=<uuid>]
 */
require("dotenv").config();
const https = require("https");
const pricing = require("./src/services/pricing");
const SHOP = process.env.SHOPIFY_STORE_DOMAIN, TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN, VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const APPLY = args.includes("--apply");
const TIER = { small: "Small", medium: "Medium", large: "Large", extra_large: "Extra Large" };

function gql(q, v) { return new Promise((resolve) => { const b = JSON.stringify({ query: q, variables: v }); const rq = https.request({ hostname: SHOP, path: `/admin/api/${VER}/graphql.json`, method: "POST", headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }, timeout: 30000 }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); }); rq.on("error", () => resolve(null)); rq.on("timeout", () => { rq.destroy(); resolve(null); }); rq.write(b); rq.end(); }); }
function supaRows(qs) { return new Promise((resolve) => { const u = new URL(SU + "/rest/v1/" + qs); const rq = https.request({ hostname: u.hostname, path: u.pathname + u.search, timeout: 30000, headers: { apikey: SK, Authorization: "Bearer " + SK } }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { if (x.statusCode >= 200 && x.statusCode < 300) { try { const j = JSON.parse(d); return resolve(Array.isArray(j) ? j : null); } catch (e) { return resolve(null); } } resolve(null); }); }); rq.on("error", () => resolve(null)); rq.on("timeout", () => { rq.destroy(); resolve(null); }); rq.end(); }); }

async function resyncProduct(asset) {
  const gid = `gid://shopify/Product/${asset.shopify_product_id}`;
  let info;
  for (let a = 0; a < 4 && !info; a++) { info = await gql(`{ product(id:"${gid}"){ options{ name } variants(first:12){ edges{ node{ id price selectedOptions{ name value } } } } } }`); if (!info) await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
  const prod = info && info.data && info.data.product;
  if (!prod) return { skip: "no-product" };
  const opt0 = prod.options && prod.options[0] && prod.options[0].name;
  if (opt0 !== "Size") return { skip: "not-size" }; // Title skeletons handled elsewhere
  const map = pricing.computePriceMap(asset.max_print_width_cm, asset.max_print_height_cm);
  const updates = [];
  for (const e of prod.variants.edges) {
    const v = e.node;
    const sizeVal = (v.selectedOptions.find((o) => o.name === "Size") || {}).value || "";
    const tierKey = Object.keys(TIER).find((k) => sizeVal.toLowerCase().startsWith(TIER[k].toLowerCase()));
    if (!tierKey) continue;
    const t = map[`${tierKey}_unframed`];
    if (!t) continue;
    const label = `${TIER[tierKey]} — ${t.dims.widthCm} × ${t.dims.heightCm} cm`;
    if (v.price === t.price.toFixed(2) && sizeVal === label) continue; // already synced
    updates.push({ id: v.id, price: t.price.toFixed(2), optionValues: [{ optionName: "Size", name: label }] });
  }
  if (!updates.length) return { skip: "already" };
  for (let a = 0; a < 5; a++) {
    const r = await gql(`mutation($pid:ID!,$vars:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid,variants:$vars){ userErrors{ message } } }`, { pid: gid, vars: updates });
    const errStr = r && r.errors ? JSON.stringify(r.errors) : "";
    if (/THROTTLED|being modified|try again/i.test(errStr)) { await new Promise((res) => setTimeout(res, 1500 * (a + 1))); continue; }
    const ue = r && r.data && r.data.productVariantsBulkUpdate && r.data.productVariantsBulkUpdate.userErrors;
    if (r && r.data && r.data.productVariantsBulkUpdate && (!ue || !ue.length)) return { ok: updates.length };
    return { error: (errStr || JSON.stringify(ue) || "unknown").slice(0, 150) };
  }
  return { error: "retry-give-up" };
}

async function runBatch(afterId, limit) {
  const CONC = 6;
  let rows = null;
  for (let a = 0; a < 6 && rows === null; a++) { rows = await supaRows(`assets?select=id,shopify_product_id,max_print_width_cm,max_print_height_cm&shopify_product_id=not.is.null&max_print_width_cm=not.is.null${afterId ? `&id=gt.${afterId}` : ""}&order=id.asc&limit=${limit}`); if (rows === null) await new Promise((r) => setTimeout(r, 2000 * (a + 1))); }
  if (rows === null) { console.error("FETCH_FAILED"); process.exit(1); }
  let done = 0, skipped = 0, failed = 0, idx = 0;
  async function worker() { while (idx < rows.length) { const asset = rows[idx++]; const r = await resyncProduct(asset); if (r.ok) done++; else if (r.skip) skipped++; else { failed++; if (failed <= 8) console.log("  FAIL", asset.shopify_product_id, r.error); } await new Promise((res) => setTimeout(res, 80)); } }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  const lastId = rows.length ? rows[rows.length - 1].id : (afterId || "");
  console.log(`resynced ${done} | skipped ${skipped} | failed ${failed} | scanned ${rows.length}`);
  console.log(`RESUME_AFTER=${lastId}`);
  console.log(`SCANNED=${rows.length}`);
}

(async () => {
  if (!APPLY) { console.log("Add --apply to write."); return; }
  await runBatch(getArg("after-id") || "", parseInt(getArg("limit") || "500", 10) || 500);
})();
