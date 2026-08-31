#!/usr/bin/env node
/**
 * rank-catalog.js — score the whole assets catalog with the commercial-ranking
 * engine and persist commercial_score on each row. Resumable: only scores rows
 * where commercial_score IS NULL, so it can run in chunks / resume after an
 * interrupt. Use --rescore to recompute everything (e.g. after tuning weights
 * or adding artists.json / famous_artworks.json).
 *
 *   node src/scripts/rank-catalog.js --limit=20000        # score up to N null rows
 *   node src/scripts/rank-catalog.js --rescore --limit=20000
 *
 * Needs the column (run once in Supabase SQL editor):
 *   ALTER TABLE assets ADD COLUMN IF NOT EXISTS commercial_score REAL;
 *   CREATE INDEX IF NOT EXISTS idx_assets_commercial ON assets(commercial_score DESC NULLS LAST);
 */
require("dotenv").config();
const https = require("https");
const { scoreAsset, tuningStatus } = require("../services/commercial-ranking");

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
const RESCORE = args.includes("--rescore");
const LIMIT = parseInt(getArg("limit") || "0", 10) || Infinity;
const PAGE = 1000;
const SELECT = "id,title,artist,subject,style,mood,palette,era,ai_tags,aspect_ratio,ratio_class,width_px,height_px,quality_tier";

function req(method, pathname, search, body) {
  return new Promise((resolve) => {
    const u = new URL(SU + "/rest/v1/" + pathname + (search || ""));
    const b = body ? JSON.stringify(body) : null;
    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method,
        headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json",
          Prefer: method === "PATCH" ? "return=minimal" : "", ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}) } },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => resolve({ status: x.statusCode, body: d })); }
    );
    r.on("error", () => resolve({ status: 0, body: "" }));
    if (b) r.write(b);
    r.end();
  });
}

async function fetchPage(afterId) {
  // Keyset pagination by id (stable, no offset drift). When not --rescore we
  // also skip rows that already have a score, so resuming is cheap.
  const filter = RESCORE ? "" : "&commercial_score=is.null";
  const after = afterId ? `&id=gt.${afterId}` : "";
  const qs = `?select=${SELECT}&ingestion_status=in.(ready,analyzed)${filter}${after}&order=id.asc&limit=${PAGE}`;
  // Retry transient failures — a non-2xx or unparseable body must NOT be
  // mistaken for "no rows left" (which would silently end the run early).
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await req("GET", "assets", qs);
    if (r.status >= 200 && r.status < 300) {
      try { const rows = JSON.parse(r.body); if (Array.isArray(rows)) return rows; } catch (e) {}
    }
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw new Error("fetchPage failed after retries (afterId=" + afterId + ")");
}

async function updateOne(id, score) {
  const r = await req("PATCH", "assets", `?id=eq.${id}`, { commercial_score: score });
  return r.status >= 200 && r.status < 300;
}

async function pool(items, worker, concurrency = 24) {
  let i = 0, ok = 0, fail = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      const good = await worker(items[idx]);
      if (good) ok++; else fail++;
    }
  }));
  return { ok, fail };
}

(async () => {
  if (!SU || !SK) { console.error("Missing SUPABASE creds"); process.exit(1); }
  const t = tuningStatus();
  console.log(`[rank] tuning: artists=${t.artists} famous=${t.famous_artworks} config=${t.config}`);
  let scored = 0, failed = 0, iter = 0, lastId = null;
  while (scored < LIMIT) {
    const rows = await fetchPage(lastId);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id; // keyset cursor
    const batch = rows.slice(0, Math.min(rows.length, LIMIT - scored));
    const { ok, fail } = await pool(batch, async (a) => {
      const { commercial_score } = scoreAsset(a);
      return updateOne(a.id, commercial_score);
    });
    scored += ok; failed += fail; iter++;
    console.log(`  page ${iter}: scored ${ok}, failed ${fail} | total scored ${scored}`);
    if (rows.length < PAGE) break; // last page
  }
  console.log(`\nRANK DONE — scored ${scored}, failed ${failed}`);
})();
