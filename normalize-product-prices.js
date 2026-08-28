/**
 * Normalize a product's Shopify variants to the dynamic area-based tiers so the
 * NATIVE Shopify data (Google Shopping feed, Shopify search/AI, native product
 * page) matches what the custom storefront shows.
 *
 * For each product: compute tiers from the artwork's max print size (same
 * pricing.js engine the storefront uses), then set the product's variants to
 * one "Size" option with those cm sizes, prices, and compare-at ("was") prices.
 *
 *   node normalize-product-prices.js --handle=the-hoosier-don-quixote-1905        # one product
 *   node normalize-product-prices.js --handle=... --apply                          # actually write
 *   node normalize-product-prices.js --limit=200 --apply                           # batch (needs a source list; see runBatch)
 */
require("dotenv").config();
const https = require("https");
const pricing = require("./src/services/pricing");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const VER = process.env.SHOPIFY_API_VERSION || "2024-10";
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const APPLY = args.includes("--apply");
const HANDLE = getArg("handle");

const TIER_ORDER = ["small", "medium", "large", "extra_large"];
const TIER_LABEL = { small: "Small", medium: "Medium", large: "Large", extra_large: "Extra Large" };

function gql(query, variables) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify({ query, variables });
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
    const u = new URL(SU + "/rest/v1/" + qs);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, headers: { apikey: SK, Authorization: "Bearer " + SK } },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve([]); } }); }
    ).on("error", () => resolve([])).end();
  });
}

// "was" price: consistent ~30% markup, charm-rounded to .99, always > price.
function wasPrice(price) {
  const was = Math.round(price * 1.3) - 0.01;
  return (was > price ? was : price + 10).toFixed(2);
}

// Build the target tier list (dedup identical sizes from the print-limit clamp).
function targetTiers(maxW, maxH) {
  const map = pricing.computePriceMap(maxW, maxH);
  const seen = new Set();
  const tiers = [];
  for (const t of TIER_ORDER) {
    const info = map[`${t}_unframed`];
    if (!info) continue;
    const size = `${info.dims.widthCm} × ${info.dims.heightCm} cm`;
    if (seen.has(size)) continue; // dedup: XL clamped to same as Large, etc.
    seen.add(size);
    tiers.push({
      optionValue: `${TIER_LABEL[t]} — ${size}`,
      price: info.price.toFixed(2),
      compareAt: wasPrice(info.price),
    });
  }
  return tiers;
}

async function normalize(handle) {
  const j = await gql(`{ productByHandle(handle: ${JSON.stringify(handle)}) {
      id title
      metafield(namespace:"neverland", key:"drive_file_id"){ value }
      options { id name }
      variants(first:20){ edges { node { id } } }
  } }`);
  const p = j && j.data && j.data.productByHandle;
  if (!p) return { handle, error: "not found" };
  const drive = p.metafield && p.metafield.value;
  if (!drive) return { handle, error: "no drive_file_id (skip)" };

  const asset = (await supa(`assets?select=max_print_width_cm,max_print_height_cm&drive_file_id=eq.${drive}&limit=1`))[0];
  if (!asset || !asset.max_print_width_cm) return { handle, error: "no dimensions" };

  const tiers = targetTiers(asset.max_print_width_cm, asset.max_print_height_cm);
  if (!tiers.length) return { handle, error: "no priceable tiers" };

  console.log(`\n${p.title}`);
  tiers.forEach((t) => console.log(`   ${t.optionValue.padEnd(28)} $${t.price} (was ${t.compareAt})`));

  if (!APPLY) return { handle, tiers: tiers.length, dryRun: true };

  // productSet declaratively replaces the product's options + variants in one call.
  const input = {
    id: p.id,
    productOptions: [{ name: "Size", values: tiers.map((t) => ({ name: t.optionValue })) }],
    variants: tiers.map((t) => ({
      optionValues: [{ optionName: "Size", name: t.optionValue }],
      price: t.price,
      compareAtPrice: t.compareAt,
    })),
  };
  const r = await gql(
    `mutation($input: ProductSetInput!){ productSet(synchronous:true, input:$input){ product{ id } userErrors{ field message } } }`,
    { input }
  );
  const errs = r && r.data && r.data.productSet && r.data.productSet.userErrors;
  if (r && r.data && r.data.productSet && r.data.productSet.product && (!errs || !errs.length)) {
    return { handle, tiers: tiers.length, applied: true };
  }
  return { handle, error: JSON.stringify(errs || (r && r.errors) || "unknown").slice(0, 200) };
}

// The current pricing model version. Bump this whenever pricing.js changes so a
// re-run re-prices everything. A product is "done" only when its stored
// price_version matches — structure alone is NOT enough (old runs left the
// Size/cm structure but with stale prices, which is the bug we're fixing).
const PRICE_VERSION = "v3-2026-08"; // v3 = price + AI description in one pass
function isNormalized(node) {
  return !!(node.pv && node.pv.value === PRICE_VERSION);
}

async function normalizeById(node) {
  const drive = node.metafield && node.metafield.value;
  if (!drive) return { skip: "no-drive" };
  const asset = (await supa(`assets?select=max_print_width_cm,max_print_height_cm,description&drive_file_id=eq.${drive}&limit=1`))[0];
  if (!asset || !asset.max_print_width_cm) return { skip: "no-dims" };
  const tiers = targetTiers(asset.max_print_width_cm, asset.max_print_height_cm);
  if (!tiers.length) return { skip: "no-tiers" };
  const input = {
    id: node.id,
    productOptions: [{ name: "Size", values: tiers.map((t) => ({ name: t.optionValue })) }],
    variants: tiers.map((t) => ({ optionValues: [{ optionName: "Size", name: t.optionValue }], price: t.price, compareAtPrice: t.compareAt })),
    metafields: [{ namespace: "neverland", key: "price_version", type: "single_line_text_field", value: PRICE_VERSION }],
  };
  // Also push the good AI description into the native Shopify body, so Google
  // Shopping / Shop app / ads / AI shop show it (they read Shopify, not our JS).
  const desc = (asset.description || "").trim();
  if (desc) input.descriptionHtml = `<p>${desc.replace(/[<>]/g, "")}</p>`;
  const r = await gql(`mutation($input: ProductSetInput!){ productSet(synchronous:true, input:$input){ product{ id } userErrors{ message } } }`, { input });
  const errs = r && r.data && r.data.productSet && r.data.productSet.userErrors;
  if (r && r.data && r.data.productSet && r.data.productSet.product && (!errs || !errs.length)) return { ok: true };
  return { error: JSON.stringify(errs || (r && r.errors) || "unknown").slice(0, 150) };
}

async function runBatch(limit) {
  let after = null, scanned = 0, done = 0, skipped = 0, failed = 0, alreadyOk = 0;
  const MAX = limit || Infinity;
  while (done < MAX) {
    const j = await gql(`{ products(first: 100${after ? `, after:"${after}"` : ""}) {
        pageInfo{ hasNextPage endCursor }
        edges{ node{ id handle
          metafield(namespace:"neverland", key:"drive_file_id"){ value }
          pv: metafield(namespace:"neverland", key:"price_version"){ value } } }
    } }`);
    if (!j || !j.data) { console.log("throttle/err, backing off..."); await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const e of j.data.products.edges) {
      scanned++;
      const n = e.node;
      if (isNormalized(n)) { alreadyOk++; continue; }
      const res = await normalizeById(n);
      if (res.ok) done++;
      else if (res.skip) skipped++;
      else { failed++; if (failed <= 10) console.log("  FAIL", n.handle, res.error); }
      await new Promise((r) => setTimeout(r, 250)); // rate limit
      if (done >= MAX) break;
    }
    console.log(`  scanned ${scanned} | normalized ${done} | already ${alreadyOk} | skipped ${skipped} | failed ${failed}`);
    if (!j.data.products.pageInfo.hasNextPage) break;
    after = j.data.products.pageInfo.endCursor;
  }
  console.log(`\nBATCH DONE — normalized ${done}, already-ok ${alreadyOk}, skipped ${skipped}, failed ${failed}`);
}

(async () => {
  if (HANDLE) {
    console.log(await normalize(HANDLE), "\n");
    if (!APPLY) console.log("DRY RUN — add --apply to write.");
    return;
  }
  const limit = parseInt(getArg("limit") || "0", 10) || Infinity;
  if (!APPLY) { console.log("Batch mode needs --apply. Add --limit=N to cap."); return; }
  await runBatch(limit);
})();
