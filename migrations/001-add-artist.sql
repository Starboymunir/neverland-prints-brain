-- ============================================================
-- MIGRATION: Add artist + quality_tier columns to assets table
-- Run this in Supabase SQL Editor
-- ============================================================
ALTER TABLE assets ADD COLUMN IF NOT EXISTS artist TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS quality_tier TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_artist ON assets(artist);
