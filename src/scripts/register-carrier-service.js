/**
 * Register Carrier Service with Shopify
 * ======================================
 * Registers our backend's /api/carrier-service/rates endpoint
 * as a Shopify Carrier Service so real-time Printful shipping rates
 * appear at checkout.
 *
 * Run: node src/scripts/register-carrier-service.js
 *
 * Requirements:
 *   - SHOPIFY_ADMIN_API_TOKEN with `write_shipping` scope
 *   - Backend deployed at BACKEND_URL
 */
require("dotenv").config();

const STORE = process.env.SHOPIFY_STORE_DOMAIN || "neverland-prints.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const BACKEND_URL = "https://neverland-prints-brain.onrender.com";

const BASE = `https://${STORE}/admin/api/${API_VERSION}`;

async function request(method, url, body = null) {
  const opts = {
    method,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  if (!res.ok) {
    console.error(`${method} ${url} → ${res.status}`);
    console.error(text.slice(0, 500));
    return null;
  }

  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log("=== Register Carrier Service ===\n");

  // 1. List existing carrier services
  console.log("Checking existing carrier services...");
  const existing = await request("GET", `${BASE}/carrier_services.json`);

  if (existing && existing.carrier_services) {
    console.log(`Found ${existing.carrier_services.length} existing carrier service(s):`);
    for (const cs of existing.carrier_services) {
      console.log(`  [${cs.id}] "${cs.name}" → ${cs.callback_url} (active: ${cs.active})`);
    }

    // Check if ours is already registered
    const ours = existing.carrier_services.find(
      (cs) => cs.callback_url && cs.callback_url.includes("carrier-service/rates")
    );
    if (ours) {
      console.log(`\n✅ Carrier service already registered (ID: ${ours.id})`);
      console.log(`   Callback: ${ours.callback_url}`);
      console.log(`   Active: ${ours.active}`);

      // Update if inactive
      if (!ours.active) {
        console.log("   Reactivating...");
        await request("PUT", `${BASE}/carrier_services/${ours.id}.json`, {
          carrier_service: { active: true },
        });
        console.log("   ✅ Reactivated");
      }
      return;
    }
  }

  // 2. Register new carrier service
  console.log("\nRegistering Printful shipping rates carrier service...");
  const result = await request("POST", `${BASE}/carrier_services.json`, {
    carrier_service: {
      name: "Printful Shipping",
      callback_url: `${BACKEND_URL}/api/carrier-service/rates`,
      service_discovery: true,
      active: true,
      format: "json",
    },
  });

  if (result && result.carrier_service) {
    console.log(`\n✅ Carrier service registered!`);
    console.log(`   ID: ${result.carrier_service.id}`);
    console.log(`   Name: ${result.carrier_service.name}`);
    console.log(`   Callback: ${result.carrier_service.callback_url}`);
    console.log(`   Active: ${result.carrier_service.active}`);
    console.log("\nShopify will now call this endpoint at checkout to get shipping rates from Printful.");
  } else {
    console.error("\n❌ Failed to register carrier service.");
    console.error("   Make sure your API token has 'write_shipping' scope.");
    console.error("   On Shopify Basic/Shopify plans, you may need the");
    console.error("   'Third-party calculated shipping rates' add-on ($20/mo).");
  }
}

main().catch((e) => console.error("FATAL:", e));
