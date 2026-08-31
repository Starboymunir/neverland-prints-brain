#!/usr/bin/env node
/**
 * Adds the assets.commercial_score column the commercial-ranking engine writes
 * and the catalog's ?sort=commercial reads. Run once in the Supabase SQL editor
 * (no exec_sql RPC / DB password is available to do it from code here).
 */
const sql = `
ALTER TABLE assets ADD COLUMN IF NOT EXISTS commercial_score REAL;
CREATE INDEX IF NOT EXISTS idx_assets_commercial
  ON assets(commercial_score DESC NULLS LAST);
`;
console.log("Run this SQL in the Supabase SQL editor:\n");
console.log(sql);
