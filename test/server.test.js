import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hud-srv-test-')); }
function rimraf(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ── inlined from server.js ────────────────────────────────────────────────────

const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function solidPng(size) {
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = _crc32Table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcVal]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const armW = Math.round(size * 0.38);
  const arcR = armW;
  const cH   = size - armW;
  const bH   = Math.round(cH * 0.22);
  const bGap = Math.round(cH * 0.07);
  const bOff = Math.round(cH * 0.06);
  const rowSize = 1 + size * 3;
  const raw = Buffer.alloc(size * rowSize);
  for (let y = 0; y < size; y++) {
    const base = y * rowSize + 1;
    for (let x = 0; x < size; x++) {
      const dx = x - armW, dy = y - armW;
      const inConcave = dx >= 0 && dy >= 0 && (dx * dx + dy * dy) < arcR * arcR;
      let pr = 0, pg = 0, pb = 0;
      if (!inConcave && (x < armW || y < armW)) { pr = 0xFF; pg = 0x99; pb = 0x00; }
      else if (!inConcave && x >= armW && y >= armW) {
        const relY = y - armW - bOff;
        if      (relY >= 0           && relY < bH)              { pr = 0x66; pg = 0x77; pb = 0xFF; }
        else if (relY >= bH + bGap   && relY < 2*bH + bGap)    { pr = 0xCC; pg = 0x99; pb = 0xCC; }
        else if (relY >= 2*(bH+bGap) && relY < 3*bH + 2*bGap) { pr = 0xCC; pg = 0x99; pb = 0x66; }
      }
      raw[base + x * 3] = pr; raw[base + x * 3 + 1] = pg; raw[base + x * 3 + 2] = pb;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CORS origin check logic (inlined from server.js)
function isCrossOrigin(method, origin, port) {
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return false;
  if (!origin) return false;
  return origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`;
}

// PWA manifest builder (inlined from server.js /manifest.json route)
function buildManifest() {
  return {
    name: 'Claude Dashboard',
    short_name: 'Claude HUD',
    description: 'LCARS-style dashboard for your Claude Code environment',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#FF9900',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

// ── inlined from generate.js ──────────────────────────────────────────────────

function escJ(s) { return JSON.stringify(s).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/`/g,'\\u0060').replace(/\$/g,'\\u0024'); }
function escA(s) { return escJ(s).replace(/"/g,'&quot;'); }

function discoverHtml(id, cardsHtml, count) {
  if (!count) return '';
  return '<div class="discover">'
    + '<div class="discover-hdr" onclick="toggleDiscover(this,\'' + id + '\')" id="dh-' + id + '">'
    + '<span class="discover-arrow">&#9658;</span>'
    + ' DISCOVER &#x2014; ' + count + ' SUGGESTION' + (count !== 1 ? 'S' : '')
    + '</div>'
    + '<div class="discover-body" id="db-' + id + '" style="display:none">' + cardsHtml + '</div>'
    + '</div>';
}

// Suggestion deduplication (mirrors SKILL_SUGG / AGENT_SUGG / MCP_SUGG filter pattern)
function filterByName(suggestions, installedNames) {
  const installed = new Set(installedNames);
  return suggestions.filter(s => !installed.has(s.name));
}

// ── solidPng ─────────────────────────────────────────────────────────────────

describe('solidPng', () => {
  test('returns a Buffer', () => {
    assert.ok(Buffer.isBuffer(solidPng(4)));
  });

  test('starts with PNG magic bytes', () => {
    const buf = solidPng(4);
    assert.deepEqual([...buf.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test('IHDR chunk encodes correct width and height', () => {
    const size = 16;
    const buf = solidPng(size);
    // Layout: 8-byte sig | 4-byte len | 4-byte 'IHDR' | 13-byte data (width@0, height@4)
    assert.equal(buf.readUInt32BE(16), size, 'width');
    assert.equal(buf.readUInt32BE(20), size, 'height');
  });

  test('bit depth is 8 and color type is 2 (RGB)', () => {
    const buf = solidPng(8);
    // bit depth at byte 24, color type at byte 25
    assert.equal(buf[24], 8, 'bit depth');
    assert.equal(buf[25], 2, 'color type RGB');
  });

  test('larger size produces larger buffer', () => {
    assert.ok(solidPng(64).length > solidPng(16).length);
  });

  test('ends with IEND chunk (last 12 bytes)', () => {
    const buf = solidPng(4);
    // IEND: 4-byte len=0, 4-byte 'IEND', 4-byte CRC
    const tail = buf.slice(-12);
    assert.equal(tail.readUInt32BE(0), 0, 'IEND data length must be 0');
    assert.equal(tail.slice(4, 8).toString('ascii'), 'IEND');
  });

  test('different sizes produce different buffers', () => {
    assert.notDeepEqual(solidPng(8), solidPng(16));
  });

  test('192x192 and 512x512 sizes do not throw', () => {
    assert.doesNotThrow(() => solidPng(192));
    assert.doesNotThrow(() => solidPng(512));
  });
});

// ── _crc32Table ───────────────────────────────────────────────────────────────

describe('_crc32Table', () => {
  test('has 256 entries', () => {
    assert.equal(_crc32Table.length, 256);
  });

  test('entry 0 is 0', () => {
    assert.equal(_crc32Table[0], 0);
  });

  test('entry 1 matches known CRC32 polynomial value', () => {
    // CRC32 of byte 1 with IEEE polynomial
    assert.equal(_crc32Table[1], 0x77073096);
  });

  test('all entries are unsigned 32-bit integers', () => {
    for (const v of _crc32Table) {
      assert.ok(v >= 0 && v <= 0xFFFFFFFF);
    }
  });
});

// ── discoverHtml ─────────────────────────────────────────────────────────────

describe('discoverHtml', () => {
  test('returns empty string when count is 0', () => {
    assert.equal(discoverHtml('skills', '<div>card</div>', 0), '');
  });

  test('returns empty string when count is falsy', () => {
    assert.equal(discoverHtml('mcp', '', null), '');
    assert.equal(discoverHtml('mcp', '', undefined), '');
  });

  test('returns HTML when count > 0', () => {
    const html = discoverHtml('skills', '', 3);
    assert.ok(html.length > 0);
  });

  test('embeds correct body id', () => {
    const html = discoverHtml('mcp', '', 1);
    assert.ok(html.includes('id="db-mcp"'));
  });

  test('embeds correct header id', () => {
    const html = discoverHtml('hooks', '', 1);
    assert.ok(html.includes('id="dh-hooks"'));
  });

  test('includes toggleDiscover call with correct id', () => {
    const html = discoverHtml('agents', '', 2);
    assert.ok(html.includes("toggleDiscover(this,'agents')"));
  });

  test('uses singular SUGGESTION when count is 1', () => {
    const html = discoverHtml('skills', '', 1);
    assert.ok(html.includes('1 SUGGESTION'));
    assert.ok(!html.includes('SUGGESTIONS'));
  });

  test('uses plural SUGGESTIONS when count > 1', () => {
    const html = discoverHtml('agents', '', 5);
    assert.ok(html.includes('5 SUGGESTIONS'));
  });

  test('embeds card HTML inside discover-body', () => {
    const cards = '<div class="suggest-card">card-content</div>';
    const html = discoverHtml('hooks', cards, 1);
    assert.ok(html.includes(cards));
    assert.ok(html.includes('class="discover-body"'));
  });

  test('discover-body starts hidden', () => {
    const html = discoverHtml('skills', '', 2);
    assert.ok(html.includes('style="display:none"'));
  });

  test('different ids produce non-conflicting output', () => {
    const a = discoverHtml('skills', '', 1);
    const b = discoverHtml('agents', '', 1);
    assert.ok(a.includes('db-skills') && !a.includes('db-agents'));
    assert.ok(b.includes('db-agents') && !b.includes('db-skills'));
  });
});

// ── CORS origin check ─────────────────────────────────────────────────────────

describe('CORS cross-origin check', () => {
  test('GET requests are never cross-origin blocked', () => {
    assert.equal(isCrossOrigin('GET', 'https://evil.com', 3200), false);
  });

  test('OPTIONS requests are never blocked (preflight)', () => {
    assert.equal(isCrossOrigin('OPTIONS', 'https://evil.com', 3200), false);
  });

  test('POST with no origin is allowed (same-tab request)', () => {
    assert.equal(isCrossOrigin('POST', undefined, 3200), false);
    assert.equal(isCrossOrigin('POST', null, 3200), false);
    assert.equal(isCrossOrigin('POST', '', 3200), false);
  });

  test('POST from localhost is allowed', () => {
    assert.equal(isCrossOrigin('POST', 'http://localhost:3200', 3200), false);
  });

  test('POST from 127.0.0.1 is allowed', () => {
    assert.equal(isCrossOrigin('POST', 'http://127.0.0.1:3200', 3200), false);
  });

  test('POST from external origin is blocked', () => {
    assert.equal(isCrossOrigin('POST', 'https://evil.com', 3200), true);
  });

  test('POST from localhost on different port is blocked', () => {
    assert.equal(isCrossOrigin('POST', 'http://localhost:8080', 3200), true);
  });

  test('PUT from external origin is blocked', () => {
    assert.equal(isCrossOrigin('PUT', 'https://attacker.io', 3200), true);
  });

  test('DELETE from external origin is blocked', () => {
    assert.equal(isCrossOrigin('DELETE', 'https://attacker.io', 3200), true);
  });

  test('POST from null origin string is blocked', () => {
    // 'null' string (sent by some browsers for opaque origins) is not the same as JS null
    assert.equal(isCrossOrigin('POST', 'null', 3200), true);
  });
});

// ── PWA manifest ──────────────────────────────────────────────────────────────

describe('PWA manifest', () => {
  test('has required name and short_name', () => {
    const m = buildManifest();
    assert.ok(m.name);
    assert.ok(m.short_name);
  });

  test('display is standalone (required for Chrome install prompt)', () => {
    assert.equal(buildManifest().display, 'standalone');
  });

  test('start_url is root', () => {
    assert.equal(buildManifest().start_url, '/');
  });

  test('theme_color is LCARS orange', () => {
    assert.equal(buildManifest().theme_color, '#FF9900');
  });

  test('includes 192x192 PNG icon', () => {
    const icon = buildManifest().icons.find(i => i.sizes === '192x192');
    assert.ok(icon, 'must have 192x192 icon');
    assert.equal(icon.type, 'image/png');
    assert.equal(icon.src, '/icon-192.png');
  });

  test('includes 512x512 PNG icon', () => {
    const icon = buildManifest().icons.find(i => i.sizes === '512x512');
    assert.ok(icon, 'must have 512x512 icon');
    assert.equal(icon.type, 'image/png');
    assert.equal(icon.src, '/icon-512.png');
  });

  test('includes SVG icon as fallback', () => {
    const icon = buildManifest().icons.find(i => i.type === 'image/svg+xml');
    assert.ok(icon, 'must have SVG icon');
    assert.equal(icon.src, '/icon.svg');
  });

  test('has at least 3 icons', () => {
    assert.ok(buildManifest().icons.length >= 3);
  });
});

// ── suggestion deduplication ─────────────────────────────────────────────────

describe('suggestion deduplication', () => {
  const SUGG = [
    { name: 'code-review', desc: 'Code review' },
    { name: 'commit', desc: 'Git commit' },
    { name: 'deploy-check', desc: 'Pre-deploy checks' },
  ];

  test('returns all suggestions when nothing is installed', () => {
    assert.equal(filterByName(SUGG, []).length, 3);
  });

  test('filters out a single installed item', () => {
    const result = filterByName(SUGG, ['code-review']);
    assert.equal(result.length, 2);
    assert.ok(!result.find(s => s.name === 'code-review'));
  });

  test('filters out multiple installed items', () => {
    const result = filterByName(SUGG, ['code-review', 'commit']);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'deploy-check');
  });

  test('returns empty array when all suggestions are installed', () => {
    assert.equal(filterByName(SUGG, ['code-review', 'commit', 'deploy-check']).length, 0);
  });

  test('ignores installed names not present in suggestions', () => {
    assert.equal(filterByName(SUGG, ['unrelated-skill', 'another-one']).length, 3);
  });

  test('is case-sensitive', () => {
    // 'Code-Review' should NOT filter 'code-review'
    assert.equal(filterByName(SUGG, ['Code-Review', 'COMMIT']).length, 3);
  });

  test('handles empty suggestions array', () => {
    assert.equal(filterByName([], ['code-review']).length, 0);
  });

  test('Set deduplication handles duplicate installed entries', () => {
    // Same name listed twice in installed should not cause issues
    assert.equal(filterByName(SUGG, ['code-review', 'code-review']).length, 2);
  });
});

// ── escA (HTML attribute JSON encoding) ──────────────────────────────────────

describe('escA', () => {
  test('wraps plain string in &quot; instead of raw double quotes', () => {
    const result = escA('hello');
    assert.equal(result, '&quot;hello&quot;');
  });

  test('escapes double quotes inside the string as \\&quot;', () => {
    const result = escA('say "hi"');
    assert.ok(result.includes('&quot;'));
    assert.ok(!result.includes('"say"') && !result.match(/[^\\]"/));
  });

  test('HTML-decoded result round-trips correctly', () => {
    // Simulate what the browser does: replace &quot; back to "
    const input = 'code-review';
    const encoded = escA(input);
    const htmlDecoded = encoded.replace(/&quot;/g, '"');
    // Should be valid JSON
    assert.equal(JSON.parse(htmlDecoded), input);
  });

  test('preserves single quotes unchanged (safe inside double-quoted HTML attrs)', () => {
    const result = escA("it's fine");
    assert.ok(result.includes("'"));
  });

  test('escapes angle brackets from JSON context', () => {
    const result = escA('<script>');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('\\u003cscript\\u003e'));
  });

  test('escapes backticks to prevent template literal injection', () => {
    const result = escA('hello `world`');
    assert.ok(!result.includes('`'));
  });

  test('content with double-quoted JSON values round-trips', () => {
    // Simulates MCP config: {"command":"npx","args":["-y","pkg"]}
    const input = JSON.stringify({ command: 'npx', args: ['-y', 'pkg'] });
    const encoded = escA(input);
    // No raw double quotes in output
    assert.ok(!encoded.match(/(?<!\\)"/));
    // Decoding &quot; back should give valid JSON string
    const decoded = encoded.replace(/&quot;/g, '"');
    const parsed = JSON.parse(decoded);
    assert.equal(JSON.parse(parsed).command, 'npx');
  });
});

// ── Marketplace path traversal protection ─────────────────────────────────────

// Inlined from /api/marketplace/install security check in server.js
function isAllowedMarketplacePath(sourcePath, allowedBase) {
  const resolved = path.resolve(sourcePath);
  return resolved.startsWith(allowedBase + path.sep);
}

describe('marketplace path traversal protection', () => {
  test('allows path directly inside allowed base', () => {
    const base = '/home/user/.claude/plugins/marketplaces';
    assert.equal(isAllowedMarketplacePath(base + '/mkt/plugins/cool-plugin', base), true);
  });

  test('blocks path traversal above allowed base', () => {
    const base = '/home/user/.claude/plugins/marketplaces';
    assert.equal(isAllowedMarketplacePath(base + '/../../../etc/passwd', base), false);
  });

  test('blocks the allowed base directory itself (not a subdirectory)', () => {
    const base = '/home/user/.claude/plugins/marketplaces';
    assert.equal(isAllowedMarketplacePath(base, base), false);
  });

  test('blocks sibling directory with shared prefix', () => {
    // e.g. /marketplaces-evil should not match /marketplaces
    const base = '/home/user/.claude/plugins/marketplaces';
    assert.equal(isAllowedMarketplacePath('/home/user/.claude/plugins/marketplaces-evil/x', base), false);
  });

  test('blocks absolute path to unrelated system location', () => {
    const base = '/home/user/.claude/plugins/marketplaces';
    assert.equal(isAllowedMarketplacePath('/etc/shadow', base), false);
  });

  test('allows deeply nested path inside allowed base', () => {
    const base = '/home/user/.claude/plugins/marketplaces';
    assert.equal(isAllowedMarketplacePath(base + '/a/b/c/d', base), true);
  });
});

// ── install-remote settings merge ────────────────────────────────────────────

// Inlined logic from /api/marketplace/install-remote in server.js
function mergeRemoteMcp(settings, name, command, args) {
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers[name] = { command, args: args || [] };
  return settings;
}

describe('install-remote settings merge', () => {
  test('adds new server to empty settings', () => {
    const s = mergeRemoteMcp({}, 'my-server', 'npx', ['-y', 'my-server']);
    assert.deepEqual(s.mcpServers['my-server'], { command: 'npx', args: ['-y', 'my-server'] });
  });

  test('creates mcpServers key if missing', () => {
    const s = mergeRemoteMcp({ otherKey: true }, 'srv', 'npx', []);
    assert.ok('mcpServers' in s);
  });

  test('adds to existing mcpServers without removing others', () => {
    const existing = { mcpServers: { 'existing': { command: 'node', args: ['./srv.js'] } } };
    const s = mergeRemoteMcp(existing, 'new-server', 'npx', ['-y', 'new-server']);
    assert.ok('existing' in s.mcpServers);
    assert.ok('new-server' in s.mcpServers);
  });

  test('overwrites existing entry with same name', () => {
    const existing = { mcpServers: { 'srv': { command: 'node', args: ['old.js'] } } };
    const s = mergeRemoteMcp(existing, 'srv', 'npx', ['-y', 'srv']);
    assert.equal(s.mcpServers['srv'].command, 'npx');
    assert.deepEqual(s.mcpServers['srv'].args, ['-y', 'srv']);
  });

  test('defaults args to empty array when not provided', () => {
    const s = mergeRemoteMcp({}, 'bare', 'uvx', undefined);
    assert.deepEqual(s.mcpServers['bare'].args, []);
  });

  test('persists through a write/read cycle via tmp file', () => {
    const tmp = makeTmpDir();
    try {
      const settingsPath = path.join(tmp, 'settings.json');
      let settings = {};
      settings = mergeRemoteMcp(settings, 'test-srv', 'npx', ['-y', 'test-srv']);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      const readBack = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.equal(readBack.mcpServers['test-srv'].command, 'npx');
    } finally { rimraf(tmp); }
  });
});

// ── remote marketplace item normalization ─────────────────────────────────────

// Inlined from /api/remote-marketplace in server.js
function normalizeRemoteItem(name, description, source, sourceLabel) {
  const shortName = name.includes('/') ? name.split('/').pop() : name;
  return { id: source + ':' + name, name, shortName, description: description || '', type: 'mcp', source, sourceLabel, command: 'npx', args: ['-y', name] };
}

function deduplicateRemoteItems(rawItems) {
  const seen = new Set();
  const results = [];
  for (const item of rawItems) {
    if (!item.name || seen.has(item.name)) continue;
    seen.add(item.name);
    results.push(item);
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

describe('remote marketplace normalization', () => {
  test('extracts shortName from scoped package', () => {
    const item = normalizeRemoteItem('@scope/my-server', 'desc', 'npm', 'NPM');
    assert.equal(item.shortName, 'my-server');
  });

  test('shortName equals name for unscoped package', () => {
    const item = normalizeRemoteItem('plain-server', 'desc', 'npm', 'NPM');
    assert.equal(item.shortName, 'plain-server');
  });

  test('id is source:name', () => {
    const item = normalizeRemoteItem('@scope/srv', '', 'registry', 'MCP REGISTRY');
    assert.equal(item.id, 'registry:@scope/srv');
  });

  test('type is always mcp', () => {
    assert.equal(normalizeRemoteItem('any', '', 'npm', 'NPM').type, 'mcp');
  });

  test('command is npx and args include -y and name', () => {
    const item = normalizeRemoteItem('@pkg/srv', '', 'npm', 'NPM');
    assert.equal(item.command, 'npx');
    assert.deepEqual(item.args, ['-y', '@pkg/srv']);
  });

  test('empty description defaults to empty string', () => {
    assert.equal(normalizeRemoteItem('srv', null, 'npm', 'NPM').description, '');
  });

  test('deduplication removes items with duplicate names', () => {
    const items = [
      normalizeRemoteItem('srv-a', 'first', 'registry', 'REGISTRY'),
      normalizeRemoteItem('srv-a', 'duplicate', 'npm', 'NPM'),
      normalizeRemoteItem('srv-b', 'second', 'npm', 'NPM'),
    ];
    const deduped = deduplicateRemoteItems(items);
    assert.equal(deduped.length, 2);
    assert.equal(deduped.find(i => i.name === 'srv-a').description, 'first');
  });

  test('deduplication sorts result alphabetically', () => {
    const items = ['zebra', 'apple', 'mango'].map(n => normalizeRemoteItem(n, '', 'npm', 'NPM'));
    const deduped = deduplicateRemoteItems(items);
    assert.deepEqual(deduped.map(i => i.name), ['apple', 'mango', 'zebra']);
  });

  test('deduplication skips items with empty name', () => {
    const items = [
      { name: '', description: '' },
      normalizeRemoteItem('valid', '', 'npm', 'NPM'),
    ];
    assert.equal(deduplicateRemoteItems(items).length, 1);
  });
});
