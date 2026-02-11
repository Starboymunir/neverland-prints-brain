-- ============================================================
-- Supabase Migration: pgvector + asset_embeddings table
-- ============================================================
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
--
-- This enables:
--   1. pgvector extension for vector similarity search
--   2. asset_embeddings table to store 768d vectors
--   3. match_assets RPC function for cosine similarity search
--   4. analytics_events table for the feedback loop
-- ============================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create asset_embeddings table
CREATE TABLE IF NOT EXISTS asset_embeddings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL,
  embedding_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(asset_id)
);

-- Index for fast vector search (IVFFlat — good for <100k rows)
CREATE INDEX IF NOT EXISTS idx_asset_embeddings_vector 
  ON asset_embeddings 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index for asset lookups
CREATE INDEX IF NOT EXISTS idx_asset_embeddings_asset_id 
  ON asset_embeddings(asset_id);

-- 3. Create the match_assets RPC function
CREATE OR REPLACE FUNCTION match_assets(
  query_embedding vector(768),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  asset_id UUID,
  shopify_product_id BIGINT,
  title TEXT,
  drive_file_id TEXT,
  artist TEXT,
  style TEXT,
  mood TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ae.asset_id,
    a.shopify_product_id,
    a.title,
    a.drive_file_id,
    a.artist,
    a.style,
    a.mood,
    1 - (ae.embedding <=> query_embedding) AS similarity
  FROM asset_embeddings ae
  JOIN assets a ON a.id = ae.asset_id
  WHERE a.shopify_status = 'synced'
    AND 1 - (ae.embedding <=> query_embedding) > match_threshold
  ORDER BY ae.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 4. Create analytics_events table
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click', 'view', 'add_to_cart', 'purchase', 'search')),
  product_id BIGINT,
  asset_id UUID REFERENCES assets(id),
  collection_id BIGINT,
  search_query TEXT,
  session_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_product_id ON analytics_events(product_id);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id);

-- 5. Create trending products materialized view
-- Refreshed by cron to avoid real-time computation
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_products AS
SELECT 
  product_id,
  COUNT(*) FILTER (WHERE event_type = 'view') AS views,
  COUNT(*) FILTER (WHERE event_type = 'click') AS clicks,
  COUNT(*) FILTER (WHERE event_type = 'add_to_cart') AS adds_to_cart,
  COUNT(*) FILTER (WHERE event_type = 'purchase') AS purchases,
  -- Weighted score: purchase=10, ATC=5, click=2, view=1
  (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
   COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
   COUNT(*) FILTER (WHERE event_type = 'click') * 2 +
   COUNT(*) FILTER (WHERE event_type = 'view') * 1
  ) AS trending_score,
  MAX(created_at) AS last_event_at
FROM analytics_events
WHERE product_id IS NOT NULL
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY product_id
ORDER BY trending_score DESC;

-- Index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_product_id ON trending_products(product_id);

-- 6. Add RLS policies (security)
ALTER TABLE asset_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access on embeddings" ON asset_embeddings
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on analytics" ON analytics_events
  FOR ALL USING (auth.role() = 'service_role');

-- Allow anon to INSERT analytics events (for storefront tracking)
CREATE POLICY "Anon can insert analytics" ON analytics_events
  FOR INSERT WITH CHECK (true);

-- Allow anon to read trending (for storefront display)
-- Materialized views don't need RLS

-- 7. Function to refresh trending view (called by cron)
CREATE OR REPLACE FUNCTION refresh_trending()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY trending_products;
END;
$$;

-- 8. Add artist and quality_tier columns to assets (if not exist)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assets' AND column_name='artist') THEN
    ALTER TABLE assets ADD COLUMN artist TEXT;
    CREATE INDEX idx_assets_artist ON assets(artist);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assets' AND column_name='quality_tier') THEN
    ALTER TABLE assets ADD COLUMN quality_tier TEXT DEFAULT 'standard';
    CREATE INDEX idx_assets_quality ON assets(quality_tier);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assets' AND column_name='description') THEN
    ALTER TABLE assets ADD COLUMN description TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assets' AND column_name='era') THEN
    ALTER TABLE assets ADD COLUMN era TEXT;
  END IF;
END $$;

-- Done!
-- After running this, your backend can:
--   1. Generate embeddings → store in asset_embeddings
--   2. Find similar artworks via match_assets() RPC
--   3. Track user events in analytics_events
--   4. Show trending products from trending_products view
