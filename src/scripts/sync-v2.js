/**
 * Neverland Prints — Product Sync v2
 * ====================================
 * Creates Shopify products with metafields pointing to Google Drive images.
 * NO image downloads. NO image uploads. The theme renders images directly
 * from Google Drive via lh3.googleusercontent.com/d/{fileId}=s{size}.
 *
 * Usage:
 *   node src/scripts/sync-v2.js                           # sync all pending (max 100)
 *   node src/scripts/sync-v2.js --limit=10                # sync 10
 *   node src/scripts/sync-v2.js --limit=100 --collections # + create collections
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "100", 10);
const CREATE_COLLECTIONS = hasFlag("collections");

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Shopify REST ──────────────────────────────────────────
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = config.shopify.apiVersion || "2024-10";
const BASE = `https://${SHOP}/admin/api/${API_VER}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function shopify(method, endpoint, body = null, retries = 3) {
  const url = `${BASE}${endpoint}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (res.status === 429) {
    const wait = parseFloat(res.headers.get("Retry-After") || "2");
    console.log(`   ⏳ Rate limited — ${wait}s`);
    await sleep(wait * 1000);
    return shopify(method, endpoint, body, retries);
  }
  if ((res.status === 502 || res.status === 503) && retries > 0) {
    console.log(`   ⏳ ${res.status} — retrying (${retries})`);
    await sleep(3000);
    return shopify(method, endpoint, body, retries - 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${method} ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get("Content-Type") || "";
  return ct.includes("json") ? res.json() : null;
}

// ── Pricing ──────────────────────────────────────────────
function price(v) {
  const area = v.width_cm * v.height_cm;
  if (area <= 600) return "29.99";
  if (area <= 1800) return "49.99";
  if (area <= 4000) return "79.99";
  return "119.99";
}
function comparePrice(v) {
  const area = v.width_cm * v.height_cm;
  if (area <= 600) return "39.99";
  if (area <= 1800) return "64.99";
  if (area <= 4000) return "99.99";
  return "149.99";
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🖼️  NEVERLAND PRINTS — Product Sync v2 (No Image Uploads)");
  console.log("═".repeat(60));
  console.log(`  Limit: ${LIMIT} | Collections: ${CREATE_COLLECTIONS ? "YES" : "NO"}`);
  console.log("═".repeat(60) + "\n");

  // Fetch pending assets
  const { data: assets, error } = await supabase
    .from("assets")
    .select("*")
    .eq("shopify_status", "pending")
    .order("artist", { ascending: true })
    .limit(LIMIT);

  if (error) throw error;
  if (!assets || !assets.length) {
    console.log("✅ All assets already synced!");
    return;
  }

  console.log(`📦 ${assets.length} assets to sync\n`);

  let synced = 0, errors = 0;
  const artistProducts = {};

  for (const asset of assets) {
    const idx = `[${synced + errors + 1}/${assets.length}]`;
    const title = asset.title || asset.filename.replace(/\.\w+$/, "");

    try {
      // Get variants
      const { data: variants } = await supabase
        .from("asset_variants")
        .select("*")
        .eq("asset_id", asset.id)
        .order("width_cm", { ascending: true });

      if (!variants?.length) {
        console.log(`${idx} "${title}" — no variants, skipping`);
        continue;
      }

      // Build product
      const shopVariants = variants.map(v => ({
        option1: `${v.label} — ${v.width_cm}×${v.height_cm} cm`,
        price: price(v),
        compare_at_price: comparePrice(v),
        sku: `NP-${asset.id.slice(0, 8)}-${v.label.toLowerCase()}`,
        requires_shipping: true,
        inventory_management: null,
        taxable: true,
        weight: Math.round(v.width_cm * v.height_cm * 0.15 + 50),
        weight_unit: "g",
      }));

      const tags = [
        asset.ratio_class?.replace(/_/g, " "),
        asset.quality_tier === "high" ? "museum grade" : "gallery grade",
        asset.style, asset.era, asset.mood, asset.subject, asset.palette,
        "art print", "fine art", "wall art",
        ...(asset.ai_tags || []),
      ].filter(Boolean);

      // Description
      const artistName = asset.artist || "Unknown Artist";
      const sizes = variants.map(v => `${v.label}: ${v.width_cm}×${v.height_cm} cm`).join(" · ");
      const desc = `<p>A museum-quality fine art print by <strong>${artistName}</strong>.</p><p><strong>Available sizes:</strong> ${sizes}</p><p>Printed on premium 310gsm cotton-rag archival paper with pigment-based inks rated for 200+ years lightfastness.</p>`;

      const payload = {
        product: {
          title,
          body_html: desc,
          vendor: artistName,
          product_type: "Art Print",
          tags: tags.join(", "),
          status: "active",
          options: [{ name: "Size" }],
          variants: shopVariants,
          metafields: [
            {
              namespace: "neverland",
              key: "drive_file_id",
              value: asset.drive_file_id,
              type: "single_line_text_field",
            },
            {
              namespace: "neverland",
              key: "ratio_class",
              value: asset.ratio_class || "",
              type: "single_line_text_field",
            },
            {
              namespace: "neverland",
              key: "quality_tier",
              value: asset.quality_tier || "",
              type: "single_line_text_field",
            },
            {
              namespace: "neverland",
              key: "max_print_cm",
              value: `${asset.max_print_width_cm} × ${asset.max_print_height_cm}`,
              type: "single_line_text_field",
            },
            {
              namespace: "neverland",
              key: "aspect_ratio",
              value: String(asset.aspect_ratio || ""),
              type: "single_line_text_field",
            },
          ],
        },
      };

      // Create product (NO images — theme loads from Drive!)
      const result = await shopify("POST", "/products.json", payload);
      const product = result.product;

      // Track for collections
      if (!artistProducts[artistName]) artistProducts[artistName] = [];
      artistProducts[artistName].push(product.id);

      // Update DB
      await supabase.from("assets").update({
        shopify_product_id: String(product.id),
        shopify_product_gid: `gid://shopify/Product/${product.id}`,
        shopify_status: "synced",
        shopify_synced_at: new Date().toISOString(),
        ingestion_status: "ready",
      }).eq("id", asset.id);

      // Map variant IDs
      if (product.variants) {
        for (let i = 0; i < product.variants.length && i < variants.length; i++) {
          await supabase.from("asset_variants").update({
            shopify_variant_id: String(product.variants[i].id),
            shopify_variant_gid: `gid://shopify/ProductVariant/${product.variants[i].id}`,
            base_price: product.variants[i].price,
          }).eq("id", variants[i].id);
        }
      }

      synced++;
      console.log(`${idx} ✅ "${title}" → #${product.id} (${product.variants.length} sizes)`);
      await sleep(500);
    } catch (err) {
      errors++;
      console.error(`${idx} ❌ "${title}": ${err.message.slice(0, 100)}`);
      await supabase.from("assets").update({
        shopify_status: "error",
        ingestion_error: err.message.slice(0, 500),
      }).eq("id", asset.id);
    }
  }

  // ── Collections ────────────────────────────────────────
  if (CREATE_COLLECTIONS && synced > 0) {
    console.log("\n" + "─".repeat(60));
    console.log("📁 Creating Collections\n");

    const smartCollections = [
      { title: "All Art Prints", rules: [{ column: "type", relation: "equals", condition: "Art Print" }], sort_order: "best-selling" },
      { title: "New Arrivals", rules: [{ column: "type", relation: "equals", condition: "Art Print" }], sort_order: "created-desc" },
      { title: "Portrait Prints", rules: [{ column: "tag", relation: "equals", condition: "portrait 4 5" }], sort_order: "best-selling" },
      { title: "Landscape Prints", rules: [{ column: "tag", relation: "equals", condition: "landscape 3 2" }], sort_order: "best-selling" },
      { title: "Museum Grade", rules: [{ column: "tag", relation: "equals", condition: "museum grade" }], sort_order: "best-selling",
        body_html: "<p>Our highest resolution artworks — perfect for large-format museum-quality prints.</p>" },
    ];

    for (const sc of smartCollections) {
      try {
        await shopify("POST", "/smart_collections.json", { smart_collection: { ...sc, published: true } });
        console.log(`   ✅ "${sc.title}"`);
      } catch (e) { console.log(`   ⚠️  "${sc.title}": ${e.message.slice(0, 60)}`); }
      await sleep(300);
    }

    // Artist collections
    const artists = Object.keys(artistProducts).sort();
    console.log(`\n   Creating ${artists.length} artist collections...`);
    for (const artist of artists) {
      try {
        const { custom_collection: col } = await shopify("POST", "/custom_collections.json", {
          custom_collection: {
            title: artist,
            body_html: `<p>Explore the works of <strong>${artist}</strong>.</p>`,
            published: true,
          },
        });
        for (const pid of artistProducts[artist]) {
          await shopify("POST", "/collects.json", { collect: { product_id: pid, collection_id: col.id } });
          await sleep(200);
        }
        console.log(`   ✅ "${artist}" (${artistProducts[artist].length} prints)`);
      } catch (e) { console.log(`   ⚠️  "${artist}": ${e.message.slice(0, 60)}`); }
      await sleep(300);
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`✅ DONE — Synced: ${synced} | Errors: ${errors}`);
  console.log("═".repeat(60) + "\n");
}

main().catch(e => { console.error("💥", e); process.exit(1); });
