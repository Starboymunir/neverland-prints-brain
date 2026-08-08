/**
 * Dynamic per-artwork pricing — Neverland Prints
 * ==============================================
 * Retail price tracks the artwork's ACTUAL physical size per tier, so margin
 * stays consistent regardless of how large each artwork prints.
 *
 *   retail = ladderRoundUp( fwBaseCost(tierDims) × MARGIN × (frame uplift) )
 *
 * fwBaseCost is a local lookup into the cached FinerWorks cost table
 * (src/config/fw-cost-table.json, regenerate via build-fw-cost-table.js).
 * No live FinerWorks calls happen per page view.
 *
 * Charged via a price-point ladder: the storefront adds the skeleton variant
 * whose fixed price equals the computed ladder price (see price-ladder map).
 */

const COST_TABLE = require("../config/fw-cost-table.json").table;

// Fraction of the artwork's MAX print size for each tier (mirrors storefront).
const TIER_SCALE = { small: 0.35, medium: 0.55, large: 0.75, extra_large: 1.0 };

// 70% target margin → cost / (1 - 0.70) = cost × 3.333 (matches sync-prices.js).
const MARGIN = 1 / (1 - 0.70);

// Framed costs more. Proportional uplift matching the current skeleton
// framed/unframed ratio (~1.31). TODO: replace with real FW frame cost.
const FRAME_UPLIFT = 1.31;

// FinerWorks printable envelope (from build-fw-cost-table.js sweep).
const MIN_SIDE_IN = 4;
const MAX_SIDE_IN = 48;

const CM_PER_IN = 2.54;

// ── Charm-rounded price ladder (ascending, prices end in .99) ──────────────
function buildLadder() {
  const pts = new Set();
  const ranges = [
    [25, 100, 5],    // $24.99 … $94.99
    [100, 300, 10],  // $99.99 … $299.99  (wait: see below)
    [300, 700, 25],  // $299.99 … $699.99
    [700, 1400, 50], // $699.99 … $1399.99
  ];
  for (const [start, end, step] of ranges) {
    for (let v = start; v < end; v += step) pts.add(Number((v - 0.01).toFixed(2)));
  }
  return [...pts].sort((a, b) => a - b);
}
const LADDER = buildLadder();

function ladderRoundUp(raw) {
  for (const p of LADDER) if (p >= raw) return p;
  return LADDER[LADDER.length - 1];
}

/**
 * Convert a desired print size (cm) to WHOLE-INCH dimensions that FinerWorks can
 * actually print, PRESERVING ASPECT RATIO. Scales the whole rectangle down so the
 * longest side fits 48" (instead of clamping each side independently, which turned
 * tall prints into squares). Returns { wIn, hIn }.
 */
function clampToPrintableIn(widthCm, heightCm) {
  let w = (widthCm || 0) / CM_PER_IN;
  let h = (heightCm || 0) / CM_PER_IN;
  const longest = Math.max(w, h);
  if (longest > MAX_SIDE_IN) { const f = MAX_SIDE_IN / longest; w *= f; h *= f; }
  w = Math.min(MAX_SIDE_IN, Math.max(MIN_SIDE_IN, Math.round(w)));
  h = Math.min(MAX_SIDE_IN, Math.max(MIN_SIDE_IN, Math.round(h)));
  return { wIn: w, hIn: h };
}

/** FinerWorks base (unframed) cost for a physical size in cm, via the cost table. */
function fwBaseCost(widthCm, heightCm) {
  const { wIn, hIn } = clampToPrintableIn(widthCm, heightCm);
  const lo = Math.min(wIn, hIn);
  const hi = Math.max(wIn, hIn);
  const entry = COST_TABLE[`5M6M9S${lo}X${hi}`];
  return entry ? entry.cost : null;
}

/** Physical dimensions (cm) of a given tier for an artwork's max print size. */
function tierDimsCm(maxWidthCm, maxHeightCm, tier) {
  const s = TIER_SCALE[tier] != null ? TIER_SCALE[tier] : TIER_SCALE.medium;
  return { widthCm: (maxWidthCm || 0) * s, heightCm: (maxHeightCm || 0) * s };
}

/**
 * Compute the retail price for one (artwork, tier, frame).
 * Returns { price, fwCost, dims, productCode } or null if not priceable.
 */
function computePrice(maxWidthCm, maxHeightCm, tier, framed) {
  const want = tierDimsCm(maxWidthCm, maxHeightCm, tier);
  // Actual printable size (aspect-preserved). Everything below — cost, code, and
  // the SIZE we display — derives from this, so what's shown = priced = printed.
  const { wIn, hIn } = clampToPrintableIn(want.widthCm, want.heightCm);
  const lo = Math.min(wIn, hIn);
  const hi = Math.max(wIn, hIn);
  const entry = COST_TABLE[`5M6M9S${lo}X${hi}`];
  if (!entry) return null;
  const base = entry.cost;

  let raw = base * MARGIN;
  if (framed) raw *= FRAME_UPLIFT;
  const price = ladderRoundUp(raw);

  return {
    price,
    fwCost: framed ? Number((base * FRAME_UPLIFT).toFixed(2)) : base,
    dims: { widthCm: Math.round(wIn * CM_PER_IN), heightCm: Math.round(hIn * CM_PER_IN) },
    productCode: `5M6M9S${lo}X${hi}`,
  };
}

/**
 * Full price map for an artwork: { small_unframed: {...}, ... }.
 * Tiers that clamp to the SAME printable size (common when an artwork's max
 * exceeds FinerWorks' 48" ceiling — e.g. Large and XL both hit the cap) are
 * de-duplicated so the storefront never shows two identical size/price options.
 */
function computePriceMap(maxWidthCm, maxHeightCm) {
  const map = {};
  const seen = new Set();
  for (const tier of Object.keys(TIER_SCALE)) {
    const uf = computePrice(maxWidthCm, maxHeightCm, tier, false);
    if (!uf) continue;
    if (seen.has(uf.productCode)) continue; // same printable size as a smaller tier
    seen.add(uf.productCode);
    map[`${tier}_unframed`] = uf;
    const fr = computePrice(maxWidthCm, maxHeightCm, tier, true);
    if (fr) map[`${tier}_framed`] = fr;
  }
  return map;
}

module.exports = {
  computePrice,
  computePriceMap,
  tierDimsCm,
  fwBaseCost,
  ladderRoundUp,
  LADDER,
  TIER_SCALE,
  MARGIN,
  FRAME_UPLIFT,
};
