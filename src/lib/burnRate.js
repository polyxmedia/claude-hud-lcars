// src/lib/burnRate.js
// Pure functions for context window burn rate calculation.
// No side effects, fully testable in isolation.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Given an array of token data points (each with ts, inputTokens, outputTokens),
 * calculate the burn rate in tokens per minute across the full window spanned by
 * the points. Returns 0 if fewer than 2 points are provided.
 *
 * @param {Array<{ts:number, inputTokens:number, outputTokens:number}>} points
 * @returns {number} tokens per minute
 */
export function calcBurnRate(points) {
  if (points.length < 2) return 0;
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const durationMs = sorted[sorted.length - 1].ts - sorted[0].ts;
  if (durationMs <= 0) return 0;
  const totalTokens = sorted.reduce((s, p) => s + (p.inputTokens || 0) + (p.outputTokens || 0), 0);
  return totalTokens / (durationMs / 60_000);
}

/**
 * Read all assistant messages from a session .jsonl file and sum their token usage.
 * Handles missing files, malformed lines, and missing fields gracefully.
 *
 * @param {string} jsonlPath - absolute path to the session .jsonl file
 * @returns {{total:number, input:number, output:number, cacheCreation:number, cacheRead:number}}
 */
export function readSessionTotalTokens(jsonlPath) {
  const zero = { total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let content;
  try { content = fs.readFileSync(jsonlPath, 'utf-8'); } catch { return zero; }
  const lines = content.split('\n').filter(l => l.trim());
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const u = entry.message?.usage;
      if (!u) continue;
      input        += u.input_tokens                || 0;
      output       += u.output_tokens               || 0;
      cacheCreation += u.cache_creation_input_tokens || 0;
      cacheRead    += u.cache_read_input_tokens      || 0;
    } catch { /* skip malformed */ }
  }
  return { input, output, cacheCreation, cacheRead, total: input + output + cacheCreation + cacheRead };
}

/**
 * Find the most recently modified .jsonl file across all project directories
 * under claudeDir/projects/. Returns null if none found.
 *
 * @param {string} claudeDir - path to ~/.claude
 * @returns {string|null}
 */
export function findActiveSessionJsonl(claudeDir) {
  const projDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projDir)) return null;
  let best = null, bestMtime = 0;
  try {
    for (const entry of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projDir, entry.name);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(dir, f);
          try {
            const mtime = fs.statSync(fp).mtimeMs;
            if (mtime > bestMtime) { bestMtime = mtime; best = fp; }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dir */ }
    }
  } catch { return null; }
  return best;
}

/**
 * Project how many minutes remain given current token usage and burn rate.
 * Returns null if burn rate is 0 or negative. Returns 0 if limit already reached.
 *
 * @param {number} totalUsed
 * @param {number} burnRatePerMin
 * @param {number} [limitTokens=88000]
 * @returns {number|null}
 */
export function projectMinutesRemaining(totalUsed, burnRatePerMin, limitTokens = 88000) {
  if (burnRatePerMin <= 0) return null;
  const remaining = limitTokens - totalUsed;
  if (remaining <= 0) return 0;
  return remaining / burnRatePerMin;
}

/**
 * Format the burn rate bar display string for the persistent context bar.
 * Uses block characters: █ (filled) and ░ (empty).
 *
 * @param {{pct:number, minsLeft:number|null, tokPerMin:number}} opts
 * @returns {string}
 */
export function formatBurnBar({ pct, minsLeft, tokPerMin }) {
  const BLOCKS = 10;
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * BLOCKS);
  const bar = '█'.repeat(filled) + '░'.repeat(BLOCKS - filled);
  const pctStr = Math.round(pct) + '%';
  const timeStr = minsLeft === null || minsLeft === undefined
    ? '—'
    : '~' + Math.round(minsLeft) + 'min left';
  const rateStr = tokPerMin >= 1000
    ? (tokPerMin / 1000).toFixed(1).replace(/\.0$/, '') + 'k tok/min'
    : Math.round(tokPerMin) + ' tok/min';
  return `CONTEXT: ${bar} ${pctStr} │ ${timeStr} │ ${rateStr}`;
}
