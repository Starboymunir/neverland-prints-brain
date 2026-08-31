#!/usr/bin/env node
/**
 * Create the analytics_events table the storefront event tracking writes to.
 * It was missing (POST /api/storefront/events failed with "Could not find the
 * table public.analytics_events"), so NO storefront events were ever stored —
 * which is the data foundation the personalized homepage needs.
 *
 * Adds visitor_id (persistent first-party ID) + consent alongside the existing
 * session_id, so anonymous personalization can key off the browser/device.
 *
 * Idempotent (IF NOT EXISTS). Tries the Supabase exec_sql RPC; if that isn't
 * available, prints the SQL to run manually in the Supabase SQL editor.
 */
require("dotenv").config();
const https = require("https");
const { URL } = require("url");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const sql = `
CREATE TABLE IF NOT EXISTS analytics_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type   TEXT NOT NULL,
  product_id   BIGINT,
  asset_id     TEXT,
  collection_id BIGINT,
  search_query TEXT,
  session_id   TEXT,
  visitor_id   TEXT,
  consent      BOOLEAN DEFAULT NULL,
  metadata     JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ae_visitor   ON analytics_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_ae_session   ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_ae_product   ON analytics_events(product_id);
CREATE INDEX IF NOT EXISTS idx_ae_type      ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ae_created   ON analytics_events(created_at);
-- Common personalization query: this visitor's recent events, newest first.
CREATE INDEX IF NOT EXISTS idx_ae_visitor_created ON analytics_events(visitor_id, created_at DESC);
`;

function rpc(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const u = new URL(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
    process.exit(1);
  }
  try {
    const r = await rpc(sql);
    if (r.status >= 200 && r.status < 300) {
      console.log("✅ analytics_events table + indexes ensured.");
    } else {
      console.log(`exec_sql RPC returned ${r.status}: ${r.body.slice(0, 200)}`);
      console.log("\nRun this SQL manually in the Supabase SQL editor:\n");
      console.log(sql);
    }
  } catch (e) {
    console.log("exec_sql RPC unavailable:", e.message);
    console.log("\nRun this SQL manually in the Supabase SQL editor:\n");
    console.log(sql);
  }
})();
