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
const path = require("path");
const { exec } = require("child_process");
const supabase = require("../db/supabase");
const FinerWorksService = require("../services/finerworks");
const ShopifyService = require("../services/shopify");
const { fulfillItem, fulfillOrder, resolveItem, previewItem } = require("../services/fulfillment");

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
      .in("status", ["awaiting_approval", "pending", "paid", "processing", "fulfillment_failed"])
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
/**
 * POST /webhooks/quote-shipping?key=...  Body: { order_name } or { shopify_order_id }
 * Returns live FinerWorks shipping options (economy/standard/2-day/overnight) with
 * costs for the WHOLE order — a quote only, nothing is placed or charged.
 */
router.post("/quote-shipping", async (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });

  const { order_name, shopify_order_id } = req.body || {};
  try {
    let q = supabase.from("fulfillment_orders").select("*");
    q = order_name ? q.eq("order_name", order_name) : q.eq("shopify_order_id", shopify_order_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    if (!rows || !rows.length) return res.status(404).json({ error: "Order not found" });

    const address = rows[0].shipping_address || {};
    const items = [];
    for (const row of rows) {
      const r = await resolveItem({
        supabase,
        item: {
          size: row.size, priceTier: row.price_tier, driveFileId: row.drive_file_id,
          assetId: row.asset_id, finerworksProductCode: row.finerworks_product_code, artworkTitle: row.artwork_title,
        },
      });
      if (r.productCode) {
        items.push({
          product_sku: r.productCode, product_qty: row.quantity || 1, product_title: (row.artwork_title || "Print").slice(0, 40),
          pixel_width: r.pixelWidth, pixel_height: r.pixelHeight, product_url_file: r.imageUrl, product_url_thumbnail: r.thumbnailUrl,
        });
      }
    }
    if (!items.length) return res.status(400).json({ error: "No priceable items" });

    const quote = await finerworks.listShippingOptions({
      recipient: {
        first_name: "Q", last_name: "uote", address1: address.address1 || "1 Main St", city: address.city || "City",
        state_code: address.province_code || null, zip: address.zip, country_code: address.country_code || "US",
      },
      items,
    });
    const options = ((quote.orders || [])[0] || {}).options || [];
    res.json({
      order: order_name || shopify_order_id,
      options: options.map((o) => ({ code: o.shipping_code, method: o.shipping_method, rate: o.rate }))
        .sort((a, b) => a.rate - b.rate),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhooks/run-descriptions?key=...&chunk=20000
 * Kick off the AI description regenerate on the SERVER and SELF-CHAIN memory-safe
 * chunks until the whole catalog is done — trigger once, it finishes on Render on
 * its own (no laptop, no re-triggering). Each chunk is a fresh child process so
 * memory is released between chunks; resumable via looksOld().
 */
let _descRunning = false;
let _descStats = { chunks: 0, done: 0, startedAt: null, lastChunk: null };

function runDescriptionChunk(chunkSize, iter) {
  const root = path.join(__dirname, "..", "..");
  const cmd = `node ${path.join(root, "src/scripts/generate-descriptions.js")} --regenerate --synced-only --gemini-only --concurrency=4 --batch-size=20 --limit=${chunkSize}`;
  console.log(`🖊️  [run-descriptions] chunk ${iter} starting`);
  exec(cmd, { cwd: root, timeout: 3 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    if (err) console.error(`🖊️  [run-descriptions] chunk ${iter} error:`, err.message);
    const out = stdout || "";
    const found = parseInt((out.match(/Found (\d+) assets/) || [])[1] || "0", 10);
    const gen = parseInt((out.match(/Phase 1 complete: (\d+)/) || [])[1] || "0", 10);
    _descStats.chunks = iter;
    _descStats.done += gen;
    _descStats.lastChunk = { found, generated: gen, at: new Date().toISOString() };
    console.log(`🖊️  [run-descriptions] chunk ${iter} done — found ${found}, generated ${gen}, total ${_descStats.done}`);

    // Chain the next chunk while there is still work (a full chunk found = more remain).
    if (found > 0 && iter < 60) {
      setTimeout(() => runDescriptionChunk(chunkSize, iter + 1), 5000);
    } else {
      _descRunning = false;
      console.log(`🖊️  [run-descriptions] ALL DONE — ${_descStats.done} descriptions over ${iter} chunks.`);
    }
  });
}

router.post("/run-descriptions", (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });
  if (_descRunning) return res.json({ ok: true, already_running: true, stats: _descStats });

  const chunk = Math.min(parseInt(req.query.chunk || "20000", 10) || 20000, 30000);
  _descRunning = true;
  _descStats = { chunks: 0, done: 0, startedAt: new Date().toISOString(), lastChunk: null };
  runDescriptionChunk(chunk, 1);
  res.json({ ok: true, started: true, chunk, note: "self-chaining on the server until the whole catalog is done" });
});

/** GET /webhooks/run-descriptions/status?key=... — progress + live key test. */
router.get("/run-descriptions/status", async (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });

  // Test the SERVER's Gemini key directly (1-token call) so a bad/missing key on
  // Render is caught immediately instead of showing as a silent 0-progress run.
  let geminiKey = "not set";
  const gk = process.env.GEMINI_API_KEY;
  if (gk) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${gk}`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "OK" }] }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }) }
      );
      geminiKey = r.ok ? "WORKS" : `FAIL ${r.status}: ${(await r.text()).slice(0, 120)}`;
    } catch (e) { geminiKey = "error: " + e.message.slice(0, 80); }
  }

  res.json({ running: _descRunning, geminiKey, ..._descStats });
});

router.post("/approve-order", async (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });

  const { order_name, shopify_order_id, line_item_id, shipping_code } = req.body || {};
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

    // Group all line items of the SAME Shopify order into ONE FinerWorks order so
    // the whole order ships together (one shipping charge), not one shipment per print.
    const byOrder = {};
    for (const row of rows) {
      // Skip items already sent (don't re-submit / double-charge).
      if (row.status === "sent_to_finerworks" && row.finerworks_order_id) continue;
      (byOrder[row.shopify_order_id] = byOrder[row.shopify_order_id] || []).push(row);
    }

    const results = [];
    for (const [oid, orderRows] of Object.entries(byOrder)) {
      const r = await fulfillOrder({
        supabase,
        finerworks,
        rows: orderRows,
        address: orderRows[0].shipping_address,
        email: orderRows[0].customer_email,
        shippingCode: shipping_code || undefined, // Standard by default; pass EX/ON for expedited
      });
      results.push({ shopify_order_id: oid, items: orderRows.length, ...r });
    }

    if (!results.length) return res.json({ approved: order_name || shopify_order_id, results: [{ skipped: "all items already sent" }] });
    res.json({ approved: order_name || shopify_order_id, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Self-chaining PRICE NORMALIZE on the server ────────────────────────────
// Rewrites every product's Shopify variants to the dynamic engine prices so the
// native feed (Google Shopping, Shop app, AI shop, ads) matches what's charged.
// Resumable via the neverland.price_version metafield; runs to completion on Render.
let _normRunning = false;
let _normStats = { chunks: 0, done: 0, startedAt: null, lastChunk: null, cursor: "" };

function runNormalizeChunk(chunkSize, iter) {
  const root = path.join(__dirname, "..", "..");
  const after = _normStats.cursor ? ` --after-id=${_normStats.cursor}` : "";
  const cmd = `node ${path.join(root, "normalize-product-prices.js")} --apply --limit=${chunkSize}${after}`;
  console.log(`💲 [run-normalize] chunk ${iter} starting (after=${_normStats.cursor || "start"})`);
  exec(cmd, { cwd: root, timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    if (err) console.error(`💲 [run-normalize] chunk ${iter} error:`, err.message);
    const out = stdout || "";
    const norm = parseInt((out.match(/normalized (\d+)/) || [])[1] || "0", 10);
    const scanned = parseInt((out.match(/SCANNED=(\d+)/) || [])[1] || "0", 10);
    const resume = (out.match(/RESUME_AFTER=([^\s]+)/) || [])[1] || _normStats.cursor;
    _normStats.chunks = iter;
    _normStats.done += norm;
    _normStats.cursor = resume;
    _normStats.lastChunk = { normalized: norm, scanned, at: new Date().toISOString() };
    // Persist the cursor DURABLY so a cold restart (Render free-tier spin-down)
    // resumes exactly here instead of from the top. Fire-and-forget.
    if (resume) {
      supabase.from("analytics_events")
        .insert({ event_type: "_norm_cursor", search_query: String(resume), consent: false, metadata: { done: _normStats.done, at: new Date().toISOString() } })
        .then(() => {}, () => {});
    }
    console.log(`💲 [run-normalize] chunk ${iter} done — normalized ${norm}, scanned ${scanned}, total ${_normStats.done}`);
    // Continue while the last batch was full (more rows remain). Stop only when a
    // batch comes back short — that's the true end of the catalog. A transient
    // error (scanned 0 but not end) also retries a few times rather than quitting.
    const moreRemain = scanned >= chunkSize;
    const transient = scanned === 0 && err;
    if ((moreRemain || transient) && iter < 5000) {
      setTimeout(() => runNormalizeChunk(chunkSize, iter + 1), transient ? 15000 : 3000);
    } else {
      _normRunning = false;
      console.log(`💲 [run-normalize] ALL DONE — ${_normStats.done} products over ${iter} chunks.`);
    }
  });
}

router.post("/run-normalize", (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });
  if (_normRunning) return res.json({ ok: true, already_running: true, stats: _normStats });
  // Batch size per chunk (Supabase page). Default 500 keeps each child short so a
  // restart loses little; the chain forwards a cursor so there's no re-scan.
  const chunk = Math.min(parseInt(req.query.chunk || "500", 10) || 500, 2000);
  const startAfter = req.query.after || ""; // optional manual resume point
  _normRunning = true;
  _normStats = { chunks: 0, done: 0, startedAt: new Date().toISOString(), lastChunk: null, cursor: startAfter };
  runNormalizeChunk(chunk, 1);
  res.json({ ok: true, started: true, chunk, note: "cursor-resumable price normalize on the server until done" });
});

router.get("/run-normalize/status", (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });
  res.json({ running: _normRunning, ..._normStats });
});

// ── Cloud-cron keep-alive + auto-resume ────────────────────────────────────
// A scheduled cloud ping hits this every few minutes. Two jobs:
//   1. The inbound request keeps the Render free-tier service awake (so an
//      in-flight self-chain keeps advancing instead of freezing).
//   2. If no run is active (e.g. after a cold restart), it RESUMES the price
//      normalize from the durable cursor stored in Supabase — so the backfill
//      finishes unattended, with no laptop and no lost progress.
async function readDurableCursor() {
  try {
    const { data } = await supabase
      .from("analytics_events")
      .select("search_query")
      .eq("event_type", "_norm_cursor")
      .order("created_at", { ascending: false })
      .limit(1);
    return (data && data[0] && data[0].search_query) || "";
  } catch (e) { return ""; }
}

router.post("/normalize-tick", async (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });
  if (_normRunning) return res.json({ ok: true, warm: true, running: true, done: _normStats.done, cursor: _normStats.cursor });
  // Not running — resume from the durable cursor.
  const cursor = await readDurableCursor();
  const chunk = 500;
  _normRunning = true;
  _normStats = { chunks: 0, done: 0, startedAt: new Date().toISOString(), lastChunk: null, cursor };
  runNormalizeChunk(chunk, 1);
  res.json({ ok: true, resumed: true, from: cursor || "start" });
});

// ── Self-chaining COMMERCIAL RANKING on the server ─────────────────────────
// Scores the whole assets catalog with the commercial-ranking engine and
// writes commercial_score on each row (used by ?sort=commercial and, later,
// the personalized homepage baseline). Resumable: each chunk scores the next
// batch of still-null rows. Needs the assets.commercial_score column.
let _rankRunning = false;
let _rankStats = { chunks: 0, scored: 0, startedAt: null, lastChunk: null };

function runRankChunk(chunkSize, iter, rescore) {
  const root = path.join(__dirname, "..", "..");
  // rescore = one full keyset pass over EVERY row (rank-catalog paginates
  // internally), so no --limit and no chaining. Null-only scoring stays chunked
  // (each chunk naturally continues since scored rows drop out of the filter).
  const limitFlag = rescore ? "" : ` --limit=${chunkSize}`;
  const rescoreFlag = rescore ? " --rescore" : "";
  const cmd = `node ${path.join(root, "src", "scripts", "rank-catalog.js")}${limitFlag}${rescoreFlag}`;
  console.log(`⭐ [run-ranking] chunk ${iter} starting${rescore ? " (RESCORE full pass)" : ""}`);
  exec(cmd, { cwd: root, timeout: 3 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    if (err) console.error(`⭐ [run-ranking] chunk ${iter} error:`, err.message);
    const out = stdout || "";
    const m = out.match(/RANK DONE — scored (\d+)/);
    const scored = m ? parseInt(m[1], 10) : 0;
    _rankStats.chunks = iter;
    _rankStats.scored += scored;
    _rankStats.lastChunk = { scored, at: new Date().toISOString() };
    console.log(`⭐ [run-ranking] chunk ${iter} done — scored ${scored}, total ${_rankStats.scored}`);
    if (!rescore && scored > 0 && iter < 400) {
      setTimeout(() => runRankChunk(chunkSize, iter + 1, false), 3000);
    } else {
      _rankRunning = false;
      console.log(`⭐ [run-ranking] ALL DONE — ${_rankStats.scored} scored over ${iter} chunks.`);
    }
  });
}

router.post("/run-ranking", (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });
  if (_rankRunning) return res.json({ ok: true, already_running: true, stats: _rankStats });
  const rescore = req.query.rescore === "1" || req.query.rescore === "true";
  const chunk = Math.min(parseInt(req.query.chunk || "20000", 10) || 20000, 60000);
  _rankRunning = true;
  _rankStats = { chunks: 0, scored: 0, startedAt: new Date().toISOString(), lastChunk: null };
  runRankChunk(chunk, 1, rescore);
  res.json({ ok: true, started: true, rescore, note: rescore ? "full rescore pass on the server" : "self-chaining commercial ranking until done" });
});

router.get("/run-ranking/status", (req, res) => {
  const key = process.env.FINERWORKS_WEBHOOK_KEY;
  if (key && req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });
  res.json({ running: _rankRunning, ..._rankStats });
});

module.exports = router;