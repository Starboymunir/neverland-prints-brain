/**
 * sync-prices.js — Apply N% gross margin to skeleton variants based on live
 * FinerWorks production costs.
 *
 * Reads:    src/config/skeleton-price-map.json (variant IDs)
 *           FW POST /v3/get_prices            (live base costs)
 *           env PRICE_MARGIN                  (default 0.70)
 *           env FRAME_UPCHARGE_MULT           (default 1.30)
 *           env COMPARE_AT_MULT               (default 1.30)
 *
 * Writes:   Shopify Admin API PUT /admin/api/2024-10/variants/{id}.json
 *           src/config/skeleton-price-map.json   (records new prices)
 *           neverland-catalog.js                  (PRICE_TIERS constant)
 *
 * Run:      node sync-prices.js          (dry run by default)
 *           node sync-prices.js --apply  (actually updates Shopify)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const FinerWorksService = require("./src/services/finerworks");

const APPLY = process.argv.includes("--apply");
const MARGIN = parseFloat(process.env.PRICE_MARGIN || "0.70");
const FRAME_MULT = parseFloat(process.env.FRAME_UPCHARGE_MULT || "1.30");
const COMPARE_MULT = parseFloat(process.env.COMPARE_AT_MULT || "1.30");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN || "neverland-prints.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || "2024-10";

if (!TOKEN) {
  console.error("Missing SHOPIFY_ADMIN_API_TOKEN in env.");
  process.exit(1);
}

// FW product codes by tier (Archival Matte, 1/2 inch border, unframed)
const TIER_CODES = {
  small: "5M6M9S8X12",
  medium: "5M6M9S12X16",
  large: "5M6M9S18X24",
  extra_large: "5M6M9S24X36",
};

// Charm rounding: round price up to the nearest .99 (e.g. 33.33 → 34.99,
// 70.00 → 70.99, 156.67 → 159.99). For prices >= $100 round to nearest 5.
function charmRound(value) {
  if (value <= 0) return 0;
  if (value < 100) {
    // Round to next .99
    return Math.ceil(value) - 0.01;
  }
  // Round up to nearest $5 then end .99 (e.g. 156.67 → 160 → 159.99)
  const rounded = Math.ceil(value / 5) * 5;
  return rounded - 0.01;
}

function asMoney(n) { return n.toFixed(2); }

async function shopify(method, endpoint, body) {
  const url = `https://${SHOP}/admin/api/${API}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log(`MODE: ${APPLY ? "APPLY (will update Shopify)" : "DRY RUN — pass --apply to commit"}`);
  console.log(`MARGIN: ${(MARGIN * 100).toFixed(0)}%   FRAME_MULT: ${FRAME_MULT}x   COMPARE_MULT: ${COMPARE_MULT}x\n`);

  // 1) Pull live FW costs
  const fw = new FinerWorksService();
  const codes = Object.values(TIER_CODES);
  const fwResp = await fw.getPrices({ productCodes: codes });
  const fwPrices = fwResp.prices || [];
  const costByCode = {};
  for (const p of fwPrices) costByCode[p.product_code] = p.product_price;

  // 2) Compute new prices per tier × framed
  const tiers = ["small", "medium", "large", "extra_large"];
  const computed = {}; // { tier: { unframedCost, unframedPrice, framedPrice, compareUnframed, compareFramed } }
  for (const tier of tiers) {
    const code = TIER_CODES[tier];
    const cost = costByCode[code];
    if (!cost) {
      console.error(`✗ FW cost missing for ${tier} (${code})`);
      process.exit(1);
    }
    const rawUnframed = cost / (1 - MARGIN);          // gross-margin formula
    const unframedPrice = charmRound(rawUnframed);
    const framedPrice = charmRound(unframedPrice * FRAME_MULT);
    const compareUnframed = charmRound(unframedPrice * COMPARE_MULT);
    const compareFramed = charmRound(framedPrice * COMPARE_MULT);
    computed[tier] = { cost, unframedPrice, framedPrice, compareUnframed, compareFramed };
  }

  // 3) Print pricing table
  console.log("Tier".padEnd(14), "FW cost".padEnd(10), "Unframed".padEnd(11), "compare".padEnd(10), "Framed".padEnd(11), "compare".padEnd(10), "Margin");
  console.log("-".repeat(80));
  for (const tier of tiers) {
    const c = computed[tier];
    const margin = ((c.unframedPrice - c.cost) / c.unframedPrice * 100).toFixed(1) + "%";
    console.log(
      tier.padEnd(14),
      `$${asMoney(c.cost)}`.padEnd(10),
      `$${asMoney(c.unframedPrice)}`.padEnd(11),
      `$${asMoney(c.compareUnframed)}`.padEnd(10),
      `$${asMoney(c.framedPrice)}`.padEnd(11),
      `$${asMoney(c.compareFramed)}`.padEnd(10),
      margin
    );
  }
  console.log("");

  // 4) Read skeleton-price-map.json
  const mapPath = path.join(__dirname, "src", "config", "skeleton-price-map.json");
  const priceMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));

  // 5) Build update plan
  const updates = [];
  for (const tier of tiers) {
    const c = computed[tier];
    const unframedKey = `${tier}_unframed`;
    const framedKey = `${tier}_framed`;
    if (priceMap[unframedKey]) {
      updates.push({
        key: unframedKey,
        variantId: priceMap[unframedKey].variantId,
        price: asMoney(c.unframedPrice),
        compare_at_price: asMoney(c.compareUnframed),
      });
    }
    if (priceMap[framedKey]) {
      updates.push({
        key: framedKey,
        variantId: priceMap[framedKey].variantId,
        price: asMoney(c.framedPrice),
        compare_at_price: asMoney(c.compareFramed),
      });
    }
  }

  console.log(`Planned variant updates: ${updates.length}`);
  for (const u of updates) {
    const old = priceMap[u.key]?.price || "—";
    console.log(`  ${u.key.padEnd(22)} variant=${u.variantId} ${old.padStart(7)} → ${u.price} (compare ${u.compare_at_price})`);
  }
  console.log("");

  if (!APPLY) {
    console.log("Dry run complete. Pass --apply to push to Shopify.");
    return;
  }

  // 6) Push to Shopify
  for (const u of updates) {
    try {
      await shopify("PUT", `/variants/${u.variantId}.json`, {
        variant: { id: parseInt(u.variantId, 10), price: u.price, compare_at_price: u.compare_at_price },
      });
      console.log(`✓ ${u.key}: $${u.price}`);
    } catch (e) {
      console.error(`✗ ${u.key}: ${e.message}`);
    }
  }

  // 7) Persist new prices to the JSON config
  for (const u of updates) {
    if (priceMap[u.key]) {
      priceMap[u.key].price = u.price;
      priceMap[u.key].compare_at_price = u.compare_at_price;
    }
  }
  fs.writeFileSync(mapPath, JSON.stringify(priceMap, null, 2));
  console.log("\n✓ Updated src/config/skeleton-price-map.json");

  // 8) Update PRICE_TIERS in neverland-catalog.js (frontend constant)
  const catalogPath = path.join(__dirname, "neverland-catalog.js");
  if (fs.existsSync(catalogPath)) {
    let js = fs.readFileSync(catalogPath, "utf-8");
    const newBlock =
      "const PRICE_TIERS = {\n" +
      `    small:       { unframed: "${asMoney(computed.small.unframedPrice)}",       framed: "${asMoney(computed.small.framedPrice)}",       label: "Small" },\n` +
      `    medium:      { unframed: "${asMoney(computed.medium.unframedPrice)}",      framed: "${asMoney(computed.medium.framedPrice)}",      label: "Medium" },\n` +
      `    large:       { unframed: "${asMoney(computed.large.unframedPrice)}",       framed: "${asMoney(computed.large.framedPrice)}",       label: "Large" },\n` +
      `    extra_large: { unframed: "${asMoney(computed.extra_large.unframedPrice)}", framed: "${asMoney(computed.extra_large.framedPrice)}", label: "Extra Large" }\n` +
      "  }";
    const re = /const PRICE_TIERS\s*=\s*\{[\s\S]*?\n\s{2}\}/;
    if (re.test(js)) {
      js = js.replace(re, newBlock);
      fs.writeFileSync(catalogPath, js);
      console.log("✓ Updated PRICE_TIERS in neverland-catalog.js (don't forget to push to Shopify CDN)");
    } else {
      console.warn("⚠ Couldn't find PRICE_TIERS block in neverland-catalog.js — update manually");
    }
  }

  console.log("\nDone. Verify on storefront, then push neverland-catalog.js to CDN.");
}

main().catch((e) => { console.error("✗", e.stack || e.message); process.exit(1); });
