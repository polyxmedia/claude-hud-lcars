// BDD: Memory Search
// Given a set of memory entries, the search functions should correctly
// tokenize, build IDF maps, score entries, and return ranked results.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  buildIdf,
  scoreEntry,
  search,
} from '../src/lib/memory-search.js';

function makeEntry(content, tags = [], daysAgo = 0) {
  const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return { id: Math.random().toString(36).slice(2), content, tags, timestamp: ts, source: 'manual', context: '' };
}

// ─── tokenize ────────────────────────────────────────────────────────────────
describe('tokenize', () => {
  it('lowercases all tokens', () => {
    const result = tokenize('Hello World');
    assert.ok(result.every(t => t === t.toLowerCase()), 'all tokens should be lowercase');
  });

  it('removes stop words', () => {
    const result = tokenize('the quick brown fox');
    assert.ok(!result.includes('the'), 'should remove "the"');
  });

  it('splits on punctuation and non-alphanumeric chars', () => {
    const result = tokenize('hello, world! foo-bar');
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('world'));
    assert.ok(result.includes('foo'));
    assert.ok(result.includes('bar'));
  });

  it('removes tokens of length 1 or less', () => {
    const result = tokenize('a b c hello');
    assert.ok(!result.includes('a'));
    assert.ok(!result.includes('b'));
    assert.ok(!result.includes('c'));
    assert.ok(result.includes('hello'));
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(tokenize(''), []);
  });

  it('removes common stop words from a sentence', () => {
    const result = tokenize('it is a truth universally acknowledged');
    assert.ok(!result.includes('it'));
    assert.ok(!result.includes('is'));
    assert.ok(!result.includes('a'));
    assert.ok(result.includes('truth'));
    assert.ok(result.includes('universally'));
    assert.ok(result.includes('acknowledged'));
  });
});

// ─── buildIdf ────────────────────────────────────────────────────────────────
describe('buildIdf', () => {
  it('returns a Map', () => {
    const idf = buildIdf([makeEntry('hello world')]);
    assert.ok(idf instanceof Map);
  });

  it('terms appearing in fewer documents have higher IDF', () => {
    const entries = [
      makeEntry('machine learning neural network'),
      makeEntry('machine learning gradient'),
      makeEntry('neural oscillation frequency'),
    ];
    const idf = buildIdf(entries);
    // 'machine' appears in 2 docs, 'oscillation' in 1 — oscillation should have higher IDF
    const machineIdf = idf.get('machine') || 0;
    const oscIdf = idf.get('oscillation') || 0;
    assert.ok(oscIdf > machineIdf, `rare term should have higher IDF: ${oscIdf} > ${machineIdf}`);
  });

  it('returns an empty Map for empty entries array', () => {
    const idf = buildIdf([]);
    assert.equal(idf.size, 0);
  });

  it('includes terms from tags as well', () => {
    const entries = [makeEntry('hello', ['tagword'])];
    const idf = buildIdf(entries);
    assert.ok(idf.has('tagword'), 'should include tag terms in IDF');
  });
});

// ─── scoreEntry ──────────────────────────────────────────────────────────────
describe('scoreEntry', () => {
  it('returns 0 if query tokens is empty', () => {
    const entry = makeEntry('hello world test content');
    const idf = buildIdf([entry]);
    assert.equal(scoreEntry(entry, [], idf), 0);
  });

  it('returns 0 if no query tokens match the entry', () => {
    const entry = makeEntry('hello world');
    const idf = buildIdf([entry]);
    const score = scoreEntry(entry, ['zzz', 'nonexistent'], idf);
    assert.equal(score, 0);
  });

  it('returns positive score when query tokens match', () => {
    // Need multiple entries so IDF > 0 (single-entry corpus yields log(1)=0 for all terms)
    const entry = makeEntry('machine learning is fascinating');
    const decoy = makeEntry('unrelated topic about cooking recipes');
    const idf = buildIdf([entry, decoy]);
    const score = scoreEntry(entry, ['machine', 'learning'], idf);
    assert.ok(score > 0, `expected positive score, got ${score}`);
  });

  it('higher score for more matching tokens', () => {
    const entry = makeEntry('machine learning deep neural network architecture');
    const decoy1 = makeEntry('cooking recipe ingredients');
    const decoy2 = makeEntry('travel destinations europe');
    const idf = buildIdf([entry, decoy1, decoy2]);
    const score1 = scoreEntry(entry, ['machine'], idf);
    const score2 = scoreEntry(entry, ['machine', 'learning', 'neural'], idf);
    assert.ok(score2 > score1, `more matches should score higher: ${score2} > ${score1}`);
  });
});

// ─── search ──────────────────────────────────────────────────────────────────
describe('search', () => {
  it('returns empty array for empty entries', () => {
    const results = search([], 'query');
    assert.deepEqual(results, []);
  });

  it('returns top N results', () => {
    const entries = [
      makeEntry('machine learning algorithms deep neural'),
      makeEntry('machine learning classification'),
      makeEntry('machine learning regression'),
      makeEntry('machine learning clustering methods'),
      makeEntry('machine learning ensemble'),
      makeEntry('machine learning reinforcement'),
    ];
    const results = search(entries, 'machine learning', { topN: 3 });
    assert.ok(results.length <= 3, `expected at most 3 results, got ${results.length}`);
  });

  it('results are sorted by score descending', () => {
    const entries = [
      makeEntry('python programming language'),
      makeEntry('python programming language tutorial advanced'),
      makeEntry('javascript web development'),
    ];
    const results = search(entries, 'python programming', { topN: 5 });
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, 'results should be sorted descending');
    }
  });

  it('recency affects ranking — newer entries rank higher when raw scores are equal', () => {
    // Use a corpus with additional entries so IDF > 0 for the shared terms
    // The two target entries share identical content; a third unrelated entry makes IDF non-zero
    const sharedContent = 'quantum entanglement physics';
    const older = makeEntry(sharedContent + ' zeta', [], 60);   // 60 days ago
    const newer = makeEntry(sharedContent + ' eta', [], 1);     // 1 day ago
    const unrelated = makeEntry('cooking recipe ingredients pasta sauce', [], 0);
    const results = search([older, newer, unrelated], 'quantum entanglement', { topN: 3, halfLifeDays: 30 });
    // Both older and newer should match; newer should rank higher due to recency
    const matchIds = results.map(r => r.entry.id);
    assert.ok(matchIds.includes(newer.id), 'newer entry should be in results');
    assert.ok(matchIds.includes(older.id), 'older entry should be in results');
    const newerIdx = results.findIndex(r => r.entry.id === newer.id);
    const olderIdx = results.findIndex(r => r.entry.id === older.id);
    assert.ok(newerIdx < olderIdx, 'newer entry should rank above older entry');
  });

  it('result shape includes entry, score, rawScore, daysAgo', () => {
    // Use multiple entries so IDF > 0
    const entry = makeEntry('algorithm analysis complexity performance');
    const decoy = makeEntry('cooking recipes kitchen ingredients');
    const results = search([entry, decoy], 'algorithm analysis', { topN: 1 });
    assert.ok(results.length > 0);
    const r = results[0];
    assert.ok('entry' in r);
    assert.ok('score' in r);
    assert.ok('rawScore' in r);
    assert.ok('daysAgo' in r);
    assert.ok(typeof r.score === 'number');
    assert.ok(typeof r.rawScore === 'number');
    assert.ok(typeof r.daysAgo === 'number');
  });
});
