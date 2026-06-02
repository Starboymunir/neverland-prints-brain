/**
 * Register the FinerWorks-backed CarrierService on the Shopify shop so that
 * checkout fetches live shipping rates from our backend.
 *
 * Idempotent: lists existing carrier services and updates the URL if one is
 * already registered with the same name; otherwise creates a new one.
 *
 * Requires Admin API token scope `write_shipping`.
 *
 *   node register-carrier-service.js
 */

const SHOP   = process.env.SHOPIFY_SHOP   || "neverland-prints.myshopify.com";
const TOKEN  = process.env.SHOPIFY_TOKEN  || process.env.SHOPIFY_ADMIN_TOKEN;
const API    = process.env.SHOPIFY_API    || "2024-10";

if (!TOKEN) {
  console.error("Set SHOPIFY_TOKEN (Shopify Admin API access token) before running.");
  process.exit(1);
}
const NAME   = process.env.CS_NAME        || "FinerWorks Live Rates";
const URL    = process.env.CS_CALLBACK_URL || "https://neverland-prints-brain-xvuy.onrender.com/api/carrier-service/rates";

const BASE = `https://${SHOP}/admin/api/${API}`;
const HEADERS = {
  "Content-Type": "application/json",
  "X-Shopify-Access-Token": TOKEN,
};

async function main() {
  console.log(`→ Listing existing carrier services on ${SHOP} ...`);
  const listRes = await fetch(`${BASE}/carrier_services.json`, { headers: HEADERS });
  if (!listRes.ok) {
    const t = await listRes.text();
    throw new Error(`List failed: ${listRes.status} ${t}`);
  }
  const { carrier_services = [] } = await listRes.json();
  console.log("  existing:", carrier_services.map(c => ({ id: c.id, name: c.name, url: c.callback_url, active: c.active })));

  const existing = carrier_services.find(c => c.name === NAME);

  if (existing) {
    if (existing.callback_url === URL && existing.active && existing.service_discovery) {
      console.log(`✓ Already up to date (id=${existing.id})`);
      return;
    }
    console.log(`→ Updating existing carrier service id=${existing.id} ...`);
    const r = await fetch(`${BASE}/carrier_services/${existing.id}.json`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        carrier_service: {
          id: existing.id,
          name: NAME,
          callback_url: URL,
          service_discovery: true,
          active: true,
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Update failed: ${r.status} ${JSON.stringify(data)}`);
    console.log("✓ Updated:", data.carrier_service);
    return;
  }

  console.log(`→ Creating new carrier service "${NAME}" → ${URL}`);
  const r = await fetch(`${BASE}/carrier_services.json`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      carrier_service: {
        name: NAME,
        callback_url: URL,
        service_discovery: true,
        active: true,
        carrier_service_type: "api",
        format: "json",
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Create failed:", r.status, data);
    if (r.status === 422 && /scope/i.test(JSON.stringify(data))) {
      console.error("\n⚠️  This shop's admin API token is missing the `write_shipping` scope.");
      console.error("    Re-install the app with that scope, or use a custom app token that has it.");
    }
    throw new Error("CarrierService creation failed");
  }
  console.log("✓ Created:", data.carrier_service);
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
