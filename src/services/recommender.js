/**
 * recommender.js — anonymous personalization for the homepage.
 * ============================================================================
 * Builds a lightweight, recency-weighted TASTE PROFILE from a visitor's own
 * events (views / clicks / cart adds), then RE-RANKS strong products using the
 * commercial_score baseline — it never replaces the ranking, only nudges it,
 * with bounded adjustments and diversity so one view can't redefine the page.
 *
 *   personalized = commercial_score
 *                  + subject/style fit  + artist fit  + mood/palette fit
 *                  + format/price fit
 *                  - repetition penalty        (all bounded; see MAX_DELTA)
 *
 * No names/emails/IPs are used — only the anonymous visitor_id and the coarse
 * taste signals below. Cold-start (no history) falls back to top commercial
 * score with subject diversity. Bots are excluded by the caller.
 */

// How much personalization may move a product from its commercial baseline.
// Small on purpose: preserves the quality ranking, avoids filter-bubble whiplash.
const MAX_DELTA = 0.28;

// Event value weights (a purchase says far more than a passing view).
const EVENT_WEIGHT = { purchase: 6, add_to_cart: 4, click: 1.5, view: 1, impression: 0.15, search: 0.5 };

// Recency: an event's weight halves every HALF_LIFE_DAYS.
const HALF_LIFE_DAYS = 10;

function recencyFactor(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  if (!isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function bump(map, key, amount) {
  if (key == null || key === "" || key === "Unknown") return;
  const k = String(key);
  map[k] = (map[k] || 0) + amount;
}

function topKeys(map, n) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

function priceBand(price) {
  const p = Number(price) || 0;
  if (p < 40) return "budget";
  if (p < 90) return "mid";
  if (p < 180) return "premium";
  return "statement";
}

// Deterministic 0..1 hash of a string (FNV-1a). Same input → same output, so a
// given (asset, seed) pair is stable within a rotation window but reshuffles
// when the seed changes.
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000000) / 1000000;
}

// A rotation seed that changes over time (default every 30 min) and per visitor,
// so the "feed" feels alive — the same strong pool reorders between visits/refreshes
// instead of showing the identical order forever. Pass a stable string (e.g. a
// module name) so different shelves rotate independently.
function rotationSeed(visitorOrSession, salt = "", windowMs = 30 * 60 * 1000) {
  const bucket = Math.floor(Date.now() / windowMs);
  return `${visitorOrSession || "anon"}:${salt}:${bucket}`;
}

/**
 * Build a taste profile from events joined to their asset metadata.
 * @param events  [{event_type, product_id, created_at, search_query}] newest-first
 * @param assetByProductId  Map shopify_product_id(string) -> asset row
 */
function buildProfile(events, assetByProductId) {
  const subjects = {}, styles = {}, moods = {}, artists = {}, palettes = {}, orientations = {}, bands = {}, eras = {};
  const seenAssetIds = new Set();       // assets already engaged with (don't recommend back)
  const viewedOrder = [];                // asset ids in recency order (for "recently viewed")
  let signalCount = 0;

  for (const e of events) {
    const w = (EVENT_WEIGHT[e.event_type] || 0) * recencyFactor(e.created_at);
    if (w <= 0) continue;
    const a = e.product_id != null ? assetByProductId.get(String(e.product_id)) : null;
    if (!a) continue;
    signalCount += w;
    if (a.id) {
      seenAssetIds.add(a.id);
      if ((e.event_type === "view" || e.event_type === "click") && !viewedOrder.includes(a.id)) viewedOrder.push(a.id);
    }
    bump(subjects, a.subject, w);
    bump(styles, a.style, w);
    bump(moods, a.mood, w);
    bump(artists, a.artist, w);
    bump(palettes, a.palette, w);
    bump(orientations, a.ratio_class, w);
    bump(eras, a.era, w);
    bump(bands, priceBand(a._price), w);
  }

  const norm = (m) => { const t = Object.values(m).reduce((s, x) => s + x, 0) || 1; const o = {}; for (const k in m) o[k] = m[k] / t; return o; };
  return {
    subjects: norm(subjects), styles: norm(styles), moods: norm(moods), artists: norm(artists),
    palettes: norm(palettes), orientations: norm(orientations), eras: norm(eras), bands: norm(bands),
    topSubjects: topKeys(subjects, 4), topStyles: topKeys(styles, 3), topArtists: topKeys(artists, 4),
    seenAssetIds, viewedOrder, signalCount,
    hasHistory: signalCount >= 1 && Object.keys(subjects).length > 0,
  };
}

/**
 * Personalized re-rank score for a candidate asset given a profile.
 * Baseline is commercial_score; fit terms are bounded to ±MAX_DELTA total.
 */
function personalizedScore(asset, profile, opts = {}) {
  const base = asset.commercial_score != null ? Number(asset.commercial_score) : 0.4;
  let delta = 0;
  delta += 0.35 * (profile.subjects[asset.subject] || 0);
  delta += 0.18 * (profile.styles[asset.style] || 0);
  delta += 0.16 * (profile.moods[asset.mood] || 0);
  delta += 0.22 * (profile.artists[asset.artist] || 0);
  delta += 0.10 * (profile.palettes[asset.palette] || 0);
  delta += 0.08 * (profile.orientations[asset.ratio_class] || 0);
  delta += 0.06 * (profile.bands[priceBand(asset._price)] || 0);

  // Repetition penalty: if this subject already dominates the current module,
  // damp it so the visitor doesn't get an endless wall of the same theme.
  const shownOfSubject = opts.shownSubjectCounts ? opts.shownSubjectCounts[asset.subject] || 0 : 0;
  delta -= Math.min(0.12, 0.04 * shownOfSubject);

  delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
  let score = base + delta;

  // Exploration: bounded, seeded jitter so the same strong pool reorders between
  // visits (feed feels alive, not frozen) without wrecking the quality ranking.
  if (opts.exploreSeed) {
    const j = hash01(String(asset.id) + "|" + opts.exploreSeed); // 0..1, stable per window
    score += (opts.exploreAmount != null ? opts.exploreAmount : 0.1) * (j - 0.5) * 2;
  }
  return Math.max(0, Math.min(1.4, score));
}

/**
 * Greedy diversity-aware pick: order by personalized score but discourage
 * repeating the same subject back-to-back (preserves variety on the shelf).
 */
function pickDiverse(candidates, profile, n, opts = {}) {
  const shownSubjectCounts = {};
  const out = [];
  const pool = candidates.slice();
  while (out.length < n && pool.length) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const s = personalizedScore(pool[i], profile, { shownSubjectCounts, exploreSeed: opts.exploreSeed, exploreAmount: opts.exploreAmount });
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const chosen = pool.splice(bestIdx, 1)[0];
    shownSubjectCounts[chosen.subject] = (shownSubjectCounts[chosen.subject] || 0) + 1;
    out.push(chosen);
  }
  return out;
}

module.exports = { buildProfile, personalizedScore, pickDiverse, priceBand, rotationSeed, hash01, MAX_DELTA };
