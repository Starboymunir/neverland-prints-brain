/**
 * Migration: Create sync_state table + get_artist_counts RPC
 * ===========================================================
 * - sync_state: stores Drive page token so Render restarts use delta sync (not full scan)
 * - get_artist_counts: database-side GROUP BY to avoid loading 135k rows into Node.js
 *
 * Usage:
 *   node src/db/migration-sync-state.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MIGRATION_SQL = `
-- ============================================================
-- sync_state table (persists Drive page token across deploys)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- get_artist_counts RPC (replaces 135k-row fetchAllRows)
-- ============================================================
CREATE OR REPLACE FUNCTION get_artist_counts()
RETURNS TABLE(artist TEXT, count BIGINT) AS $$
  SELECT artist, count(*) as count
  FROM assets
  WHERE ingestion_status IN ('ready', 'analyzed')
    AND artist IS NOT NULL
  GROUP BY artist
  ORDER BY count DESC;
$$ LANGUAGE sql STABLE;
`;

async function runMigration() {
  console.log("Running sync_state + RPC migration...\n");

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ query: MIGRATION_SQL }),
  });

  if (!response.ok) {
    // exec_sql RPC might not exist — try via Supabase SQL directly
    console.log("exec_sql RPC not available, trying individual statements...\n");

    // Create sync_state table
    const { error: e1 } = await supabase.rpc("exec_sql", {
      query: `CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );`,
    }).catch(() => ({ error: { message: "RPC not available" } }));

    // Try direct table creation via REST
    console.log("  Creating sync_state table via upsert test...");
    const { error: testErr } = await supabase
      .from("sync_state")
      .upsert({ key: "_test", value: "ok", updated_at: new Date().toISOString() }, { onConflict: "key" });
    
    if (testErr) {
      console.log("  ⚠️  sync_state table doesn't exist yet.");
      console.log("  Please run this SQL in the Supabase SQL Editor:\n");
      console.log(MIGRATION_SQL);
      console.log("\n  Then re-run this migration.");
      return;
    }

    // Clean up test row
    await supabase.from("sync_state").delete().eq("key", "_test");
    console.log("  ✅ sync_state table exists");
  } else {
    console.log("✅ Migration SQL executed successfully");
  }
}

runMigration().catch(console.error);
