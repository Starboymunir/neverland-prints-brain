/**
 * Order Webhook Routes
 * ====================
 * Handles Shopify order webhooks for the Skeleton Product Architecture.
 * When an order comes in, it reads line item properties to identify
 * the actual artwork, size, and framing details.
 *
 * Webhook: orders/create → POST /webhooks/order-created
 */

const express = require("express");
const crypto = require("crypto");
const supabase = require("../db/supabase");
const FinerWorksService = require("../services/finerworks");
const ShopifyService = require("../services/shopify");

const router = express.Router();

const SHOPIFY_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const finerworks = new FinerWorksService();
const shopify = new ShopifyService();

/**
 * Verify Shopify webhook signature (HMAC-SHA256)
 */
function verifyWebhook(req) {
  if (!SHOPIFY_SECRET) return true; // skip in dev if not configured

  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac) return false;

  const hash = crypto
    .createHmac("sha256", SHOPIFY_SECRET)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

/**
 * POST /webhooks/order-created
 * Process new orders — extract artwork info from line item properties.
 */
router.post("/order-created", async (req, res) => {
  // Verify webhook authenticity
  if (!verifyWebhook(req)) {
    console.error("Webhook verification failed");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const order = req.body;
    console.log(`\n📦 Order received: ${order.name} (${order.id})`);
    console.log(`   Customer: ${order.email}`);
    console.log(`   Total: ${order.total_price} ${order.currency}`);
    console.log(`   Items: ${order.line_items?.length || 0}`);

    const orderItems = [];

    for (const item of order.line_items || []) {
      const props = {};
      (item.properties || []).forEach((p) => {
        props[p.name] = p.value;
      });

      const isSkeletonProduct = !!props["Artwork"];

      if (isSkeletonProduct) {
        // This is a catalog item purchased through skeleton product
        const orderItem = {
          orderId: order.id.toString(),
          orderName: order.name,
          lineItemId: item.id?.toString(),
          assetId: props["_asset_id"] || null,
          artworkTitle: props["Artwork"],
          artist: props["Artist"] || "Unknown",
          size: props["Size"] || "",
          frame: props["Frame"] || "Unframed",
          priceTier: props["_price_tier"] || "",
          finerworksProductCode: props["_finerworks_product_code"] || "",
          driveFileId: props["_drive_file_id"] || "",
          previewUrl: props["_preview"] || "",
          quantity: item.quantity,
          price: item.price,
          skuBase: item.sku,
          customerEmail: order.email,
          shippingAddress: order.shipping_address
            ? {
                name: `${order.shipping_address.first_name} ${order.shipping_address.last_name}`,
                address1: order.shipping_address.address1,
                address2: order.shipping_address.address2,
                city: order.shipping_address.city,
                province: order.shipping_address.province,
                country: order.shipping_address.country,
                zip: order.shipping_address.zip,
              }
            : null,
        };

        orderItems.push(orderItem);

        console.log(`   🎨 Art: "${orderItem.artworkTitle}" by ${orderItem.artist}`);
        console.log(`      Size: ${orderItem.size} | Frame: ${orderItem.frame} | Qty: ${orderItem.quantity}`);
        console.log(`      Asset ID: ${orderItem.assetId}`);
      } else {
        console.log(`   📦 Standard: ${item.title} × ${item.quantity}`);
      }
    }

    // Save order items to Supabase for fulfillment
    if (orderItems.length > 0) {
      // Insert into a fulfillment_orders table
      const rows = orderItems.map((item) => ({
        shopify_order_id: item.orderId,
        order_name: item.orderName,
        line_item_id: item.lineItemId,
        asset_id: item.assetId,
        artwork_title: item.artworkTitle,
        artist: item.artist,
        size: item.size,
        frame: item.frame,
        price_tier: item.priceTier,
        drive_file_id: item.driveFileId,
        quantity: item.quantity,
        price: item.price,
        customer_email: item.customerEmail,
        shipping_address: item.shippingAddress,
        status: "pending",
      }));

      try {
        const { error } = await supabase.from("fulfillment_orders").upsert(rows, {
          onConflict: "shopify_order_id,line_item_id",
        });
        if (error) {
          // Table might not exist yet — log but don't fail
          console.warn("   ⚠ DB insert warning:", error.message);
          console.log("   (Create the 'fulfillment_orders' table to persist order data)");
        } else {
          console.log(`   ✓ Saved ${rows.length} fulfillment items to DB`);
        }
      } catch (dbErr) {
        console.warn("   ⚠ DB error:", dbErr.message);
      }

      // Track purchase events
      for (const item of orderItems) {
        try {
          await supabase.from("analytics_events").insert({
            event_type: "purchase",
            product_id: null,
            metadata: {
              asset_id: item.assetId,
              title: item.artworkTitle,
              artist: item.artist,
              price: item.price,
              order_id: item.orderId,
            },
          });
        } catch (e) { /* ignore */ }
      }

      // ── AUTO-FULFILL via FinerWorks ─────────────────────
      if (process.env.FINERWORKS_WEB_API_KEY && process.env.FINERWORKS_APP_KEY && order.shipping_address) {
        console.log("   🖨️  Sending to FinerWorks for fulfillment...");
        for (const item of orderItems) {
          try {
            // Build high-res image URL from Drive file ID (s0 = max resolution)
            const imageUrl = item.driveFileId
              ? `https://lh3.googleusercontent.com/d/${item.driveFileId}=s0`
              : item.previewUrl;

            // Smaller thumbnail for FinerWorks invoice preview
            const thumbnailUrl = item.driveFileId
              ? `https://lh3.googleusercontent.com/d/${item.driveFileId}=s400`
              : item.previewUrl;

            if (!imageUrl) {
              console.log(`   ⚠️  No image URL for "${item.artworkTitle}" — skip FinerWorks`);
              continue;
            }

            // Look up the artwork in Supabase (by asset_id or drive_file_id) for
            // pixel dimensions and the max print size.
            let asset = null;
            try {
              let q = supabase
                .from("assets")
                .select("width_px,height_px,max_print_width_cm,max_print_height_cm");
              q = item.assetId
                ? q.eq("id", item.assetId)
                : q.eq("drive_file_id", item.driveFileId);
              const { data } = await q.single();
              asset = data || null;
            } catch (e) { /* ignore */ }

            // Determine the exact print dimensions. Prefer the Size property when it
            // carries real "W × H cm"; otherwise compute from the artwork's max print
            // size × the tier scale (orders from /products/ pages send a tier label
            // like "Extra Large" instead of dimensions).
            let dims = FinerWorksService.parseSizeCm(item.size);
            if (!dims && asset && asset.max_print_width_cm && asset.max_print_height_cm) {
              const TIER_SCALE = { small: 0.35, medium: 0.55, large: 0.75, extra_large: 1.0 };
              const tierKey = (item.priceTier || item.size || "")
                .toString().trim().toLowerCase().replace(/\s+/g, "_");
              const scale = TIER_SCALE[tierKey] || 0.55;
              dims = {
                widthCm:  asset.max_print_width_cm  * scale,
                heightCm: asset.max_print_height_cm * scale,
              };
              console.log(`   ℹ️  Size "${item.size}" → ${Math.round(dims.widthCm)}×${Math.round(dims.heightCm)}cm (max × ${tierKey} ${scale})`);
            }
            if (!dims) {
              console.error(`   ⚠️  Cannot determine print size for "${item.artworkTitle}" (size="${item.size}") — skip FinerWorks`);
              continue;
            }

            // Clamp to FinerWorks' max printable size (longest side 48 in), keeping
            // aspect — the catalog can advertise larger "max print" sizes than
            // FinerWorks can actually produce.
            const MAX_PRINT_IN = 48;
            const longestIn = Math.max(dims.widthCm, dims.heightCm) / 2.54;
            if (longestIn > MAX_PRINT_IN) {
              const f = MAX_PRINT_IN / longestIn;
              dims = { widthCm: dims.widthCm * f, heightCm: dims.heightCm * f };
            }

            const productCode = item.finerworksProductCode || FinerWorksService.buildDefaultProductCode(dims.widthCm, dims.heightCm);

            // FinerWorks requires pixel dimensions in product_image_file.
            let pixelWidth  = asset ? (asset.width_px  || 0) : 0;
            let pixelHeight = asset ? (asset.height_px || 0) : 0;
            if (!pixelWidth || !pixelHeight) {
              // Fallback: assume enough pixels for the print at 300dpi.
              pixelWidth  = Math.round(dims.widthCm  * 0.393700787 * 300);
              pixelHeight = Math.round(dims.heightCm * 0.393700787 * 300);
            }

            const fwOrder = await finerworks.createOrder({
              recipient: {
                name:         order.shipping_address.first_name + " " + order.shipping_address.last_name,
                email:        order.email,
                address1:     order.shipping_address.address1,
                address2:     order.shipping_address.address2 || "",
                city:         order.shipping_address.city,
                state_code:   order.shipping_address.province_code || "",
                country_code: order.shipping_address.country_code,
                zip:          order.shipping_address.zip,
                phone:        order.shipping_address.phone || order.phone || null,
              },
              imageUrl,
              thumbnailUrl,
              pixelWidth,
              pixelHeight,
              productCode,
              quantity: item.quantity || 1,
              title:     item.artworkTitle,
              externalId: `${item.orderId}-${item.lineItemId}`,
            });

            console.log(`   🖨️  FinerWorks order ${fwOrder.id} (${productCode}) submitted for "${item.artworkTitle}"`);

            // Persist FinerWorks order metadata
            try {
              await supabase
                .from("fulfillment_orders")
                .update({
                  finerworks_order_id: fwOrder.id,
                  finerworks_product_code: productCode,
                  status: "sent_to_finerworks",
                })
                .eq("shopify_order_id", item.orderId)
                .eq("line_item_id", item.lineItemId);
            } catch (e) { /* table may not exist yet */ }

          } catch (fwErr) {
            console.error(`   ❌ FinerWorks error for "${item.artworkTitle}": ${fwErr.message.slice(0, 200)}`);
            // Persist the failure so it's visible (was silently leaving status "pending").
            try {
              await supabase
                .from("fulfillment_orders")
                .update({ status: "fulfillment_failed", error: fwErr.message.slice(0, 300) })
                .eq("shopify_order_id", item.orderId)
                .eq("line_item_id", item.lineItemId);
            } catch (e) { /* ignore */ }
          }
        }
      }
    }

    res.status(200).json({ received: true, items: orderItems.length });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ received: true, error: err.message });
  }
});

/**
 * POST /webhooks/order-paid
 * Optional: triggered when payment is confirmed.
 */
router.post("/order-paid", async (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const order = req.body;
    console.log(`💰 Order paid: ${order.name}`);

    // Update fulfillment status to "paid"
    try {
      await supabase
        .from("fulfillment_orders")
        .update({ status: "paid" })
        .eq("shopify_order_id", order.id.toString());
    } catch (e) { /* table may not exist */ }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ received: true });
  }
});

/**
 * Process a single FW status payload — looks up the matching
 * fulfillment_orders row, calls Shopify fulfillmentCreateV2 if shipped,
 * persists tracking. Returns a small summary suitable for logging.
 */
async function processFinerWorksStatus(payload) {
  const norm = FinerWorksService.normalizeStatus(payload);
  if (!norm) return { ok: false, reason: "empty_payload" };

  // Find the Supabase row this FW order maps to.
  let row = null;
  if (norm.fwOrderNumber) {
    const { data } = await supabase
      .from("fulfillment_orders")
      .select("*")
      .eq("finerworks_order_id", String(norm.fwOrderNumber))
      .maybeSingle();
    row = data;
  }
  if (!row && norm.externalId) {
    const { data } = await supabase
      .from("fulfillment_orders")
      .select("*")
      .eq("external_id", norm.externalId)
      .maybeSingle();
    row = data;
  }
  if (!row) {
    return { ok: false, reason: "no_local_row", normalized: norm };
  }

  if (row.status === "shipped") {
    return { ok: true, alreadyShipped: true, row: row.id };
  }

  if (!norm.shipped) {
    // Just record the latest FW status without creating a fulfillment.
    await supabase
      .from("fulfillment_orders")
      .update({ status: `fw_${norm.status || "unknown"}` })
      .eq("id", row.id);
    return { ok: true, status: norm.status, fulfilled: false };
  }

  if (!norm.tracking) {
    return { ok: false, reason: "shipped_but_no_tracking", normalized: norm };
  }

  // Create the Shopify fulfillment + send the shipped email.
  let fulfillmentResult;
  try {
    fulfillmentResult = await shopify.createShipmentFulfillment({
      shopifyOrderId: row.shopify_order_id,
      trackingNumber: norm.tracking,
      trackingUrl: norm.trackingUrl,
      carrier: norm.carrier || "Other",
      notifyCustomer: true,
    });
  } catch (err) {
    await supabase
      .from("fulfillment_orders")
      .update({ status: "fulfillment_failed", notes: err.message?.slice(0, 500) })
      .eq("id", row.id);
    throw err;
  }

  await supabase
    .from("fulfillment_orders")
    .update({
      status: "shipped",
      tracking_number: norm.tracking,
      tracking_url: norm.trackingUrl || null,
      carrier: norm.carrier || null,
      shipped_at: norm.shippedAt || new Date().toISOString(),
    })
    .eq("id", row.id);

  return { ok: true, fulfilled: true, fulfillmentResult, row: row.id };
}

/**
 * POST /webhooks/finerworks-status
 * Endpoint we register with FW (`webhook_order_status_url` on submit_orders_v2).
 * FW will POST status changes here. We accept the call, look up the local
 * fulfillment row, and create a Shopify fulfillment when status indicates shipped.
 *
 * Auth: optional shared secret via `?key=` query string matched against
 * FINERWORKS_WEBHOOK_KEY env var. Safe to omit during initial testing.
 */
router.post("/finerworks-status", async (req, res) => {
  const secret = process.env.FINERWORKS_WEBHOOK_KEY;
  if (secret && req.query.key !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.log("📦 FW status webhook:", JSON.stringify(req.body).slice(0, 600));
    const result = await processFinerWorksStatus(req.body);
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    console.error("FW status webhook error:", err);
    res.status(200).json({ received: true, error: err.message });
  }
});

/**
 * POST /webhooks/poll-finerworks
 * Manual / cron-triggered poll: scan fulfillment_orders that are
 * sent_to_finerworks (and not yet shipped) and call FW for the latest status.
 *
 * Auth: optional `?key=` query string against FINERWORKS_WEBHOOK_KEY.
 */
router.post("/poll-finerworks", async (req, res) => {
  const secret = process.env.FINERWORKS_WEBHOOK_KEY;
  if (secret && req.query.key !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { data: rows, error } = await supabase
      .from("fulfillment_orders")
      .select("*")
      .in("status", ["sent_to_finerworks", "paid"])
      .not("finerworks_order_id", "is", null)
      .limit(200);

    if (error) throw error;

    const results = [];
    for (const row of rows || []) {
      try {
        const statusResp = await finerworks.getOrderStatus(row.finerworks_order_id);
        const payload = statusResp?.orders?.[0] || statusResp;
        const result = await processFinerWorksStatus(payload);
        results.push({ id: row.id, fw: row.finerworks_order_id, ...result });
      } catch (e) {
        results.push({ id: row.id, fw: row.finerworks_order_id, error: e.message });
      }
    }
    res.status(200).json({ checked: results.length, results });
  } catch (err) {
    console.error("poll-finerworks error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;