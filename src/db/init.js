/**
 * Database initialization — creates tables in Supabase via SQL.
 *
 * Run:  npm run db:init
 *
 * NOTE: Supabase also lets you create tables from the dashboard.
 *       This script is provided so the schema is version-controlled.
 */
const supabase = require("./supabase");

const TABLES_SQL = `
-- ============================================================
-- assets: the canonical record for every artwork
-- ============================================================
CREATE TABLE IF NOT EXISTS assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id   TEXT UNIQUE NOT NULL,          -- Google Drive file ID
  filename        TEXT NOT NULL,
  filepath        TEXT,                           -- relative path inside the Drive folder
  mime_type       TEXT,
  file_size_bytes BIGINT,

  -- Image dimensions (pixels)
  width_px        INT,
  height_px       INT,
  aspect_ratio    NUMERIC(8,4),                  -- width / height

  -- Resolution engine outputs
  ratio_class     TEXT,                           -- e.g. 'square', 'portrait', 'landscape', 'panoramic'
  max_print_width_cm  NUMERIC(8,2),
  max_print_height_cm NUMERIC(8,2),

  -- AI-generated metadata
  title           TEXT,
  description     TEXT,
  style           TEXT,                           -- e.g. minimalist, abstract, pop
  era             TEXT,                           -- e.g. 60s, 80s, Y2K
  palette         TEXT,                           -- e.g. warm, cool, vivid, muted
  mood            TEXT,
  subject         TEXT,                           -- e.g. cityscape, portrait, nature
  ai_tags         JSONB DEFAULT '[]'::jsonb,      -- full tag array from AI

  -- Duplicate detection
  content_hash    TEXT,                           -- SHA-256 of file content for dedup

  -- Shopify sync
  shopify_product_id    BIGINT,
  shopify_product_gid   TEXT,
  shopify_status        TEXT DEFAULT 'pending',   -- pending | synced | error
  shopify_synced_at     TIMESTAMPTZ,

  -- Pipeline status
  ingestion_status  TEXT DEFAULT 'pending',       -- pending | downloaded | analyzed | tagged | ready | error
  ingestion_error   TEXT,

  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_assets_drive_file_id ON assets(drive_file_id);
CREATE INDEX IF NOT EXISTS idx_assets_content_hash ON assets(content_hash);
CREATE INDEX IF NOT EXISTS idx_assets_ingestion_status ON assets(ingestion_status);
CREATE INDEX IF NOT EXISTS idx_assets_shopify_status ON assets(shopify_status);
CREATE INDEX IF NOT EXISTS idx_assets_ratio_class ON assets(ratio_class);
CREATE INDEX IF NOT EXISTS idx_assets_style ON assets(style);
CREATE INDEX IF NOT EXISTS idx_assets_era ON assets(era);

-- ============================================================
-- asset_variants: valid print size variants per asset
-- ============================================================
CREATE TABLE IF NOT EXISTS asset_variants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID REFERENCES assets(id) ON DELETE CASCADE,
  
  -- Size info
  label           TEXT NOT NULL,                  -- e.g. 'Small', 'Medium', 'Large'
  width_cm        NUMERIC(8,2) NOT NULL,
  height_cm       NUMERIC(8,2) NOT NULL,
  width_inches    NUMERIC(8,2),
  height_inches   NUMERIC(8,2),

  -- Print quality
  effective_dpi   NUMERIC(8,2),
  quality_grade   TEXT,                           -- 'excellent' | 'good' | 'acceptable' | 'low'

  -- Pricing
  base_price      NUMERIC(10,2),

  -- Shopify
  shopify_variant_id   BIGINT,
  shopify_variant_gid  TEXT,

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_variants_asset_id ON asset_variants(asset_id);

-- ============================================================
-- print_profiles: reusable material/provider profiles
-- ============================================================
CREATE TABLE IF NOT EXISTS print_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,                  -- e.g. 'Matte Paper', 'Canvas Wrap'
  provider        TEXT,                           -- e.g. 'printful', 'gelato', 'generic'
  material_type   TEXT,                           -- paper_matte, paper_glossy, canvas, metal, etc.
  bleed_mm        NUMERIC(5,2) DEFAULT 0,
  min_dpi         INT DEFAULT 150,
  max_long_edge_cm NUMERIC(8,2),
  file_format     TEXT DEFAULT 'PNG',             -- PNG, PDF, TIFF
  color_profile   TEXT DEFAULT 'sRGB',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- pipeline_runs: track each batch run for the dashboard
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type        TEXT NOT NULL,                  -- 'ingestion' | 'tagging' | 'shopify_sync'
  status          TEXT DEFAULT 'running',         -- running | completed | failed
  total_items     INT DEFAULT 0,
  processed_items INT DEFAULT 0,
  error_count     INT DEFAULT 0,
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}'::jsonb
);
`;

async function initDatabase() {
  console.log("🔧 Initializing database tables...\n");

  const { error } = await supabase.rpc("exec_sql", { sql: TABLES_SQL }).maybeSingle();

  // If RPC doesn't exist, fall back to running via the REST endpoint
  if (error) {
    console.log("ℹ️  Could not run via RPC. Please run the following SQL in your Supabase SQL Editor:\n");
    console.log(TABLES_SQL);
    console.log("\n📋 SQL has been printed above — copy it into Supabase Dashboard → SQL Editor → Run.");
    return;
  }

  console.log("✅ All tables created successfully.");
}

// Allow running directly or importing
if (require.main === module) {
  initDatabase().catch(console.error);
}

module.exports = { initDatabase, TABLES_SQL };
