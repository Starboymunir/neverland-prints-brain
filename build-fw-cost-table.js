#!/usr/bin/env node
/**
 * Build a FinerWorks cost table: for every printable WxH (inches) in the
 * archival-matte family (5M6M9S{w}X{h}), record FW's base unframed cost.
 *
 * FW cost is a pure function of the product code, so we only need to fetch
 * this once and cache it. The per-artwork pricing function then does a local
 * lookup (no live FW calls per page view).
 *
 * Read-only against FinerWorks (get_prices). Writes src/config/fw-cost-table.json
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const FW = require("./src/services/finerworks");

const fw = new FW();

// Enumerate W<=H (the product code uses min x max) up to a generous cap.
// FW will tell us which are actually printable (price>0, no exception).
const MIN_IN = 4;
const MAX_IN = 48;
const BATCH = 50;

function codeFor(w, h) { return `5M6M9S${w}X${h}`; }

async function priceBatch(codes) {
  const resp = await fw.getPrices({ productCodes: codes });
  const rows = Array.isArray(resp?.prices) ? resp.prices : [];
  const out = {};
  for (const p of rows) {
    const code = p.product_code || p.product_sku;
    const price = p.total_price ?? p.product_price ?? p.single_price ?? p.price;
    const exc = p?.debug?.Exception || p?.info;
    out[code] = { price: price != null ? parseFloat(price) : null, exc: exc || null };
  }
  return out;
}

(async () => {
  // Build the full list of candidate codes.
  const candidates = [];
  for (let w = MIN_IN; w <= MAX_IN; w++) {
    for (let h = w; h <= MAX_IN; h++) {
      candidates.push({ w, h, code: codeFor(w, h) });
    }
  }
  console.log(`Probing ${candidates.length} candidate sizes (${MIN_IN}-${MAX_IN}" , W<=H) in batches of ${BATCH}...`);

  const table = {};   // code -> { w, h, cost }
  let valid = 0, invalid = 0;
  let maxSide = 0, maxArea = 0;
  let costMin = Infinity, costMax = 0;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    let priced;
    try {
      priced = await priceBatch(slice.map((c) => c.code));
    } catch (e) {
      console.error(`  batch ${i}-${i + slice.length} error: ${e.message.slice(0, 120)}`);
      continue;
    }
    for (const c of slice) {
      const r = priced[c.code];
      const ok = r && r.price != null && r.price > 0 && !r.exc;
      if (ok) {
        table[c.code] = { w: c.w, h: c.h, cost: r.price };
        valid++;
        maxSide = Math.max(maxSide, c.h);
        maxArea = Math.max(maxArea, c.w * c.h);
        costMin = Math.min(costMin, r.price);
        costMax = Math.max(costMax, r.price);
      } else {
        invalid++;
      }
    }
    process.stdout.write(`  ...${Math.min(i + BATCH, candidates.length)}/${candidates.length}  (valid ${valid})\r`);
  }

  const outPath = path.join(__dirname, "src", "config", "fw-cost-table.json");
  const payload = {
    generated_note: "FinerWorks archival-matte base unframed cost by size code. Regenerate with build-fw-cost-table.js",
    units: "inches / USD",
    test_mode: fw.testMode,
    count: valid,
    max_side_in: maxSide,
    cost_range: { min: costMin === Infinity ? null : costMin, max: costMax },
    table,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log(`\n\nDone. valid=${valid} invalid=${invalid}`);
  console.log(`Largest printable side: ${maxSide}"  | cost range $${costMin}-$${costMax}`);
  console.log(`Wrote ${outPath}`);

  // Show the cost curve along the diagonal (square-ish) for a feel.
  console.log("\nSample cost curve (square sizes):");
  for (let s = 4; s <= maxSide; s += 4) {
    const r = table[codeFor(s, s)];
    if (r) console.log(`  ${s}x${s}"  $${r.cost}`);
  }
  process.exit(0);
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
