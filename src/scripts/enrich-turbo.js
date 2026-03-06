#!/usr/bin/env node
/**
 * enrich-turbo.js — Ultra-fast multi-process AI tag enricher v3
 * ==============================================================
 * Architecture: Workers do ONLY OpenAI API calls.
 * Master does ALL DB writes with a centralized concurrency pool.
 * This guarantees exactly N DB connections regardless of worker count.
 *
 * Usage:
 *   node src/scripts/enrich-turbo.js                 # defaults
 *   node src/scripts/enrich-turbo.js --workers=10    # 10 workers
 *   node src/scripts/enrich-turbo.js --limit=1000    # test run
 *   node src/scripts/enrich-turbo.js --dbpool=8      # 8 DB connections
 */

if (process.env.__ENRICH_WORKER__) {
  // ═══════════════════════════════════════════════════════
  // WORKER MODE — Only does OpenAI API calls, sends results to master
  // ═══════════════════════════════════════════════════════
  require("dotenv").config();
  const { createClient } = require("@supabase/supabase-js");
  const OpenAI = require("openai");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const BATCH_SIZE = 25;
  let LANES = 4; // overridden by master via IPC
  const API_TIMEOUT_MS = 120000;

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
    return `Classify well-known public domain artworks using art-historical knowledge. Do NOT guess from title alone.
Return JSON array, one object per item, same order.
Each: {"style":"...","mood":"...","subject":"...","era":"...","palette":"...","country":"...","continent":"...","tags":["t1","t2",...]}
styles:${STYLES}
moods:${MOODS}
subjects:${SUBJECTS}
eras:${ERAS}
palettes:${PALETTES}
country: artist nationality (France, Netherlands, Japan, Italy, etc)
continent: Europe, Asia, North America, South America, Africa, Oceania
tags: 8-12 SEO keywords including country name, room suggestions.
Monet=Impressionism(France), Hokusai=Ukiyo-e(Japan), Rembrandt=Baroque(Netherlands). Get it RIGHT.

${items}`;
  }

  async function callOpenAI(assets, retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Expert art historian. Classify using established art history facts. Return valid JSON array only." },
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
        const isRateLimit = err?.status === 429 || err?.code === 'rate_limit_exceeded' || (err?.message || '').includes('429');
        const errType = isRateLimit ? 'RATE_LIMIT' : err?.name === 'AbortError' ? 'TIMEOUT' : 'API_ERR';
        if (attempt === 1 || isRateLimit) {
          process.send({ type: "log", msg: `${errType}: ${(err?.message || '').slice(0, 80)} (attempt ${attempt}/${retries})` });
        }
        const jitter = Math.random() * 2000;
        const backoff = isRateLimit ? 8000 * attempt + jitter : 2000 * attempt + jitter;
        if (attempt < retries) { await sleep(backoff); continue; }
        throw err;
      }
    }
  }

  process.on("message", async (msg) => {
    if (msg.type === 'config') { LANES = msg.lanes || LANES; return; }
    const { ids } = msg;
    let apiDone = 0, apiErrors = 0;
    let batchIdx = 0;
    let lastReport = Date.now();

    // Fetch assigned assets
    const allAssets = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase
        .from("assets")
        .select("id, title, artist")
        .in("id", ids.slice(i, i + 200));
      if (error) { process.send({ type: "log", msg: `Fetch error at ${i}: ${error.message}` }); continue; }
      if (data) allAssets.push(...data);
    }

    process.send({ type: "log", msg: `Fetched ${allAssets.length}/${ids.length} assets` });

    // Pre-split into batches
    const batches = [];
    for (let i = 0; i < allAssets.length; i += BATCH_SIZE) {
      batches.push(allAssets.slice(i, i + BATCH_SIZE));
    }

    // Each lane does API calls and sends results to master for DB writing
    async function lane(laneId) {
      // Stagger lane starts to avoid thundering herd
      await sleep(laneId * 500);
      while (true) {
        const bi = batchIdx++;
        if (bi >= batches.length) break;
        const chunk = batches[bi];

        try {
          const results = await callOpenAI(chunk);
          const updates = [];
          for (let i = 0; i < Math.min(results.length, chunk.length); i++) {
            updates.push({ id: chunk[i].id, result: results[i] });
          }
          if (updates.length > 0) {
            process.send({ type: "updates", updates });
          }
          apiDone += chunk.length;
        } catch {
          apiErrors += chunk.length;
          process.send({ type: "api_errors", count: chunk.length });
        }

        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now();
          process.send({ type: "api_progress", done: apiDone, errors: apiErrors });
        }
      }
    }

    const lanes = [];
    for (let i = 0; i < LANES; i++) {
      lanes.push(lane(i));
    }
    await Promise.all(lanes);

    process.send({ type: "worker_done", apiDone, apiErrors });
  });

  process.send({ type: "ready" });

} else {
  // ═══════════════════════════════════════════════════════
  // MASTER MODE — Coordinates workers + centralized DB writer pool
  // ═══════════════════════════════════════════════════════
  require("dotenv").config();
  const { fork } = require("child_process");
  const { createClient } = require("@supabase/supabase-js");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const args = process.argv.slice(2);
  const getArg = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };
  const NUM_WORKERS = parseInt(getArg("workers") || "4", 10);
  const LIMIT = parseInt(getArg("limit") || "0", 10);
  const DB_POOL = parseInt(getArg("dbpool") || "8", 10);
  const LANES = parseInt(getArg("lanes") || "2", 10);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function main() {
    console.log("\n" + "═".repeat(60));
    console.log("⚡ NEVERLAND PRINTS — TURBO AI Tag Enricher v3");
    console.log("═".repeat(60));

    // ── Fetch untagged IDs ──
    console.log("  📋 Fetching untagged asset IDs...");
    const allIds = [];
    let offset = 0;
    const PAGE = 5000;
    while (true) {
      const t0f = Date.now();
      let data, error;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await supabase
          .from("assets")
          .select("id")
          .is("style", null)
          .order("id")
          .range(offset, offset + PAGE - 1);
        data = res.data;
        error = res.error;
        if (!error && data) break;
        console.log(`    ⚠️ Fetch error at offset ${offset} (attempt ${attempt}): ${error?.message || 'no data'}`);
        await sleep(2000 * attempt);
      }
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
    console.log(`  👷 ${actualWorkers} workers × ${LANES} lanes = ${actualWorkers * LANES} concurrent API calls`);
    console.log(`  💾 ${DB_POOL} concurrent DB writes (centralized in master)`);
    console.log(`  🎯 ETA: ~${Math.ceil(total / 15 / 60)} min (at ~15/s)`);
    console.log("═".repeat(60) + "\n");

    // ── Centralized DB write pool ──
    const dbQueue = [];
    let dbWritten = 0;
    let dbErrors = 0;
    let apiErrors = 0;
    let dbRunning = 0;
    let allWorkersDone = false;
    let dbDoneResolve;
    const dbDonePromise = new Promise(r => { dbDoneResolve = r; });

    async function writeOne(id, r) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          var tags = r.tags || [];
          if (r.country && tags.indexOf(r.country) === -1) tags.push(r.country);
          if (r.continent && tags.indexOf(r.continent) === -1) tags.push(r.continent);
          const res = await Promise.race([
            supabase.from("assets").update({
              style: r.style || null,
              mood: r.mood || null,
              subject: r.subject || null,
              era: r.era || null,
              palette: r.palette || null,
              ai_tags: tags,
            }).eq("id", id),
            sleep(10000).then(() => ({ error: { message: "timeout" } })),
          ]);
          if (!res.error) return true;
          if (attempt < 3) await sleep(300 * attempt);
        } catch {
          if (attempt < 3) await sleep(300 * attempt);
        }
      }
      return false;
    }

    function tryDrainDB() {
      while (dbRunning < DB_POOL && dbQueue.length > 0) {
        const item = dbQueue.shift();
        dbRunning++;
        writeOne(item.id, item.result).then(ok => {
          dbRunning--;
          if (ok) dbWritten++; else dbErrors++;
          // Keep draining
          if (dbQueue.length > 0 || dbRunning < DB_POOL) tryDrainDB();
          // Check if all done
          if (allWorkersDone && dbQueue.length === 0 && dbRunning === 0) {
            dbDoneResolve();
          }
        });
      }
    }

    // ── Status display ──
    const t0 = Date.now();
    let doneWorkers = 0;

    function printStatus() {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (dbWritten / (elapsed || 1)).toFixed(1);
      const processed = dbWritten + dbErrors + apiErrors;
      const remaining = total - processed;
      const eta = rate > 0 ? Math.ceil(remaining / rate / 60) : "?";
      const qLen = dbQueue.length;
      process.stdout.write(
        `\r  ⚡ ${processed}/${total} | ${dbWritten} tagged | ${dbErrors + apiErrors} err | ${rate}/s | ${elapsed}s | Q:${qLen} | ETA: ${eta}min  `
      );
    }

    const interval = setInterval(printStatus, 3000);

    // ── Launch workers ──
    const workerPromises = workerChunks.map((chunk, i) => {
      return new Promise((resolve) => {
        const child = fork(__filename, [], {
          env: { ...process.env, __ENRICH_WORKER__: "1" },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        child.stderr.on("data", () => {});

        child.on("message", msg => {
          if (msg.type === "ready") {
            child.send({ type: 'config', lanes: LANES });
            child.send({ ids: chunk });
          } else if (msg.type === "log") {
            console.log(`\n  [W${i}] ${msg.msg}`);
          } else if (msg.type === "updates") {
            dbQueue.push(...msg.updates);
            tryDrainDB();
          } else if (msg.type === "api_errors") {
            apiErrors += msg.count;
          } else if (msg.type === "worker_done") {
            doneWorkers++;
            resolve();
          }
        });

        child.on("error", () => resolve());
        child.on("exit", () => resolve());
      });
    });

    await Promise.all(workerPromises);
    allWorkersDone = true;

    // Drain remaining DB queue
    if (dbQueue.length > 0 || dbRunning > 0) {
      tryDrainDB();
      await dbDonePromise;
    }

    clearInterval(interval);
    printStatus();

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
    const rateF = (dbWritten / (totalTime || 1)).toFixed(1);
    console.log("\n\n" + "═".repeat(60));
    console.log(`✅ TURBO enrichment complete!`);
    console.log(`   Tagged: ${dbWritten} | DB Errors: ${dbErrors} | API Errors: ${apiErrors} | Time: ${totalTime}s (${(totalTime / 60).toFixed(1)} min)`);
    console.log(`   Throughput: ${rateF} items/s`);
    console.log("═".repeat(60) + "\n");
  }

  main().catch(e => { console.error("💥", e); process.exit(1); });
}
