// BDD: Context Burn Rate
// Given the user's session JSONL data, the dashboard should show
// how fast tokens are being consumed and project time to limit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  calcBurnRate,
  readSessionTotalTokens,
  findActiveSessionJsonl,
  projectMinutesRemaining,
  formatBurnBar,
} from '../src/lib/burnRate.js';

// ─── helpers ───────────────────────────────────────────────────────────────
function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hud-burn-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function assistantLine(inputTokens, outputTokens, cacheCreate = 0, cacheRead = 0, ts = Date.now()) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}
function userLine() {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
}

// ─── calcBurnRate ──────────────────────────────────────────────────────────
describe('calcBurnRate', () => {
  it('given no data points, it returns 0 tokens per minute', () => {
    assert.equal(calcBurnRate([]), 0);
  });

  it('given a single data point, it returns 0 (no duration to calculate rate from)', () => {
    const pts = [{ ts: Date.now(), inputTokens: 500, outputTokens: 100 }];
    assert.equal(calcBurnRate(pts), 0);
  });

  it('given two points exactly 1 minute apart totalling 1200 tokens, it returns 1200 tok/min', () => {
    const now = Date.now();
    const pts = [
      { ts: now - 60_000, inputTokens: 600, outputTokens: 0 },
      { ts: now,          inputTokens: 600, outputTokens: 0 },
    ];
    const rate = calcBurnRate(pts);
    assert.ok(rate > 1150 && rate < 1250, `expected ~1200 got ${rate}`);
  });

  it('given two points 30s apart totalling 600 tokens, it returns ~1200 tok/min', () => {
    const now = Date.now();
    const pts = [
      { ts: now - 30_000, inputTokens: 300, outputTokens: 0 },
      { ts: now,          inputTokens: 300, outputTokens: 0 },
    ];
    const rate = calcBurnRate(pts);
    assert.ok(rate > 1100 && rate < 1300, `expected ~1200 got ${rate}`);
  });

  it('given points in non-chronological order, it still calculates correctly', () => {
    const now = Date.now();
    const pts = [
      { ts: now,          inputTokens: 600, outputTokens: 0 },
      { ts: now - 60_000, inputTokens: 600, outputTokens: 0 },
    ];
    const rate = calcBurnRate(pts);
    assert.ok(rate > 1150 && rate < 1250, `expected ~1200 got ${rate}`);
  });

  it('given points with output tokens, it includes them in the rate', () => {
    const now = Date.now();
    const pts = [
      { ts: now - 60_000, inputTokens: 500, outputTokens: 100 },
      { ts: now,          inputTokens: 500, outputTokens: 100 },
    ];
    const rate = calcBurnRate(pts);
    assert.ok(rate > 1150 && rate < 1250, `expected ~1200 got ${rate}`);
  });

  it('returns a float, not an integer', () => {
    const now = Date.now();
    const pts = [
      { ts: now - 90_000, inputTokens: 100, outputTokens: 0 },
      { ts: now,          inputTokens: 100, outputTokens: 0 },
    ];
    // 200 tokens / 1.5 min = 133.33...
    const rate = calcBurnRate(pts);
    assert.ok(!Number.isInteger(rate) || rate === 0, 'expected float');
  });
});

// ─── readSessionTotalTokens ────────────────────────────────────────────────
describe('readSessionTotalTokens', () => {
  it('given an empty file, it returns all zeros', () => {
    const tmp = makeTmp();
    const p = path.join(tmp, 'empty.jsonl');
    fs.writeFileSync(p, '');
    const r = readSessionTotalTokens(p);
    assert.equal(r.total, 0);
    assert.equal(r.input, 0);
    assert.equal(r.output, 0);
    rm(tmp);
  });

  it('given a file with only user messages, it returns zeros', () => {
    const tmp = makeTmp();
    const p = path.join(tmp, 's.jsonl');
    fs.writeFileSync(p, [userLine(), userLine()].join('\n'));
    const r = readSessionTotalTokens(p);
    assert.equal(r.total, 0);
    rm(tmp);
  });

  it('given one assistant message, it sums all four token fields', () => {
    const tmp = makeTmp();
    const p = path.join(tmp, 's.jsonl');
    fs.writeFileSync(p, assistantLine(100, 50, 200, 150));
    const r = readSessionTotalTokens(p);
    assert.equal(r.input, 100);
    assert.equal(r.output, 50);
    assert.equal(r.cacheCreation, 200);
    assert.equal(r.cacheRead, 150);
    assert.equal(r.total, 500);
    rm(tmp);
  });

  it('given multiple assistant messages, it sums across all of them', () => {
    const tmp = makeTmp();
    const p = path.join(tmp, 's.jsonl');
    fs.writeFileSync(p, [
      assistantLine(100, 50),
      assistantLine(200, 100),
      userLine(),
      assistantLine(300, 150),
    ].join('\n'));
    const r = readSessionTotalTokens(p);
    assert.equal(r.input, 600);
    assert.equal(r.output, 300);
    assert.equal(r.total, 900);
    rm(tmp);
  });

  it('given malformed JSON lines, it skips them without throwing', () => {
    const tmp = makeTmp();
    const p = path.join(tmp, 's.jsonl');
    fs.writeFileSync(p, ['not json', assistantLine(100, 50), '{bad}'].join('\n'));
    const r = readSessionTotalTokens(p);
    assert.equal(r.total, 150);
    rm(tmp);
  });

  it('given an assistant message missing the usage field, it treats it as 0', () => {
    const tmp = makeTmp();
    const p = path.join(tmp, 's.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }));
    const r = readSessionTotalTokens(p);
    assert.equal(r.total, 0);
    rm(tmp);
  });

  it('given a non-existent file, it returns zeros without throwing', () => {
    const r = readSessionTotalTokens('/tmp/__hud_no_such_file__.jsonl');
    assert.equal(r.total, 0);
  });
});

// ─── findActiveSessionJsonl ────────────────────────────────────────────────
describe('findActiveSessionJsonl', () => {
  it('given no projects directory, it returns null', () => {
    const result = findActiveSessionJsonl('/tmp/__hud_no_dir__');
    assert.equal(result, null);
  });

  it('given an empty projects directory, it returns null', () => {
    const tmp = makeTmp();
    const proj = path.join(tmp, 'projects');
    fs.mkdirSync(proj);
    assert.equal(findActiveSessionJsonl(tmp), null);
    rm(tmp);
  });

  it('given a single .jsonl file, it returns its path', () => {
    const tmp = makeTmp();
    const proj = path.join(tmp, 'projects', '-foo');
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'abc.jsonl');
    fs.writeFileSync(f, assistantLine(100, 50));
    const result = findActiveSessionJsonl(tmp);
    assert.equal(result, f);
    rm(tmp);
  });

  it('given multiple .jsonl files, it returns the most recently modified one', () => {
    const tmp = makeTmp();
    const proj = path.join(tmp, 'projects', '-foo');
    fs.mkdirSync(proj, { recursive: true });
    const old = path.join(proj, 'old.jsonl');
    const recent = path.join(proj, 'recent.jsonl');
    fs.writeFileSync(old, assistantLine(100, 50));
    // touch recent after a 10ms gap
    fs.writeFileSync(recent, assistantLine(200, 100));
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(old, oldTime, oldTime);
    const result = findActiveSessionJsonl(tmp);
    assert.equal(result, recent);
    rm(tmp);
  });

  it('given files across multiple project subdirectories, it finds the newest overall', () => {
    const tmp = makeTmp();
    const p1 = path.join(tmp, 'projects', '-proj1');
    const p2 = path.join(tmp, 'projects', '-proj2');
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    const f1 = path.join(p1, 'a.jsonl');
    const f2 = path.join(p2, 'b.jsonl');
    fs.writeFileSync(f1, assistantLine(100, 50));
    fs.writeFileSync(f2, assistantLine(200, 100));
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(f1, old, old);
    const result = findActiveSessionJsonl(tmp);
    assert.equal(result, f2);
    rm(tmp);
  });

  it('given non-.jsonl files in project dirs, it ignores them', () => {
    const tmp = makeTmp();
    const proj = path.join(tmp, 'projects', '-foo');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'meta.json'), '{}');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# test');
    const result = findActiveSessionJsonl(tmp);
    assert.equal(result, null);
    rm(tmp);
  });
});

// ─── projectMinutesRemaining ───────────────────────────────────────────────
describe('projectMinutesRemaining', () => {
  it('given a burn rate of 0, it returns null (cannot project)', () => {
    assert.equal(projectMinutesRemaining(1000, 0, 88000), null);
  });

  it('given a negative burn rate, it returns null', () => {
    assert.equal(projectMinutesRemaining(1000, -100, 88000), null);
  });

  it('given 44000 used at 1000 tok/min with limit 88000, it returns 44 minutes', () => {
    const result = projectMinutesRemaining(44000, 1000, 88000);
    assert.ok(Math.abs(result - 44) < 0.01, `expected 44 got ${result}`);
  });

  it('given usage equal to limit, it returns 0', () => {
    assert.equal(projectMinutesRemaining(88000, 1000, 88000), 0);
  });

  it('given usage exceeding limit, it returns 0', () => {
    assert.equal(projectMinutesRemaining(90000, 1000, 88000), 0);
  });

  it('uses 88000 as the default limit when not provided', () => {
    const r1 = projectMinutesRemaining(44000, 1000);
    const r2 = projectMinutesRemaining(44000, 1000, 88000);
    assert.equal(r1, r2);
  });

  it('returns a fractional value when appropriate', () => {
    // 1000 used, 500 tok/min, limit 88000 → (87000 / 500) = 174.0 min — exact
    // try a non-integer: 1100 used, 300 tok/min, limit 88000 → 86900/300 = 289.666...
    const r = projectMinutesRemaining(1100, 300, 88000);
    assert.ok(!Number.isInteger(r), `expected fractional, got ${r}`);
  });
});

// ─── formatBurnBar ─────────────────────────────────────────────────────────
describe('formatBurnBar', () => {
  it('always starts with CONTEXT:', () => {
    const s = formatBurnBar({ pct: 0, minsLeft: null, tokPerMin: 0 });
    assert.ok(s.startsWith('CONTEXT'), `got: ${s}`);
  });

  it('includes the percentage in the output', () => {
    const s = formatBurnBar({ pct: 62, minsLeft: 18, tokPerMin: 4200 });
    assert.ok(s.includes('62%'), `got: ${s}`);
  });

  it('shows minutes remaining when minsLeft is a number', () => {
    const s = formatBurnBar({ pct: 50, minsLeft: 30, tokPerMin: 1000 });
    assert.ok(s.includes('30'), `got: ${s}`);
  });

  it('shows a dash or infinity symbol when minsLeft is null', () => {
    const s = formatBurnBar({ pct: 10, minsLeft: null, tokPerMin: 0 });
    assert.ok(s.includes('—') || s.includes('∞') || s.includes('-'), `got: ${s}`);
  });

  it('formats tokPerMin above 1000 with k suffix', () => {
    const s = formatBurnBar({ pct: 50, minsLeft: 20, tokPerMin: 4200 });
    assert.ok(s.includes('4.2k') || s.includes('4k'), `got: ${s}`);
  });

  it('contains 10 block characters in total', () => {
    const s = formatBurnBar({ pct: 50, minsLeft: 10, tokPerMin: 500 });
    const filled = (s.match(/█/g) || []).length;
    const empty  = (s.match(/░/g) || []).length;
    assert.equal(filled + empty, 10, `blocks: filled=${filled} empty=${empty}`);
  });

  it('at 0% shows 0 filled blocks and 10 empty blocks', () => {
    const s = formatBurnBar({ pct: 0, minsLeft: null, tokPerMin: 0 });
    assert.equal((s.match(/█/g) || []).length, 0);
    assert.equal((s.match(/░/g) || []).length, 10);
  });

  it('at 100% shows 10 filled blocks and 0 empty blocks', () => {
    const s = formatBurnBar({ pct: 100, minsLeft: 0, tokPerMin: 1000 });
    assert.equal((s.match(/█/g) || []).length, 10);
    assert.equal((s.match(/░/g) || []).length, 0);
  });

  it('at 50% shows 5 filled and 5 empty blocks', () => {
    const s = formatBurnBar({ pct: 50, minsLeft: 20, tokPerMin: 1000 });
    assert.equal((s.match(/█/g) || []).length, 5);
    assert.equal((s.match(/░/g) || []).length, 5);
  });
});
