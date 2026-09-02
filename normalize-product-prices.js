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
      inventoryPolicy: "CONTINUE",
      inventoryItem: { tracked: false },
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
const PRICE_VERSION = "v5-2026-08"; // v5 = v4 + made-to-order inventory (untracked/oversell → always available cross-channel)
// Shopify Standard Taxonomy: Home & Garden > Decor > Artwork > Posters, Prints,
// & Visual Artwork > Prints. Required for cross-channel/Managed Markets, Google feed.
const CATEGORY_ID = "gid://shopify/TaxonomyCategory/hg-3-4-2-2";
function isNormalized(node) {
  return !!(node.pv && node.pv.value === PRICE_VERSION);
}

async function normalizeById(node) {
  // Look up the asset by SHOPIFY PRODUCT ID — reliable, since every synced asset
  // stores shopify_product_id, whereas the drive_file_id metafield is missing on
  // many products (which made the old lookup skip almost everything).
  const legacyId = node.legacyResourceId || String(node.id || "").split("/").pop();
  if (!legacyId) return { skip: "no-id" };
  const asset = (await supa(`assets?select=max_print_width_cm,max_print_height_cm,description&shopify_product_id=eq.${legacyId}&limit=1`))[0];
  if (!asset || !asset.max_print_width_cm) return { skip: "no-asset" };
  const tiers = targetTiers(asset.max_print_width_cm, asset.max_print_height_cm);
  if (!tiers.length) return { skip: "no-tiers" };
  const input = {
    id: node.id,
    category: CATEGORY_ID,
    productOptions: [{ name: "Size", values: tiers.map((t) => ({ name: t.optionValue })) }],
    // Print-on-demand: every size is made to order, we hold NO physical stock.
    // Untrack inventory + allow overselling so the variant is ALWAYS available and
    // reports "in stock" on every channel (native cart, Shop app, Google, AI shop).
    // Without this, Shopify defaults new variants to tracked/DENY at qty 0 →
    // available:false → the store reads "sold out" everywhere and cannot sell.
    variants: tiers.map((t) => ({
      optionValues: [{ optionName: "Size", name: t.optionValue }],
      price: t.price,
      compareAtPrice: t.compareAt,
      inventoryPolicy: "CONTINUE",
      inventoryItem: { tracked: false },
    })),
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

// Normalize straight from a Supabase asset row (no Shopify lookup): the row
// already carries shopify_product_id, print dimensions, and the AI description.
async function normalizeFromAsset(asset) {
  const legacyId = asset.shopify_product_id;
  if (!legacyId) return { skip: "no-shopify-id" };
  if (!asset.max_print_width_cm) return { skip: "no-dimensions" };
  const tiers = targetTiers(asset.max_print_width_cm, asset.max_print_height_cm);
  if (!tiers.length) return { skip: "no-tiers" };
  const input = {
    id: `gid://shopify/Product/${legacyId}`,
    category: CATEGORY_ID,
    productOptions: [{ name: "Size", values: tiers.map((t) => ({ name: t.optionValue })) }],
    variants: tiers.map((t) => ({ optionValues: [{ optionName: "Size", name: t.optionValue }], price: t.price, compareAtPrice: t.compareAt })),
    metafields: [{ namespace: "neverland", key: "price_version", type: "single_line_text_field", value: PRICE_VERSION }],
  };
  const desc = (asset.description || "").trim();
  if (desc) input.descriptionHtml = `<p>${desc.replace(/[<>]/g, "")}</p>`;
  // Retry on Shopify GraphQL throttling (cost-based) rather than dropping the row.
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await gql(`mutation($input: ProductSetInput!){ productSet(synchronous:true, input:$input){ product{ id } userErrors{ message } } }`, { input });
    const throttled = r && r.errors && JSON.stringify(r.errors).includes("THROTTLED");
    if (throttled) { await new Promise((res) => setTimeout(res, 2000 * (attempt + 1))); continue; }
    const errs = r && r.data && r.data.productSet && r.data.productSet.userErrors;
    if (r && r.data && r.data.productSet && r.data.productSet.product && (!errs || !errs.length)) return { ok: true };
    return { error: JSON.stringify(errs || (r && r.errors) || "unknown").slice(0, 150) };
  }
  return { error: "throttled-give-up" };
}

// Forward-only, resumable batch driven by a stable Supabase id-cursor. Each
// invocation processes the next `limit` assets after `afterId` (ordered by id),
// then prints RESUME_AFTER / SCANNED so the server chain can continue exactly
// where it left off — no Shopify re-scan, no premature stop.
async function runBatchCursor(afterId, limit) {
  const CONC = 3;
  const rows = await supa(
    `assets?select=id,shopify_product_id,max_print_width_cm,max_print_height_cm,description` +
    `&shopify_product_id=not.is.null${afterId ? `&id=gt.${afterId}` : ""}&order=id.asc&limit=${limit}`
  );
  let done = 0, skipped = 0, failed = 0, idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const a = rows[idx++];
      const res = await normalizeFromAsset(a);
      if (res.ok) done++;
      else if (res.skip) skipped++;
      else { failed++; if (failed <= 8) console.log("  FAIL", a.shopify_product_id, res.error); }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  const lastId = rows.length ? rows[rows.length - 1].id : (afterId || "");
  console.log(`normalized ${done} | skipped ${skipped} | failed ${failed} | scanned ${rows.length}`);
  console.log(`RESUME_AFTER=${lastId}`);
  console.log(`SCANNED=${rows.length}`);
}

(async () => {
  if (HANDLE) {
    console.log(await normalize(HANDLE), "\n");
    if (!APPLY) console.log("DRY RUN — add --apply to write.");
    return;
  }
  const limit = parseInt(getArg("limit") || "500", 10) || 500;
  const afterId = getArg("after-id") || "";
  if (!APPLY) { console.log("Batch mode needs --apply. Add --limit=N to cap."); return; }
  await runBatchCursor(afterId, limit);
})();
