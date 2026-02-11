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

const router = express.Router();

const SHOPIFY_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

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

module.exports = router;
