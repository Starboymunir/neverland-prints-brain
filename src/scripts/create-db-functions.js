/**
 * Create PostgreSQL aggregate functions for efficient filter/artist queries.
 * Run once: node src/scripts/create-db-functions.js
 *
 * These functions run server-side in Postgres, bypassing the 1000-row
 * Supabase API limit and making filter/artist queries O(1) API calls
 * instead of paginating through 163K+ rows.
 */
require("dotenv").config();
const { Client } = require("pg");

const REF = "mjgdxcwmequgbmqevttl";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DB_HOST = "aws-0-us-east-1.pooler.supabase.com";

const FUNCTIONS_SQL = `
-- ===== Artist counts (used by /api/storefront/artists) =====
CREATE OR REPLACE FUNCTION get_artist_counts()
RETURNS TABLE(artist_name text, artwork_count bigint) AS $$
  SELECT artist AS artist_name, COUNT(*) AS artwork_count
  FROM public.assets
  WHERE ingestion_status IN ('ready', 'analyzed')
    AND artist IS NOT NULL
  GROUP BY artist
  ORDER BY artwork_count DESC;
$$ LANGUAGE sql STABLE;

-- ===== Filter aggregation (used by /api/storefront/filters) =====
CREATE OR REPLACE FUNCTION get_filter_counts()
RETURNS json AS $$
  SELECT json_build_object(
    'styles', COALESCE((
      SELECT json_agg(row_to_json(t)) FROM (
        SELECT style AS value, COUNT(*) AS count
        FROM public.assets
        WHERE ingestion_status IN ('ready','analyzed') AND style IS NOT NULL
        GROUP BY style ORDER BY count DESC
      ) t
    ), '[]'::json),
    'moods', COALESCE((
      SELECT json_agg(row_to_json(t)) FROM (
        SELECT mood AS value, COUNT(*) AS count
        FROM public.assets
        WHERE ingestion_status IN ('ready','analyzed') AND mood IS NOT NULL
        GROUP BY mood ORDER BY count DESC
      ) t
    ), '[]'::json),
    'orientations', COALESCE((
      SELECT json_agg(row_to_json(t)) FROM (
        SELECT ratio_class AS value, COUNT(*) AS count
        FROM public.assets
        WHERE ingestion_status IN ('ready','analyzed') AND ratio_class IS NOT NULL
        GROUP BY ratio_class ORDER BY count DESC
      ) t
    ), '[]'::json),
    'eras', COALESCE((
      SELECT json_agg(row_to_json(t)) FROM (
        SELECT era AS value, COUNT(*) AS count
        FROM public.assets
        WHERE ingestion_status IN ('ready','analyzed') AND era IS NOT NULL
        GROUP BY era ORDER BY count DESC
      ) t
    ), '[]'::json),
    'subjects', COALESCE((
      SELECT json_agg(row_to_json(t)) FROM (
        SELECT subject AS value, COUNT(*) AS count
        FROM public.assets
        WHERE ingestion_status IN ('ready','analyzed') AND subject IS NOT NULL
        GROUP BY subject ORDER BY count DESC
      ) t
    ), '[]'::json)
  );
$$ LANGUAGE sql STABLE;

-- ===== Total asset count =====
CREATE OR REPLACE FUNCTION get_total_assets()
RETURNS bigint AS $$
  SELECT COUNT(*) FROM public.assets
  WHERE ingestion_status IN ('ready', 'analyzed');
$$ LANGUAGE sql STABLE;
`;

async function tryConnect(config, label) {
  console.log(`\nTrying ${label}...`);
  const client = new Client({
    ...config,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
    console.log("  Connected!");
    await client.query(FUNCTIONS_SQL);
    console.log("  Functions created successfully!");
    await client.end();
    return true;
  } catch (e) {
    console.log(`  Failed: ${e.message.substring(0, 120)}`);
    try { await client.end(); } catch (_) {}
    return false;
  }
}

async function main() {
  console.log("Creating database aggregate functions...\n");

  const attempts = [
    {
      config: { user: `postgres.${REF}`, password: SUPABASE_KEY, host: DB_HOST, port: 6543 },
      label: "Pooler with JWT",
    },
    {
      config: { user: `postgres.${REF}`, password: SUPABASE_KEY, host: `db.${REF}.supabase.co`, port: 5432 },
      label: "Direct with JWT",
    },
    {
      config: { user: "postgres", password: SUPABASE_KEY, host: `db.${REF}.supabase.co`, port: 5432 },
      label: "Direct postgres user",
    },
  ];

  for (const { config, label } of attempts) {
    const ok = await tryConnect(config, label);
    if (ok) {
      console.log("\n✅ All database functions created. You can now use supabase.rpc() for efficient queries.");
      console.log("   - get_artist_counts()  → used by /api/storefront/artists");
      console.log("   - get_filter_counts()  → used by /api/storefront/filters");
      console.log("   - get_total_assets()   → total asset count");
      process.exit(0);
    }
  }

  console.log("\n⚠️  Could not connect to database directly. The pagination approach in api.js will still work.");
  console.log("   To create functions manually, run the SQL in Supabase SQL Editor.");
  process.exit(1);
}

main();
