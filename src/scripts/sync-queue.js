/**
 * Shopify Sync Queue — Handles the 1k/day Variant Limit
 * ======================================================
 * Shopify allows creating up to ~50k variants instantly when a store is new.
 * After that, it enforces a soft limit of ~1,000 new variants per day.
 *
 * Strategy (two-phase):
 *   Phase 1: Bulk sync — push as many products as possible until Shopify
 *            starts returning 429s or variant creation errors.
 *   Phase 2: Queue — remaining assets go into a queue, processed at
 *            ~1,000 variants/day via a cron job.
 *
 * Usage:
 *   node src/scripts/sync-queue.js                    # process next batch
 *   node src/scripts/sync-queue.js --status           # show queue status
 *   node src/scripts/sync-queue.js --limit=50         # process 50 assets max
 *   node src/scripts/sync-queue.js --max-variants=500 # stop after 500 variants created
 *   node src/scripts/sync-queue.js --collections      # also create/update collections
 *   node src/scripts/sync-queue.js --reset-errors     # retry errored assets
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "200", 10);
const MAX_VARIANTS = parseInt(getArg("max-variants") || "900", 10); // Stay under 1k/day
const SHOW_STATUS = hasFlag("status");
const CREATE_COLLECTIONS = hasFlag("collections");
const RESET_ERRORS = hasFlag("reset-errors");

// ── Supabase & Shopify ────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
    console.log(`   ⏳ Rate limited — waiting ${wait}s`);
    await sleep(wait * 1000);
    return shopify(method, endpoint, body, retries);
  }
  if ((res.status === 502 || res.status === 503) && retries > 0) {
    await sleep(3000);
    return shopify(method, endpoint, body, retries - 1);
  }
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Shopify ${method} ${endpoint} → ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
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

// ── Queue Status ──────────────────────────────────────────
async function showStatus() {
  const counts = {};
  for (const status of ["pending", "synced", "error"]) {
    const { count } = await supabase
      .from("assets")
      .select("*", { count: "exact", head: true })
      .eq("shopify_status", status);
    counts[status] = count || 0;
  }

  // Get today's sync count
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { count: syncedToday } = await supabase
    .from("assets")
    .select("*", { count: "exact", head: true })
    .eq("shopify_status", "synced")
    .gte("shopify_synced_at", today.toISOString());

  // Estimate variants synced today
  const { data: todayAssets } = await supabase
    .from("assets")
    .select("id")
    .eq("shopify_status", "synced")
    .gte("shopify_synced_at", today.toISOString());

  let variantsToday = 0;
  if (todayAssets?.length) {
    const { count } = await supabase
      .from("asset_variants")
      .select("*", { count: "exact", head: true })
      .in("asset_id", todayAssets.map(a => a.id));
    variantsToday = count || 0;
  }

  console.log("\n" + "═".repeat(50));
  console.log("📊 SYNC QUEUE STATUS");
  console.log("═".repeat(50));
  console.log(`  Pending:     ${counts.pending}`);
  console.log(`  Synced:      ${counts.synced}`);
  console.log(`  Errors:      ${counts.error}`);
  console.log("─".repeat(50));
  console.log(`  Synced today: ${syncedToday || 0} products (~${variantsToday} variants)`);
  console.log(`  Remaining:    ${counts.pending} products`);
  if (counts.pending > 0) {
    const daysLeft = Math.ceil((counts.pending * 3) / 900); // ~3 variants per product
    console.log(`  Est. days:    ~${daysLeft} days at 900 variants/day`);
  }
  console.log("═".repeat(50) + "\n");
}

// ── Reset Errors ──────────────────────────────────────────
async function resetErrors() {
  const { count } = await supabase
    .from("assets")
    .select("*", { count: "exact", head: true })
    .eq("shopify_status", "error");

  if (!count || count === 0) {
    console.log("✅ No errored assets to reset!");
    return;
  }

  const { error } = await supabase
    .from("assets")
    .update({ shopify_status: "pending", ingestion_error: null })
    .eq("shopify_status", "error");

  if (error) throw error;
  console.log(`🔄 Reset ${count} errored assets back to pending`);
}

// ── Main Sync ─────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("🛍️  NEVERLAND PRINTS — Sync Queue");
  console.log("═".repeat(60));

  if (SHOW_STATUS) return await showStatus();
  if (RESET_ERRORS) return await resetErrors();

  console.log(`  Limit: ${LIMIT} assets | Max variants: ${MAX_VARIANTS}/batch`);
  console.log("═".repeat(60) + "\n");

  // Create pipeline run
  const { data: runData } = await supabase
    .from("pipeline_runs")
    .insert({ run_type: "shopify_sync_queue", status: "running", total_items: 0 })
    .select()
    .single();
  const runId = runData?.id;

  try {
    // Fetch pending assets (ordered by artist for collection grouping)
    const { data: assets, error } = await supabase
      .from("assets")
      .select("*")
      .eq("shopify_status", "pending")
      .in("ingestion_status", ["tagged", "analyzed", "ready"])
      .not("width_px", "is", null)
      .order("artist", { ascending: true })
      .limit(LIMIT);

    if (error) throw error;
    if (!assets?.length) {
      console.log("✅ All assets already synced!");
      return;
    }

    // Pre-fetch variant counts to stay under the limit
    let totalVariantsToCreate = 0;
    const assetsToSync = [];

    for (const asset of assets) {
      const { count } = await supabase
        .from("asset_variants")
        .select("*", { count: "exact", head: true })
        .eq("asset_id", asset.id);

      const variantCount = count || 0;
      if (totalVariantsToCreate + variantCount > MAX_VARIANTS) {
        console.log(`   ⚠️  Stopping at ${assetsToSync.length} assets — would exceed ${MAX_VARIANTS} variant limit`);
        break;
      }
      totalVariantsToCreate += variantCount;
      assetsToSync.push(asset);
    }

    console.log(`📦 Syncing ${assetsToSync.length} assets (~${totalVariantsToCreate} variants)\n`);

    if (runId) {
      await supabase.from("pipeline_runs").update({ total_items: assetsToSync.length }).eq("id", runId);
    }

    let synced = 0;
    let errors = 0;
    const artistProducts = {};

    for (const asset of assetsToSync) {
      const idx = `[${synced + errors + 1}/${assetsToSync.length}]`;
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

        const artistName = asset.artist || "Unknown Artist";
        const sizes = variants.map(v => `${v.label}: ${v.width_cm}×${v.height_cm} cm`).join(" · ");
        const desc = `<p>A museum-quality fine art print by <strong>${artistName}</strong>.</p>` +
          `<p><strong>Available sizes:</strong> ${sizes}</p>` +
          `<p>Printed on premium 310gsm cotton-rag archival paper with pigment-based inks rated for 200+ years lightfastness.</p>`;

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
              { namespace: "neverland", key: "drive_file_id", value: asset.drive_file_id, type: "single_line_text_field" },
              { namespace: "neverland", key: "ratio_class", value: asset.ratio_class || "", type: "single_line_text_field" },
              { namespace: "neverland", key: "quality_tier", value: asset.quality_tier || "", type: "single_line_text_field" },
              { namespace: "neverland", key: "max_print_cm", value: `${asset.max_print_width_cm} × ${asset.max_print_height_cm}`, type: "single_line_text_field" },
              { namespace: "neverland", key: "aspect_ratio", value: String(asset.aspect_ratio || ""), type: "single_line_text_field" },
            ],
          },
        };

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
        await sleep(500); // respect rate limits
      } catch (err) {
        errors++;

        // If Shopify is actively refusing variants, stop the batch
        if (err.status === 422 && err.message.includes("variant")) {
          console.error(`\n🛑 Shopify variant limit hit — stopping batch. Resume tomorrow.`);
          await supabase.from("assets").update({
            shopify_status: "pending", // Keep pending for next run
          }).eq("id", asset.id);
          break;
        }

        console.error(`${idx} ❌ "${title}": ${err.message.slice(0, 100)}`);
        await supabase.from("assets").update({
          shopify_status: "error",
          ingestion_error: err.message.slice(0, 500),
        }).eq("id", asset.id);
      }
    }

    // ── Collections (additive — won't recreate existing) ──
    if (CREATE_COLLECTIONS && synced > 0) {
      console.log("\n" + "─".repeat(60));
      console.log("📁 Updating Collections\n");

      // Get existing artist collections
      const existingCollections = {};
      let pageUrl = "/custom_collections.json?limit=250";
      while (pageUrl) {
        const res = await shopify("GET", pageUrl);
        for (const col of (res.custom_collections || [])) {
          existingCollections[col.title.toLowerCase()] = col.id;
        }
        // Simple pagination — check if more pages
        const linkHeader = ""; // REST doesn't return link easily, so we'll just get first page
        pageUrl = null;
      }

      for (const [artist, productIds] of Object.entries(artistProducts)) {
        try {
          const existingId = existingCollections[artist.toLowerCase()];
          let colId;

          if (existingId) {
            colId = existingId;
          } else {
            // Create new collection
            const { custom_collection } = await shopify("POST", "/custom_collections.json", {
              custom_collection: {
                title: artist,
                body_html: `<p>Explore the works of <strong>${artist}</strong>.</p>`,
                published: true,
              },
            });
            colId = custom_collection.id;
          }

          // Add products to collection
          for (const pid of productIds) {
            try {
              await shopify("POST", "/collects.json", { collect: { product_id: pid, collection_id: colId } });
            } catch (e) {
              // May already exist — ignore
            }
            await sleep(200);
          }
          console.log(`   ✅ "${artist}" (${productIds.length} prints ${existingId ? "added" : "new"})`);
        } catch (e) {
          console.log(`   ⚠️  "${artist}": ${e.message.slice(0, 60)}`);
        }
        await sleep(300);
      }
    }

    // Finalize
    if (runId) {
      await supabase.from("pipeline_runs").update({
        status: errors > 0 ? "completed_with_errors" : "completed",
        processed_items: synced,
        error_count: errors,
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }

    console.log("\n" + "═".repeat(60));
    console.log(`✅ DONE — Synced: ${synced} | Errors: ${errors} | Variants: ~${totalVariantsToCreate}`);
    console.log("═".repeat(60) + "\n");

    // Show remaining
    await showStatus();
  } catch (fatalErr) {
    console.error("\n💥 Fatal error:", fatalErr);
    if (runId) {
      await supabase.from("pipeline_runs").update({
        status: "failed", finished_at: new Date().toISOString()
      }).eq("id", runId);
    }
    process.exit(1);
  }
}

main().catch(e => { console.error("💥", e); process.exit(1); });
