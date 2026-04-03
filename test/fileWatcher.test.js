// BDD: File Watcher + Live SSE Updates
// Given that files in ~/.claude/ change, the server should broadcast
// categorized events to connected dashboard clients in real time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { categorizeChange, resolveWatchPath, buildChangeEvent, buildHudEvent } from '../src/lib/fileWatcher.js';

const CLAUDE_DIR = '/Users/test/.claude';

// ─── categorizeChange ──────────────────────────────────────────────────────
describe('categorizeChange', () => {
  it('given a path inside skills/, it returns "skills"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/skills/commit/SKILL.md`, CLAUDE_DIR), 'skills');
  });

  it('given a path inside agents/, it returns "agents"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/agents/security-auditor.md`, CLAUDE_DIR), 'agents');
  });

  it('given settings.json, it returns "settings"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/settings.json`, CLAUDE_DIR), 'settings');
  });

  it('given the global CLAUDE.md, it returns "claudemd"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/CLAUDE.md`, CLAUDE_DIR), 'claudemd');
  });

  it('given a CLAUDE.md inside a projects subdir, it returns "claudemd"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/projects/-Users-foo/CLAUDE.md`, CLAUDE_DIR), 'claudemd');
  });

  it('given hud-events.jsonl, it returns "hud-events"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/hud-events.jsonl`, CLAUDE_DIR), 'hud-events');
  });

  it('given a .jsonl file in projects/, it returns "session"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/projects/-Users-foo/abc123.jsonl`, CLAUDE_DIR), 'session');
  });

  it('given a file in the memory dir, it returns "memory"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/memory/user_role.md`, CLAUDE_DIR), 'memory');
  });

  it('given an unrecognised path inside claudeDir, it returns "other"', () => {
    assert.equal(categorizeChange(`${CLAUDE_DIR}/some-random-file.txt`, CLAUDE_DIR), 'other');
  });

  it('given a path outside claudeDir, it returns "other"', () => {
    assert.equal(categorizeChange('/tmp/something.json', CLAUDE_DIR), 'other');
  });
});

// ─── resolveWatchPath ──────────────────────────────────────────────────────
describe('resolveWatchPath', () => {
  it('given a relative filename, it returns the absolute path under watchedDir', () => {
    const result = resolveWatchPath('/home/user/.claude', 'settings.json');
    assert.equal(result, '/home/user/.claude/settings.json');
  });

  it('given an absolute filename, it returns it unchanged', () => {
    const abs = '/home/user/.claude/settings.json';
    const result = resolveWatchPath('/home/user/.claude', abs);
    assert.equal(result, abs);
  });

  it('given a null filename, it returns the watchedDir itself', () => {
    const result = resolveWatchPath('/home/user/.claude', null);
    assert.equal(result, '/home/user/.claude');
  });

  it('combines watchedDir and filename correctly using path.join semantics', () => {
    const result = resolveWatchPath('/home/user/.claude', 'skills/commit/SKILL.md');
    assert.equal(result, path.join('/home/user/.claude', 'skills/commit/SKILL.md'));
  });
});

// ─── buildChangeEvent ─────────────────────────────────────────────────────
describe('buildChangeEvent', () => {
  it('always sets type to "file-change"', () => {
    const evt = buildChangeEvent('settings', `${CLAUDE_DIR}/settings.json`);
    assert.equal(evt.type, 'file-change');
  });

  it('passes category through unchanged', () => {
    const evt = buildChangeEvent('skills', `${CLAUDE_DIR}/skills/foo/SKILL.md`);
    assert.equal(evt.category, 'skills');
  });

  it('passes the file path through unchanged', () => {
    const p = `${CLAUDE_DIR}/settings.json`;
    const evt = buildChangeEvent('settings', p);
    assert.equal(evt.path, p);
  });

  it('sets ts to a number close to the current time', () => {
    const before = Date.now();
    const evt = buildChangeEvent('other', '/tmp/x');
    const after = Date.now();
    assert.ok(typeof evt.ts === 'number', 'ts must be a number');
    assert.ok(evt.ts >= before && evt.ts <= after, 'ts should be current time');
  });
});

// ─── buildHudEvent ────────────────────────────────────────────────────────
describe('buildHudEvent', () => {
  it('given an empty string, it returns null', () => {
    assert.equal(buildHudEvent(''), null);
  });

  it('given invalid JSON, it returns null', () => {
    assert.equal(buildHudEvent('{not valid json'), null);
  });

  it('given valid JSON missing required fields, it returns null', () => {
    assert.equal(buildHudEvent('{}'), null);
  });

  it('given a well-formed hud-event line, it parses event, tool, session, ts', () => {
    const line = JSON.stringify({ ts: '2026-04-03T12:00:00Z', event: 'PreToolUse', tool: 'Bash', session: 'abc123' });
    const evt = buildHudEvent(line);
    assert.ok(evt, 'expected non-null result');
    assert.equal(evt.event, 'PreToolUse');
    assert.equal(evt.tool, 'Bash');
    assert.equal(evt.session, 'abc123');
    assert.equal(evt.ts, '2026-04-03T12:00:00Z');
  });

  it('always sets type to "hud-event" on success', () => {
    const line = JSON.stringify({ ts: '2026-04-03T12:00:00Z', event: 'Stop', tool: '', session: '' });
    const evt = buildHudEvent(line);
    assert.equal(evt.type, 'hud-event');
  });

  it('given a line missing the tool field, it defaults tool to empty string', () => {
    const line = JSON.stringify({ ts: '2026-04-03T12:00:00Z', event: 'Stop', session: 'x' });
    const evt = buildHudEvent(line);
    assert.equal(evt.tool, '');
  });

  it('given a line missing the session field, it defaults session to empty string', () => {
    const line = JSON.stringify({ ts: '2026-04-03T12:00:00Z', event: 'Stop', tool: 'Write' });
    const evt = buildHudEvent(line);
    assert.equal(evt.session, '');
  });
});
