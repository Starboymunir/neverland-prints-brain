#!/usr/bin/env node
/**
 * Shopify GraphQL Bulk Sync
 * ─────────────────────────
 * Syncs ALL pending assets to Shopify using GraphQL Bulk Operations.
 * Instead of 1 REST call per product (days), this uploads a JSONL file
 * and Shopify processes everything in the background (~1 hour for 100k).
 *
 * Usage:
 *   node src/scripts/bulk-sync.js                  # Sync all pending
 *   node src/scripts/bulk-sync.js --batch=5000     # Custom batch size
 *   node src/scripts/bulk-sync.js --status         # Check running operation
 *   node src/scripts/bulk-sync.js --collections    # Also create collections
 *   node src/scripts/bulk-sync.js --dry-run        # Generate JSONL only, don't upload
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const supabase = require("../db/supabase");
const config = require("../config");

// ─── Config ──────────────────────────────────────────────
const SHOP = config.shopify.storeDomain;
const TOKEN = config.shopify.adminApiToken;
const API_VERSION = config.shopify.apiVersion || "2024-10";
const GQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith("--batch="))?.split("=")[1] || "10000");
const DRY_RUN = process.argv.includes("--dry-run");
const STATUS_ONLY = process.argv.includes("--status");
const CREATE_COLLECTIONS = process.argv.includes("--collections");

// ─── Pricing ─────────────────────────────────────────────
function calcPrice(variant) {
  const area = (variant.width_cm || 0) * (variant.height_cm || 0);
  if (area <= 600) return { price: "29.99", compareAt: "39.99" };
  if (area <= 1800) return { price: "49.99", compareAt: "64.99" };
  if (area <= 4000) return { price: "79.99", compareAt: "99.99" };
  return { price: "119.99", compareAt: "149.99" };
}

function estimateWeight(variant) {
  const w = variant.width_cm || 30;
  const h = variant.height_cm || 40;
  return Math.round(w * h * 0.15 + 50); // grams
}

// ─── GraphQL helper ──────────────────────────────────────
async function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const url = new URL(GQL_URL);
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
          const parsed = JSON.parse(data);
          if (parsed.errors) {
            reject(new Error(JSON.stringify(parsed.errors)));
          } else {
            resolve(parsed.data);
          }
        } catch (e) {
          reject(new Error(`GraphQL parse error: ${data.substring(0, 500)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("GraphQL request timeout"));
    });

    req.write(body);
    req.end();
  });
}

// Retry wrapper
async function graphqlRetry(query, variables = {}, maxRetries = 3) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await graphql(query, variables);
    } catch (err) {
      if (i === maxRetries) throw err;
      const delay = 2000 * i + Math.random() * 1000;
      console.warn(`   ⚠️ GraphQL retry ${i}/${maxRetries}: ${err.message.substring(0, 100)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Check current bulk operation ────────────────────────
async function checkBulkStatus() {
  const data = await graphqlRetry(`{
    currentBulkOperation(type: MUTATION) {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
  }`);

  return data.currentBulkOperation;
}

// ─── Step 1: Generate JSONL lines from DB ────────────────
async function generateJSONL(offset = 0, limit = BATCH_SIZE) {
  console.log(`\n📦 Fetching pending assets (offset=${offset}, limit=${limit})...`);

  // Fetch assets that haven't been synced yet (paginate since Supabase caps at 1000)
  const assets = [];
  let fetchOffset = offset;
  const fetchEnd = offset + limit;
  while (fetchOffset < fetchEnd) {
    const batchSize = Math.min(1000, fetchEnd - fetchOffset);
    const { data: batch, error: batchErr } = await supabase
      .from("assets")
      .select("*")
      .eq("shopify_status", "pending")
      .order("created_at", { ascending: true })
      .range(fetchOffset, fetchOffset + batchSize - 1);

    if (batchErr) throw new Error(`DB error fetching assets: ${batchErr.message}`);
    if (!batch || batch.length === 0) break;
    assets.push(...batch);
    fetchOffset += batch.length;
    if (batch.length < batchSize) break; // No more rows
  }
  if (!assets || assets.length === 0) {
    console.log("   No pending assets found.");
    return { lines: [], assets: [] };
  }

  console.log(`   Found ${assets.length} pending assets`);

  // Fetch all variants for these assets (batch in groups of 200 to avoid Supabase URL length limits)
  const assetIds = assets.map(a => a.id);
  const allVariants = [];
  const CHUNK = 200;
  for (let i = 0; i < assetIds.length; i += CHUNK) {
    const chunk = assetIds.slice(i, i + CHUNK);
    const { data: chunkVariants, error: varErr } = await supabase
      .from("asset_variants")
      .select("*")
      .in("asset_id", chunk)
      .order("width_cm", { ascending: true });

    if (varErr) throw new Error(`DB error fetching variants (chunk ${i}): ${varErr.message}`);
    if (chunkVariants) allVariants.push(...chunkVariants);
  }

  // Group variants by asset_id
  const variantMap = {};
  for (const v of allVariants || []) {
    if (!variantMap[v.asset_id]) variantMap[v.asset_id] = [];
    variantMap[v.asset_id].push(v);
  }

  console.log(`   Loaded ${(allVariants || []).length} variants`);

  // Generate JSONL — one line per product
  const lines = [];
  for (const asset of assets) {
    const variants = variantMap[asset.id] || [];
    if (variants.length === 0) continue;

    // Build tags
    const tags = ["art print", "fine art", "wall art"];
    if (asset.ratio_class) tags.push(asset.ratio_class);
    if (asset.quality_tier === "high") tags.push("museum grade");
    else tags.push("gallery grade");
    if (asset.style) tags.push(asset.style);
    if (asset.era) tags.push(asset.era);
    if (asset.mood) tags.push(asset.mood);
    if (asset.subject) tags.push(asset.subject);
    if (asset.palette) tags.push(asset.palette);
    if (asset.artist) tags.push(asset.artist);
    if (asset.ai_tags && Array.isArray(asset.ai_tags)) {
      tags.push(...asset.ai_tags.slice(0, 10));
    }

    // Build title
    const title = asset.title || asset.filename?.replace(/\.[^.]+$/, "").replace(/_\d+x\d+$/, "") || "Untitled Print";

    // Build description
    const artistLine = asset.artist ? `<p><strong>Artist:</strong> ${asset.artist}</p>` : "";
    const sizesHtml = variants
      .map(v => `${v.label} — ${v.width_cm}×${v.height_cm} cm`)
      .join(" | ");
    const bodyHtml = `${artistLine}<p>Premium fine art print on museum-quality paper.</p><p><strong>Available sizes:</strong> ${sizesHtml}</p>`;

    // Build variant inputs (productSet format for 2024-10 API)
    const optionValues = variants.map(v => ({
      name: `${v.label} — ${Math.round(v.width_cm)}×${Math.round(v.height_cm)} cm`,
    }));

    const variantInputs = variants.map(v => {
      const pricing = calcPrice(v);
      const sizeName = `${v.label} — ${Math.round(v.width_cm)}×${Math.round(v.height_cm)} cm`;
      return {
        optionValues: [{ optionName: "Size", name: sizeName }],
        price: pricing.price,
        compareAtPrice: pricing.compareAt,
        sku: `NP-${asset.id.substring(0, 8)}-${(v.label || "std").toLowerCase().replace(/[^a-z0-9]/g, "")}`,
        taxable: true,
        inventoryPolicy: "CONTINUE",
      };
    });

    // Build metafields
    const metafields = [
      { namespace: "neverland", key: "drive_file_id", value: asset.drive_file_id, type: "single_line_text_field" },
      { namespace: "neverland", key: "ratio_class", value: asset.ratio_class || "", type: "single_line_text_field" },
      { namespace: "neverland", key: "quality_tier", value: asset.quality_tier || "", type: "single_line_text_field" },
      { namespace: "neverland", key: "aspect_ratio", value: String(asset.aspect_ratio || ""), type: "single_line_text_field" },
    ];

    if (asset.max_print_width_cm && asset.max_print_height_cm) {
      metafields.push({
        namespace: "neverland",
        key: "max_print_cm",
        value: `${Math.round(asset.max_print_width_cm)} × ${Math.round(asset.max_print_height_cm)}`,
        type: "single_line_text_field",
      });
    }

    // Each JSONL line = the input for one productSet mutation (2024-10 API)
    const input = {
      title,
      descriptionHtml: bodyHtml,
      vendor: asset.artist || "Neverland Prints",
      productType: "Art Print",
      tags,
      status: "ACTIVE",
      productOptions: [{
        name: "Size",
        values: optionValues,
      }],
      variants: variantInputs,
      metafields,
    };

    lines.push(JSON.stringify({ input }));
  }

  console.log(`   Generated ${lines.length} JSONL lines`);
  return { lines, assets };
}

// ─── Step 2: Stage upload to Shopify ─────────────────────
async function stageUpload(jsonlContent) {
  console.log(`\n📤 Staging upload (${(Buffer.byteLength(jsonlContent) / 1024 / 1024).toFixed(1)} MB)...`);

  const data = await graphqlRetry(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    input: [{
      resource: "BULK_MUTATION_VARIABLES",
      filename: "bulk-products.jsonl",
      mimeType: "text/jsonl",
      httpMethod: "POST",
    }],
  });

  const result = data.stagedUploadsCreate;
  if (result.userErrors?.length > 0) {
    throw new Error(`Staged upload error: ${JSON.stringify(result.userErrors)}`);
  }

  const target = result.stagedTargets[0];
  console.log(`   Upload URL: ${target.url.substring(0, 80)}...`);

  // Upload the JSONL file using multipart form (with retry)
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await uploadToStaged(target, jsonlContent);
      break;
    } catch (err) {
      console.error(`   ⚠️ Upload attempt ${attempt}/5 failed: ${err.message}`);
      if (attempt === 5) throw err;
      const delay = Math.pow(2, attempt) * 2000;
      console.log(`   Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // The stagedUploadPath for bulkOperationRunMutation is the "key" parameter value
  const keyParam = target.parameters.find(p => p.name === "key");
  const stagePath = keyParam ? keyParam.value : target.resourceUrl;
  console.log(`   Staged path: ${stagePath}`);
  return stagePath;
}

// ─── Upload file to staged URL ───────────────────────────
function uploadToStaged(target, content) {
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Date.now();
    const url = new URL(target.url);

    // Build multipart form body
    let formBody = "";
    for (const param of target.parameters) {
      formBody += `--${boundary}\r\n`;
      formBody += `Content-Disposition: form-data; name="${param.name}"\r\n\r\n`;
      formBody += `${param.value}\r\n`;
    }
    formBody += `--${boundary}\r\n`;
    formBody += `Content-Disposition: form-data; name="file"; filename="bulk-products.jsonl"\r\n`;
    formBody += `Content-Type: text/jsonl\r\n\r\n`;

    const footer = `\r\n--${boundary}--\r\n`;

    const bodyBuffer = Buffer.concat([
      Buffer.from(formBody, "utf-8"),
      Buffer.from(content, "utf-8"),
      Buffer.from(footer, "utf-8"),
    ]);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuffer.length,
      },
    };

    const protocol = url.protocol === "https:" ? https : require("http");
    const req = protocol.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`   ✅ Upload complete (${res.statusCode})`);
          resolve(data);
        } else {
          reject(new Error(`Upload failed: ${res.statusCode} — ${data.substring(0, 300)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(900000, () => {
      req.destroy();
      reject(new Error("Upload timeout (15 min)"));
    });

    req.write(bodyBuffer);
    req.end();
  });
}

// ─── Step 3: Start bulk mutation ─────────────────────────
async function waitForNoActiveOperation() {
  // Check if there's already a bulk operation running
  const data = await graphqlRetry(`{
    currentBulkOperation(type: MUTATION) {
      id
      status
    }
  }`);
  const op = data.currentBulkOperation;
  if (op && (op.status === "RUNNING" || op.status === "CREATED" || op.status === "CANCELING")) {
    console.log(`   ⏳ Waiting for existing operation ${op.id} (${op.status}) to finish...`);
    // Poll until it's done
    while (true) {
      await new Promise(r => setTimeout(r, 10000));
      const check = await graphqlRetry(`{
        currentBulkOperation(type: MUTATION) { id status }
      }`);
      const cur = check.currentBulkOperation;
      if (!cur || !["RUNNING", "CREATED", "CANCELING"].includes(cur.status)) break;
      console.log(`   Still waiting... (${cur.status})`);
    }
    console.log(`   ✅ Previous operation cleared`);
  }
}

async function startBulkOperation(stagedUploadPath) {
  console.log(`\n🚀 Starting bulk mutation...`);

  // Ensure no other bulk operation is running
  await waitForNoActiveOperation();

  const mutation = `
    mutation productSet($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product {
          id
          title
          variants(first: 20) {
            nodes {
              id
              title
              sku
            }
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }
  `;

  const data = await graphqlRetry(`
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: $mutation,
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    mutation,
    stagedUploadPath,
  });

  const result = data.bulkOperationRunMutation;
  if (result.userErrors?.length > 0) {
    throw new Error(`Bulk operation error: ${JSON.stringify(result.userErrors)}`);
  }

  console.log(`   ✅ Bulk operation started: ${result.bulkOperation.id}`);
  console.log(`   Status: ${result.bulkOperation.status}`);
  return result.bulkOperation;
}

// ─── Step 4: Poll for completion ─────────────────────────
async function pollUntilDone(intervalMs = 10000) {
  console.log(`\n⏳ Polling for completion (every ${intervalMs / 1000}s)...\n`);

  while (true) {
    const op = await checkBulkStatus();

    if (!op) {
      console.log("   No bulk operation found.");
      return null;
    }

    const elapsed = op.createdAt
      ? Math.round((Date.now() - new Date(op.createdAt).getTime()) / 1000)
      : 0;

    console.log(
      `   [${new Date().toLocaleTimeString()}] Status: ${op.status} | ` +
      `Objects: ${op.objectCount || 0} | ` +
      `Size: ${op.fileSize ? (op.fileSize / 1024 / 1024).toFixed(1) + "MB" : "—"} | ` +
      `Elapsed: ${Math.floor(elapsed / 60)}m${elapsed % 60}s`
    );

    if (op.status === "COMPLETED") {
      console.log(`\n   ✅ Bulk operation completed!`);
      return op;
    }

    if (op.status === "FAILED") {
      console.error(`\n   ❌ Bulk operation failed: ${op.errorCode}`);
      return op;
    }

    if (op.status === "CANCELED" || op.status === "CANCELLED") {
      console.error(`\n   ❌ Bulk operation was canceled.`);
      return op;
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ─── Step 5: Process results ─────────────────────────────
async function processResults(resultUrl, assets) {
  if (!resultUrl) {
    console.log("   No result URL — skipping DB update.");
    return { synced: 0, errors: 0 };
  }

  console.log(`\n📥 Downloading results from: ${resultUrl.substring(0, 80)}...`);

  // Download the result JSONL
  const resultData = await new Promise((resolve, reject) => {
    https.get(resultUrl, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });

  const lines = resultData.trim().split("\n").filter(l => l.trim());
  console.log(`   Got ${lines.length} result lines`);

  // Parse results — bulk mutation result format:
  // Success: {"data":{"productSet":{"product":{"id":"gid://..."},"userErrors":[]}},"__lineNumber":0}
  // Throttle: {"errors":[{"message":"Daily variant creation limit...","extensions":{"code":"VARIANT_THROTTLE_EXCEEDED"}}],"data":{"productSet":null},"__lineNumber":0}
  // Variant child: {"id":"gid://shopify/ProductVariant/...","title":"...","sku":"...","__parentId":"gid://shopify/Product/..."}
  let synced = 0;
  let errors = 0;
  let throttled = 0;
  const productResults = []; // { lineNumber, shopifyId, shopifyGid, variants: [{id, gid, sku}] }
  const variantChildren = []; // { parentGid, shopifyGid, shopifyId, sku, title }
  const productMap = new Map(); // shopifyGid -> productResults index
  let skippedLines = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const lineNum = obj.__lineNumber;

      // Check for top-level errors (throttle, etc.)
      if (obj.errors && Array.isArray(obj.errors) && obj.errors.length > 0) {
        const isThrottle = obj.errors.some(e => 
          e.extensions?.code === "VARIANT_THROTTLE_EXCEEDED" ||
          e.message?.includes("Daily variant creation limit") ||
          e.message?.includes("throttle")
        );
        if (isThrottle) {
          throttled++;
        } else {
          if (errors < 5) {
            const msg = obj.errors.map(e => e.message).join("; ");
            console.error(`   ⚠️ Line ${lineNum}: ${msg}`);
          }
          errors++;
        }
        continue;
      }

      const result = obj.data?.productSet || obj.data?.productCreate;

      if (result) {
        // This is a product result line
        if (result.userErrors && result.userErrors.length > 0) {
          const msg = result.userErrors.map(e => e.message).join("; ");
          if (errors < 5) console.error(`   ⚠️ Line ${lineNum}: ${msg}`);
          errors++;
          continue;
        }

        const product = result.product;
        if (!product || !product.id) continue;

        // Extract inline variants (if Shopify includes them in the product line)
        const inlineNodes = product.variants?.nodes
          || product.variants?.edges?.map(e => e.node)
          || [];

        const idx = productResults.length;
        productResults.push({
          lineNumber: lineNum,
          shopifyGid: product.id,
          shopifyId: product.id.split("/").pop(),
          title: product.title,
          variants: inlineNodes.map(v => ({
            shopifyGid: v.id,
            shopifyId: v.id.split("/").pop(),
            sku: v.sku || "",
            title: v.title || "",
          })),
        });
        productMap.set(product.id, idx);
      } else if (obj.__parentId && obj.id && obj.id.includes("ProductVariant")) {
        // This is a variant child line (flattened connection from bulk operation)
        variantChildren.push({
          parentGid: obj.__parentId,
          shopifyGid: obj.id,
          shopifyId: obj.id.split("/").pop(),
          sku: obj.sku || "",
          title: obj.title || "",
        });
      } else {
        skippedLines++;
      }
    } catch (e) {
      // Skip unparseable lines
    }
  }

  // Merge variant children into their parent products
  let mergedVariants = 0;
  for (const vc of variantChildren) {
    const idx = productMap.get(vc.parentGid);
    if (idx !== undefined) {
      productResults[idx].variants.push({
        shopifyGid: vc.shopifyGid,
        shopifyId: vc.shopifyId,
        sku: vc.sku,
        title: vc.title,
      });
      mergedVariants++;
    }
  }

  console.log(`   Parsed ${productResults.length} products, ${variantChildren.length} variant children (merged ${mergedVariants}), ${errors} errors, ${throttled} throttled, ${skippedLines} skipped`);

  // If most results are throttled, warn and signal to stop
  if (throttled > 0) {
    console.error(`\n   🚫 THROTTLE LIMIT HIT: ${throttled}/${lines.length} results were throttled by Shopify!`);
    if (throttled > lines.length * 0.5) {
      console.error(`   ⛔ More than 50% throttled — daily variant creation limit exceeded.`);
      console.error(`   ⏰ Shopify resets this limit daily. Please wait and try again later.`);
    }
  }

  // Match results to our assets by lineNumber (JSONL is processed in order)
  // Filter assets that actually had variants (matches JSONL generation filter)
  const assetsWithVariants = assets.filter(a => true); // All assets in the batch

  // Process DB updates in parallel chunks for speed
  const CONCURRENCY = 20;
  const chunks = [];
  for (let i = 0; i < productResults.length; i += CONCURRENCY) {
    chunks.push(productResults.slice(i, i + CONCURRENCY));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (ci % 50 === 0) console.log(`   DB update: ${ci * CONCURRENCY}/${productResults.length}`);

    await Promise.all(chunk.map(async (product) => {
      const asset = assetsWithVariants[product.lineNumber];
      if (!asset) return;

      try {
        // Update asset with Shopify IDs
        await supabase
          .from("assets")
          .update({
            shopify_product_id: product.shopifyId,
            shopify_product_gid: product.shopifyGid,
            shopify_status: "synced",
            shopify_synced_at: new Date().toISOString(),
            ingestion_status: "ready",
          })
          .eq("id", asset.id);

        // Update variants with Shopify IDs
        const { data: dbVariants } = await supabase
          .from("asset_variants")
          .select("id, label, width_cm")
          .eq("asset_id", asset.id)
          .order("width_cm", { ascending: true });

        if (dbVariants) {
          await Promise.all(
            dbVariants.slice(0, product.variants.length).map((dbv, j) => {
              const pricing = calcPrice(dbv);
              return supabase
                .from("asset_variants")
                .update({
                  shopify_variant_id: product.variants[j].shopifyId,
                  shopify_variant_gid: product.variants[j].shopifyGid,
                  base_price: parseFloat(pricing.price),
                })
                .eq("id", dbv.id);
            })
          );
        }

        synced++;
      } catch (err) {
        console.error(`   Error updating asset ${asset.id}: ${err.message}`);
        errors++;
      }
    }));
  }

  console.log(`   DB update complete: ${synced} synced, ${errors} errors`);
  return { synced, errors, throttled };
}

// ─── Create Smart Collections ────────────────────────────
async function createCollections() {
  console.log("\n🏷️ Creating smart collections...");

  const collections = [
    { title: "All Art Prints", rules: [{ column: "TYPE", relation: "EQUALS", condition: "Art Print" }] },
    { title: "Portrait Prints", rules: [{ column: "TAG", relation: "EQUALS", condition: "portrait" }] },
    { title: "Landscape Prints", rules: [{ column: "TAG", relation: "EQUALS", condition: "landscape" }] },
    { title: "Square Prints", rules: [{ column: "TAG", relation: "EQUALS", condition: "square" }] },
    { title: "Museum Grade", rules: [{ column: "TAG", relation: "EQUALS", condition: "museum grade" }] },
  ];

  for (const col of collections) {
    try {
      const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/smart_collections.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          smart_collection: {
            title: col.title,
            rules: col.rules.map(r => ({ column: r.column.toLowerCase(), relation: r.relation.toLowerCase(), condition: r.condition })),
            published: true,
          },
        }),
      });
      const data = await res.json();
      if (data.smart_collection) {
        console.log(`   ✅ ${col.title} (ID: ${data.smart_collection.id})`);
      } else {
        console.log(`   ⚠️ ${col.title}: ${JSON.stringify(data.errors || data)}`);
      }
    } catch (err) {
      console.log(`   ❌ ${col.title}: ${err.message}`);
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  NEVERLAND PRINTS — GraphQL Bulk Sync");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Store: ${SHOP}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("═══════════════════════════════════════════════════");

  // Status check mode
  if (STATUS_ONLY) {
    const op = await checkBulkStatus();
    if (op) {
      console.log("\nCurrent bulk operation:");
      console.log(JSON.stringify(op, null, 2));
    } else {
      console.log("\nNo active bulk operation.");
    }
    return;
  }

  // Check if there's already a running operation
  const existingOp = await checkBulkStatus();
  if (existingOp && (existingOp.status === "RUNNING" || existingOp.status === "CREATED")) {
    console.log(`\n⚠️ A bulk operation is already running (${existingOp.status}).`);
    console.log("   Waiting for it to complete...");
    const completed = await pollUntilDone();
    if (completed?.status !== "COMPLETED") {
      console.error("   Previous operation did not complete successfully. Exiting.");
      process.exit(1);
    }
  }

  // Count total pending
  const { count: totalPending } = await supabase
    .from("assets")
    .select("*", { count: "exact", head: true })
    .eq("shopify_status", "pending");

  console.log(`\n📊 Total pending assets: ${totalPending}`);

  if (totalPending === 0) {
    console.log("   Nothing to sync!");
    return;
  }

  // Process in batches (Shopify recommends keeping JSONL under ~20MB)
  let totalSynced = 0;
  let totalErrors = 0;
  let batchNum = 0;
  let offset = 0;

  while (offset < totalPending) {
    batchNum++;
    console.log(`\n${"─".repeat(50)}`);
    console.log(`  BATCH ${batchNum} (offset=${offset}, limit=${BATCH_SIZE})`);
    console.log(`${"─".repeat(50)}`);

    let batchSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Step 1: Generate JSONL
        const { lines, assets } = await generateJSONL(0, BATCH_SIZE); // Always offset=0 since we query pending
        if (lines.length === 0) { batchSuccess = true; break; }

        const jsonlContent = lines.join("\n");
        const sizeMB = Buffer.byteLength(jsonlContent) / 1024 / 1024;
        console.log(`   JSONL: ${lines.length} products, ${sizeMB.toFixed(1)} MB`);

        // Save JSONL for reference
        const jsonlPath = path.join(process.cwd(), `bulk-sync-batch-${batchNum}.jsonl`);
        fs.writeFileSync(jsonlPath, jsonlContent);
        console.log(`   Saved to: ${jsonlPath}`);

        if (DRY_RUN) {
          console.log("\n   🏁 DRY RUN — skipping upload.");
          return;
        }

        // Step 2: Stage upload
        const stagedPath = await stageUpload(jsonlContent);

        // Step 3: Start bulk mutation
        await startBulkOperation(stagedPath);

        // Step 4: Poll for completion
        const result = await pollUntilDone(15000);

        if (result?.status === "COMPLETED" && result.url) {
          // Step 5: Process results & update DB
          const { synced, errors, throttled } = await processResults(result.url, assets);
          totalSynced += synced;
          totalErrors += errors;
          console.log(`   Batch ${batchNum}: ${synced} synced, ${errors} errors, ${throttled || 0} throttled`);

          // If throttled, stop all further batches
          if (throttled && throttled > lines.length * 0.5) {
            console.error(`\n   ⛔ STOPPING: Daily variant creation limit reached.`);
            console.error(`   ⏰ Shopify resets daily. Re-run this script later.`);
            console.error(`   📊 Progress so far: ${totalSynced} synced this session.\n`);
            batchSuccess = true;
            offset = totalPending; // Force exit from outer loop
            break;
          }
        } else {
          console.error(`   Batch ${batchNum} did not complete.`);
          if (result?.partialDataUrl) {
            const { synced, errors, throttled } = await processResults(result.partialDataUrl, assets);
            totalSynced += synced;
            totalErrors += errors;
            if (throttled && throttled > 0) {
              console.error(`\n   ⛔ STOPPING: Daily variant creation limit reached.`);
              offset = totalPending;
            }
          }
        }

        batchSuccess = true;
        break; // Success, exit retry loop
      } catch (err) {
        console.error(`   ⚠️ Batch ${batchNum} attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 10000;
          console.log(`   Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`   ❌ Batch ${batchNum} failed after 3 attempts. Continuing to next batch.`);
        }
      }
    }

    if (!batchSuccess) {
      // Skip this batch's worth of assets
    }

    offset += BATCH_SIZE;

    // Small cooldown between batches
    if (offset < totalPending) {
      console.log("\n   Cooling down 5s before next batch...");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Create collections if requested
  if (CREATE_COLLECTIONS) {
    await createCollections();
  }

  // Final stats
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  ✅ BULK SYNC COMPLETE`);
  console.log(`  Synced: ${totalSynced} | Errors: ${totalErrors}`);
  console.log("═══════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
