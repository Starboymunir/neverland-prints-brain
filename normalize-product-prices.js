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

// Safety net: a transient network/TLS blip must never hard-crash a long backfill.
process.on("unhandledRejection", (e) => console.error("[warn] unhandledRejection:", e && e.message));
process.on("uncaughtException", (e) => console.error("[warn] uncaughtException:", e && e.message));

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
      { hostname: SHOP, path: `/admin/api/${VER}/graphql.json`, method: "POST", timeout: 30000,
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) } },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
    );
    rq.on("error", reject);
    rq.on("timeout", () => { rq.destroy(new Error("gql timeout")); });
    rq.write(b); rq.end();
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

// A gql() call that retries on transient GraphQL throttling / network blips and
// returns the parsed response (or null after giving up). Note: the daily
// VARIANT_THROTTLE_EXCEEDED (variant *creation* limit) is NOT retryable — it
// only clears the next day — which is exactly why we no longer create variants.
async function gqlRetry(query, variables) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let r;
    try { r = await gql(query, variables); }
    catch (e) { await new Promise((res) => setTimeout(res, 1200 * (attempt + 1) + Math.floor(Math.random() * 700))); continue; }
    const errStr = r && r.errors ? JSON.stringify(r.errors) : "";
    if (/THROTTLED|being modified|try again/i.test(errStr) && !/VARIANT_THROTTLE/i.test(errStr)) {
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1) + Math.floor(Math.random() * 700)));
      continue;
    }
    return r;
  }
  return null;
}

// Normalize straight from a Supabase asset row. CRITICAL: we UPDATE the existing
// variant in place (price/compare/availability) and set category + description via
// productUpdate — we NEVER create variants. Recreating the Size option made a new
// variant per size, which blew Shopify's ~1,000/day variant-creation cap and
// stalled the whole backfill. Updating in place has no such limit, so this
// finishes the entire catalog. The multi-size selection is handled by the custom
// storefront; the native "from" price is what ads / Google / Shop app / AI shop read.
async function normalizeFromAsset(asset) {
  const legacyId = asset.shopify_product_id;
  if (!legacyId) return { skip: "no-shopify-id" };
  if (!asset.max_print_width_cm) return { skip: "no-dimensions" };
  const gid = `gid://shopify/Product/${legacyId}`;
  const tiers = targetTiers(asset.max_print_width_cm, asset.max_print_height_cm);
  if (!tiers.length) return { skip: "no-tiers" };
  const fromPrice = Math.min(...tiers.map((t) => parseFloat(t.price)));
  const wasP = wasPrice(fromPrice);

  // 1. Read current version + option name (safety: never destroy an already-sized
  //    product, since productSet is declarative).
  const info = await gqlRetry(`{ product(id:"${gid}"){ pv:metafield(namespace:"neverland",key:"price_version"){ value } options{ name } variants(first:1){ edges{ node{ id } } } } }`);
  const prod = info && info.data && info.data.product;
  if (!prod) return { error: "no-product" };
  if (prod.pv && prod.pv.value === PRICE_VERSION) return { skip: "already" };
  if (!(prod.variants && prod.variants.edges && prod.variants.edges[0])) return { skip: "no-variant" };
  const optName = prod.options && prod.options[0] && prod.options[0].name;
  // Only touch single-option "Title/Default Title" skeletons. Anything already
  // restructured (a "Size" option with real size variants) is left untouched.
  if (optName && optName !== "Title") return { skip: "has-structure" };

  // 2. ONE productSet that KEEPS the existing "Title/Default Title" option — so
  //    the existing variant is updated in place (no new variant → no daily
  //    variant-creation cap) — and sets price + made-to-order availability +
  //    category + description + version stamp together.
  const desc = (asset.description || "").trim().replace(/[<>]/g, "");
  const input = {
    id: gid,
    category: CATEGORY_ID,
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: fromPrice.toFixed(2), compareAtPrice: wasP, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: false } }],
    metafields: [{ namespace: "neverland", key: "price_version", type: "single_line_text_field", value: PRICE_VERSION }],
  };
  if (desc) input.descriptionHtml = `<p>${desc}</p>`;
  const r = await gqlRetry(`mutation($input: ProductSetInput!){ productSet(synchronous:true, input:$input){ product{ id } userErrors{ message } } }`, { input });
  const ue = r && r.data && r.data.productSet && r.data.productSet.userErrors;
  if (!r || (r.errors && r.errors.length) || (ue && ue.length)) {
    return { error: JSON.stringify((r && (r.errors || ue)) || "productset-failed").slice(0, 150) };
  }
  if (r.data.productSet.product) return { ok: true };
  return { error: "no-product-returned" };
}

// Forward-only, resumable batch driven by a stable Supabase id-cursor. Each
// invocation processes the next `limit` assets after `afterId` (ordered by id),
// then prints RESUME_AFTER / SCANNED so the server chain can continue exactly
// where it left off — no Shopify re-scan, no premature stop.
// Like supa() but returns null on a real failure (network/timeout/non-2xx/
// non-array) instead of [] — so the caller can tell "query failed, retry" apart
// from "genuinely no rows left" (the empty result that means end-of-catalog).
function supaRowsOrNull(qs) {
  return new Promise((resolve) => {
    const u = new URL(SU + "/rest/v1/" + qs);
    const rq = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, timeout: 30000, headers: { apikey: SK, Authorization: "Bearer " + SK } },
      (x) => {
        let d = ""; x.on("data", (c) => (d += c));
        x.on("end", () => {
          if (x.statusCode >= 200 && x.statusCode < 300) {
            try { const j = JSON.parse(d); return resolve(Array.isArray(j) ? j : null); } catch (e) { return resolve(null); }
          }
          resolve(null);
        });
      }
    );
    rq.on("error", () => resolve(null));
    rq.on("timeout", () => { rq.destroy(); resolve(null); });
    rq.end();
  });
}

async function runBatchCursor(afterId, limit) {
  const CONC = 12; // in-place updates don't create variants, so we can push harder
  const qs =
    `assets?select=id,shopify_product_id,max_print_width_cm,max_print_height_cm,description` +
    `&shopify_product_id=not.is.null${afterId ? `&id=gt.${afterId}` : ""}&order=id.asc&limit=${limit}`;
  // Retry the page fetch before ever concluding "empty" — a transient Supabase
  // failure must NOT be mistaken for end-of-catalog (that was the stall bug).
  let rows = null;
  for (let attempt = 0; attempt < 6 && rows === null; attempt++) {
    rows = await supaRowsOrNull(qs);
    if (rows === null) { console.log(`  page fetch failed, retry ${attempt + 1}/6`); await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
  }
  if (rows === null) { console.error("FETCH_FAILED after retries"); process.exit(1); } // non-zero → server chain retries this chunk
  let done = 0, skipped = 0, failed = 0, idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const a = rows[idx++];
      try {
        const res = await normalizeFromAsset(a);
        if (res.ok) done++;
        else if (res.skip) skipped++;
        else { failed++; if (failed <= 8) console.log("  FAIL", a.shopify_product_id, res.error); }
      } catch (e) {
        failed++; if (failed <= 8) console.log("  FAIL", a.shopify_product_id, "exception:", e && e.message);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  const lastId = rows.length ? rows[rows.length - 1].id : (afterId || "");
  console.log(`normalized ${done} | skipped ${skipped} | failed ${failed} | scanned ${rows.length}`);
  console.log(`RESUME_AFTER=${lastId}`);
  console.log(`SCANNED=${rows.length}`);
  return { scanned: rows.length, lastId, done, skipped, failed };
}

// Loop runBatchCursor to completion in ONE process (for local/direct runs that
// don't suffer Render's free-tier spin-down). Keyset-resumes from afterId.
async function runToCompletion(afterId, pageSize) {
  let cursor = afterId || "";
  let totalDone = 0, totalFail = 0, page = 0;
  const t0 = Date.now();
  for (;;) {
    const r = await runBatchCursor(cursor, pageSize);
    cursor = r.lastId;
    totalDone += r.done; totalFail += r.failed; page++;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`  [loop] page ${page} | total normalized ${totalDone} | failed ${totalFail} | ${mins}m | cursor ${String(cursor).slice(0, 8)}`);
    if (r.scanned < pageSize) break; // short page = true end of catalog
  }
  console.log(`\nLOOP DONE — normalized ${totalDone}, failed ${totalFail} over ${page} pages.`);
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
  if (args.includes("--loop")) await runToCompletion(afterId, limit);
  else await runBatchCursor(afterId, limit);
})();
