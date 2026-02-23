/**
 * Neverland Prints — Bulk Shopify Sync (GraphQL Bulk Operations)
 * ==============================================================
 * Creates Shopify products via Shopify's server-side bulk mutation API.
 * Processes ~5-10k products per batch with NO per-request rate limits.
 *
 * Expected: ~1-2 hours for 100k products (vs 14+ hours with REST)
 *
 * Flow per batch:
 *   1. Fetch assets from Supabase (paginated)
 *   2. Build JSONL (one product per line)
 *   3. Stage upload to Shopify
 *   4. Submit bulk mutation
 *   5. Poll until complete (~5-15 min)
 *   6. Download result JSONL, map product IDs back
 *   7. Update Supabase
 *
 * Usage:
 *   node src/scripts/sync-bulk.js --test          # test 1 product via normal GQL
 *   node src/scripts/sync-bulk.js                 # sync all pending
 *   node src/scripts/sync-bulk.js --limit=5000    # partial run
 *   node src/scripts/sync-bulk.js --batch=8000    # custom batch size
 *   node src/scripts/sync-bulk.js --dry-run       # generate JSONL only
 */

require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const { analyzeArtwork } = require("../services/resolution-engine");

// ── CLI ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : null;
};
const hasFlag = (n) => args.includes(`--${n}`);

const LIMIT = parseInt(getArg("limit") || "0", 10);
const BATCH_SIZE = parseInt(getArg("batch") || "10000", 10);
const DRY_RUN = hasFlag("dry-run");
const TEST_MODE = hasFlag("test");

// ── Services ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VER = "2024-10";
const GQL_URL = `https://${SHOP}/admin/api/${API_VER}/graphql.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── GraphQL helper ───────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GQL HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(
      `GQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`
    );
  }
  return json.data;
}

// ── Pricing ──────────────────────────────────────────────
function price(w, h) {
  const a = w * h;
  return a <= 600 ? "29.99" : a <= 1800 ? "49.99" : a <= 4000 ? "79.99" : "119.99";
}
function comparePrice(w, h) {
  const a = w * h;
  return a <= 600 ? "39.99" : a <= 1800 ? "64.99" : a <= 4000 ? "99.99" : "149.99";
}

// ── Build productSet input ───────────────────────────────
// Single default variant per product — sizes served from Supabase
// This bypasses Shopify's daily variant creation limit
function buildInput(asset) {
  const title = (asset.title || "Untitled").slice(0, 255);
  const artist = asset.artist || "Unknown Artist";

  // Description
  const desc = asset.description || "";
  const descHtml = desc
    ? `<div class="np-desc"><p class="np-ai">${desc}</p><p>Museum-quality fine art print by <strong>${artist}</strong>.</p><p>Premium 310gsm cotton-rag archival paper, 200+ year lightfast inks.</p></div>`
    : `<p>Museum-quality fine art print by <strong>${artist}</strong>.</p><p>Premium 310gsm cotton-rag archival paper, 200+ year lightfast inks.</p>`;

  // Tags
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

  // Single default variant — base price $29.99
  return {
    title,
    descriptionHtml: descHtml,
    vendor: artist,
    productType: "Art Print",
    tags,
    status: "ACTIVE",
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [
      {
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        price: "29.99",
        compareAtPrice: "39.99",
        sku: `NP-${asset.id.slice(0, 8)}`,
      },
    ],
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
        value: `${asset.max_print_width_cm || 0}×${asset.max_print_height_cm || 0}`,
        type: "single_line_text_field",
      },
      {
        namespace: "neverland",
        key: "aspect_ratio",
        value: String(asset.aspect_ratio || ""),
        type: "single_line_text_field",
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════
// PRODUCT SET MUTATION (2024-10 API — supports inline variants)
// ═══════════════════════════════════════════════════════════
const PRODUCT_SET_MUTATION = `
  mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        legacyResourceId
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ═══════════════════════════════════════════════════════════
// TEST MODE — single product via regular GraphQL
// ═══════════════════════════════════════════════════════════
async function testOne() {
  console.log("\n🧪 Testing productSet with 1 product...\n");

  // First, introspect to verify ProductSetInput exists
  console.log("   Checking schema...");
  try {
    const schema = await gql(`{
      __type(name: "ProductSetInput") {
        name
        inputFields { name type { name kind ofType { name } } }
      }
    }`);
    if (schema.__type) {
      const fields = schema.__type.inputFields.map((f) => f.name);
      console.log(
        `   ✅ ProductSetInput fields: ${fields.join(", ")}\n`
      );
    } else {
      console.log("   ⚠️ ProductSetInput not found in schema\n");
    }
  } catch (e) {
    console.log(`   ⚠️ Schema introspection failed: ${e.message}\n`);
  }

  // Fetch one asset
  const { data: assets } = await supabase
    .from("assets")
    .select(
      "id, title, artist, description, drive_file_id, width_px, height_px, aspect_ratio, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, style, era, mood, subject, palette, ai_tags"
    )
    .is("shopify_product_id", null)
    .limit(1);

  if (!assets?.length) {
    console.log("No unsynced assets!");
    return;
  }
  const asset = assets[0];
  console.log(
    `   Asset: "${asset.title}" by ${asset.artist} (${asset.width_px}×${asset.height_px}px)\n`
  );

  const input = buildInput(asset);
  console.log(
    "   Payload preview:",
    JSON.stringify(input, null, 2).slice(0, 800),
    "...\n"
  );

  try {
    const data = await gql(PRODUCT_SET_MUTATION, {
      input,
      synchronous: true,
    });
    const result = data.productSet;

    if (result.userErrors?.length) {
      console.log("   ❌ User errors:");
      for (const e of result.userErrors) {
        console.log(`      ${e.field?.join(".")}: ${e.message} (${e.code})`);
      }
      return;
    }

    const pid = result.product.legacyResourceId;
    const gid = result.product.id;
    console.log(`   ✅ Created! Product ID: ${pid}`);
    console.log(`   ✅ GID: ${gid}`);

    // Update Supabase
    await supabase
      .from("assets")
      .update({
        shopify_product_id: pid,
        shopify_product_gid: gid,
        shopify_status: "synced",
        shopify_synced_at: new Date().toISOString(),
        ingestion_status: "ready",
      })
      .eq("id", asset.id);
    console.log(`   ✅ Supabase updated\n`);
  } catch (err) {
    console.error(`   ❌ ${err.message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════
// STAGED UPLOAD
// ═══════════════════════════════════════════════════════════
async function stageUpload(jsonl) {
  const data = await gql(`
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES
        filename: "bulk.jsonl"
        mimeType: "text/jsonl"
        httpMethod: POST
      }]) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `);

  const errs = data.stagedUploadsCreate.userErrors;
  if (errs?.length) throw new Error(`Stage errors: ${JSON.stringify(errs)}`);

  const target = data.stagedUploadsCreate.stagedTargets[0];

  // Upload via multipart POST
  const form = new FormData();
  for (const p of target.parameters) {
    form.append(p.name, p.value);
  }
  form.append(
    "file",
    new Blob([jsonl], { type: "text/jsonl" }),
    "bulk.jsonl"
  );

  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upload HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  return target.resourceUrl;
}

// ═══════════════════════════════════════════════════════════
// RUN BULK MUTATION
// ═══════════════════════════════════════════════════════════
async function runBulk(stagedPath) {
  // Wait for any existing bulk op to finish
  while (true) {
    const check = await gql(
      `{ currentBulkOperation(type: MUTATION) { id status } }`
    );
    const op = check.currentBulkOperation;
    if (
      !op ||
      ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status)
    )
      break;
    console.log(
      `   ⏳ Waiting for previous bulk op (${op.status})...`
    );
    await sleep(15000);
  }

  const data = await gql(
    `
    mutation bulkRun($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: $mutation,
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `,
    {
      mutation: PRODUCT_SET_MUTATION,
      stagedUploadPath: stagedPath,
    }
  );

  const errs = data.bulkOperationRunMutation.userErrors;
  if (errs?.length)
    throw new Error(`Bulk mutation errors: ${JSON.stringify(errs)}`);

  return data.bulkOperationRunMutation.bulkOperation;
}

// ═══════════════════════════════════════════════════════════
// POLL UNTIL COMPLETE
// ═══════════════════════════════════════════════════════════
async function poll() {
  const t0 = Date.now();
  while (true) {
    const data = await gql(
      `{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }`
    );
    const op = data.currentBulkOperation;
    if (!op) throw new Error("No bulk operation found");

    if (op.status === "COMPLETED") {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(
        `   ✅ Bulk complete — ${op.objectCount} objects in ${mins} min`
      );
      return op.url;
    }

    if (op.status === "FAILED")
      throw new Error(`Bulk FAILED: ${op.errorCode}`);
    if (op.status === "CANCELED" || op.status === "EXPIRED")
      throw new Error(`Bulk ${op.status}`);

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(
      `   ⏳ ${op.status} — ${op.objectCount || 0} objects (${secs}s)\r`
    );
    await sleep(15000);
  }
}

// ═══════════════════════════════════════════════════════════
// DOWNLOAD & PARSE RESULTS
// ═══════════════════════════════════════════════════════════
async function downloadResults(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════
// FETCH ASSETS (paginated, since Supabase caps at 1000/query)
// ═══════════════════════════════════════════════════════════
const ASSET_FIELDS =
  "id, title, artist, description, drive_file_id, width_px, height_px, aspect_ratio, ratio_class, quality_tier, max_print_width_cm, max_print_height_cm, style, era, mood, subject, palette, ai_tags";

async function fetchAssets(limit) {
  const PAGE = 1000;
  const results = [];
  while (results.length < limit) {
    const need = Math.min(PAGE, limit - results.length);
    const { data, error } = await supabase
      .from("assets")
      .select(ASSET_FIELDS)
      .is("shopify_product_id", null)
      .order("id")
      .range(results.length, results.length + need - 1);
    if (error) throw error;
    if (!data?.length) break;
    results.push(...data);
    if (data.length < need) break; // No more rows
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("⚡ NEVERLAND PRINTS — Bulk Shopify Sync (GraphQL)");
  console.log("═".repeat(60));

  if (TEST_MODE) return testOne();

  // Count pending
  const { count: pending } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .is("shopify_product_id", null);

  const total = LIMIT > 0 ? Math.min(LIMIT, pending) : pending;
  const numBatches = Math.ceil(total / BATCH_SIZE);

  console.log(
    `  📦 ${pending} unsynced | Syncing: ${total} | Batches: ${numBatches} × ${BATCH_SIZE}`
  );
  console.log(
    `  ⏱️  Est: ~${numBatches * 8}-${numBatches * 15} min`
  );
  if (DRY_RUN) console.log("  🏃 DRY RUN MODE");
  console.log("═".repeat(60) + "\n");

  if (pending === 0) {
    console.log("✅ All assets already synced!");
    return;
  }

  const t0 = Date.now();
  let synced = 0;
  let errors = 0;
  let batchNum = 0;

  while (synced + errors < total) {
    batchNum++;
    const batchLimit = Math.min(BATCH_SIZE, total - synced - errors);
    console.log(
      `\n${"─".repeat(50)}\n📦 Batch ${batchNum}/${numBatches} — ${batchLimit} products\n${"─".repeat(50)}`
    );

    // 1. Fetch assets
    console.log("   📥 Fetching from Supabase...");
    const assets = await fetchAssets(batchLimit);
    if (!assets.length) {
      console.log("   No more assets to sync.");
      break;
    }
    console.log(`   📥 Got ${assets.length} assets`);

    // 2. Build JSONL
    console.log("   📝 Building JSONL...");
    const ids = []; // index → asset.id mapping
    const lines = [];
    let skipCount = 0;

    for (const a of assets) {
      try {
        const input = buildInput(a);
        // Each line: the variables for one productSet invocation
        lines.push(JSON.stringify({ input, synchronous: true }));
        ids.push(a.id);
      } catch (e) {
        skipCount++;
        errors++;
        if (skipCount <= 10) {
          console.error(
            `   ⚠️ Skip "${(a.title || "").slice(0, 30)}": ${e.message.slice(0, 80)}`
          );
        }
      }
    }

    const jsonl = lines.join("\n");
    const mb = (Buffer.byteLength(jsonl) / 1048576).toFixed(1);
    console.log(
      `   📝 ${lines.length} products | ${mb} MB${skipCount ? ` | ${skipCount} skipped` : ""}`
    );

    if (DRY_RUN) {
      const outFile = `batch_${batchNum}.jsonl`;
      fs.writeFileSync(outFile, jsonl);
      console.log(`   💾 Saved ${outFile}`);
      break;
    }

    // 3. Stage upload
    console.log("   📤 Uploading JSONL to Shopify...");
    const stagedPath = await stageUpload(jsonl);
    console.log("   📤 Uploaded ✓");

    // 4. Start bulk mutation
    console.log("   🚀 Starting bulk mutation...");
    const op = await runBulk(stagedPath);
    console.log(`   🚀 Operation: ${op.id} (${op.status})`);

    // 5. Poll until complete
    const resultUrl = await poll();
    console.log(""); // Clear the \r line

    // 6. Download results
    console.log("   📥 Downloading results...");
    const results = await downloadResults(resultUrl);
    console.log(`   📥 Got ${results.length} result lines`);

    // 7. Map results → Supabase updates
    let bSynced = 0;
    let bErrors = 0;
    const updates = [];

    for (const r of results) {
      const idx = r.__lineNumber;
      const aid = ids[idx];
      if (!aid) continue;

      const ps = r.data?.productSet;
      const ue = ps?.userErrors || [];
      const prod = ps?.product;

      if (ue.length > 0) {
        bErrors++;
        if (bErrors <= 10) {
          console.error(
            `   ❌ Line ${idx}: ${ue.map((e) => e.message).join("; ").slice(0, 120)}`
          );
        }
        updates.push({
          id: aid,
          shopify_status: "error",
          ingestion_error: ue
            .map((e) => `${e.field}: ${e.message}`)
            .join("; ")
            .slice(0, 500),
        });
      } else if (prod?.id) {
        bSynced++;
        const lid =
          prod.legacyResourceId ||
          prod.id.replace("gid://shopify/Product/", "");
        updates.push({
          id: aid,
          shopify_product_id: lid,
          shopify_product_gid: prod.id,
          shopify_status: "synced",
          shopify_synced_at: new Date().toISOString(),
          ingestion_status: "ready",
        });
      }
    }

    // 8. Flush to Supabase
    console.log(`   💾 Updating Supabase (${updates.length} records)...`);
    for (let i = 0; i < updates.length; i += 500) {
      await Promise.all(
        updates.slice(i, i + 500).map((u) => {
          const { id, ...d } = u;
          return supabase.from("assets").update(d).eq("id", id);
        })
      );
    }

    synced += bSynced;
    errors += bErrors;
    const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(
      `   ✅ Batch ${batchNum}: +${bSynced} synced, +${bErrors} errors`
    );
    console.log(
      `   📊 Total: ${synced}/${total} synced | ${errors} errors | ${elapsed} min`
    );

    // Safety
    if (errors > synced && errors > 200) {
      console.error("\n💥 Too many errors — stopping.");
      process.exit(1);
    }
  }

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log("\n" + "═".repeat(60));
  console.log(
    `✅ BULK SYNC COMPLETE — ${synced} synced, ${errors} errors in ${totalMin} min`
  );
  console.log("═".repeat(60) + "\n");
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
