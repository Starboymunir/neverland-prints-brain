#!/usr/bin/env node
/**
 * enrich-turbo.js — Ultra-fast multi-process AI tag enricher
 * ===========================================================
 * Uses a streaming concurrency pool (no wave blocking) with
 * multiple worker processes for maximum throughput.
 *
 * Usage:
 *   node src/scripts/enrich-turbo.js                 # 10 workers (default)
 *   node src/scripts/enrich-turbo.js --workers=12    # 12 workers
 *   node src/scripts/enrich-turbo.js --limit=1000    # test run
 */

if (process.env.__ENRICH_WORKER__) {
  // ═══════════════════════════════════════════════════════
  // WORKER MODE
  // ═══════════════════════════════════════════════════════
  require("dotenv").config();
  const { createClient } = require("@supabase/supabase-js");
  const OpenAI = require("openai");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const BATCH_SIZE = 25;
  const LANES = 8;            // concurrent API calls per worker (streaming)
  const API_TIMEOUT_MS = 120000;
  const DB_BATCH = 25;        // sequential DB writes per flush cycle

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const STYLES = "Impressionism,Post-Impressionism,Realism,Romanticism,Baroque,Renaissance,Art Nouveau,Art Deco,Expressionism,Abstract,Cubism,Surrealism,Symbolism,Minimalism,Ukiyo-e,Folk Art,Gothic,Neoclassicism,Rococo,Fauvism,Modernism,Naturalism,Pre-Raphaelite,Pop Art,Naive Art,Watercolor,Engraving,Photography,Other";
  const MOODS = "Serene,Dramatic,Melancholic,Joyful,Mysterious,Romantic,Dark,Whimsical,Contemplative,Vibrant,Peaceful,Ethereal,Nostalgic,Powerful,Elegant,Warm";
  const SUBJECTS = "Landscape,Portrait,Still Life,Seascape,Cityscape,Abstract,Mythology,Religious,Botanical,Animal,Figure Study,Architecture,Genre Scene,Allegory,Nude,Fantasy,Nature,Rural Life,Night Scene,Decorative";
  const ERAS = "Ancient,Medieval,15th Century,16th Century,17th Century,18th Century,Early 19th Century,Late 19th Century,Early 20th Century,Mid 20th Century,Late 20th Century,Contemporary,Unknown";
  const PALETTES = "Warm Earth Tones,Cool Blues,Vibrant Multi-Color,Muted Pastels,Monochrome,Gold & Ochre,Dark & Moody,Light & Airy,Rich Jewel Tones,Black & White,Sepia,Green & Natural";

  function buildPrompt(assets) {
    const items = assets.map((a, i) =>
      `${i}:"${a.title}" by ${a.artist || "?"}`
    ).join("\n");
    return `Classify each artwork. Return JSON array, one object per item, same order.
Each: {"style":"...","mood":"...","subject":"...","era":"...","palette":"...","tags":["t1","t2",...]}
styles:${STYLES}
moods:${MOODS}
subjects:${SUBJECTS}
eras:${ERAS}
palettes:${PALETTES}
tags: 5-8 SEO keywords.

${items}`;
  }

  async function callOpenAI(assets, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Art classification bot. Return valid JSON array only." },
            { role: "user", content: buildPrompt(assets) },
          ],
          temperature: 0.2,
          max_tokens: 8000,
          response_format: { type: "json_object" },
        }, { signal: controller.signal });
        clearTimeout(timer);

        let parsed = JSON.parse(response.choices[0].message.content);
        if (!Array.isArray(parsed)) {
          const arr = Object.values(parsed).find(v => Array.isArray(v));
          if (arr) parsed = arr;
          else throw new Error("Not array");
        }
        return parsed;
      } catch (err) {
        if (attempt < retries) { await sleep(1000 * attempt); continue; }
        throw err;
      }
    }
  }

  // ── Streaming pool: each lane grabs next batch immediately ──
  process.on("message", async ({ ids }) => {
    let tagged = 0, errors = 0;
    let batchIdx = 0;
    let lastReport = Date.now();

    // Fetch all assigned assets (small chunks to avoid URL length limits)
    const allAssets = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase
        .from("assets")
        .select("id, title, artist")
        .in("id", ids.slice(i, i + 200));
      if (error) { process.send({ type: "progress", tagged: 0, errors: 0, log: `Fetch error at ${i}: ${error.message}` }); continue; }
      if (data) allAssets.push(...data);
    }

    process.send({ type: "progress", tagged: 0, errors: 0, log: `Fetched ${allAssets.length}/${ids.length} assets` });

    // Pre-split into batches
    const batches = [];
    for (let i = 0; i < allAssets.length; i += BATCH_SIZE) {
      batches.push(allAssets.slice(i, i + BATCH_SIZE));
    }

    // Pending DB updates buffer + mutex
    const pendingUpdates = [];
    let flushing = false;

    async function writeOne(id, r, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const writePromise = supabase.from("assets").update({
            style: r.style || null,
            mood: r.mood || null,
            subject: r.subject || null,
            era: r.era || null,
            palette: r.palette || null,
            ai_tags: r.tags || [],
          }).eq("id", id);
          const result = await Promise.race([
            writePromise,
            sleep(15000).then(() => ({ error: { message: 'timeout' } }))
          ]);
          if (!result.error) return true;
          if (attempt < retries) await sleep(300 * attempt);
        } catch {
          if (attempt < retries) await sleep(300 * attempt);
        }
      }
      return false;
    }

    async function flushDB() {
      if (flushing) return; // only one flush at a time
      flushing = true;
      try {
        while (pendingUpdates.length > 0) {
          const batch = pendingUpdates.splice(0, DB_BATCH);
          const results = await Promise.allSettled(
            batch.map(({ id, result: r }) => writeOne(id, r))
          );
          for (const res of results) {
            if (res.status === "fulfilled" && res.value === true) tagged++;
            else errors++;
          }
        }
      } finally {
        flushing = false;
      }
    }

    // Each "lane" is an independent async loop — no wave blocking!
    async function lane() {
      while (true) {
        const bi = batchIdx++;
        if (bi >= batches.length) break;
        const chunk = batches[bi];

        try {
          const results = await callOpenAI(chunk);
          for (let i = 0; i < Math.min(results.length, chunk.length); i++) {
            pendingUpdates.push({ id: chunk[i].id, result: results[i] });
          }
        } catch {
          errors += chunk.length;
        }

        // Flush DB frequently to avoid large final flush
        if (pendingUpdates.length >= 25) {
          await flushDB();
        }

        // Report progress every 5s
        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now();
          process.send({ type: "progress", tagged, errors });
        }
      }
    }

    // Launch all lanes (streaming — no wave blocking!)
    const lanes = [];
    for (let i = 0; i < LANES; i++) {
      lanes.push(lane());
    }
    await Promise.all(lanes);

    // Final DB flush — force it even if mutex was held
    flushing = false;
    await flushDB();

    process.send({ type: "done", tagged, errors });
  });

  process.send({ type: "ready" });

} else {
  // ═══════════════════════════════════════════════════════
  // MASTER MODE
  // ═══════════════════════════════════════════════════════
  require("dotenv").config();
  const { fork } = require("child_process");
  const { createClient } = require("@supabase/supabase-js");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const args = process.argv.slice(2);
  const getArg = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
  const NUM_WORKERS = parseInt(getArg("workers") || "10", 10);
  const LIMIT = parseInt(getArg("limit") || "0", 10);

  async function main() {
    console.log("\n" + "═".repeat(60));
    console.log("⚡ NEVERLAND PRINTS — TURBO AI Tag Enricher v2");
    console.log("═".repeat(60));

    console.log("  📋 Fetching untagged asset IDs...");
    const allIds = [];
    let offset = 0;
    const PAGE = 5000;
    while (true) {
      const t0f = Date.now();
      const { data, error } = await supabase
        .from("assets")
        .select("id")
        .is("style", null)
        .order("id")
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allIds.push(...data.map(d => d.id));
      offset += data.length;
      console.log(`    ... fetched ${allIds.length} IDs (${Date.now() - t0f}ms)`);
      if (LIMIT > 0 && allIds.length >= LIMIT) break;
    }

    const ids = LIMIT > 0 ? allIds.slice(0, LIMIT) : allIds;
    const total = ids.length;

    if (total === 0) {
      console.log("  ✅ All assets already tagged!");
      return;
    }

    const chunkSize = Math.ceil(total / NUM_WORKERS);
    const workerChunks = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
      const c = ids.slice(i * chunkSize, (i + 1) * chunkSize);
      if (c.length > 0) workerChunks.push(c);
    }

    const actualWorkers = workerChunks.length;
    console.log(`  📦 ${total} untagged assets`);
    console.log(`  👷 ${actualWorkers} workers × ${8} lanes × 25/batch = ${actualWorkers * 8} concurrent API calls`);
    console.log(`  🎯 ETA: ~${Math.ceil(total / 30 / 60)} min (at ~30/s)`);
    console.log("═".repeat(60) + "\n");

    const t0 = Date.now();
    let totalTagged = 0;
    let totalErrors = 0;
    let doneWorkers = 0;

    function printStatus() {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (totalTagged / (elapsed || 1)).toFixed(1);
      const remaining = total - totalTagged - totalErrors;
      const eta = rate > 0 ? Math.ceil(remaining / rate / 60) : "?";
      process.stdout.write(
        `\r  ⚡ ${totalTagged + totalErrors}/${total} | ${totalTagged} tagged | ${totalErrors} err | ${rate}/s | ${elapsed}s | ETA: ${eta}min  `
      );
    }

    const interval = setInterval(printStatus, 3000);

    const workerPromises = workerChunks.map((chunk, i) => {
      return new Promise((resolve) => {
        const child = fork(__filename, [], {
          env: { ...process.env, __ENRICH_WORKER__: "1" },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        child.stderr.on("data", () => {});

        child.on("message", msg => {
          if (msg.type === "ready") {
            child.send({ ids: chunk });
          } else if (msg.type === "progress") {
            if (msg.log) console.log(`\n  [W${i}] ${msg.log}`);
            const prevTagged = child._lastTagged || 0;
            const prevErrors = child._lastErrors || 0;
            totalTagged += msg.tagged - prevTagged;
            totalErrors += msg.errors - prevErrors;
            child._lastTagged = msg.tagged;
            child._lastErrors = msg.errors;
          } else if (msg.type === "done") {
            const prevTagged = child._lastTagged || 0;
            const prevErrors = child._lastErrors || 0;
            totalTagged += msg.tagged - prevTagged;
            totalErrors += msg.errors - prevErrors;
            doneWorkers++;
            resolve();
          }
        });

        child.on("error", () => resolve());
        child.on("exit", () => {
          if (doneWorkers <= i) resolve();
        });
      });
    });

    await Promise.all(workerPromises);
    clearInterval(interval);
    printStatus();

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
    const rateF = (totalTagged / (totalTime || 1)).toFixed(1);
    console.log("\n\n" + "═".repeat(60));
    console.log(`✅ TURBO enrichment complete!`);
    console.log(`   Tagged: ${totalTagged} | Errors: ${totalErrors} | Time: ${totalTime}s (${(totalTime / 60).toFixed(1)} min)`);
    console.log(`   Throughput: ${rateF} items/s`);
    console.log("═".repeat(60) + "\n");
  }

  main().catch(e => { console.error("💥", e); process.exit(1); });
}
