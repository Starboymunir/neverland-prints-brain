#!/usr/bin/env node
/**
 * Create the fulfillment_orders table in Supabase
 * Uses Supabase's management RPC to run SQL.
 * 
 * Run: node src/scripts/create-fulfillment-table.js
 */

require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sql = `
-- Fulfillment Orders table for Skeleton Product Architecture
CREATE TABLE IF NOT EXISTS fulfillment_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  order_name TEXT,
  line_item_id TEXT,
  asset_id UUID REFERENCES assets(id),
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

-- Index for order lookups
CREATE INDEX IF NOT EXISTS idx_fulfillment_order_id ON fulfillment_orders(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_status ON fulfillment_orders(status);
CREATE INDEX IF NOT EXISTS idx_fulfillment_asset ON fulfillment_orders(asset_id);

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_fulfillment_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fulfillment_orders_updated ON fulfillment_orders;
CREATE TRIGGER fulfillment_orders_updated
  BEFORE UPDATE ON fulfillment_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_fulfillment_timestamp();
`;

function supabaseRpc(sqlQuery) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sqlQuery });
    const u = new URL(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname, method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log("Creating fulfillment_orders table...");
  
  // Try via RPC first (requires exec_sql function on Supabase)
  const result = await supabaseRpc(sql);
  
  if (result.status === 200 || result.status === 204) {
    console.log("✓ Table created successfully!");
  } else {
    console.log(`RPC method returned ${result.status}: ${result.body.slice(0, 200)}`);
    console.log("\nPlease run this SQL in the Supabase SQL editor:");
    console.log("Dashboard > SQL Editor > New Query > Paste & Run\n");
    console.log("=".repeat(60));
    console.log(sql);
    console.log("=".repeat(60));
  }
}

main().catch((e) => console.error("Error:", e));
