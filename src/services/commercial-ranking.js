/**
 * commercial-ranking.js — server-side port of rank_artworks_4.py's scoring.
 * ============================================================================
 * The client's local Python (qwen3-vl via Ollama) ranked a text list of titles
 * by commercial/POD appeal. This runs the SAME idea against our LIVE Supabase
 * `assets` catalog instead — and, crucially, it needs NO local model and NO
 * Wikimedia lookup, because ingestion already stored per-asset AI metadata
 * (subject, style, mood, era, palette, ai_tags, artist, dimensions, quality).
 * So the qwen "identification" pass is already done; we reuse it.
 *
 * What we compute (0..1 each, then a weighted blend → commercial_score 0..1):
 *   - subject_commercial   : how sellable the subject is (priors), from the
 *                            stored `subject`/`ai_tags` first, title regex as backup.
 *   - decor_appeal         : mood/palette heuristic (warm/serene/vibrant sell).
 *   - product_versatility  : aspect ratio + resolution + quality_tier (print-readiness).
 *   - artist_recognition   : optional, needs artists.json (else 0).
 *   - famous_work          : optional, needs famous_artworks.json (else 0).
 *   - technical_penalty    : down-weights studies/diagrams/anatomy plates.
 *
 * VISION (optional, injectable later — matches the client's brief): a cloud
 * vision pass can later fill a `visual_commercial_appeal` term; the weights
 * already leave room for it. Until then its weight is redistributed.
 *
 * External tuning (all optional, hand-editable, same spirit as the Python):
 *   ranking/config.json, ranking/artists.json, ranking/famous_artworks.json,
 *   ranking/collection_profiles.json — loaded if present, sane defaults if not.
 */
const fs = require("fs");
const path = require("path");

const RANKING_DIR = path.join(__dirname, "..", "..", "ranking");

// ── Subject taxonomy (ported subset of the Python SUBJECT_PATTERNS) ─────────
// We key primarily off the stored AI `subject`/`ai_tags`, and fall back to
// title regex only when metadata is thin.
const SUBJECT_PATTERNS = {
  female_portrait: [/young woman/i, /young lady/i, /\blady\b/i, /\bwoman\b/i, /\bgirl\b/i, /maiden/i],
  male_portrait: [/portrait of a man/i, /portrait of a gentleman/i, /\byoung man\b/i, /self[- ]portrait/i],
  romance: [/lovers?\b/i, /amorous/i, /courtship/i, /wedding/i, /\bbride\b/i, /\bcouple\b/i, /embrace/i],
  motherhood: [/madonna/i, /mother and child/i, /maternal/i],
  family: [/\bfamily\b/i, /\bchildren\b/i, /\bchild\b/i],
  flowers: [/\bflowers?\b/i, /floral/i, /\brose/i, /tulip/i, /bouquet/i, /blossom/i],
  botanical: [/botanical/i, /\bbotany\b/i, /herbarium/i, /\bplant(s)?\b/i],
  landscape: [/landscape/i, /\bvalley\b/i, /\bmeadow\b/i, /\bforest\b/i, /\bcountryside\b/i, /pastoral/i],
  mountains: [/\bmountain/i, /\balps?\b/i, /\bpeak(s)?\b/i],
  coastal: [/\bcoast/i, /\bharbou?r\b/i, /\bbeach\b/i, /\bshore\b/i, /\bcliffs?\b/i],
  water: [/\bwater\b/i, /waterfall/i, /\bwaves?\b/i, /\bfountain\b/i],
  river: [/\briver\b/i, /\bstream\b/i, /\bcanal\b/i],
  lake: [/\blake\b/i, /\blagoon\b/i],
  architecture: [/\bcastle\b/i, /\bpalace\b/i, /\bcathedral\b/i, /\bchurch\b/i, /\btemple\b/i, /\bruins?\b/i, /\bbridge\b/i],
  venice: [/\bvenice\b/i, /\bvenezia\b/i, /\bgondola\b/i, /san marco/i],
  rome: [/\brome\b/i, /colosseum/i, /\bpantheon\b/i],
  paris: [/\bparis\b/i, /\bmontmartre\b/i, /seine\b/i],
  mythology: [/\bvenus\b/i, /\bcupid\b/i, /\bapollo\b/i, /\bdiana\b/i, /\bnymph/i, /\bsatyr/i, /\bmyth/i, /medusa/i, /pegasus/i, /\bleda\b/i],
  religious: [/madonna/i, /\bvirgin\b/i, /annunciation/i, /adoration/i, /\bchrist\b/i, /\bsaint\b/i, /nativity/i, /crucifixion/i],
  angel: [/\bangel/i, /\bcherub/i],
  animal: [/\bhorses?\b/i, /\bbirds?\b/i, /\bdogs?\b/i, /\bcats?\b/i, /\blions?\b/i, /\bdeer\b/i, /\bstag\b/i],
  horse: [/\bhorses?\b/i, /\bequestrian\b/i, /\bstallion\b/i],
  bird: [/\bbirds?\b/i, /\bswans?\b/i, /\bdoves?\b/i, /\bpeacocks?\b/i],
  still_life: [/still life/i, /\bvase\b/i, /\bjugs?\b/i],
  fruit: [/\bfruits?\b/i, /\bapples?\b/i, /\bgrapes?\b/i],
  historical: [/\bnapoleon\b/i, /\bemperor\b/i, /\bking\b/i, /\bqueen\b/i, /\bduke\b/i, /coronation/i],
  military: [/\bbattle\b/i, /\bwar\b/i, /\bsoldiers?\b/i, /\bcavalry\b/i, /\barmou?r\b/i],
  fantasy: [/\bdragon/i, /\bunicorn\b/i, /\bphantom\b/i, /\bghost\b/i, /\bsphinx\b/i, /\bgriffin\b/i, /\bsiren\b/i],
  fairytale: [/\bfairy/i, /fairytale/i, /\bwitch\b/i, /\bmermaid\b/i, /\bknight\b/i],
  decorative: [/\bornament/i, /arabesques?/i, /\bfrieze\b/i, /decorative/i],
  technical: [/perspect/i, /\bprojection\b/i, /\bproportions?\b/i, /architectural (design|plan)/i, /\belevation\b/i, /\bgeometr/i],
  anatomy: [/\banatom/i, /nude study/i, /studies? of hands?/i, /\bskull\b/i, /ecorche/i],
  academic_study: [/\bstudy\b/i, /\bstudies\b/i, /\bsketch\b/i, /\bfragment\b/i, /\bpreparatory\b/i],
};

// Categories that should only count as a "study/plate", not a finished work.
const CONTEXT_GATED = {
  anatomy: /\b(study|studies|sketch|anatomical|anatomy)\b/i,
  technical: /\b(study|studies|design|drawing|projection|perspective|plans?|construction|proportions?|architectural)\b/i,
  decorative: /\b(plate|ornament|arabesques?|design for|frieze)\b/i,
  academic_study: /\b(study|studies|sketch|fragment|preparatory|sheet)\b/i,
};

const DECOR_HEAVY = new Set(["flowers", "botanical", "romance", "landscape", "venice", "paris", "coastal", "animal", "horse", "bird", "still_life", "female_portrait", "mountains", "lake", "river"]);
const NICHE = new Set(["military", "technical", "anatomy", "academic_study", "decorative", "male_portrait"]);

// Default per-category commercial priors (0..1). Overridable via config.json.
const DEFAULT_PRIORS = {
  female_portrait: 0.72, male_portrait: 0.42, romance: 0.78, motherhood: 0.6, family: 0.58,
  flowers: 0.9, botanical: 0.82, landscape: 0.85, mountains: 0.8, coastal: 0.83, water: 0.7,
  river: 0.68, lake: 0.72, architecture: 0.66, venice: 0.86, rome: 0.7, paris: 0.8,
  mythology: 0.62, religious: 0.5, angel: 0.6, animal: 0.78, horse: 0.74, bird: 0.76,
  still_life: 0.7, fruit: 0.62, historical: 0.55, military: 0.4, fantasy: 0.72, fairytale: 0.7,
  decorative: 0.5, technical: 0.22, anatomy: 0.25, academic_study: 0.3,
};

const DEFAULT_WEIGHTS = {
  visual_commercial_appeal: 0.0, // reserved for optional vision (redistributed until then)
  subject_commercial: 0.34,
  decor_appeal: 0.24,
  product_versatility: 0.16,
  artist_recognition: 0.14,
  famous_work: 0.08,
  emotional_appeal: 0.04,
};

// Mood/palette → decor-appeal heuristic. Warm/serene/vibrant read as sellable;
// dark/somber/clinical read lower. Values 0..1.
const MOOD_APPEAL = {
  warm: 0.85, serene: 0.85, peaceful: 0.85, tranquil: 0.82, romantic: 0.85, dreamy: 0.82,
  joyful: 0.85, vibrant: 0.82, elegant: 0.8, luminous: 0.82, cheerful: 0.82, calm: 0.8,
  nostalgic: 0.7, mysterious: 0.66, dramatic: 0.62, melancholic: 0.5, somber: 0.42,
  dark: 0.42, tense: 0.4, chaotic: 0.4, clinical: 0.3,
};
const PALETTE_APPEAL = {
  "warm earth tones": 0.82, pastel: 0.85, "soft pastel": 0.85, vibrant: 0.82, "jewel tones": 0.8,
  "cool blues": 0.78, verdant: 0.78, golden: 0.82, monochrome: 0.55, muted: 0.6, "high contrast": 0.66,
  dark: 0.45, sepia: 0.55,
};

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ── Optional external tuning DBs (client's hand-tuned files) ────────────────
function loadJson(file) {
  try {
    const p = path.join(RANKING_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { return null; }
}

let _cfg = null;
function config() {
  if (_cfg) return _cfg;
  const raw = loadJson("config.json") || {};
  _cfg = {
    weights: { ...DEFAULT_WEIGHTS, ...(raw.weights || {}) },
    priors: { ...DEFAULT_PRIORS, ...(raw.subject_priors || raw.priors || {}) },
  };
  // If no vision weight is in use, redistribute it across the other weights.
  const w = _cfg.weights;
  if (!w.visual_commercial_appeal) {
    const others = Object.keys(w).filter((k) => k !== "visual_commercial_appeal");
    const sum = others.reduce((s, k) => s + w[k], 0) || 1;
    others.forEach((k) => (w[k] = w[k] / sum));
    w.visual_commercial_appeal = 0;
  }
  return _cfg;
}

// artists.json: [{ name, aliases?, recognition (0..1), commercial_appeal? }]
let _artists = null;
function artistIndex() {
  if (_artists) return _artists;
  _artists = new Map();
  const recs = loadJson("artists.json") || [];
  for (const r of recs) {
    const names = [r.name, ...(r.aliases || [])].filter(Boolean);
    for (const n of names) _artists.set(String(n).toLowerCase().trim(), r);
  }
  return _artists;
}

// famous_artworks.json: [{ title, aliases?, recognition, commercial_strength?, artist? }]
let _famous = null;
function famousIndex() {
  if (_famous) return _famous;
  _famous = [];
  const recs = loadJson("famous_artworks.json") || [];
  for (const r of recs) {
    const titles = [r.title, ...(r.aliases || [])].filter(Boolean).map((t) => String(t).toLowerCase());
    _famous.push({ rec: r, titles });
  }
  return _famous;
}

function norm(text) {
  return String(text || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

// ── Component scorers ───────────────────────────────────────────────────────
function classifySubjects(asset) {
  const title = norm(asset.title);
  // Seed hits from stored AI metadata (already a strong classifier).
  const metaText = norm([asset.subject, asset.style, asset.mood, ...(Array.isArray(asset.ai_tags) ? asset.ai_tags : [])].join(" "));
  const hits = {};
  for (const [cat, pats] of Object.entries(SUBJECT_PATTERNS)) {
    let n = 0;
    for (const p of pats) { if (p.test(title) || p.test(metaText)) n++; }
    if (CONTEXT_GATED[cat] && n && !CONTEXT_GATED[cat].test(title) && !CONTEXT_GATED[cat].test(metaText)) n = 0;
    if (n) hits[cat] = Math.min(n, 1); // cap repeat-keyword weight at 1 (Python requirement 8)
  }
  // technical/academic penalty
  let penalty = 0;
  if (hits.technical) penalty += 0.35;
  if (hits.anatomy) penalty += 0.3;
  if (hits.decorative) penalty += 0.2;
  if (hits.academic_study && !Object.keys(hits).some((k) => DECOR_HEAVY.has(k))) penalty += 0.15;
  penalty = Math.min(0.75, penalty);
  return { hits, penalty };
}

function subjectCommercial(hits, priors) {
  const cats = Object.keys(hits);
  if (!cats.length) return 0.4;
  const total = cats.reduce((s, c) => s + hits[c], 0);
  const weighted = cats.reduce((s, c) => s + (priors[c] != null ? priors[c] : 0.5) * hits[c], 0);
  const base = total ? weighted / total : 0.5;
  // compress toward neutral so one keyword can't dominate (Python compression=0.82)
  return clamp01(0.5 + (base - 0.5) * 0.82);
}

function decorAppeal(asset, subjScore) {
  const mood = norm(asset.mood);
  const palette = norm(asset.palette);
  let m = MOOD_APPEAL[mood];
  let p = PALETTE_APPEAL[palette];
  // partial matches (e.g. "warm earth tones" contains "warm")
  if (m == null) { for (const k in MOOD_APPEAL) if (mood.includes(k)) { m = MOOD_APPEAL[k]; break; } }
  if (p == null) { for (const k in PALETTE_APPEAL) if (palette.includes(k)) { p = PALETTE_APPEAL[k]; break; } }
  const parts = [];
  if (m != null) parts.push(m);
  if (p != null) parts.push(p);
  // Blend mood/palette with the subject signal so decor isn't mood-only.
  const moodPalette = parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : 0.6;
  return clamp01(0.55 * moodPalette + 0.45 * (0.3 + 0.55 * subjScore));
}

function productVersatility(asset, hits) {
  let base = 0.5;
  const ar = Number(asset.aspect_ratio) || (asset.width_px && asset.height_px ? asset.width_px / asset.height_px : 1);
  // near-standard frame ratios are most versatile
  if (ar >= 0.6 && ar <= 1.8) base += 0.15;
  else if (ar >= 0.4 && ar <= 2.5) base += 0.05;
  else base -= 0.1;
  if ((asset.width_px || 0) >= 3000 && (asset.height_px || 0) >= 3000) base += 0.12;
  else if ((asset.width_px || 0) >= 1500 && (asset.height_px || 0) >= 1500) base += 0.06;
  const qt = norm(asset.quality_tier);
  if (qt === "high") base += 0.08; else if (qt === "low") base -= 0.08;
  const cats = new Set(Object.keys(hits));
  if ([...cats].some((c) => NICHE.has(c))) base -= 0.1;
  if ([...cats].some((c) => DECOR_HEAVY.has(c))) base += 0.08;
  return clamp01(base);
}

function matchArtist(asset) {
  const idx = artistIndex();
  if (!idx.size) return { strength: 0, recognition: 0, commercial: 0.5, name: "" };
  const a = norm(asset.artist);
  let rec = a && idx.get(a);
  if (!rec && a) { // token contains a known artist surname
    for (const [name, r] of idx) { if (a.includes(name)) { rec = r; break; } }
  }
  if (!rec) return { strength: 0, recognition: 0, commercial: 0.5, name: "" };
  return {
    strength: 0.85,
    recognition: clamp01(Number(rec.recognition) || 0),
    commercial: rec.commercial_appeal != null ? clamp01(Number(rec.commercial_appeal)) : 0.5,
    name: rec.name || asset.artist,
  };
}

function matchFamous(asset) {
  const list = famousIndex();
  if (!list.length) return { strength: 0, recognition: 0, commercial: 0 };
  const title = norm(asset.title);
  for (const { rec, titles } of list) {
    for (const t of titles) {
      if (t.length >= 4 && title.includes(t)) {
        const recg = clamp01(Number(rec.recognition) || 0.6);
        const comm = rec.commercial_strength != null ? clamp01(Number(rec.commercial_strength)) : recg;
        return { strength: 0.55, recognition: recg, commercial: comm };
      }
    }
  }
  return { strength: 0, recognition: 0, commercial: 0 };
}

/**
 * Score a single asset row → { commercial_score, breakdown }.
 * `visualAppeal` (0..1) is an optional injected vision score; when provided and
 * config gives it weight, it's blended in.
 */
function scoreAsset(asset, visualAppeal = null) {
  const cfg = config();
  const { hits, penalty } = classifySubjects(asset);
  const subj = subjectCommercial(hits, cfg.priors);
  const decor = decorAppeal(asset, subj);
  const versatility = productVersatility(asset, hits);
  const artist = matchArtist(asset);
  const famous = matchFamous(asset);
  const emotional = clamp01(0.35 + 0.4 * subj);

  const artistTerm = artist.strength * artist.recognition * (penalty > 0 ? Math.max(0.3, 1 - penalty) : 1);
  const famousTerm = famous.strength * famous.commercial;

  const w = cfg.weights;
  let score =
    w.subject_commercial * subj +
    w.decor_appeal * decor +
    w.product_versatility * versatility +
    w.artist_recognition * artistTerm +
    w.famous_work * famousTerm +
    w.emotional_appeal * emotional;

  if (visualAppeal != null && w.visual_commercial_appeal > 0) {
    score = score * (1 - w.visual_commercial_appeal) + w.visual_commercial_appeal * clamp01(visualAppeal);
  }

  // direct technical penalty so a genuine study can't ride an unrelated keyword up
  score = clamp01(score - 0.3 * penalty);

  // small iconic bonuses
  if (artist.recognition >= 0.8 && famous.strength >= 0.5) score = clamp01(score + 0.05 * artist.commercial);
  if (famous.strength >= 0.5 && famous.recognition >= 0.7) score = clamp01(score + 0.05);

  return {
    commercial_score: Math.round(score * 10000) / 10000,
    breakdown: {
      subject: Math.round(subj * 1000) / 1000,
      decor: Math.round(decor * 1000) / 1000,
      versatility: Math.round(versatility * 1000) / 1000,
      artist: Math.round(artistTerm * 1000) / 1000,
      famous: Math.round(famousTerm * 1000) / 1000,
      penalty: Math.round(penalty * 1000) / 1000,
      primary_subject: Object.keys(hits).sort((a, b) => hits[b] - hits[a])[0] || "unclassified",
      artist_name: artist.name,
    },
  };
}

function tuningStatus() {
  return {
    config: !!loadJson("config.json"),
    artists: (loadJson("artists.json") || []).length,
    famous_artworks: (loadJson("famous_artworks.json") || []).length,
    collection_profiles: !!loadJson("collection_profiles.json"),
    weights: config().weights,
  };
}

module.exports = { scoreAsset, tuningStatus, RANKING_DIR };
