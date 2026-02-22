/**
 * Create Smart Collections
 * ========================
 * Creates curated smart collections based on product tags/type.
 * These categorize the art catalog for browsing.
 *
 * Usage:
 *   node src/scripts/create-collections.js
 *   node src/scripts/create-collections.js --delete-first   # delete existing before creating
 */

require("dotenv").config();
const config = require("../config");

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;
const DELETE_FIRST = process.argv.includes("--delete-first");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopifyREST(method, endpoint, body = null, retries = 3) {
  const url = `${BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (res.status === 429) {
    const wait = parseFloat(res.headers.get("Retry-After") || "2");
    console.log(`   ⏳ Rate limited — waiting ${wait}s`);
    await sleep(wait * 1000);
    return shopifyREST(method, endpoint, body, retries);
  }

  if ((res.status === 502 || res.status === 503) && retries > 0) {
    console.log(`   ⏳ Shopify ${res.status} — retrying in 3s`);
    await sleep(3000);
    return shopifyREST(method, endpoint, body, retries - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${method} ${endpoint} → ${res.status}: ${text}`);
  }

  const ct = res.headers.get("Content-Type") || "";
  return ct.includes("json") ? res.json() : null;
}

// ── Smart Collections to create ──────────────────────────
const COLLECTIONS = [
  {
    title: "All Art Prints",
    body_html: "<p>Browse our complete collection of over 101,000 museum-quality art prints, spanning centuries of artistic mastery.</p>",
    rules: [{ column: "type", relation: "equals", condition: "Art Print" }],
    sort_order: "best-selling",
  },
  {
    title: "New Arrivals",
    body_html: "<p>The latest additions to our collection — freshly digitised masterworks ready for your walls.</p>",
    rules: [{ column: "type", relation: "equals", condition: "Art Print" }],
    sort_order: "created-desc",
  },
  {
    title: "Portrait Prints",
    body_html: "<p>Vertical compositions perfect for narrow walls, hallways, and intimate spaces. From classical portraits to figure studies.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "portrait_2_3" },
      { column: "tag", relation: "equals", condition: "portrait_3_4" },
      { column: "tag", relation: "equals", condition: "portrait_4_5" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Landscape Prints",
    body_html: "<p>Wide-format masterpieces capturing sweeping vistas, seascapes, and atmospheric scenes. Ideal for living rooms and offices.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "landscape_3_2" },
      { column: "tag", relation: "equals", condition: "landscape_4_3" },
      { column: "tag", relation: "equals", condition: "landscape_16_9" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Square Prints",
    body_html: "<p>Perfectly balanced square-format artworks. Versatile for any room and stunning in gallery wall arrangements.</p>",
    rules: [
      { column: "tag", relation: "equals", condition: "square" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Museum Grade",
    body_html: "<p>Our highest resolution artworks — exceeding 300 DPI at maximum print size. The pinnacle of print quality for discerning collectors.</p>",
    rules: [
      { column: "tag", relation: "equals", condition: "museum grade" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Panoramic Prints",
    body_html: "<p>Ultra-wide or ultra-tall format prints for dramatic visual impact. Perfect for statement walls and unique spaces.</p>",
    disjunctive: true,
    rules: [
      { column: "tag", relation: "equals", condition: "panoramic_wide" },
      { column: "tag", relation: "equals", condition: "panoramic_tall" },
    ],
    sort_order: "best-selling",
  },
  {
    title: "Gallery Grade",
    body_html: "<p>Beautiful prints at gallery-standard quality. Outstanding value without compromising on materials or craftsmanship.</p>",
    rules: [
      { column: "tag", relation: "equals", condition: "gallery grade" },
    ],
    sort_order: "best-selling",
  },
];

async function deleteExistingCollections() {
  console.log("\n🗑️  Deleting existing smart collections...");
  try {
    const { smart_collections } = await shopifyREST("GET", "/smart_collections.json?limit=250");
    for (const col of (smart_collections || [])) {
      try {
        await shopifyREST("DELETE", `/smart_collections/${col.id}.json`);
        console.log(`   Deleted: ${col.title} (${col.id})`);
        await sleep(300);
      } catch (e) {
        console.log(`   ⚠️ Failed to delete ${col.title}: ${e.message.slice(0, 60)}`);
      }
    }
  } catch (e) {
    console.log(`   ⚠️ Could not list collections: ${e.message.slice(0, 80)}`);
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  NEVERLAND PRINTS — Create Smart Collections");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Store: ${SHOP}`);
  console.log(`  Collections: ${COLLECTIONS.length}`);
  console.log(`  Delete first: ${DELETE_FIRST}`);
  console.log("═══════════════════════════════════════════════════\n");

  if (DELETE_FIRST) {
    await deleteExistingCollections();
  }

  let created = 0;
  let errors = 0;

  for (const col of COLLECTIONS) {
    try {
      const result = await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: col.title,
          body_html: col.body_html,
          rules: col.rules,
          sort_order: col.sort_order || "best-selling",
          disjunctive: col.disjunctive || false,
          published: true,
        },
      });

      if (result.smart_collection) {
        console.log(`   ✅ "${col.title}" — ID: ${result.smart_collection.id} (${result.smart_collection.products_count || 0} products)`);
        created++;
      } else {
        console.log(`   ⚠️ "${col.title}": ${JSON.stringify(result.errors || result)}`);
        errors++;
      }
    } catch (e) {
      // If it already exists, skip
      if (e.message.includes("422") && e.message.includes("has already been taken")) {
        console.log(`   ⏭️  "${col.title}" already exists — skipping`);
      } else {
        console.log(`   ❌ "${col.title}": ${e.message.slice(0, 100)}`);
        errors++;
      }
    }
    await sleep(500);
  }

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  ✅ Created: ${created} | ❌ Errors: ${errors}`);
  console.log(`═══════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err);
  process.exit(1);
});
