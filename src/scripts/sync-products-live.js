/**
 * Neverland Prints — Live Product Sync
 * =====================================
 * Downloads images from Google Drive, uploads to Shopify as real products
 * with proper images, variants, pricing, artist info, and collections.
 *
 * Usage:
 *   node src/scripts/sync-products-live.js                  # sync all pending (max 50)
 *   node src/scripts/sync-products-live.js --limit=10       # sync 10
 *   node src/scripts/sync-products-live.js --active          # publish as active (not draft)
 *   node src/scripts/sync-products-live.js --collections     # also create collections
 *   node src/scripts/sync-products-live.js --limit=100 --active --collections
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const LIMIT = parseInt(getArg("limit") || "100", 10);
const PUBLISH_ACTIVE = hasFlag("active");
const CREATE_COLLECTIONS = hasFlag("collections");

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Shopify REST helpers ──────────────────────────────────
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;

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

  // Rate limit
  if (res.status === 429) {
    const wait = parseFloat(res.headers.get("Retry-After") || "2");
    console.log(`   ⏳ Rate limited — waiting ${wait}s`);
    await sleep(wait * 1000);
    return shopifyREST(method, endpoint, body, retries);
  }

  // Retry on 502/503
  if ((res.status === 502 || res.status === 503) && retries > 0) {
    console.log(`   ⏳ Shopify ${res.status} — retrying in 3s (${retries} left)`);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pricing ──────────────────────────────────────────────
function calcPrice(variant) {
  const area = variant.width_cm * variant.height_cm;
  if (area <= 600) return "29.99";
  if (area <= 1800) return "49.99";
  if (area <= 4000) return "79.99";
  return "119.99";
}

function calcCompareAtPrice(variant) {
  const area = variant.width_cm * variant.height_cm;
  if (area <= 600) return "39.99";
  if (area <= 1800) return "64.99";
  if (area <= 4000) return "99.99";
  return "149.99";
}

// ── Description builder ──────────────────────────────────
function buildDescription(asset, variants) {
  const artist = asset.artist || "Unknown Artist";
  const maxW = asset.max_print_width_cm;
  const maxH = asset.max_print_height_cm;
  const ratio = asset.ratio_class?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "";
  const sizes = variants
    .map((v) => `${v.label}: ${v.width_cm} × ${v.height_cm} cm (${v.width_inches} × ${v.height_inches}″)`)
    .join("<br>");

  return `
<div class="neverland-product-desc">
  <p>A stunning fine art print by <strong>${artist}</strong>, meticulously reproduced on museum-grade archival paper with fade-resistant inks.</p>

  <h4>Print Details</h4>
  <ul>
    <li><strong>Artist:</strong> ${artist}</li>
    <li><strong>Orientation:</strong> ${ratio}</li>
    <li><strong>Maximum Print Size:</strong> ${maxW} × ${maxH} cm</li>
    <li><strong>Quality:</strong> ${asset.quality_tier === "high" ? "Museum Grade (300+ DPI)" : "Gallery Grade (150+ DPI)"}</li>
  </ul>

  <h4>Available Sizes</h4>
  <p>${sizes}</p>

  <h4>Materials & Craftsmanship</h4>
  <ul>
    <li>Premium 310gsm cotton-rag archival paper</li>
    <li>Giclée printing with pigment-based inks</li>
    <li>Rated 200+ years lightfastness</li>
    <li>Ships flat in protective packaging</li>
  </ul>
</div>`.trim();
}

// ── Main sync ────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🖼️  NEVERLAND PRINTS — Live Product Sync");
  console.log("═".repeat(60));
  console.log(`  Limit: ${LIMIT} products`);
  console.log(`  Status: ${PUBLISH_ACTIVE ? "ACTIVE (visible on store)" : "DRAFT"}`);
  console.log(`  Collections: ${CREATE_COLLECTIONS ? "YES" : "NO"}`);
  console.log("═".repeat(60) + "\n");

  // 1) No longer need Google Drive API — we use public thumbnail URLs

  // 2) Fetch unsynced assets from Supabase
  const { data: assets, error } = await supabase
    .from("assets")
    .select("*")
    .eq("shopify_status", "pending")
    .order("artist", { ascending: true })
    .limit(LIMIT);

  if (error) throw error;

  if (!assets || assets.length === 0) {
    console.log("✅ No pending assets to sync. Everything up to date!");
    return;
  }

  console.log(`📦 Found ${assets.length} assets to sync\n`);

  let synced = 0;
  let errors = 0;
  const artistProducts = {}; // Track { artistName: [productId, ...] }

  for (const asset of assets) {
    const idx = `[${synced + errors + 1}/${assets.length}]`;
    const title = asset.title || asset.filename.replace(/\.\w+$/, "");

    try {
      console.log(`${idx} "${title}" by ${asset.artist}`);

      // 2a) Get variants from DB
      const { data: variants } = await supabase
        .from("asset_variants")
        .select("*")
        .eq("asset_id", asset.id)
        .order("width_cm", { ascending: true });

      if (!variants || variants.length === 0) {
        console.log("   ⏭️  No variants — skipping");
        continue;
      }

      // 2b) Build image URL from Google Drive (public thumbnail API)
      let imageUrl = null;
      if (asset.drive_file_id) {
        // lh3.googleusercontent.com serves thumbnails publicly for shared files
        // =s2048 gives a 2048px max dimension (good quality for product images)
        imageUrl = `https://lh3.googleusercontent.com/d/${asset.drive_file_id}=s2048`;
        console.log("   🖼️  Image URL ready");
      }

      // 2c) Build Shopify product
      const shopifyVariants = variants.map((v) => ({
        option1: `${v.label} — ${v.width_cm}×${v.height_cm} cm`,
        price: calcPrice(v),
        compare_at_price: calcCompareAtPrice(v),
        sku: `NP-${asset.id.slice(0, 8)}-${v.label.toLowerCase()}`,
        requires_shipping: true,
        inventory_management: null,
        taxable: true,
        weight: Math.round(v.width_cm * v.height_cm * 0.15 + 50),
        weight_unit: "g",
      }));

      // Tags for filtering/collections
      const tags = [
        asset.ratio_class?.replace(/_/g, " "),
        asset.quality_tier === "high" ? "museum grade" : "gallery grade",
        asset.style,
        asset.era,
        asset.mood,
        asset.subject,
        asset.palette,
        "art print",
        "fine art",
        "wall art",
        ...(asset.ai_tags || []),
      ].filter(Boolean);

      const productPayload = {
        product: {
          title: title,
          body_html: buildDescription(asset, variants),
          vendor: asset.artist || "Neverland Prints",
          product_type: "Art Print",
          tags: tags.join(", "),
          status: PUBLISH_ACTIVE ? "active" : "draft",
          options: [{ name: "Size" }],
          variants: shopifyVariants,
        },
      };

      // Attach image as URL (Shopify fetches it directly)
      if (imageUrl) {
        productPayload.product.images = [{
          src: imageUrl,
          alt: `${title} by ${asset.artist}`,
        }];
      }

      // 2d) Create product on Shopify
      console.log("   🛍️  Creating Shopify product...");
      const result = await shopifyREST("POST", "/products.json", productPayload);
      const product = result.product;

      // Track for collections
      const artistName = asset.artist || "Unknown";
      if (!artistProducts[artistName]) artistProducts[artistName] = [];
      artistProducts[artistName].push(product.id);

      // 2e) Update Supabase records
      await supabase
        .from("assets")
        .update({
          shopify_product_id: String(product.id),
          shopify_product_gid: `gid://shopify/Product/${product.id}`,
          shopify_status: "synced",
          shopify_synced_at: new Date().toISOString(),
          ingestion_status: "ready",
        })
        .eq("id", asset.id);

      // Map variant IDs back
      if (product.variants && variants) {
        for (let i = 0; i < product.variants.length && i < variants.length; i++) {
          await supabase
            .from("asset_variants")
            .update({
              shopify_variant_id: String(product.variants[i].id),
              shopify_variant_gid: `gid://shopify/ProductVariant/${product.variants[i].id}`,
              base_price: product.variants[i].price,
            })
            .eq("id", variants[i].id);
        }
      }

      synced++;
      console.log(
        `   ✅ Product #${product.id} — ${product.variants?.length} variants, ` +
          `${product.images?.length || 0} image(s)\n`
      );

      // Rate-limit pause (Shopify REST allows 2 req/s at Basic plan)
      await sleep(600);
    } catch (err) {
      errors++;
      console.error(`   ❌ Error: ${err.message}\n`);
      await supabase
        .from("assets")
        .update({ shopify_status: "error", ingestion_error: err.message })
        .eq("id", asset.id);
    }
  }

  // ── Collections ────────────────────────────────────────
  if (CREATE_COLLECTIONS && synced > 0) {
    console.log("\n" + "─".repeat(60));
    console.log("📁 Creating Collections...\n");

    // "All Art Prints" collection
    try {
      const allArt = await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: "All Art Prints",
          rules: [
            { column: "type", relation: "equals", condition: "Art Print" },
          ],
          sort_order: "best-selling",
          published: true,
        },
      });
      console.log(`   ✅ "All Art Prints" collection created`);
    } catch (e) {
      console.log(`   ⚠️  "All Art Prints": ${e.message.slice(0, 80)}`);
    }

    // "New Arrivals" smart collection
    try {
      await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: "New Arrivals",
          rules: [
            { column: "type", relation: "equals", condition: "Art Print" },
          ],
          sort_order: "created-desc",
          published: true,
        },
      });
      console.log(`   ✅ "New Arrivals" collection created`);
    } catch (e) {
      console.log(`   ⚠️  "New Arrivals": ${e.message.slice(0, 80)}`);
    }

    // Portrait prints
    try {
      await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: "Portrait Prints",
          rules: [
            { column: "tag", relation: "equals", condition: "portrait 4 5" },
          ],
          sort_order: "best-selling",
          published: true,
        },
      });
      console.log(`   ✅ "Portrait Prints" collection created`);
    } catch (e) {
      console.log(`   ⚠️  Portrait: ${e.message.slice(0, 80)}`);
    }

    // Landscape prints
    try {
      await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: "Landscape Prints",
          rules: [
            { column: "tag", relation: "equals", condition: "landscape 3 2" },
          ],
          sort_order: "best-selling",
          published: true,
        },
      });
      console.log(`   ✅ "Landscape Prints" collection created`);
    } catch (e) {
      console.log(`   ⚠️  Landscape: ${e.message.slice(0, 80)}`);
    }

    // Museum Grade
    try {
      await shopifyREST("POST", "/smart_collections.json", {
        smart_collection: {
          title: "Museum Grade",
          rules: [
            { column: "tag", relation: "equals", condition: "museum grade" },
          ],
          sort_order: "best-selling",
          published: true,
          body_html:
            "<p>Our highest resolution artworks, sourced from scans exceeding 300 DPI at maximum print size. Perfect for large-format museum-quality prints.</p>",
        },
      });
      console.log(`   ✅ "Museum Grade" collection created`);
    } catch (e) {
      console.log(`   ⚠️  Museum Grade: ${e.message.slice(0, 80)}`);
    }

    // Per-artist collections (custom collections with manual product assignment)
    const artistNames = Object.keys(artistProducts).sort();
    console.log(`\n   Creating ${artistNames.length} artist collections...`);

    for (const artist of artistNames) {
      try {
        // Create custom collection
        const { custom_collection: col } = await shopifyREST(
          "POST",
          "/custom_collections.json",
          {
            custom_collection: {
              title: artist,
              body_html: `<p>Explore the works of <strong>${artist}</strong>. Each piece is available as a museum-quality giclée print on archival paper.</p>`,
              published: true,
            },
          }
        );

        // Add products to collection via collects
        for (const productId of artistProducts[artist]) {
          await shopifyREST("POST", "/collects.json", {
            collect: {
              product_id: productId,
              collection_id: col.id,
            },
          });
          await sleep(250);
        }

        console.log(
          `   ✅ "${artist}" — ${artistProducts[artist].length} products`
        );
        await sleep(500);
      } catch (e) {
        console.log(`   ⚠️  "${artist}": ${e.message.slice(0, 80)}`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log(`✅ SYNC COMPLETE`);
  console.log(`   Products synced: ${synced}`);
  console.log(`   Errors: ${errors}`);
  if (CREATE_COLLECTIONS) {
    console.log(`   Artist collections: ${Object.keys(artistProducts).length}`);
  }
  console.log(
    `\n🌐 View store: https://${SHOP}`
  );
  console.log("═".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err);
  process.exit(1);
});
