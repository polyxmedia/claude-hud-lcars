// src/lib/memory-search.js

const STOP_WORDS = new Set(['a','an','the','is','it','in','of','to','and','or','for',
  'with','on','at','from','by','as','be','this','that','was','are','were','been',
  'has','have','had','do','does','did','will','would','could','should','may',
  'might','not','no','but','if','so','than','then','when','where','who','which',
  'what','how','all','any','both','each','few','more','most','other','some',
  'such','up','out','about','into','i','you','he','she','we','they','them',
  'their','your','our','my','his','her','its']);

export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

export function buildIdf(entries) {
  const N = entries.length;
  const docFreq = new Map();

  for (const entry of entries) {
    const text = entry.content + ' ' + (entry.tags || []).join(' ');
    const terms = new Set(tokenize(text));
    for (const term of terms) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const idfMap = new Map();
  for (const [term, freq] of docFreq.entries()) {
    idfMap.set(term, Math.log((N + 1) / (freq + 1)));
  }
  return idfMap;
}

export function scoreEntry(entry, queryTokens, idfMap) {
  if (!queryTokens || queryTokens.length === 0) return 0;

  const text = entry.content + ' ' + (entry.tags || []).join(' ');
  const docTokens = tokenize(text);
  const docLen = docTokens.length;
  if (docLen === 0) return 0;

  const termCounts = new Map();
  for (const t of docTokens) {
    termCounts.set(t, (termCounts.get(t) || 0) + 1);
  }

  let score = 0;
  for (const qt of queryTokens) {
    if (termCounts.has(qt)) {
      const tf = termCounts.get(qt) / docLen;
      const idf = idfMap.get(qt) || 0;
      score += tf * idf;
    }
  }
  return score;
}

export function search(entries, query, opts = {}) {
  const { halfLifeDays = 30, topN = 5 } = opts;
  if (!entries || entries.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const idfMap = buildIdf(entries);
  const now = Date.now();

  const results = [];
  for (const entry of entries) {
    const rawScore = scoreEntry(entry, queryTokens, idfMap);
    if (rawScore <= 0) continue;

    const daysAgo = (now - new Date(entry.timestamp).getTime()) / 86400000;
    const recencyDecay = Math.exp(-Math.LN2 / halfLifeDays * daysAgo);
    const score = rawScore * recencyDecay;

    results.push({ entry, score, rawScore, daysAgo });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topN);
}

// ── Future embedding interface (stubs) ────────────────────────────────────────

/** @param {string} text @returns {Promise<number[]>} */
export async function getEmbedding(text) {
  // TODO: call embedding API
  void text;
  return [];
}

/** @param {number[]} a @param {number[]} b @returns {number} */
export function cosineSimilarity(a, b) {
  // TODO: dot product / magnitude
  void a; void b;
  return 0;
}
