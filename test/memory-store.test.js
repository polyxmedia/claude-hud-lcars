// BDD: Memory Store
// Given a persistent JSON store, operations should be pure, injectable, and handle all edge cases.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  storePath,
  loadStore,
  saveStore,
  addEntry,
  filterEntries,
  parseRelativeDate,
  getStats,
} from '../src/lib/memory-store.js';

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-mem-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── loadStore ───────────────────────────────────────────────────────────────
describe('loadStore', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => rm(tmp));

  it('returns default structure when file is missing', () => {
    const store = loadStore(tmp);
    assert.deepEqual(store, { version: 1, entries: [] });
  });

  it('parses valid JSON from disk', () => {
    const data = { version: 1, entries: [{ id: 'abc', content: 'hello' }] };
    fs.writeFileSync(storePath(tmp), JSON.stringify(data));
    const store = loadStore(tmp);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].content, 'hello');
  });

  it('returns default on malformed JSON', () => {
    fs.writeFileSync(storePath(tmp), '{bad json!!}');
    const store = loadStore(tmp);
    assert.deepEqual(store, { version: 1, entries: [] });
  });

  it('returns default when file contains non-array entries', () => {
    fs.writeFileSync(storePath(tmp), JSON.stringify({ version: 1, entries: null }));
    const store = loadStore(tmp);
    assert.deepEqual(store, { version: 1, entries: [] });
  });
});

// ─── saveStore ───────────────────────────────────────────────────────────────
describe('saveStore', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => rm(tmp));

  it('creates directory if it does not exist', () => {
    const nested = path.join(tmp, 'nested', 'dir');
    const store = { version: 1, entries: [] };
    saveStore(store, nested);
    assert.ok(fs.existsSync(nested));
  });

  it('writes valid indented JSON to disk', () => {
    const store = { version: 1, entries: [{ id: '1', content: 'test' }] };
    saveStore(store, tmp);
    const raw = fs.readFileSync(storePath(tmp), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries[0].content, 'test');
    // Check 2-space indent
    assert.ok(raw.includes('  "version"'), 'expected 2-space indent');
  });
});

// ─── addEntry ────────────────────────────────────────────────────────────────
describe('addEntry', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => rm(tmp));

  it('adds an entry with correct schema', () => {
    const entry = addEntry('hello world', {}, tmp);
    assert.equal(entry.content, 'hello world');
    assert.equal(entry.source, 'manual');
    assert.equal(entry.context, '');
    assert.deepEqual(entry.tags, []);
  });

  it('assigns a uuid to the id field', () => {
    const entry = addEntry('test', {}, tmp);
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
  });

  it('timestamp is an ISO 8601 string', () => {
    const entry = addEntry('test', {}, tmp);
    assert.ok(!isNaN(new Date(entry.timestamp).getTime()), 'timestamp should be valid date');
    assert.ok(entry.timestamp.includes('T'), 'should be ISO format');
  });

  it('tags default to empty array when not provided', () => {
    const entry = addEntry('test', {}, tmp);
    assert.deepEqual(entry.tags, []);
  });

  it('stores provided tags, source, and context', () => {
    const entry = addEntry('test', { tags: ['ai', 'memory'], source: 'import', context: 'project x' }, tmp);
    assert.deepEqual(entry.tags, ['ai', 'memory']);
    assert.equal(entry.source, 'import');
    assert.equal(entry.context, 'project x');
  });

  it('persists entry to store on disk', () => {
    addEntry('persisted', {}, tmp);
    const store = loadStore(tmp);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].content, 'persisted');
  });
});

// ─── filterEntries ───────────────────────────────────────────────────────────
describe('filterEntries', () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000).toISOString();
  const lastWeek = new Date(now.getTime() - 7 * 86400000).toISOString();
  const lastMonth = new Date(now.getTime() - 31 * 86400000).toISOString();

  const entries = [
    { id: '1', content: 'alpha', tags: ['ai'], timestamp: now.toISOString() },
    { id: '2', content: 'beta',  tags: ['memory'], timestamp: yesterday },
    { id: '3', content: 'gamma', tags: ['ai', 'memory'], timestamp: lastWeek },
    { id: '4', content: 'delta', tags: [], timestamp: lastMonth },
  ];

  it('returns all entries when filters is empty', () => {
    assert.equal(filterEntries(entries, {}).length, 4);
  });

  it('filters by a single tag', () => {
    const result = filterEntries(entries, { tags: ['ai'] });
    assert.equal(result.length, 2);
    assert.ok(result.every(e => e.tags.includes('ai')));
  });

  it('filters by multiple tags (any match)', () => {
    const result = filterEntries(entries, { tags: ['ai', 'memory'] });
    assert.equal(result.length, 3);
  });

  it('filters by relative date (2d — last 2 days)', () => {
    const result = filterEntries(entries, { from: '2d' });
    assert.ok(result.length >= 2, 'should include today and yesterday');
    assert.ok(result.every(e => new Date(e.timestamp) >= new Date(now.getTime() - 2 * 86400000)));
  });

  it('filters by both tags and from', () => {
    const result = filterEntries(entries, { tags: ['ai'], from: '2d' });
    // Only entries with 'ai' tag and within last 2 days
    assert.ok(result.every(e => e.tags.includes('ai')));
    assert.ok(result.every(e => new Date(e.timestamp) >= new Date(now.getTime() - 2 * 86400000)));
  });

  it('returns empty when no entries match tag', () => {
    const result = filterEntries(entries, { tags: ['nonexistent'] });
    assert.equal(result.length, 0);
  });
});

// ─── parseRelativeDate ───────────────────────────────────────────────────────
describe('parseRelativeDate', () => {
  it('"2w" returns approximately 14 days ago', () => {
    const d = parseRelativeDate('2w');
    const diffDays = (Date.now() - d.getTime()) / 86400000;
    assert.ok(Math.abs(diffDays - 14) < 0.01, `expected ~14 days got ${diffDays}`);
  });

  it('"3d" returns approximately 3 days ago', () => {
    const d = parseRelativeDate('3d');
    const diffDays = (Date.now() - d.getTime()) / 86400000;
    assert.ok(Math.abs(diffDays - 3) < 0.01, `expected ~3 days got ${diffDays}`);
  });

  it('"1m" returns approximately 30 days ago', () => {
    const d = parseRelativeDate('1m');
    const diffMs = Date.now() - d.getTime();
    assert.ok(Math.abs(diffMs - 2592000000) < 5000, `expected ~30d ms got ${diffMs}`);
  });

  it('"1y" returns approximately 365 days ago', () => {
    const d = parseRelativeDate('1y');
    const diffMs = Date.now() - d.getTime();
    assert.ok(Math.abs(diffMs - 31536000000) < 5000, `expected ~365d ms got ${diffMs}`);
  });

  it('accepts an ISO date string', () => {
    const iso = '2024-01-15T12:00:00.000Z';
    const d = parseRelativeDate(iso);
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), iso);
  });

  it('returns null for invalid strings', () => {
    assert.equal(parseRelativeDate('invalid'), null);
    assert.equal(parseRelativeDate('5x'), null);
    assert.equal(parseRelativeDate(''), null);
    assert.equal(parseRelativeDate(null), null);
  });
});

// ─── getStats ────────────────────────────────────────────────────────────────
describe('getStats', () => {
  let tmp;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => rm(tmp));

  it('returns zeros for an empty store', () => {
    const stats = getStats(tmp);
    assert.equal(stats.total, 0);
    assert.equal(stats.today, 0);
    assert.equal(stats.lastEntry, null);
  });

  it('total reflects number of entries', () => {
    addEntry('one', {}, tmp);
    addEntry('two', {}, tmp);
    const stats = getStats(tmp);
    assert.equal(stats.total, 2);
  });

  it('today counts entries added today', () => {
    addEntry('today entry', {}, tmp);
    const stats = getStats(tmp);
    assert.equal(stats.today, 1);
  });

  it('today excludes entries from previous days', () => {
    // Write an entry with yesterday timestamp directly
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const store = { version: 1, entries: [{ id: '1', content: 'old', tags: [], timestamp: yesterday, source: 'manual', context: '' }] };
    saveStore(store, tmp);
    const stats = getStats(tmp);
    assert.equal(stats.today, 0);
    assert.equal(stats.total, 1);
  });

  it('lastEntry returns the last entry in the store', () => {
    addEntry('first', {}, tmp);
    addEntry('last', {}, tmp);
    const stats = getStats(tmp);
    assert.equal(stats.lastEntry.content, 'last');
  });
});
