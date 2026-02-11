#!/usr/bin/env node
/**
 * Bulk Delete via Shopify Bulk Operations API
 * =============================================
 * 1) Runs a bulk query to get ALL product IDs
 * 2) Creates a staged upload
 * 3) Uploads JSONL with productDelete mutations
 * 4) Runs bulk mutation
 * 
 * This deletes all products asynchronously on Shopify's side — MUCH faster.
 */

process.on("unhandledRejection", (err) => { console.error("UNHANDLED:", err); });

require("dotenv").config();
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || "2024-10";
const GQL = `https://${STORE}/admin/api/${API}/graphql.json`;

function gql(query, variables) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const u = new URL(GQL);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } });
      }
    );
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("GQL timeout")); });
    req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollBulkOp() {
  while (true) {
    const res = await gql(`{
      currentBulkOperation {
        id status errorCode objectCount url
      }
    }`);
    const op = res.data?.currentBulkOperation;
    if (!op) { console.log("No active bulk operation"); return null; }
    console.log(`  Status: ${op.status} | Objects: ${op.objectCount}`);
    if (op.status === "COMPLETED") return op;
    if (op.status === "FAILED") { console.error("Bulk op failed:", op.errorCode); return null; }
    if (op.status === "CANCELED") { console.log("Canceled"); return null; }
    await sleep(5000);
  }
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

function uploadFile(url, params, content) {
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    let body = "";

    // Add form parameters
    for (const [key, val] of Object.entries(params)) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
      body += `${val}\r\n`;
    }

    // Add file
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="bulk_input.jsonl"\r\n`;
    body += `Content-Type: text/jsonl\r\n\r\n`;
    body += content;
    body += `\r\n--${boundary}--\r\n`;

    const u = new URL(url);
    const buf = Buffer.from(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": buf.length } },
      (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error("upload timeout")); });
    req.write(buf); req.end();
  });
}

async function main() {
  console.log("=== BULK DELETE VIA BULK OPERATIONS ===");
  console.log("Store:", STORE);

  // Step 0: Check for existing bulk operation
  const current = await gql(`{ currentBulkOperation { id status } }`);
  if (current.data?.currentBulkOperation?.status === "RUNNING") {
    console.log("A bulk operation is already running. Waiting for it to finish...");
    await pollBulkOp();
  }

  // Step 1: Check if JSONL from previous run exists
  const jsonlPath = path.join(__dirname, "../../delete-products.jsonl");
  let productIds = [];
  
  if (fs.existsSync(jsonlPath)) {
    console.log("\n1. Using existing JSONL from previous run...");
    const data = fs.readFileSync(jsonlPath, "utf-8");
    productIds = data.trim().split("\n").filter(Boolean).map(line => {
      const obj = JSON.parse(line);
      return obj.input?.id;
    }).filter(Boolean);
    console.log(`   Found ${productIds.length} products in JSONL`);
  }

  if (productIds.length === 0) {
    // Run bulk query to get all product IDs
    console.log("\n1. Starting bulk query for all product IDs...");
    const queryRes = await gql(`
      mutation {
        bulkOperationRunQuery(query: """
          { products { edges { node { id } } } }
        """) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }
    `);

    if (queryRes.data?.bulkOperationRunQuery?.userErrors?.length > 0) {
      console.error("Query error:", queryRes.data.bulkOperationRunQuery.userErrors);
      return;
    }
    console.log("   Bulk query started:", queryRes.data?.bulkOperationRunQuery?.bulkOperation?.id);

    // Poll until complete
    console.log("\n2. Waiting for bulk query to complete...");
    const queryOp = await pollBulkOp();
    if (!queryOp || !queryOp.url) {
      console.log("No results from bulk query");
      return;
    }

    // Download the JSONL with product IDs
    console.log("\n3. Downloading product IDs...");
    const rawData = await downloadFile(queryOp.url);
    const lines = rawData.trim().split("\n").filter(Boolean);
    productIds = lines.map(line => {
      const obj = JSON.parse(line);
      return obj.id;
    }).filter(id => id && id.startsWith("gid://shopify/Product/"));
    
    console.log(`   Found ${productIds.length} products`);
  }
  
  if (productIds.length === 0) {
    console.log("No products to delete!");
    return;
  }

  // Step 4: Create JSONL for delete mutations
  console.log("\n4. Creating delete mutations JSONL...");
  const jsonlContent = productIds.map(id => JSON.stringify({ input: { id } })).join("\n");
  
  // Save locally for reference
  fs.writeFileSync(jsonlPath, jsonlContent);
  console.log(`   Wrote ${productIds.length} mutations to delete-products.jsonl (${(Buffer.byteLength(jsonlContent) / 1024 / 1024).toFixed(1)}MB)`);

  // Step 5: Create staged upload
  console.log("\n5. Creating staged upload...");
  const stageRes = await gql(`
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "bulk_input.jsonl",
        mimeType: "text/jsonl",
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

  if (stageRes.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    console.error("Stage error:", stageRes.data.stagedUploadsCreate.userErrors);
    return;
  }

  const target = stageRes.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    console.error("No staged target returned");
    return;
  }
  console.log("   Upload URL:", target.url.slice(0, 80) + "...");

  // Step 6: Upload JSONL
  console.log("\n6. Uploading JSONL...");
  const params = {};
  target.parameters.forEach(p => { params[p.name] = p.value; });
  
  // The "key" parameter is the staged upload path for bulkOperationRunMutation
  const stagedUploadPath = params.key;
  console.log("   Staged path:", stagedUploadPath);
  
  const uploadRes = await uploadFile(target.url, params, jsonlContent);
  console.log(`   Upload status: ${uploadRes.status}`);
  if (uploadRes.status >= 400) {
    console.error("Upload failed:", uploadRes.body.slice(0, 300));
    return;
  }

  // Step 7: Run bulk mutation
  console.log("\n7. Starting bulk mutation (productDelete)...");
  const mutRes = await gql(`
    mutation($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation del($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }",
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `, { stagedUploadPath });

  if (mutRes.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
    console.error("Mutation error:", mutRes.data.bulkOperationRunMutation.userErrors);
    return;
  }
  console.log("   Bulk mutation started:", mutRes.data?.bulkOperationRunMutation?.bulkOperation?.id);

  // Step 8: Poll until complete
  console.log("\n8. Waiting for bulk deletion to complete...");
  const delOp = await pollBulkOp();
  
  if (delOp) {
    console.log(`\n=== COMPLETE ===`);
    console.log(`Objects processed: ${delOp.objectCount}`);
    
    // Verify
    const cnt = await gql("{ productsCount { count } }");
    console.log(`Products remaining: ${cnt.data?.productsCount?.count}`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
