/**
 * Database Migration — Add missing columns
 * =========================================
 * Adds columns that the v2 pipeline expects:
 *   - artist (TEXT)
 *   - quality_tier (TEXT)
 *   - Indexes for artist, shopify_synced_at
 *
 * Safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 *
 * Usage:
 *   node src/db/migrate.js
 *
 * Or run this SQL directly in Supabase SQL Editor.
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MIGRATION_SQL = `
-- ============================================================
-- Migration: Add artist & quality_tier columns + new indexes
-- ============================================================

-- Add artist column if not exists
DO $$ BEGIN
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS artist TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add quality_tier column if not exists
DO $$ BEGIN
  ALTER TABLE assets ADD COLUMN IF NOT EXISTS quality_tier TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Change shopify_product_id to TEXT for consistency (some UUIDs are strings)
-- This is a no-op if already TEXT
DO $$ BEGIN
  ALTER TABLE assets ALTER COLUMN shopify_product_id TYPE TEXT USING shopify_product_id::TEXT;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Add useful indexes
CREATE INDEX IF NOT EXISTS idx_assets_artist ON assets(artist);
CREATE INDEX IF NOT EXISTS idx_assets_quality_tier ON assets(quality_tier);
CREATE INDEX IF NOT EXISTS idx_assets_shopify_synced_at ON assets(shopify_synced_at);
CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at);

-- Add composite index for the sync queue query
CREATE INDEX IF NOT EXISTS idx_assets_sync_queue 
  ON assets(shopify_status, ingestion_status) 
  WHERE shopify_status = 'pending';

-- Update the updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assets_updated_at ON assets;
CREATE TRIGGER assets_updated_at
  BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function migrate() {
  console.log("🔧 Running database migration...\n");
  console.log("SQL to execute:");
  console.log("─".repeat(50));
  console.log(MIGRATION_SQL);
  console.log("─".repeat(50));
  console.log("\n📋 Copy the SQL above into Supabase Dashboard → SQL Editor → Run");
  console.log("   URL: https://supabase.com/dashboard/project/mjgdxcwmequgbmqevttl/sql/new\n");

  // Try executing via RPC (may not work if exec_sql RPC isn't set up)
  try {
    const { error } = await supabase.rpc("exec_sql", { sql: MIGRATION_SQL });
    if (error) throw error;
    console.log("✅ Migration executed successfully!");
  } catch (e) {
    console.log("ℹ️  Could not execute via RPC (this is normal).");
    console.log("   Please run the SQL manually in the Supabase SQL Editor.\n");
  }
}

if (require.main === module) {
  migrate().catch(console.error);
}

module.exports = { MIGRATION_SQL };
