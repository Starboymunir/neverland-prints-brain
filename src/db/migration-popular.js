/**
 * Migration: Create get_popular_assets RPC function
 * This function queries analytics_events directly by asset_id
 * to rank assets by (purchases*10 + add_to_cart*5 + views*1)
 */
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  console.log("Creating get_popular_assets function...");

  const { error } = await supabase.rpc("exec_sql", {
    sql: `
      CREATE OR REPLACE FUNCTION get_popular_assets(days_back INT DEFAULT 30, max_results INT DEFAULT 500)
      RETURNS TABLE(asset_id UUID, score BIGINT) LANGUAGE sql STABLE AS $$
        SELECT
          asset_id,
          (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
           COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
           COUNT(*) FILTER (WHERE event_type = 'view') * 1
          ) AS score
        FROM analytics_events
        WHERE asset_id IS NOT NULL
          AND created_at > NOW() - (days_back || ' days')::INTERVAL
        GROUP BY asset_id
        HAVING (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
                COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
                COUNT(*) FILTER (WHERE event_type = 'view') * 1) > 0
        ORDER BY score DESC
        LIMIT max_results;
      $$;
    `,
  });

  if (error) {
    // Try direct SQL via REST if exec_sql doesn't exist
    console.log("exec_sql not available, trying direct query...");
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql: `
          CREATE OR REPLACE FUNCTION get_popular_assets(days_back INT DEFAULT 30, max_results INT DEFAULT 500)
          RETURNS TABLE(asset_id UUID, score BIGINT) LANGUAGE sql STABLE AS $$
            SELECT
              asset_id,
              (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
               COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
               COUNT(*) FILTER (WHERE event_type = 'view') * 1
              ) AS score
            FROM analytics_events
            WHERE asset_id IS NOT NULL
              AND created_at > NOW() - (days_back || ' days')::INTERVAL
            GROUP BY asset_id
            HAVING (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
                    COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
                    COUNT(*) FILTER (WHERE event_type = 'view') * 1) > 0
            ORDER BY score DESC
            LIMIT max_results;
          $$;
        `,
      }),
    });
    if (!res.ok) {
      console.error("Migration failed. Please run this SQL in Supabase SQL Editor:");
      console.log(`
CREATE OR REPLACE FUNCTION get_popular_assets(days_back INT DEFAULT 30, max_results INT DEFAULT 500)
RETURNS TABLE(asset_id UUID, score BIGINT) LANGUAGE sql STABLE AS $$
  SELECT
    asset_id,
    (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
     COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
     COUNT(*) FILTER (WHERE event_type = 'view') * 1
    ) AS score
  FROM analytics_events
  WHERE asset_id IS NOT NULL
    AND created_at > NOW() - (days_back || ' days')::INTERVAL
  GROUP BY asset_id
  HAVING (COUNT(*) FILTER (WHERE event_type = 'purchase') * 10 +
          COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 5 +
          COUNT(*) FILTER (WHERE event_type = 'view') * 1) > 0
  ORDER BY score DESC
  LIMIT max_results;
$$;
      `);
      return;
    }
  }

  console.log("✓ get_popular_assets function created");
}

run().catch(console.error);
