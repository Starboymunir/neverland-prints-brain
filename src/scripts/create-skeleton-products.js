#!/usr/bin/env node
/**
 * Create Skeleton Products
 * ========================
 * Creates 4 price-tier products on Shopify (8 variants total).
 * These are the ONLY products needed — the full 101k catalog
 * is served from Supabase. Cart uses line item properties.
 *
 * Products:
 *   1. Art Print - Small    → Unframed $29.99, Framed $39.99
 *   2. Art Print - Medium   → Unframed $49.99, Framed $64.99
 *   3. Art Print - Large    → Unframed $79.99, Framed $99.99
 *   4. Art Print - Extra Large → Unframed $119.99, Framed $149.99
 *
 * Flags:
 *   --delete-first    Delete ALL existing products first (resets variant throttle)
 *   --delete-only     Only delete products, don't create skeletons
 *
 * Run: node src/scripts/create-skeleton-products.js
 *      node src/scripts/create-skeleton-products.js --delete-first
 */

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
const REST_URL = `https://${STORE}/admin/api/${API_VERSION}`;

const DELETE_FIRST = process.argv.includes("--delete-first");
const DELETE_ONLY = process.argv.includes("--delete-only");

const SKELETON_PRODUCTS = [
  {
    title: "Art Print - Small",
    handle: "art-print-small",
    tier: "small",
    description:
      "Museum-quality giclée art print on premium 310gsm cotton-rag archival paper. Available unframed or framed in solid wood frame. Sizes up to 24×17 cm.",
    variants: [
      { title: "Unframed", price: "29.99", sku: "NP-SMALL-UNFRAMED" },
      { title: "Framed", price: "39.99", sku: "NP-SMALL-FRAMED" },
    ],
  },
  {
    title: "Art Print - Medium",
    handle: "art-print-medium",
    tier: "medium",
    description:
      "Museum-quality giclée art print on premium 310gsm cotton-rag archival paper. Available unframed or framed in solid wood frame. Sizes up to 42×30 cm.",
    variants: [
      { title: "Unframed", price: "49.99", sku: "NP-MEDIUM-UNFRAMED" },
      { title: "Framed", price: "64.99", sku: "NP-MEDIUM-FRAMED" },
    ],
  },
  {
    title: "Art Print - Large",
    handle: "art-print-large",
    tier: "large",
    description:
      "Museum-quality giclée art print on premium 310gsm cotton-rag archival paper. Available unframed or framed in solid wood frame. Sizes up to 63×45 cm.",
    variants: [
      { title: "Unframed", price: "79.99", sku: "NP-LARGE-UNFRAMED" },
      { title: "Framed", price: "99.99", sku: "NP-LARGE-FRAMED" },
    ],
  },
  {
    title: "Art Print - Extra Large",
    handle: "art-print-extra-large",
    tier: "extra_large",
    description:
      "Museum-quality giclée art print on premium 310gsm cotton-rag archival paper. Available unframed or framed in solid wood frame. Sizes over 63×45 cm.",
    variants: [
      { title: "Unframed", price: "119.99", sku: "NP-XL-UNFRAMED" },
      { title: "Framed", price: "149.99", sku: "NP-XL-FRAMED" },
    ],
  },
];

// ─── HTTP helpers using Node https (compatible with all Node versions) ───

function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const url = new (require("url").URL)(GQL_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(JSON.stringify(json.errors, null, 2)));
          } else {
            resolve(json.data);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function restDelete(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new (require("url").URL)(`${REST_URL}${endpoint}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "DELETE",
      headers: { "X-Shopify-Access-Token": TOKEN },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createSkeletonProduct(spec) {
  console.log(`\nCreating: ${spec.title}...`);

  const mutation = `
    mutation productSet($input: ProductSetInput!) {
      productSet(input: $input) {
        product {
          id
          title
          handle
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                sku
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    title: spec.title,
    handle: spec.handle,
    descriptionHtml: `<p>${spec.description}</p>`,
    vendor: "Neverland Prints",
    productType: "Art Print",
    tags: ["skeleton-product", `tier-${spec.tier}`, "price-tier"],
    status: "ACTIVE",
    productOptions: [
      {
        name: "Frame",
        values: spec.variants.map((v) => ({ name: v.title })),
      },
    ],
    variants: spec.variants.map((v) => ({
      optionValues: [{ optionName: "Frame", name: v.title }],
      price: v.price,
      sku: v.sku,
      inventoryPolicy: "CONTINUE",
    })),
  };

  const data = await graphql(mutation, { input });
  const result = data.productSet;

  if (result.userErrors && result.userErrors.length > 0) {
    console.error("  Errors:", result.userErrors);
    return null;
  }

  const product = result.product;
  console.log(`  ✓ Created: ${product.title} (${product.id})`);
  product.variants.edges.forEach((e) => {
    console.log(`    → ${e.node.title}: $${e.node.price} (${e.node.id})`);
  });

  return product;
}

// ─── Bulk delete all existing products ───

async function deleteAllProducts() {
  console.log("\n═══ DELETING ALL EXISTING PRODUCTS ═══");
  console.log("This resets the variant count below 50k, removing the throttle.\n");

  let totalDeleted = 0;
  let hasMore = true;

  while (hasMore) {
    // Fetch a batch of product IDs
    const data = await graphql(`{
      products(first: 250) {
        edges {
          node {
            id
            title
            variantsCount { count }
          }
        }
        pageInfo { hasNextPage }
      }
    }`);

    const products = data.products.edges;
    if (products.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`  Deleting batch of ${products.length} products...`);

    // Delete each product
    for (const edge of products) {
      try {
        await graphql(`
          mutation deleteProduct($id: ID!) {
            productDelete(input: { id: $id }) {
              deletedProductId
              userErrors { field message }
            }
          }
        `, { id: edge.node.id });
        totalDeleted++;
      } catch (err) {
        // Check for rate limit
        if (err.message.includes("Throttled")) {
          console.log("    Rate limited, waiting 2s...");
          await sleep(2000);
          // Retry
          try {
            await graphql(`
              mutation deleteProduct($id: ID!) {
                productDelete(input: { id: $id }) {
                  deletedProductId
                  userErrors { field message }
                }
              }
            `, { id: edge.node.id });
            totalDeleted++;
          } catch (e) {
            console.error(`    ✗ Skip ${edge.node.title}: ${e.message.slice(0, 80)}`);
          }
        } else {
          console.error(`    ✗ Skip ${edge.node.title}: ${err.message.slice(0, 80)}`);
        }
      }

      // Pace ourselves to avoid Shopify rate limits
      if (totalDeleted % 50 === 0) {
        console.log(`  … deleted ${totalDeleted} so far`);
        await sleep(500);
      }
    }

    hasMore = data.products.pageInfo.hasNextPage;
  }

  console.log(`\n  ✓ Total deleted: ${totalDeleted} products`);
  return totalDeleted;
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  NEVERLAND PRINTS — Skeleton Product Setup   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\nStore: ${STORE}`);

  // Check current product count
  const countData = await graphql(`{ productsCount { count } }`);
  console.log(`Current products on Shopify: ${countData.productsCount.count}`);

  // Delete existing products if requested
  if (DELETE_FIRST || DELETE_ONLY) {
    await deleteAllProducts();

    // Re-check count
    const newCount = await graphql(`{ productsCount { count } }`);
    console.log(`\nProducts after deletion: ${newCount.productsCount.count}`);

    if (DELETE_ONLY) {
      console.log("\n--delete-only flag set. Done.");
      return;
    }

    // Wait a moment for Shopify to update throttle state
    console.log("\nWaiting 5s for Shopify to update throttle state...");
    await sleep(5000);
  }

  console.log(`\nCreating ${SKELETON_PRODUCTS.length} products (${SKELETON_PRODUCTS.length * 2} variants)...\n`);

  const results = {};

  for (const spec of SKELETON_PRODUCTS) {
    try {
      const product = await createSkeletonProduct(spec);
      if (product) {
        results[spec.tier] = {
          productId: product.id,
          handle: product.handle,
          variants: {},
        };
        product.variants.edges.forEach((e) => {
          const key = e.node.title.toLowerCase();
          results[spec.tier].variants[key] = {
            id: e.node.id,
            numericId: e.node.id.replace("gid://shopify/ProductVariant/", ""),
            price: e.node.price,
            sku: e.node.sku,
          };
        });
      }
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    }
    await sleep(500); // pace requests
  }

  if (Object.keys(results).length === 0) {
    console.error("\n✗ No products created! The variant throttle may still be active.");
    console.error("  Try running with --delete-first to remove existing products first.");
    process.exit(1);
  }

  // Build the price map
  const priceMap = {};
  for (const [tier, data] of Object.entries(results)) {
    for (const [frame, variant] of Object.entries(data.variants)) {
      const key = `${tier}_${frame}`;
      priceMap[key] = {
        variantId: variant.numericId,
        variantGid: variant.id,
        price: variant.price,
        sku: variant.sku,
        tier,
        framed: frame === "framed",
      };
    }
  }

  console.log("\n\n═══ PRICE MAP ═══");
  console.log(JSON.stringify(priceMap, null, 2));

  // Write price map to config file
  const mapPath = path.join(__dirname, "..", "config", "skeleton-price-map.json");
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(priceMap, null, 2));
  console.log(`\n✓ Price map saved to: ${mapPath}`);

  // Also save full product map
  const fullPath = path.join(__dirname, "..", "config", "skeleton-products.json");
  fs.writeFileSync(fullPath, JSON.stringify(results, null, 2));
  console.log(`✓ Full product map saved to: ${fullPath}`);

  console.log("\n═══ SUMMARY ═══");
  console.log(`Products created: ${Object.keys(results).length}`);
  console.log(`Variants created: ${Object.keys(priceMap).length}`);
  console.log("\nThese skeleton products handle ALL purchases.");
  console.log("The full 101k catalog is served from Supabase via API.");
  console.log("Cart uses line item properties to identify each artwork.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
