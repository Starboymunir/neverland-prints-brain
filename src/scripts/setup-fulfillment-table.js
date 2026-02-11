#!/usr/bin/env node
/**
 * Create fulfillment_orders table via Supabase SQL endpoint
 */
require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sql = `
CREATE TABLE IF NOT EXISTS fulfillment_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  order_name TEXT,
  line_item_id TEXT,
  asset_id UUID,
  artwork_title TEXT NOT NULL,
  artist TEXT,
  size TEXT,
  frame TEXT DEFAULT 'Unframed',
  price_tier TEXT,
  drive_file_id TEXT,
  quantity INT DEFAULT 1,
  price DECIMAL(10,2),
  customer_email TEXT,
  shipping_address JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopify_order_id, line_item_id)
);
`;

// First, create the exec_sql function, then use it
const createFnSql = `
CREATE OR REPLACE FUNCTION exec_sql(query text)
RETURNS void AS $$
BEGIN
  EXECUTE query;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`;

// Alternative: Just test if we can insert — if not, table doesn't exist
// Try creating by directly calling the management API

// Actually, let's just try to query the table
function supabasePost(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const u = new URL(`${SUPABASE_URL}${path}`);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Length": Buffer.byteLength(bodyStr),
          "Prefer": "return=minimal",
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}${path}`);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname + u.search, method: "GET",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  // Check if table exists by trying to query it
  console.log("Checking if fulfillment_orders table exists...");
  const check = await supabaseGet("/rest/v1/fulfillment_orders?limit=0");
  
  if (check.status === 200) {
    console.log("✓ Table already exists!");
    return;
  }
  
  console.log(`Table check returned ${check.status}: ${check.body.slice(0, 100)}`);
  console.log("\n⚠ The table needs to be created manually in Supabase SQL Editor.");
  console.log("Go to: https://supabase.com/dashboard > Your Project > SQL Editor > New Query");
  console.log("\nPaste this SQL and click Run:\n");
  console.log(sql);
  console.log(`\nAlso create indexes:\n`);
  console.log(`CREATE INDEX IF NOT EXISTS idx_fulfillment_order_id ON fulfillment_orders(shopify_order_id);`);
  console.log(`CREATE INDEX IF NOT EXISTS idx_fulfillment_status ON fulfillment_orders(status);`);
}

main().catch((e) => console.error("Error:", e));
