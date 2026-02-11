-- ============================================================
-- NEVERLAND PRINTS — DATABASE SCHEMA
-- Paste this entire block into Supabase SQL Editor and click "Run"
-- ============================================================

-- assets: the canonical record for every artwork
CREATE TABLE IF NOT EXISTS assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id   TEXT UNIQUE NOT NULL,
  filename        TEXT NOT NULL,
  filepath        TEXT,
  mime_type       TEXT,
  file_size_bytes BIGINT,
  width_px        INT,
  height_px       INT,
  aspect_ratio    NUMERIC(8,4),
  ratio_class     TEXT,
  max_print_width_cm  NUMERIC(8,2),
  max_print_height_cm NUMERIC(8,2),
  title           TEXT,
  description     TEXT,
  style           TEXT,
  era             TEXT,
  palette         TEXT,
  mood            TEXT,
  subject         TEXT,
  ai_tags         JSONB DEFAULT '[]'::jsonb,
  content_hash    TEXT,
  shopify_product_id    BIGINT,
  shopify_product_gid   TEXT,
  shopify_status        TEXT DEFAULT 'pending',
  shopify_synced_at     TIMESTAMPTZ,
  ingestion_status  TEXT DEFAULT 'pending',
  ingestion_error   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assets_drive_file_id ON assets(drive_file_id);
CREATE INDEX IF NOT EXISTS idx_assets_content_hash ON assets(content_hash);
CREATE INDEX IF NOT EXISTS idx_assets_ingestion_status ON assets(ingestion_status);
CREATE INDEX IF NOT EXISTS idx_assets_shopify_status ON assets(shopify_status);
CREATE INDEX IF NOT EXISTS idx_assets_ratio_class ON assets(ratio_class);
CREATE INDEX IF NOT EXISTS idx_assets_style ON assets(style);
CREATE INDEX IF NOT EXISTS idx_assets_era ON assets(era);

-- asset_variants: valid print size variants per asset
CREATE TABLE IF NOT EXISTS asset_variants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID REFERENCES assets(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  width_cm        NUMERIC(8,2) NOT NULL,
  height_cm       NUMERIC(8,2) NOT NULL,
  width_inches    NUMERIC(8,2),
  height_inches   NUMERIC(8,2),
  effective_dpi   NUMERIC(8,2),
  quality_grade   TEXT,
  base_price      NUMERIC(10,2),
  shopify_variant_id   BIGINT,
  shopify_variant_gid  TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_variants_asset_id ON asset_variants(asset_id);

-- print_profiles: reusable material/provider profiles
CREATE TABLE IF NOT EXISTS print_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  provider        TEXT,
  material_type   TEXT,
  bleed_mm        NUMERIC(5,2) DEFAULT 0,
  min_dpi         INT DEFAULT 150,
  max_long_edge_cm NUMERIC(8,2),
  file_format     TEXT DEFAULT 'PNG',
  color_profile   TEXT DEFAULT 'sRGB',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- pipeline_runs: track each batch run for the dashboard
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type        TEXT NOT NULL,
  status          TEXT DEFAULT 'running',
  total_items     INT DEFAULT 0,
  processed_items INT DEFAULT 0,
  error_count     INT DEFAULT 0,
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}'::jsonb
);
