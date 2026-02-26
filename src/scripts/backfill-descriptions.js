#!/usr/bin/env node
/**
 * Backfill AI Descriptions
 * ========================
 * Fills the `description` column for every asset that has AI metadata
 * (style/mood/subject/era/palette) but no description yet.
 *
 * Generates a natural-language description from the existing AI tags —
 * no OpenAI calls needed.
 *
 * Usage:
 *   node src/scripts/backfill-descriptions.js
 *   node src/scripts/backfill-descriptions.js --dry-run
 *   node src/scripts/backfill-descriptions.js --limit 1000
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1], 10) : 0;
const BATCH = 500;
const DB_CONCURRENCY = 10;

function generateDescription(asset) {
  const artist = asset.artist || "Unknown Artist";
  const style = asset.style;
  const mood = asset.mood;
  const subject = asset.subject;
  const era = asset.era;
  const palette = asset.palette;
  const an = (w) => /^[aeiou]/i.test(w) ? "An" : "A";

  const parts = [];

  if (style && subject) {
    parts.push(`${an(style)} ${style.toLowerCase()} ${subject.toLowerCase()} by ${artist}.`);
  } else if (style) {
    parts.push(`${an(style)} ${style.toLowerCase()} work by ${artist}.`);
  } else if (subject) {
    parts.push(`${an(subject)} ${subject.toLowerCase()} by ${artist}.`);
  } else {
    parts.push(`A work by ${artist}.`);
  }

  if (era && era !== "Unknown") {
    parts.push(`Created during the ${era.toLowerCase()} period.`);
  }

  if (mood && palette) {
    parts.push(`This piece evokes a ${mood.toLowerCase()} atmosphere with ${palette.toLowerCase()}.`);
  } else if (mood) {
    parts.push(`This piece evokes a ${mood.toLowerCase()} atmosphere.`);
  } else if (palette) {
    parts.push(`Featuring ${palette.toLowerCase()}.`);
  }

  parts.push("Printed on premium museum-quality archival paper with vivid, lightfast inks.");
  return parts.join(" ");
}

async function main() {
  console.log("═".repeat(60));
  console.log("  Backfill AI Descriptions");
  console.log("═".repeat(60));
  if (DRY_RUN) console.log("  🧪 DRY RUN — no writes");
  if (LIMIT) console.log(`  📏 Limit: ${LIMIT}`);

  // Count assets needing backfill (have style but no description)
  const { count: total } = await supabase
    .from("assets")
    .select("id", { count: "exact", head: true })
    .is("description", null)
    .not("style", "is", null);

  console.log(`\n  📊 Assets with AI tags but no description: ${total}\n`);

  if (total === 0) {
    console.log("  ✅ Nothing to backfill!");
    return;
  }

  const target = LIMIT > 0 ? Math.min(LIMIT, total) : total;
  let written = 0;
  let errors = 0;
  let offset = 0;
  const t0 = Date.now();

  while (written + errors < target) {
    // Fetch a batch
    const { data: batch, error } = await supabase
      .from("assets")
      .select("id, title, artist, style, mood, subject, era, palette")
      .is("description", null)
      .not("style", "is", null)
      .range(offset, offset + BATCH - 1);

    if (error) {
      console.error("  ❌ Fetch error:", error.message);
      break;
    }
    if (!batch || batch.length === 0) break;

    // Process in parallel chunks
    const updates = batch.map((asset) => ({
      id: asset.id,
      description: generateDescription(asset),
    }));

    if (DRY_RUN) {
      console.log(`  [DRY] Would update ${updates.length} assets. Sample:`);
      console.log(`    ID: ${updates[0].id}`);
      console.log(`    Desc: ${updates[0].description}\n`);
      written += updates.length;
      offset += BATCH;
      if (LIMIT > 0 && written >= LIMIT) break;
      continue;
    }

    // Write in parallel (DB_CONCURRENCY at a time)
    for (let i = 0; i < updates.length; i += DB_CONCURRENCY) {
      const chunk = updates.slice(i, i + DB_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((u) =>
          supabase
            .from("assets")
            .update({ description: u.description })
            .eq("id", u.id)
            .then((res) => {
              if (res.error) {
                errors++;
                return false;
              }
              written++;
              return true;
            })
        )
      );

      // Progress
      const elapsed = (Date.now() - t0) / 1000;
      const rate = written / elapsed;
      const eta = ((target - written - errors) / rate).toFixed(0);
      process.stdout.write(
        `\r  ✏️  ${written.toLocaleString()} / ${target.toLocaleString()} written | ${errors} errors | ${rate.toFixed(0)}/s | ETA: ${eta}s`
      );
    }

    // Don't increment offset since we're always fetching where description IS NULL
    // and we just filled them in — so next fetch returns the next batch automatically
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\n  ✅ Done! ${written.toLocaleString()} descriptions written in ${elapsed}s (${errors} errors)`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
