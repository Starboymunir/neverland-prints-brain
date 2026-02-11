#!/usr/bin/env node
/**
 * Setup Shopify Pages & Webhook
 * ==============================
 * 1) Creates "Catalog" page (template: page.catalog)
 * 2) Creates "Art" page (template: page.art)
 * 3) Registers orders/create webhook
 *
 * Run: node src/scripts/setup-shopify.js
 */

require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || "2024-10";
const BASE = `https://${STORE}/admin/api/${API}`;

// Change this to your deployed backend URL
const BACKEND_URL = "https://neverland-prints-brain.onrender.com";

function request(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    };
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
          catch (e) { resolve({ status: res.statusCode, data: d }); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function createPage(title, handle, templateSuffix, bodyHtml = "") {
  console.log(`\nCreating page: "${title}" (handle: ${handle}, template: page.${templateSuffix})...`);

  // Check if page already exists
  const existing = await request("GET", `${BASE}/pages.json?handle=${handle}`);
  if (existing.data?.pages?.length > 0) {
    console.log(`  ✓ Page "${title}" already exists (ID: ${existing.data.pages[0].id})`);
    return existing.data.pages[0];
  }

  const res = await request("POST", `${BASE}/pages.json`, {
    page: {
      title,
      handle,
      body_html: bodyHtml,
      template_suffix: templateSuffix,
      published: true,
    },
  });

  if (res.status === 201 || res.status === 200) {
    console.log(`  ✓ Created page "${title}" (ID: ${res.data.page.id})`);
    return res.data.page;
  } else {
    console.error(`  ✗ Failed (${res.status}):`, JSON.stringify(res.data).slice(0, 200));
    return null;
  }
}

async function registerWebhook(topic, address) {
  console.log(`\nRegistering webhook: ${topic} → ${address}...`);

  // Check existing webhooks
  const existing = await request("GET", `${BASE}/webhooks.json?topic=${topic}`);
  const existingWebhooks = existing.data?.webhooks || [];
  const match = existingWebhooks.find((w) => w.address === address);
  if (match) {
    console.log(`  ✓ Webhook already registered (ID: ${match.id})`);
    return match;
  }

  const res = await request("POST", `${BASE}/webhooks.json`, {
    webhook: {
      topic,
      address,
      format: "json",
    },
  });

  if (res.status === 201 || res.status === 200) {
    console.log(`  ✓ Webhook registered (ID: ${res.data.webhook.id})`);
    return res.data.webhook;
  } else {
    console.error(`  ✗ Failed (${res.status}):`, JSON.stringify(res.data).slice(0, 300));
    return null;
  }
}

async function main() {
  console.log("=== SHOPIFY SETUP ===");
  console.log("Store:", STORE);
  console.log("Backend:", BACKEND_URL);

  // 1. Create "Catalog" page
  await createPage(
    "Catalog",
    "catalog",
    "catalog",
    "<p>Browse our collection of fine art prints.</p>"
  );

  // 2. Create "Art" page
  await createPage(
    "Art",
    "art",
    "art",
    ""
  );

  // 3. Register order webhook
  await registerWebhook(
    "orders/create",
    `${BACKEND_URL}/webhooks/order-created`
  );

  // 4. Register order-paid webhook (optional)
  await registerWebhook(
    "orders/paid",
    `${BACKEND_URL}/webhooks/order-paid`
  );

  // 5. List all webhooks
  console.log("\n--- Active Webhooks ---");
  const webhooks = await request("GET", `${BASE}/webhooks.json`);
  for (const w of webhooks.data?.webhooks || []) {
    console.log(`  ${w.topic} → ${w.address}`);
  }

  // 6. List all pages
  console.log("\n--- Pages ---");
  const pages = await request("GET", `${BASE}/pages.json`);
  for (const p of pages.data?.pages || []) {
    console.log(`  ${p.title} → /pages/${p.handle} (template: page.${p.template_suffix || "default"})`);
  }

  console.log("\n=== DONE ===");
}

main().catch((e) => console.error("FATAL:", e));
