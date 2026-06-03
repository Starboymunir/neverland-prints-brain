// setup-shipping-zones.js — Provision Shopify shipping zones + rates via Admin API.
//
// Inspect:   node setup-shipping-zones.js
// Apply:     node setup-shipping-zones.js --apply
//
// Idempotent-ish: creates "Neverland — US" and "Neverland — Rest of World"
// on the default delivery profile. If zones with those exact names already
// exist they are deleted first.
require("dotenv").config();

const APPLY = process.argv.includes("--apply");
const TIER = process.argv.includes("--tiered") ? "tiered" : "flat";

const SHOP = process.env.SHOPIFY_STORE_DOMAIN || "neverland-prints.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || "2024-10";

if (!TOKEN) { console.error("Missing SHOPIFY_ADMIN_API_TOKEN"); process.exit(1); }

const ZONE_US_NAME = "Neverland — US";
const ZONE_INTL_NAME = "Neverland — Rest of World";

// Flat plan
const FLAT_US = "11.95";
const FLAT_INTL = "26.95";

// Tiered plan
const US_TIER_THRESHOLD = "200.00";
const INTL_TIER_THRESHOLD = "250.00";

// Common ISO-3166 country codes (Shopify "REST_OF_WORLD" trick): we list all
// supported countries except US. Easiest: pass `includeRestOfWorld: true` on the zone
// for the international zone.

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function fetchProfile() {
  const q = `{
    deliveryProfiles(first: 5) {
      edges { node {
        id name default
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: 50) {
            edges { node {
              zone { id name countries { code { countryCode restOfWorld } } }
              methodDefinitionCounts { rateDefinitionsCount participantDefinitionsCount }
            } }
          }
        }
      } }
    }
  }`;
  const d = await gql(q);
  const def = d.deliveryProfiles.edges.map(e => e.node).find(n => n.default) || d.deliveryProfiles.edges[0]?.node;
  if (!def) throw new Error("No delivery profile found");
  return def;
}

function buildMethodDefinitions(plan, zoneType) {
  // zoneType: "us" | "intl"
  if (plan === "flat") {
    const price = zoneType === "us" ? FLAT_US : FLAT_INTL;
    const name = zoneType === "us" ? "Standard shipping (US — arrives in 1–2 weeks)" : "International shipping (3–5 weeks incl. customs)";
    return [{ name, active: true, rateDefinition: { price: { amount: price, currencyCode: "USD" } } }];
  }
  // tiered
  if (zoneType === "us") {
    return [
      { name: "Standard shipping (US — arrives in 1–2 weeks)", active: true,
        rateDefinition: { price: { amount: "9.95", currencyCode: "USD" } },
        conditions: [{ conditionCriteria: { price: { amount: "0.00", currencyCode: "USD" } }, field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO" },
                     { conditionCriteria: { price: { amount: US_TIER_THRESHOLD, currencyCode: "USD" } }, field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO" }] },
      { name: "Large item shipping", active: true,
        rateDefinition: { price: { amount: "24.99", currencyCode: "USD" } },
        conditions: [{ conditionCriteria: { price: { amount: US_TIER_THRESHOLD, currencyCode: "USD" } }, field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO" }] },
    ];
  }
  return [
    { name: "International shipping (3–5 weeks incl. customs)", active: true,
      rateDefinition: { price: { amount: "22.95", currencyCode: "USD" } },
      conditions: [{ conditionCriteria: { price: { amount: "0.00", currencyCode: "USD" } }, field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO" },
                   { conditionCriteria: { price: { amount: INTL_TIER_THRESHOLD, currencyCode: "USD" } }, field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO" }] },
    { name: "Large international shipping", active: true,
      rateDefinition: { price: { amount: "36.95", currencyCode: "USD" } },
      conditions: [{ conditionCriteria: { price: { amount: INTL_TIER_THRESHOLD, currencyCode: "USD" } }, field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO" }] },
  ];
}

async function main() {
  console.log(`MODE: ${APPLY ? "APPLY" : "DRY RUN — pass --apply to write"} | PLAN: ${TIER}`);
  const profile = await fetchProfile();
  console.log(`\nDelivery profile: ${profile.name} (${profile.id}) default=${profile.default}`);
  const lg = profile.profileLocationGroups[0];
  console.log(`Location group: ${lg.locationGroup.id}`);
  console.log("\nExisting zones:");
  const zones = lg.locationGroupZones.edges.map(e => e.node);
  for (const z of zones) {
    const cc = z.zone.countries.map(c => c.code.restOfWorld ? "RoW" : c.code.countryCode).join(",");
    console.log(`  - ${z.zone.name} [${cc}]  rates=${z.methodDefinitionCounts.rateDefinitionsCount}  id=${z.zone.id}`);
  }

  const toDelete = zones.map(z => z.zone.id); // wipe-and-replace

  const plan = TIER;
  const zonesToCreate = [
    {
      name: ZONE_US_NAME,
      countries: [{ code: "US", includeAllProvinces: true }],
      methodDefinitionsToCreate: buildMethodDefinitions(plan, "us"),
    },
    {
      name: ZONE_INTL_NAME,
      countries: [{ restOfWorld: true }],
      methodDefinitionsToCreate: buildMethodDefinitions(plan, "intl"),
    },
  ];

  console.log("\nPlanned operations:");
  if (toDelete.length) console.log(`  delete ${toDelete.length} existing zone(s): ${zones.map(z => z.zone.name).join(", ")}`);
  console.log(`  create zone "${ZONE_US_NAME}" (US) with ${zonesToCreate[0].methodDefinitionsToCreate.length} rate(s)`);
  console.log(`  create zone "${ZONE_INTL_NAME}" (Rest of World) with ${zonesToCreate[1].methodDefinitionsToCreate.length} rate(s)`);
  for (const z of zonesToCreate) {
    for (const m of z.methodDefinitionsToCreate) {
      const rate = m.rateDefinition.price.amount;
      const cond = m.conditions ? ` (conditions: ${m.conditions.length})` : "";
      console.log(`     • ${z.name} → "${m.name}" $${rate}${cond}`);
    }
  }

  if (!APPLY) { console.log("\nDry run only. Re-run with --apply (and optionally --tiered)."); return; }

  const mutation = `
    mutation deliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
      deliveryProfileUpdate(id: $id, profile: $profile) {
        profile { id name }
        userErrors { field message }
      }
    }`;

  const variables = {
    id: profile.id,
    profile: {
      ...(toDelete.length ? { zonesToDelete: toDelete } : {}),
      locationGroupsToUpdate: [
        {
          id: lg.locationGroup.id,
          zonesToCreate,
        },
      ],
    },
  };

  const result = await gql(mutation, variables);
  const errs = result.deliveryProfileUpdate.userErrors;
  if (errs.length) {
    console.error("\n✗ userErrors:");
    for (const e of errs) console.error(`  ${e.field?.join(".") || "?"}: ${e.message}`);
    process.exit(1);
  }
  console.log("\n✓ Zones provisioned.");

  // Re-fetch and print
  const after = await fetchProfile();
  console.log("\nResulting zones:");
  for (const z of after.profileLocationGroups[0].locationGroupZones.edges.map(e => e.node)) {
    const cc = z.zone.countries.map(c => c.code.restOfWorld ? "RoW" : c.code.countryCode).join(",");
    console.log(`  - ${z.zone.name} [${cc}]  rates=${z.methodDefinitionCounts.rateDefinitionsCount}`);
  }
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
