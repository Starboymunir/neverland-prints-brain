/**
 * Migration: Add mockup_url column to assets table
 * =================================================
 * Stores Printful-generated wall mockup URLs for each asset.
 *
 * Run: node src/db/migration-mockup-url.js
 * Or paste the SQL directly in Supabase SQL Editor.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SQL = `
-- Add mockup_url column to assets table
ALTER TABLE assets ADD COLUMN IF NOT EXISTS mockup_url TEXT;

-- Index for quickly finding assets without mockups
CREATE INDEX IF NOT EXISTS idx_assets_mockup_url ON assets(mockup_url) WHERE mockup_url IS NOT NULL;

-- Comment
COMMENT ON COLUMN assets.mockup_url IS 'Printful-generated wall mockup image URL';
`;

async function main() {
  console.log("Adding mockup_url column to assets table...");
  console.log("\nSQL to execute:");
  console.log(SQL);

  try {
    const { error } = await supabase.rpc("exec_sql", { sql: SQL });
    if (error) {
      // rpc might not exist — try raw
      console.log("\nrpc failed, trying direct...");
      const statements = SQL.split(";").filter((s) => s.trim());
      for (const stmt of statements) {
        if (!stmt.trim() || stmt.trim().startsWith("--")) continue;
        console.log(`  Executing: ${stmt.trim().substring(0, 80)}...`);
        const { error: err } = await supabase.rpc("exec_sql", {
          sql: stmt + ";",
        });
        if (err) {
          console.log(`  Warning: ${err.message}`);
        } else {
          console.log("  OK");
        }
      }
    } else {
      console.log("Done!");
    }
  } catch (e) {
    console.error("Error:", e.message);
    console.log(
      "\nPlease run the SQL manually in the Supabase SQL Editor:\n" + SQL
    );
  }
}

main();
