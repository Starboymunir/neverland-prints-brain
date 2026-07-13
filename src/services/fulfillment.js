/**
 * Fulfillment — Neverland Prints
 * ==============================
 * Shared logic for turning a stored order line into a FinerWorks order.
 *
 * Used by BOTH:
 *   - the orders/create webhook (only when FINERWORKS_AUTO_SUBMIT=true)
 *   - the manual approval endpoint (the normal path)
 *
 * Keeping it in one place means the two can't drift apart — the print that gets
 * made is decided here and nowhere else.
 */

const FinerWorksService = require("./finerworks");

// Tier => FIXED longest edge in inches, aspect ratio preserved.
// NOT a percentage of the artwork's max print size: that made "Small" scale with
// the source resolution (a 19x29" print costing $60 sold as a $33.99 "Small").
const TIER_LONGEST_EDGE_IN = { small: 10, medium: 16, large: 24, extra_large: 36 };

// FinerWorks cannot print a side longer than this.
const MAX_PRINT_IN = 48;

// Fallback for rows saved before the ISO country code was stored alongside the
// address. Extend as new markets open up.
const COUNTRY_CODES = {
  nigeria: "NG",
  "united states": "US",
  "united kingdom": "GB",
  canada: "CA",
  ghana: "GH",
  "south africa": "ZA",
  kenya: "KE",
  ireland: "IE",
  australia: "AU",
  germany: "DE",
  france: "FR",
};

function countryCodeFor(address) {
  if (!address) return null;
  if (address.country_code) return address.country_code;
  const name = String(address.country || "").trim().toLowerCase();
  return COUNTRY_CODES[name] || null;
}

/**
 * Work out the exact print dimensions for a line.
 * Prefers a real "W × H cm" size; otherwise maps the tier to a fixed longest edge.
 */
function resolveDims({ size, priceTier, asset }) {
  const explicit = FinerWorksService.parseSizeCm(size);
  if (explicit) return explicit;

  const tierKey = (priceTier || size || "")
    .toString().trim().toLowerCase().replace(/\s+/g, "_");
  const longestIn = TIER_LONGEST_EDGE_IN[tierKey] || TIER_LONGEST_EDGE_IN.medium;

  // Aspect ratio from the artwork (print dims or pixel dims — same ratio).
  const aspW = asset && (asset.max_print_width_cm || asset.width_px);
  const aspH = asset && (asset.max_print_height_cm || asset.height_px);
  if (!aspW || !aspH) return null;

  const ratio = aspW / aspH; // >1 landscape, <1 portrait
  const wIn = ratio >= 1 ? longestIn : longestIn * ratio;
  const hIn = ratio >= 1 ? longestIn / ratio : longestIn;
  return { widthCm: wIn * 2.54, heightCm: hIn * 2.54 };
}

function clampToPrintable(dims) {
  const longestIn = Math.max(dims.widthCm, dims.heightCm) / 2.54;
  if (longestIn <= MAX_PRINT_IN) return dims;
  const f = MAX_PRINT_IN / longestIn;
  return { widthCm: dims.widthCm * f, heightCm: dims.heightCm * f };
}

/**
 * Submit one line item to FinerWorks and record the outcome.
 *
 * item:      { orderId, lineItemId, artworkTitle, size, priceTier, driveFileId,
 *              previewUrl, assetId, quantity }
 * address:   Shopify-style shipping address (or the stored jsonb)
 *
 * Returns { ok, fwOrderId?, productCode?, error? }
 */
async function fulfillItem({ supabase, finerworks, item, address, email }) {
  const setStatus = async (patch) => {
    try {
      await supabase
        .from("fulfillment_orders")
        .update(patch)
        .eq("shopify_order_id", item.orderId)
        .eq("line_item_id", item.lineItemId);
    } catch (e) { /* table may not exist yet */ }
  };

  const fail = async (msg) => {
    console.error(`   ❌ ${item.artworkTitle}: ${msg}`);
    await setStatus({ status: "fulfillment_failed", error: String(msg).slice(0, 300) });
    return { ok: false, error: msg };
  };

  const imageUrl = item.driveFileId
    ? `https://lh3.googleusercontent.com/d/${item.driveFileId}=s0`
    : item.previewUrl;
  const thumbnailUrl = item.driveFileId
    ? `https://lh3.googleusercontent.com/d/${item.driveFileId}=s400`
    : item.previewUrl;

  if (!imageUrl) return fail("No image URL for artwork");
  if (!address) return fail("No shipping address");

  const countryCode = countryCodeFor(address);
  if (!countryCode) return fail(`Unknown country "${address.country}" — cannot map to an ISO code`);

  // Artwork record gives pixel dimensions and the aspect ratio.
  let asset = null;
  try {
    let q = supabase
      .from("assets")
      .select("width_px,height_px,max_print_width_cm,max_print_height_cm");
    q = item.assetId ? q.eq("id", item.assetId) : q.eq("drive_file_id", item.driveFileId);
    const { data } = await q.single();
    asset = data || null;
  } catch (e) { /* ignore */ }

  let dims = resolveDims({ size: item.size, priceTier: item.priceTier, asset });
  if (!dims) return fail(`Cannot determine print size (size="${item.size}")`);
  dims = clampToPrintable(dims);

  // Always derived server-side — the theme's product code carried an oversized
  // tier and a border the customer never asked for.
  const productCode = FinerWorksService.buildDefaultProductCode(dims.widthCm, dims.heightCm);

  let pixelWidth = asset ? asset.width_px || 0 : 0;
  let pixelHeight = asset ? asset.height_px || 0 : 0;
  if (!pixelWidth || !pixelHeight) {
    pixelWidth = Math.round(dims.widthCm * 0.393700787 * 300);
    pixelHeight = Math.round(dims.heightCm * 0.393700787 * 300);
  }

  const name = address.name
    || `${address.first_name || ""} ${address.last_name || ""}`.trim()
    || "Customer";

  let fwOrder;
  try {
    fwOrder = await finerworks.createOrder({
      recipient: {
        name,
        email: email || null,
        address1: address.address1,
        address2: address.address2 || "",
        city: address.city,
        state_code: address.province_code || "",
        country_code: countryCode,
        zip: address.zip,
        phone: address.phone || null,
      },
      imageUrl,
      thumbnailUrl,
      pixelWidth,
      pixelHeight,
      productCode,
      quantity: item.quantity || 1,
      title: item.artworkTitle,
      externalId: `${item.orderId}-${item.lineItemId}`,
    });
  } catch (err) {
    return fail(err.message);
  }

  // A 200 alone doesn't mean an order exists — FinerWorks returns an order_id even
  // for submissions it silently drops. Only trust a real order number.
  if (!fwOrder.created) {
    return fail(`FinerWorks created no order: ${fwOrder.message || "no order_id returned"}`);
  }

  console.log(
    `   🖨️  FinerWorks order ${fwOrder.fwOrderId} (${productCode}) for "${item.artworkTitle}"` +
    (fwOrder.paymentFailed ? " [UNPAID — pay it in FinerWorks to start production]" : "")
  );

  await setStatus({
    finerworks_order_id: String(fwOrder.fwOrderId),
    finerworks_product_code: productCode,
    status: "sent_to_finerworks",
    error: null,
  });

  return {
    ok: true,
    fwOrderId: fwOrder.fwOrderId,
    productCode,
    unpaid: fwOrder.paymentFailed,
  };
}

module.exports = { fulfillItem, resolveDims, countryCodeFor, TIER_LONGEST_EDGE_IN };
