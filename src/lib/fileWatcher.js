// src/lib/fileWatcher.js
// Pure functions for file watcher event categorization and event building.
// No side effects, fully testable in isolation.

import path from 'node:path';

/**
 * Categorize a changed file path relative to claudeDir.
 *
 * Categories:
 *   'skills'     — inside claudeDir/skills/
 *   'agents'     — inside claudeDir/agents/
 *   'settings'   — is claudeDir/settings.json
 *   'claudemd'   — any CLAUDE.md file inside claudeDir
 *   'hud-events' — is claudeDir/hud-events.jsonl
 *   'session'    — a .jsonl file inside claudeDir/projects/
 *   'memory'     — inside claudeDir/memory/
 *   'other'      — anything else (or outside claudeDir)
 *
 * @param {string} filePath
 * @param {string} claudeDir
 * @returns {string}
 */
export function categorizeChange(filePath, claudeDir) {
  // Must be inside claudeDir
  const rel = path.relative(claudeDir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'other';

  const parts = rel.split(path.sep);

  if (parts[0] === 'skills') return 'skills';
  if (parts[0] === 'agents') return 'agents';
  if (parts[0] === 'memory') return 'memory';
  if (rel === 'settings.json') return 'settings';
  if (rel === 'hud-events.jsonl') return 'hud-events';
  if (path.basename(filePath) === 'CLAUDE.md') return 'claudemd';
  if (parts[0] === 'projects' && filePath.endsWith('.jsonl')) return 'session';

  return 'other';
}

/**
 * Resolve the absolute path of a changed file given the watched directory and
 * the filename reported by fs.watch().
 *
 * fs.watch() on macOS reports filenames relative to the watched dir (or null
 * for directory-level events). On Linux it may report absolute paths.
 *
 * @param {string} watchedDir
 * @param {string|null} filename
 * @returns {string}
 */
export function resolveWatchPath(watchedDir, filename) {
  if (!filename) return watchedDir;
  if (path.isAbsolute(filename)) return filename;
  return path.join(watchedDir, filename);
}

/**
 * Build a file-change SSE event payload.
 *
 * @param {string} category - one of the categorizeChange categories
 * @param {string} filePath - absolute path of the changed file
 * @returns {{type:'file-change', category:string, path:string, ts:number}}
 */
export function buildChangeEvent(category, filePath) {
  return {
    type: 'file-change',
    category,
    path: filePath,
    ts: Date.now(),
  };
}

/**
 * Parse a single line from hud-events.jsonl into a hud-event SSE payload.
 * Returns null if the line is empty, invalid JSON, or missing the required
 * 'event' and 'ts' fields.
 *
 * @param {string} line
 * @returns {{type:'hud-event', event:string, tool:string, session:string, ts:string}|null}
 */
export function buildHudEvent(line) {
  if (!line || !line.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed.event || !parsed.ts) return null;
  return {
    type: 'hud-event',
    event: parsed.event,
    tool: parsed.tool ?? '',
    session: parsed.session ?? '',
    ts: parsed.ts,
  };
}
