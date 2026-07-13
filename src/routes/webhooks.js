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
const { fulfillItem, previewItem } = require("../services/fulfillment");

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
                // Store the ISO codes too — manual approval submits from this
                // record and FinerWorks needs country_code, not the country name.
                province_code: order.shipping_address.province_code || null,
                country: order.shipping_address.country,
                country_code: order.shipping_address.country_code || null,
                zip: order.shipping_address.zip,
                phone: order.shipping_address.phone || order.phone || null,
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
      // OFF BY DEFAULT. Auto-submitting charges the card on file immediately with
      // no chance to review the order, so orders are parked as "awaiting_approval"
      // and only sent to FinerWorks when a human approves them
      // (POST /webhooks/approve-order). Set FINERWORKS_AUTO_SUBMIT=true to re-enable.
      const autoSubmit = String(process.env.FINERWORKS_AUTO_SUBMIT || "").trim().toLowerCase() === "true";
      if (!autoSubmit && orderItems.length > 0) {
        console.log("   ⏸️  Auto-fulfil OFF — order parked for manual approval (no charge).");
        try {
          await supabase
            .from("fulfillment_orders")
            .update({ status: "awaiting_approval" })
            .eq("shopify_order_id", orderItems[0].orderId);
        } catch (e) { /* ignore */ }
      }

      if (autoSubmit && process.env.FINERWORKS_WEB_API_KEY && process.env.FINERWORKS_APP_KEY && order.shipping_address) {
        console.log("   🖨️  Auto-fulfil ON — sending to FinerWorks...");
        for (const item of orderItems) {
          await fulfillItem({
            supabase,
            finerworks,
            item,
            address: order.shipping_address,
            email: order.email,
          });
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

/**
 * GET /webhooks/pending-orders?key=...
 * Orders waiting for manual approval — nothing here has touched FinerWorks or
 * cost a penny yet.
 */
router.get("/pending-orders", async (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { data: rows, error } = await supabase
      .from("fulfillment_orders")
      .select("*")
      .in("status", ["awaiting_approval", "pending", "fulfillment_failed"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    // Show exactly what will be printed and what FinerWorks will charge, so an
    // order is never approved blind.
    const orders = [];
    for (const row of rows || []) {
      const preview = await previewItem({ supabase, row });
      orders.push({
        order_name: row.order_name,
        shopify_order_id: row.shopify_order_id,
        line_item_id: row.line_item_id,
        artwork_title: row.artwork_title,
        artist: row.artist,
        tier: row.price_tier || row.size,
        quantity: row.quantity,
        sold_for: row.price,
        customer_email: row.customer_email,
        shipping_address: row.shipping_address,
        status: row.status,
        error: row.error,
        created_at: row.created_at,
        print_size: preview.printSize || null,
        product_code: preview.productCode || null,
        preview_error: preview.error || null,
      });
    }

    // Batch the FinerWorks cost lookup for everything we could price.
    const codes = [...new Set(orders.map((o) => o.product_code).filter(Boolean))];
    if (codes.length) {
      try {
        const priced = await finerworks.getPrices({ productCodes: codes });
        const costByCode = {};
        (priced.prices || []).forEach((p) => { costByCode[p.product_code] = p.total_price; });
        orders.forEach((o) => { o.finerworks_cost = o.product_code ? costByCode[o.product_code] : null; });
      } catch (e) { /* pricing is a nicety — never block the queue */ }
    }

    res.json({ count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhooks/approve-order?key=...
 * Body: { order_name: "#1010" } or { shopify_order_id, line_item_id? }
 *
 * The ONLY path that sends anything to FinerWorks. The order arrives there UNPAID —
 * production starts only once it is paid in FinerWorks, so approving still costs
 * nothing by itself.
 */
router.post("/approve-order", async (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });

  const { order_name, shopify_order_id, line_item_id } = req.body || {};
  if (!order_name && !shopify_order_id) {
    return res.status(400).json({ error: "order_name or shopify_order_id is required" });
  }

  try {
    let q = supabase.from("fulfillment_orders").select("*");
    q = order_name ? q.eq("order_name", order_name) : q.eq("shopify_order_id", shopify_order_id);
    if (line_item_id) q = q.eq("line_item_id", line_item_id);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) return res.status(404).json({ error: "Order not found" });

    const results = [];
    for (const row of rows) {
      if (row.status === "sent_to_finerworks" && row.finerworks_order_id) {
        results.push({
          artwork: row.artwork_title,
          skipped: "already sent to FinerWorks",
          finerworks_order_id: row.finerworks_order_id,
        });
        continue;
      }

      const result = await fulfillItem({
        supabase,
        finerworks,
        item: {
          orderId: row.shopify_order_id,
          lineItemId: row.line_item_id,
          artworkTitle: row.artwork_title,
          size: row.size,
          priceTier: row.price_tier,
          driveFileId: row.drive_file_id,
          assetId: row.asset_id,
          quantity: row.quantity,
        },
        address: row.shipping_address,
        email: row.customer_email,
      });

      results.push({ artwork: row.artwork_title, ...result });
    }

    res.json({ approved: order_name || shopify_order_id, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;