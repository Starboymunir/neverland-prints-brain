#!/usr/bin/env node
/**
 * Creates the batch_update_tags RPC function in Supabase
 * Uses the Supabase Management API (requires service key)
 */
require("dotenv").config();
const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Extract project ref from URL
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];

const sql = `
CREATE OR REPLACE FUNCTION batch_update_tags(updates jsonb)
RETURNS integer AS $$
DECLARE
  item jsonb;
  cnt integer := 0;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(updates)
  LOOP
    UPDATE assets SET
      style = item->>'style',
      mood = item->>'mood',
      subject = item->>'subject',
      era = item->>'era',
      palette = item->>'palette',
      ai_tags = COALESCE((item->'ai_tags')::jsonb, '[]'::jsonb)
    WHERE id = (item->>'id')::uuid;
    cnt := cnt + 1;
  END LOOP;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`;

// Try using the pg-meta SQL endpoint
const body = JSON.stringify({ query: sql });

const options = {
  hostname: new URL(SUPABASE_URL).hostname,
  port: 443,
  path: "/rest/v1/rpc/",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
  },
};

// Actually, Supabase doesn't expose raw SQL via REST.
// We need to use the Supabase Management API at api.supabase.com
// OR connect via pg directly.
// Let's try the Management API:

const mgmtBody = JSON.stringify({ query: sql });

const mgmtOptions = {
  hostname: "api.supabase.com",
  port: 443,
  path: `/v1/projects/${ref}/database/query`,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${SERVICE_KEY}`,
  },
};

console.log(`Creating RPC function on project: ${ref}`);
console.log(`Using Management API: https://api.supabase.com/v1/projects/${ref}/database/query`);

const req = https.request(mgmtOptions, (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Response: ${data.substring(0, 500)}`);
    if (res.statusCode === 200 || res.statusCode === 201) {
      console.log("✅ RPC function created successfully!");
    } else {
      console.log("❌ Failed. You may need to create this function manually in the Supabase SQL Editor.");
      console.log("\nSQL to paste in Supabase SQL Editor (https://supabase.com/dashboard):\n");
      console.log(sql);
    }
  });
});

req.on("error", (e) => {
  console.error("Request error:", e.message);
});

req.write(mgmtBody);
req.end();
