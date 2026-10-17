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
const { FRAME_IDS } = require("./pricing");
const FRAME_BY_ID = Object.fromEntries(Object.entries(FRAME_IDS).map(([color, id]) => [String(id), color]));

/**
 * Which frame the customer bought. The stored "Frame" text is the customer's
 * choice ("Framed — Walnut", "Framed — Natural Oak", "Framed", "Unframed") and
 * wins over the colour baked into the priced code (the /pages/art cart always
 * passes the BLACK framed code). "Framed" with no colour = black, the default.
 * Returns a FRAME_IDS key, or null for unframed.
 */
function frameColorOf(frameText, codeFrameId) {
  const t = String(frameText || "").toLowerCase().trim();
  if (t.startsWith("unframed")) return null;
  const named = Object.keys(FRAME_IDS).find((c) => t.includes(c));
  if (t.startsWith("framed")) return named || FRAME_BY_ID[String(codeFrameId)] || "black";
  return codeFrameId ? FRAME_BY_ID[String(codeFrameId)] || "black" : null;
}

/** Print code -> framed code: {print}F{frameId}S{w}X{h}G1 (frame + clear acrylic, no mat). */
function applyFrame(printCode, color) {
  if (!color) return printCode;
  const m = String(printCode).match(/^(\d+M\d+M\d+)(S\d+X\d+)$/);
  return m ? `${m[1]}${m[2]}F${FRAME_IDS[color]}${m[2]}G1` : printCode;
}

/**
 * The exact FinerWorks code for one order line: the PRICED size when the cart
 * passed a code (borderless M8 forced), else a size computed from the tier/size
 * text — then the customer's frame applied on top. Previously any framed code was
 * ignored and every framed order went to FinerWorks as a bare print.
 * Returns { productCode, dims, frameColor } or { error }.
 */
function codeFor(item, asset) {
  const passed = String(item.finerworksProductCode || "").trim().toUpperCase();
  const m = passed.match(/^(\d+M\d+M)\d+(S(\d+)X(\d+))(?:F(\d+)S\d+X\d+G\d+)?$/);
  let productCode, dims;
  if (m) {
    productCode = m[1] + "8" + m[2]; // force borderless (M8)
    dims = { widthCm: parseInt(m[3], 10) * 2.54, heightCm: parseInt(m[4], 10) * 2.54 };
  } else {
    dims = resolveDims({ size: item.size, priceTier: item.priceTier, asset });
    if (!dims) return { error: `cannot determine print size (size="${item.size}")` };
    dims = clampToPrintable(dims);
    productCode = FinerWorksService.buildDefaultProductCode(dims.widthCm, dims.heightCm);
  }
  const frameColor = frameColorOf(item.frame, m && m[5]);
  return { productCode: applyFrame(productCode, frameColor), dims, frameColor };
}


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

  // Determine the FinerWorks product code + print size.
  // PRIORITY: honour the code the PRICE was computed from (passed as
  // _finerworks_product_code by the dynamic price map). Area-based pricing means
  // the customer paid for a specific size, so we MUST print that size — otherwise
  // charge != print. Force borderless mounting M8 (identical cost, no unwanted
  // border). Only fall back to computing a size when no priced code was passed
  // (legacy flat orders).
  const resolved = codeFor(item, asset);
  if (resolved.error) return fail(resolved.error);
  const { productCode, dims } = resolved;

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

/**
 * Resolve one order line to what FinerWorks needs (image + product code + pixels),
 * honouring the priced size (borderless M8). Returns { productCode, imageUrl, ... }
 * or { error }. Shared by the single- and multi-item fulfil paths.
 */
async function resolveItem({ supabase, item }) {
  const imageUrl = item.driveFileId ? `https://lh3.googleusercontent.com/d/${item.driveFileId}=s0` : item.previewUrl;
  const thumbnailUrl = item.driveFileId ? `https://lh3.googleusercontent.com/d/${item.driveFileId}=s400` : item.previewUrl;
  if (!imageUrl) return { error: "no image URL" };

  let asset = null;
  try {
    let q = supabase.from("assets").select("width_px,height_px,max_print_width_cm,max_print_height_cm");
    q = item.assetId ? q.eq("id", item.assetId) : q.eq("drive_file_id", item.driveFileId);
    const { data } = await q.single();
    asset = data || null;
  } catch (e) { /* ignore */ }

  const resolved = codeFor(item, asset);
  if (resolved.error) return { error: resolved.error };
  const { productCode, dims } = resolved;

  let pixelWidth = asset ? asset.width_px || 0 : 0;
  let pixelHeight = asset ? asset.height_px || 0 : 0;
  if (!pixelWidth || !pixelHeight) {
    pixelWidth = Math.round(dims.widthCm * 0.393700787 * 300);
    pixelHeight = Math.round(dims.heightCm * 0.393700787 * 300);
  }
  return { productCode, imageUrl, thumbnailUrl, pixelWidth, pixelHeight };
}

/**
 * Fulfil ALL line items of one customer order as a SINGLE FinerWorks order — so
 * the whole order ships together (one shipping charge) instead of one shipment
 * per print. `rows` are fulfillment_orders rows for the same shopify_order_id.
 */
async function fulfillOrder({ supabase, finerworks, rows, address, email, shippingCode }) {
  if (!rows || !rows.length) return { ok: false, error: "no rows" };
  if (!address) return { ok: false, error: "no shipping address" };
  const countryCode = countryCodeFor(address);
  if (!countryCode) return { ok: false, error: `unknown country "${address.country}"` };

  const orderId = rows[0].shopify_order_id;
  const items = [];
  const rowByLine = {};
  for (const row of rows) {
    const item = {
      orderId: row.shopify_order_id, lineItemId: row.line_item_id,
      artworkTitle: row.artwork_title, size: row.size, priceTier: row.price_tier,
      driveFileId: row.drive_file_id, assetId: row.asset_id, quantity: row.quantity,
      finerworksProductCode: row.finerworks_product_code, frame: row.frame,
    };
    const r = await resolveItem({ supabase, item });
    if (r.error) {
      await supabase.from("fulfillment_orders").update({ status: "fulfillment_failed", error: r.error.slice(0, 300) })
        .eq("shopify_order_id", row.shopify_order_id).eq("line_item_id", row.line_item_id);
      continue;
    }
    items.push({ ...r, quantity: row.quantity || 1, title: row.artwork_title, lineId: row.line_item_id });
    rowByLine[row.line_item_id] = { row, productCode: r.productCode };
  }
  if (!items.length) return { ok: false, error: "no fulfillable items" };

  const name = address.name || `${address.first_name || ""} ${address.last_name || ""}`.trim() || "Customer";
  let fw;
  try {
    fw = await finerworks.createMultiItemOrder({
      recipient: { name, email: email || null, address1: address.address1, address2: address.address2 || "",
        city: address.city, state_code: address.province_code || "", country_code: countryCode, zip: address.zip, phone: address.phone || null },
      items,
      externalId: String(orderId),
      shippingCode,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!fw.created) return { ok: false, error: `FinerWorks created no order: ${fw.message || "no order_id"}` };

  // Stamp every line of the order with the SAME FinerWorks order number.
  for (const line of Object.keys(rowByLine)) {
    await supabase.from("fulfillment_orders").update({
      finerworks_order_id: String(fw.fwOrderId),
      finerworks_product_code: rowByLine[line].productCode,
      status: "sent_to_finerworks",
      error: null,
    }).eq("shopify_order_id", orderId).eq("line_item_id", line);
  }
  console.log(`   🖨️  FinerWorks order ${fw.fwOrderId} — ${fw.itemCount} items shipped together${fw.paymentFailed ? " [UNPAID]" : ""}`);
  return { ok: true, fwOrderId: fw.fwOrderId, itemCount: fw.itemCount, unpaid: fw.paymentFailed };
}

/**
 * Work out what WOULD be printed for a stored order line, without submitting
 * anything. Used by the approval queue so nothing is ever approved blind —
 * the exact print size and the FinerWorks cost are shown up front.
 *
 * Returns { productCode, printSize, widthIn, heightIn } or { error }.
 */
async function previewItem({ supabase, row }) {
  let asset = null;
  try {
    let q = supabase
      .from("assets")
      .select("width_px,height_px,max_print_width_cm,max_print_height_cm");
    q = row.asset_id ? q.eq("id", row.asset_id) : q.eq("drive_file_id", row.drive_file_id);
    const { data } = await q.single();
    asset = data || null;
  } catch (e) { /* ignore */ }

  const resolved = codeFor({ size: row.size, priceTier: row.price_tier, finerworksProductCode: row.finerworks_product_code, frame: row.frame }, asset);
  if (resolved.error) return { error: resolved.error };
  const { dims } = resolved;

  const widthIn = Math.round(dims.widthCm / 2.54);
  const heightIn = Math.round(dims.heightCm / 2.54);

  return {
    productCode: resolved.productCode,
    frameColor: resolved.frameColor,
    printSize: `${Math.min(widthIn, heightIn)}" × ${Math.max(widthIn, heightIn)}"`,
    widthIn,
    heightIn,
  };
}

module.exports = { fulfillItem, fulfillOrder, resolveItem, previewItem, resolveDims, countryCodeFor, codeFor, frameColorOf, applyFrame, TIER_LONGEST_EDGE_IN };
