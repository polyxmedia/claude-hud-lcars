// src/lib/memory-store.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DEFAULT_DIR = path.join(os.homedir(), '.lcars');

export function storePath(dir = DEFAULT_DIR) {
  return path.join(dir, 'memory.json');
}

export function loadStore(dir = DEFAULT_DIR) {
  const p = storePath(dir);
  if (!fs.existsSync(p)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || !Array.isArray(raw.entries)) return { version: 1, entries: [] };
    return raw;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveStore(store, dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath(dir), JSON.stringify(store, null, 2), 'utf-8');
}

export function addEntry(content, opts = {}, dir = DEFAULT_DIR) {
  const { tags = [], source = 'manual', context = '' } = opts;
  const entry = {
    id: randomUUID(),
    content,
    tags,
    timestamp: new Date().toISOString(),
    source,
    context,
  };
  const store = loadStore(dir);
  store.entries.push(entry);
  saveStore(store, dir);
  return entry;
}

export function filterEntries(entries, filters = {}) {
  let result = entries;

  if (filters.tags && filters.tags.length > 0) {
    const filterTags = filters.tags;
    result = result.filter(e => e.tags && filterTags.some(t => e.tags.includes(t)));
  }

  if (filters.from) {
    const fromDate = parseRelativeDate(filters.from);
    if (fromDate) {
      result = result.filter(e => e.timestamp && new Date(e.timestamp) >= fromDate);
    }
  }

  return result;
}

export function parseRelativeDate(str) {
  if (!str) return null;
  const relative = str.match(/^(\d+)([dwmy])$/i);
  if (relative) {
    const n = parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const multipliers = { d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
    const ms = multipliers[unit];
    if (!ms) return null;
    return new Date(Date.now() - n * ms);
  }
  // Try ISO date string
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  return null;
}

export function getStats(dir = DEFAULT_DIR) {
  const store = loadStore(dir);
  const entries = store.entries;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = entries.filter(e => e.timestamp && e.timestamp.slice(0, 10) === today).length;
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  return {
    total: entries.length,
    today: todayCount,
    lastEntry,
  };
}
