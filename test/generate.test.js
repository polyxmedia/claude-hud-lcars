import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hud-test-'));
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── inlined functions under test (sourced from generate.js) ──────────────────

function getSkills(claudeDir) {
  const dir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const f = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    let raw;
    try { raw = fs.readFileSync(f, 'utf-8'); } catch(e) { continue; }
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    let name = entry.name, desc = '', ver = '', ctx = '';
    if (fm) {
      const t = fm[1];
      name = t.match(/^name:\s*(.+)$/m)?.[1] || name;
      desc = t.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.slice(0, 200) || '';
      ver = t.match(/^version:\s*(.+)$/m)?.[1] || '';
      ctx = t.match(/^context:\s*(.+)$/m)?.[1] || '';
    }
    out.push({ name, desc, ver, ctx, body: raw.replace(/^---\n[\s\S]*?\n---\n*/, '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function getAgents(claudeDir) {
  const dir = path.join(claudeDir, 'agents');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch(e) { continue; }
    const name = f.replace('.md', '');
    const desc = raw.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.slice(0, 200) || '';
    out.push({ name, desc, body: raw.replace(/^---\n[\s\S]*?\n---\n*/, '') });
  }
  return out;
}

function getMemoryFiles(claudeDir) {
  const out = [];
  const dir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(dir)) return out;
  for (const p of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    const md = path.join(dir, p.name, 'memory');
    if (!fs.existsSync(md)) continue;
    for (const f of fs.readdirSync(md)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      let raw;
      try { raw = fs.readFileSync(path.join(md, f), 'utf-8'); } catch(e) { continue; }
      out.push({
        proj: p.name.replace(/-/g, '/').replace(/^\//, ''), file: f,
        name: raw.match(/^name:\s*(.+)$/m)?.[1] || f.replace('.md', ''),
        type: raw.match(/^type:\s*(.+)$/m)?.[1] || 'unknown',
        body: raw.replace(/^---\n[\s\S]*?\n---\n*/, ''),
      });
    }
  }
  return out;
}

function parseMcpEntry(name, c, source) {
  let serverType = 'unknown';
  const mainArg = (c.args || []).slice(-1)[0] || '';
  if (c.command === 'node') serverType = 'node';
  else if (c.command === 'uvx' || c.command === 'uv') serverType = 'python';
  else if (c.command === 'npx') serverType = 'npx';
  else if (c.command === 'docker') serverType = 'docker';

  let fileStatus = 'unknown';
  if (mainArg.endsWith('.js') || mainArg.endsWith('.mjs') || mainArg.endsWith('.py')) {
    fileStatus = fs.existsSync(mainArg) ? 'found' : 'missing';
  }

  const envCount = c.env ? Object.keys(c.env).length : 0;
  return {
    name, cmd: c.command, args: c.args || [], hasEnv: !!c.env,
    serverType, fileStatus, envCount, source,
    entryPoint: mainArg,
    config: { ...c, env: c.env ? '{redacted — ' + envCount + ' vars}' : undefined },
  };
}

function getHooks(s) {
  if (!s?.hooks) return [];
  const out = [];
  for (const [ev, ms] of Object.entries(s.hooks)) {
    if (!Array.isArray(ms)) continue;
    for (const m of ms) {
      if (!m.hooks) continue;
      for (const h of m.hooks) {
        out.push({ ev, matcher: m.matcher || '*', type: h.type,
          cmd: h.command || h.prompt || h.url || '',
          async: h.async || h.asyncRewake || false, full: h });
      }
    }
  }
  return out;
}

function getPlugins(s) {
  if (!s?.enabledPlugins) return [];
  return Object.entries(s.enabledPlugins).map(([id, en]) => ({ id, on: !!en }));
}

function getSettings(claudeDir) {
  const p = path.join(claudeDir, 'settings.json');
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; }
  catch(e) { return null; }
}

function getMcpServers(s, claudeDir) {
  const out = [];
  const seen = new Set();
  if (s?.mcpServers) {
    for (const [name, c] of Object.entries(s.mcpServers)) {
      out.push(parseMcpEntry(name, c, 'settings.json'));
      seen.add(name);
    }
  }
  const homeMcp = path.join(claudeDir, '.mcp.json');
  if (fs.existsSync(homeMcp)) {
    try {
      const data = JSON.parse(fs.readFileSync(homeMcp, 'utf-8'));
      if (data.mcpServers) {
        for (const [name, c] of Object.entries(data.mcpServers)) {
          if (!seen.has(name)) { out.push(parseMcpEntry(name, c, '.mcp.json')); seen.add(name); }
        }
      }
    } catch(e) {}
  }
  return out;
}

function getSessionCount(claudeDir) {
  const d = path.join(claudeDir, 'sessions');
  return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).length : 0;
}

function getSessions(claudeDir) {
  const out = [];
  const d = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8'));
      out.push({
        id: raw.sessionId || f.replace('.json', ''),
        pid: raw.pid || '',
        cwd: raw.cwd || '',
        project: (raw.cwd || '').split('/').slice(-2).join('/'),
        started: raw.startedAt || 0,
        kind: raw.kind || 'unknown',
        entry: raw.entrypoint || '',
      });
    } catch(e) {}
  }
  return out.sort((a, b) => b.started - a.started);
}

function getHistory(claudeDir) {
  const p = path.join(claudeDir, 'history.jsonl');
  if (!fs.existsSync(p)) return [];
  const out = [];
  try {
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines.slice(-200)) {
      try {
        const h = JSON.parse(line);
        out.push({
          msg: (h.display || '').slice(0, 120),
          ts: h.timestamp || 0,
          project: (h.project || '').split('/').slice(-2).join('/'),
          sid: h.sessionId || '',
        });
      } catch(e) {}
    }
  } catch(e) {}
  return out;
}

function getClaudeMdFiles(claudeDir) {
  const out = [];
  const globalPath = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, 'utf-8');
      out.push({ scope: 'GLOBAL', path: globalPath, project: '~/.claude/', body: raw, size: raw.length });
    } catch(e) {}
  }
  const projDir = path.join(claudeDir, 'projects');
  if (fs.existsSync(projDir)) {
    for (const p of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const cp = path.join(projDir, p.name, 'CLAUDE.md');
      if (!fs.existsSync(cp)) continue;
      try {
        const raw = fs.readFileSync(cp, 'utf-8');
        const proj = p.name.replace(/-/g, '/').replace(/^\//, '');
        out.push({ scope: 'PROJECT', path: cp, project: proj, body: raw, size: raw.length });
      } catch(e) {}
    }
  }
  return out;
}

function getEnv(s) { return s?.env || {}; }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escJ(s) {
  return JSON.stringify(s).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/`/g,'\\u0060').replace(/\$/g,'\\u0024');
}

// ── getSkills ─────────────────────────────────────────────────────────────────

describe('getSkills', () => {
  test('returns empty array when skills dir does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getSkills(tmp), []); } finally { rimraf(tmp); }
  });

  test('returns empty array when skills dir is empty', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'skills'));
      assert.deepEqual(getSkills(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('parses a valid skill with frontmatter', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'skills', 'my-skill');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: my-skill\ndescription: Does something useful\nversion: 1.0.0\ncontext: fork\n---\n\n# Body');
      const skills = getSkills(tmp);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'my-skill');
      assert.equal(skills[0].desc, 'Does something useful');
      assert.equal(skills[0].ver, '1.0.0');
      assert.equal(skills[0].ctx, 'fork');
      assert.ok(skills[0].body.includes('# Body'));
    } finally { rimraf(tmp); }
  });

  test('strips frontmatter from body', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'skills', 'clean');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: clean\n---\n\nJust the body.');
      const skills = getSkills(tmp);
      assert.ok(!skills[0].body.includes('---'));
      assert.ok(skills[0].body.includes('Just the body.'));
    } finally { rimraf(tmp); }
  });

  test('skips skill directory with no SKILL.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'skills', 'empty'), { recursive: true });
      assert.deepEqual(getSkills(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('skips unreadable SKILL.md without crashing', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'skills', 'bad');
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, 'SKILL.md');
      fs.writeFileSync(f, 'content');
      fs.chmodSync(f, 0o000);
      assert.deepEqual(getSkills(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('returns skills sorted alphabetically', () => {
    const tmp = makeTmpDir();
    try {
      for (const name of ['zebra', 'apple', 'mango']) {
        const d = path.join(tmp, 'skills', name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\n---\n`);
      }
      assert.deepEqual(getSkills(tmp).map(s => s.name), ['apple', 'mango', 'zebra']);
    } finally { rimraf(tmp); }
  });

  test('falls back to directory name when frontmatter has no name', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'skills', 'dir-name');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), '# No frontmatter\n');
      assert.equal(getSkills(tmp)[0].name, 'dir-name');
    } finally { rimraf(tmp); }
  });

  test('truncates description to 200 chars', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'skills', 'long');
      fs.mkdirSync(d, { recursive: true });
      const longDesc = 'x'.repeat(300);
      fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: long\ndescription: ${longDesc}\n---\n`);
      assert.equal(getSkills(tmp)[0].desc.length, 200);
    } finally { rimraf(tmp); }
  });
});

// ── getAgents ─────────────────────────────────────────────────────────────────

describe('getAgents', () => {
  test('returns empty array when agents dir does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getAgents(tmp), []); } finally { rimraf(tmp); }
  });

  test('parses agent files', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'agents', 'my-agent.md'), '---\ndescription: A test agent\n---\n\nAgent body.');
      const agents = getAgents(tmp);
      assert.equal(agents.length, 1);
      assert.equal(agents[0].name, 'my-agent');
      assert.equal(agents[0].desc, 'A test agent');
      assert.ok(agents[0].body.includes('Agent body.'));
    } finally { rimraf(tmp); }
  });

  test('ignores non-.md files in agents dir', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'agents', 'readme.txt'), 'ignore me');
      assert.deepEqual(getAgents(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('handles agent with no description gracefully', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'agents', 'nodesc.md'), '# Just a title\n\nBody text.');
      const agents = getAgents(tmp);
      assert.equal(agents[0].desc, '');
      assert.ok(agents[0].body.includes('Body text.'));
    } finally { rimraf(tmp); }
  });

  test('skips unreadable agent files without crashing', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      const f = path.join(tmp, 'agents', 'locked.md');
      fs.writeFileSync(f, 'content');
      fs.chmodSync(f, 0o000);
      assert.doesNotThrow(() => getAgents(tmp));
      assert.deepEqual(getAgents(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('parses multiple agents', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'agents', 'alpha.md'), '---\ndescription: Alpha\n---\n');
      fs.writeFileSync(path.join(tmp, 'agents', 'beta.md'), '---\ndescription: Beta\n---\n');
      assert.equal(getAgents(tmp).length, 2);
    } finally { rimraf(tmp); }
  });
});

// ── getMemoryFiles ────────────────────────────────────────────────────────────

describe('getMemoryFiles', () => {
  test('returns empty array when projects dir does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getMemoryFiles(tmp), []); } finally { rimraf(tmp); }
  });

  test('returns empty when no memory subdirectories exist', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'projects', 'my-project'), { recursive: true });
      assert.deepEqual(getMemoryFiles(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('parses memory files with frontmatter', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', '-Users-andre-myproject', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'user_role.md'), '---\nname: User Role\ntype: user\n---\n\nAndre is a developer.');
      const files = getMemoryFiles(tmp);
      assert.equal(files.length, 1);
      assert.equal(files[0].name, 'User Role');
      assert.equal(files[0].type, 'user');
      assert.ok(files[0].body.includes('Andre is a developer.'));
    } finally { rimraf(tmp); }
  });

  test('skips MEMORY.md index file', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', 'proj', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Index');
      assert.deepEqual(getMemoryFiles(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('skips unreadable memory files without crashing', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', 'proj', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      const f = path.join(memDir, 'locked.md');
      fs.writeFileSync(f, 'content');
      fs.chmodSync(f, 0o000);
      assert.doesNotThrow(() => getMemoryFiles(tmp));
      assert.deepEqual(getMemoryFiles(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('defaults type to unknown when missing', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', 'proj', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'notype.md'), '---\nname: No Type\n---\nBody.');
      assert.equal(getMemoryFiles(tmp)[0].type, 'unknown');
    } finally { rimraf(tmp); }
  });

  test('converts project dir dashes to path slashes', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', '-Users-andre-Code', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'file.md'), '---\nname: f\ntype: user\n---\n');
      const proj = getMemoryFiles(tmp)[0].proj;
      assert.ok(proj.includes('/'), 'should contain forward slashes');
    } finally { rimraf(tmp); }
  });
});

// ── parseMcpEntry ─────────────────────────────────────────────────────────────

describe('parseMcpEntry', () => {
  test('detects node server type', () => {
    const e = parseMcpEntry('srv', { command: 'node', args: ['/path/server.js'] }, 'settings.json');
    assert.equal(e.serverType, 'node');
  });

  test('detects npx server type', () => {
    const e = parseMcpEntry('srv', { command: 'npx', args: ['some-pkg'] }, 'settings.json');
    assert.equal(e.serverType, 'npx');
  });

  test('detects python server type for uvx', () => {
    const e = parseMcpEntry('srv', { command: 'uvx', args: ['tool'] }, 'settings.json');
    assert.equal(e.serverType, 'python');
  });

  test('detects python server type for uv', () => {
    const e = parseMcpEntry('srv', { command: 'uv', args: ['run', 'server.py'] }, 'settings.json');
    assert.equal(e.serverType, 'python');
  });

  test('detects docker server type', () => {
    const e = parseMcpEntry('srv', { command: 'docker', args: ['run', 'img'] }, 'settings.json');
    assert.equal(e.serverType, 'docker');
  });

  test('unknown server type for unrecognised command', () => {
    const e = parseMcpEntry('srv', { command: 'ruby', args: ['server.rb'] }, 'settings.json');
    assert.equal(e.serverType, 'unknown');
  });

  test('marks .js entry point as missing when file does not exist', () => {
    const e = parseMcpEntry('srv', { command: 'node', args: ['/nonexistent/server.js'] }, 'settings.json');
    assert.equal(e.fileStatus, 'missing');
  });

  test('marks entry point as found when file exists', () => {
    const tmp = makeTmpDir();
    try {
      const f = path.join(tmp, 'server.js');
      fs.writeFileSync(f, '// server');
      const e = parseMcpEntry('srv', { command: 'node', args: [f] }, 'settings.json');
      assert.equal(e.fileStatus, 'found');
    } finally { rimraf(tmp); }
  });

  test('fileStatus is unknown for non-file args', () => {
    const e = parseMcpEntry('srv', { command: 'npx', args: ['some-package'] }, 'settings.json');
    assert.equal(e.fileStatus, 'unknown');
  });

  test('redacts env vars in config', () => {
    const e = parseMcpEntry('srv', { command: 'node', args: [], env: { SECRET: 'shh', TOKEN: 'abc' } }, 'settings.json');
    assert.ok(typeof e.config.env === 'string');
    assert.ok(e.config.env.includes('redacted'));
    assert.ok(e.config.env.includes('2'));
    assert.equal(e.envCount, 2);
    assert.equal(e.hasEnv, true);
  });

  test('envCount is 0 when no env', () => {
    const e = parseMcpEntry('srv', { command: 'node', args: [] }, 'settings.json');
    assert.equal(e.envCount, 0);
    assert.equal(e.hasEnv, false);
  });

  test('args defaults to empty array when not provided', () => {
    const e = parseMcpEntry('srv', { command: 'node' }, 'settings.json');
    assert.deepEqual(e.args, []);
  });

  test('preserves name and source', () => {
    const e = parseMcpEntry('my-server', { command: 'node', args: [] }, 'project/.mcp.json');
    assert.equal(e.name, 'my-server');
    assert.equal(e.source, 'project/.mcp.json');
  });
});

// ── getHooks ──────────────────────────────────────────────────────────────────

describe('getHooks', () => {
  test('returns empty array when settings has no hooks', () => {
    assert.deepEqual(getHooks({}), []);
    assert.deepEqual(getHooks(null), []);
    assert.deepEqual(getHooks({ mcpServers: {} }), []);
  });

  test('extracts a single hook', () => {
    const s = {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    };
    const hooks = getHooks(s);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].ev, 'PostToolUse');
    assert.equal(hooks[0].matcher, 'Bash');
    assert.equal(hooks[0].type, 'command');
    assert.equal(hooks[0].cmd, 'echo hi');
  });

  test('extracts multiple events and hooks', () => {
    const s = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'pre' }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'post' }] }],
      },
    };
    assert.equal(getHooks(s).length, 2);
  });

  test('defaults matcher to * when not set', () => {
    const s = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'run' }] }],
      },
    };
    assert.equal(getHooks(s)[0].matcher, '*');
  });

  test('picks up prompt-type hook cmd', () => {
    const s = {
      hooks: {
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', prompt: 'Do X' }] }],
      },
    };
    assert.equal(getHooks(s)[0].cmd, 'Do X');
  });

  test('picks up async flag', () => {
    const s = {
      hooks: {
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', async: true }] }],
      },
    };
    assert.equal(getHooks(s)[0].async, true);
  });

  test('skips matchers with no hooks array', () => {
    const s = { hooks: { PostToolUse: [{ matcher: 'Bash' }] } };
    assert.deepEqual(getHooks(s), []);
  });
});

// ── getPlugins ────────────────────────────────────────────────────────────────

describe('getPlugins', () => {
  test('returns empty array when no enabledPlugins', () => {
    assert.deepEqual(getPlugins({}), []);
    assert.deepEqual(getPlugins(null), []);
  });

  test('maps enabled plugins correctly', () => {
    const s = { enabledPlugins: { 'my-plugin': true, 'off-plugin': false } };
    const plugins = getPlugins(s);
    assert.equal(plugins.length, 2);
    const on = plugins.find(p => p.id === 'my-plugin');
    const off = plugins.find(p => p.id === 'off-plugin');
    assert.equal(on.on, true);
    assert.equal(off.on, false);
  });
});

// ── getEnv ────────────────────────────────────────────────────────────────────

describe('getEnv', () => {
  test('returns empty object when no env', () => {
    assert.deepEqual(getEnv({}), {});
    assert.deepEqual(getEnv(null), {});
  });

  test('returns env object from settings', () => {
    const s = { env: { FOO: 'bar', COUNT: '42' } };
    assert.deepEqual(getEnv(s), { FOO: 'bar', COUNT: '42' });
  });
});

// ── esc / escJ ────────────────────────────────────────────────────────────────

describe('esc', () => {
  test('escapes &', () => assert.equal(esc('a & b'), 'a &amp; b'));
  test('escapes <', () => assert.equal(esc('<div>'), '&lt;div&gt;'));
  test('escapes "', () => assert.equal(esc('"hi"'), '&quot;hi&quot;'));
  test('handles non-string input', () => assert.equal(esc(42), '42'));
  test('no-ops clean string', () => assert.equal(esc('hello'), 'hello'));
});

describe('escJ', () => {
  test('escapes < and > to unicode', () => {
    const out = escJ('<script>');
    assert.ok(out.includes('\\u003c'));
    assert.ok(out.includes('\\u003e'));
  });

  test('escapes backtick', () => {
    const out = escJ('`template`');
    assert.ok(out.includes('\\u0060'));
  });

  test('escapes $', () => {
    const out = escJ('${injection}');
    assert.ok(out.includes('\\u0024'));
  });

  test('output is valid JSON', () => {
    const out = escJ({ key: '<value>' });
    assert.doesNotThrow(() => JSON.parse(out));
  });
});

// ── getSettings ───────────────────────────────────────────────────────────────

describe('getSettings', () => {
  test('returns null when settings.json does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.equal(getSettings(tmp), null); } finally { rimraf(tmp); }
  });

  test('parses valid settings.json', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ env: { FOO: 'bar' } }));
      const s = getSettings(tmp);
      assert.deepEqual(s.env, { FOO: 'bar' });
    } finally { rimraf(tmp); }
  });

  test('returns null on malformed JSON', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'settings.json'), '{ not valid json }');
      assert.equal(getSettings(tmp), null);
    } finally { rimraf(tmp); }
  });

  test('returns null on empty file', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'settings.json'), '');
      assert.equal(getSettings(tmp), null);
    } finally { rimraf(tmp); }
  });

  test('parses settings with mcpServers and hooks', () => {
    const tmp = makeTmpDir();
    try {
      const data = { mcpServers: { boost: { command: 'php', args: ['artisan'] } }, hooks: {} };
      fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(data));
      const s = getSettings(tmp);
      assert.ok(s.mcpServers.boost);
      assert.equal(s.mcpServers.boost.command, 'php');
    } finally { rimraf(tmp); }
  });
});

// ── getMcpServers ─────────────────────────────────────────────────────────────

describe('getMcpServers', () => {
  test('returns empty when settings has no mcpServers', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getMcpServers({}, tmp), []); } finally { rimraf(tmp); }
  });

  test('returns empty when settings is null', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getMcpServers(null, tmp), []); } finally { rimraf(tmp); }
  });

  test('reads servers from settings.mcpServers', () => {
    const tmp = makeTmpDir();
    try {
      const s = { mcpServers: { myserver: { command: 'node', args: ['srv.js'] } } };
      const servers = getMcpServers(s, tmp);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].name, 'myserver');
      assert.equal(servers[0].source, 'settings.json');
    } finally { rimraf(tmp); }
  });

  test('reads servers from .mcp.json in claudeDir', () => {
    const tmp = makeTmpDir();
    try {
      const mcp = { mcpServers: { remote: { command: 'npx', args: ['remote-pkg'] } } };
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify(mcp));
      const servers = getMcpServers({}, tmp);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].name, 'remote');
      assert.equal(servers[0].source, '.mcp.json');
    } finally { rimraf(tmp); }
  });

  test('deduplicates servers by name — settings.json wins', () => {
    const tmp = makeTmpDir();
    try {
      const s = { mcpServers: { shared: { command: 'node', args: [] } } };
      const mcp = { mcpServers: { shared: { command: 'npx', args: ['other'] } } };
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify(mcp));
      const servers = getMcpServers(s, tmp);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].source, 'settings.json');
    } finally { rimraf(tmp); }
  });

  test('ignores malformed .mcp.json without crashing', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, '.mcp.json'), '{ bad json }');
      assert.doesNotThrow(() => getMcpServers({}, tmp));
    } finally { rimraf(tmp); }
  });
});

// ── getSessionCount ───────────────────────────────────────────────────────────

describe('getSessionCount', () => {
  test('returns 0 when sessions dir does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.equal(getSessionCount(tmp), 0); } finally { rimraf(tmp); }
  });

  test('returns 0 when sessions dir is empty', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'sessions'));
      assert.equal(getSessionCount(tmp), 0);
    } finally { rimraf(tmp); }
  });

  test('counts only directories, not files', () => {
    const tmp = makeTmpDir();
    try {
      const sessDir = path.join(tmp, 'sessions');
      fs.mkdirSync(sessDir);
      fs.mkdirSync(path.join(sessDir, 'session-1'));
      fs.mkdirSync(path.join(sessDir, 'session-2'));
      fs.writeFileSync(path.join(sessDir, 'not-a-dir.json'), '{}');
      assert.equal(getSessionCount(tmp), 2);
    } finally { rimraf(tmp); }
  });
});

// ── getSessions ───────────────────────────────────────────────────────────────

describe('getSessions', () => {
  test('returns empty array when sessions dir does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getSessions(tmp), []); } finally { rimraf(tmp); }
  });

  test('parses a session file', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'sessions');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'abc123.json'), JSON.stringify({
        sessionId: 'abc123', pid: 99, cwd: '/Users/andre/Code/myproject',
        startedAt: 1700000000, kind: 'interactive', entrypoint: 'index.js',
      }));
      const sessions = getSessions(tmp);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, 'abc123');
      assert.equal(sessions[0].pid, 99);
      assert.equal(sessions[0].project, 'Code/myproject');
      assert.equal(sessions[0].started, 1700000000);
      assert.equal(sessions[0].kind, 'interactive');
    } finally { rimraf(tmp); }
  });

  test('falls back to filename when sessionId missing', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'sessions');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'fallback.json'), JSON.stringify({ cwd: '/a/b', startedAt: 1 }));
      assert.equal(getSessions(tmp)[0].id, 'fallback');
    } finally { rimraf(tmp); }
  });

  test('skips malformed session files without crashing', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'sessions');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'bad.json'), 'not json at all');
      assert.doesNotThrow(() => getSessions(tmp));
      assert.deepEqual(getSessions(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('ignores non-.json files', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'sessions');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'readme.txt'), 'ignore');
      assert.deepEqual(getSessions(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('sorts sessions by startedAt descending', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'sessions');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'old.json'), JSON.stringify({ sessionId: 'old', startedAt: 1000 }));
      fs.writeFileSync(path.join(d, 'new.json'), JSON.stringify({ sessionId: 'new', startedAt: 9000 }));
      const sessions = getSessions(tmp);
      assert.equal(sessions[0].id, 'new');
      assert.equal(sessions[1].id, 'old');
    } finally { rimraf(tmp); }
  });
});

// ── getHistory ────────────────────────────────────────────────────────────────

describe('getHistory', () => {
  test('returns empty array when history.jsonl does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getHistory(tmp), []); } finally { rimraf(tmp); }
  });

  test('parses valid history lines', () => {
    const tmp = makeTmpDir();
    try {
      const line = JSON.stringify({ display: 'Fix bug', timestamp: 1700000000, project: '/Users/a/Code/proj', sessionId: 's1' });
      fs.writeFileSync(path.join(tmp, 'history.jsonl'), line + '\n');
      const h = getHistory(tmp);
      assert.equal(h.length, 1);
      assert.equal(h[0].msg, 'Fix bug');
      assert.equal(h[0].ts, 1700000000);
      assert.equal(h[0].project, 'Code/proj');
      assert.equal(h[0].sid, 's1');
    } finally { rimraf(tmp); }
  });

  test('skips malformed JSON lines without crashing', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'history.jsonl'), 'not json\n{"display":"ok","timestamp":1}\n');
      const h = getHistory(tmp);
      assert.equal(h.length, 1);
      assert.equal(h[0].msg, 'ok');
    } finally { rimraf(tmp); }
  });

  test('truncates display to 120 chars', () => {
    const tmp = makeTmpDir();
    try {
      const long = 'x'.repeat(200);
      fs.writeFileSync(path.join(tmp, 'history.jsonl'), JSON.stringify({ display: long, timestamp: 1 }) + '\n');
      assert.equal(getHistory(tmp)[0].msg.length, 120);
    } finally { rimraf(tmp); }
  });

  test('defaults ts to 0 and sid to empty when missing', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'history.jsonl'), JSON.stringify({ display: 'hi' }) + '\n');
      const h = getHistory(tmp)[0];
      assert.equal(h.ts, 0);
      assert.equal(h.sid, '');
    } finally { rimraf(tmp); }
  });

  test('handles empty history file', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'history.jsonl'), '');
      assert.deepEqual(getHistory(tmp), []);
    } finally { rimraf(tmp); }
  });
});

// ── getClaudeMdFiles ──────────────────────────────────────────────────────────

describe('getClaudeMdFiles', () => {
  test('returns empty when no CLAUDE.md files exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getClaudeMdFiles(tmp), []); } finally { rimraf(tmp); }
  });

  test('reads global CLAUDE.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Global rules\n\nBe helpful.');
      const files = getClaudeMdFiles(tmp);
      assert.equal(files.length, 1);
      assert.equal(files[0].scope, 'GLOBAL');
      assert.equal(files[0].project, '~/.claude/');
      assert.ok(files[0].body.includes('Be helpful.'));
      assert.equal(files[0].size, files[0].body.length);
    } finally { rimraf(tmp); }
  });

  test('reads project-level CLAUDE.md files', () => {
    const tmp = makeTmpDir();
    try {
      const projDir = path.join(tmp, 'projects', '-Users-andre-myproject');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Project rules');
      const files = getClaudeMdFiles(tmp);
      assert.equal(files.length, 1);
      assert.equal(files[0].scope, 'PROJECT');
      assert.ok(files[0].project.includes('/'));
    } finally { rimraf(tmp); }
  });

  test('reads both global and project CLAUDE.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Global');
      const projDir = path.join(tmp, 'projects', '-Users-andre-proj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Project');
      assert.equal(getClaudeMdFiles(tmp).length, 2);
    } finally { rimraf(tmp); }
  });

  test('skips project dirs with no CLAUDE.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'projects', 'no-claude'), { recursive: true });
      assert.deepEqual(getClaudeMdFiles(tmp), []);
    } finally { rimraf(tmp); }
  });

  test('skips unreadable CLAUDE.md without crashing', () => {
    const tmp = makeTmpDir();
    try {
      const f = path.join(tmp, 'CLAUDE.md');
      fs.writeFileSync(f, '# content');
      fs.chmodSync(f, 0o000);
      assert.doesNotThrow(() => getClaudeMdFiles(tmp));
      assert.deepEqual(getClaudeMdFiles(tmp), []);
    } finally { rimraf(tmp); }
  });
});

// ── getMarketplaceItems ───────────────────────────────────────────────────────

function getMarketplaceItems(claudeDir, installedMcpNames) {
  const marketplaceDir = path.join(claudeDir, 'plugins', 'marketplaces');
  if (!fs.existsSync(marketplaceDir)) return [];
  const installedPlugins = new Set();
  const pluginsRoot = path.join(claudeDir, 'plugins');
  if (fs.existsSync(pluginsRoot)) {
    for (const e of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'marketplaces') installedPlugins.add(e.name);
    }
  }
  const items = [];
  for (const mktEntry of fs.readdirSync(marketplaceDir, { withFileTypes: true })) {
    if (!mktEntry.isDirectory()) continue;
    const mktName = mktEntry.name;
    const mktPath = path.join(marketplaceDir, mktName);
    const pluginsDir = path.join(mktPath, 'plugins');
    if (fs.existsSync(pluginsDir)) {
      for (const pe of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!pe.isDirectory() || pe.name === 'README.md') continue;
        const pluginPath = path.join(pluginsDir, pe.name);
        const manifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
        let description = '', author = '';
        if (fs.existsSync(manifestPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            description = m.description || '';
            author = (m.author && m.author.name) ? m.author.name : '';
          } catch(e) {}
        }
        if (!description) {
          const readme = path.join(pluginPath, 'README.md');
          if (fs.existsSync(readme)) {
            try {
              const txt = fs.readFileSync(readme, 'utf-8');
              const lines = txt.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('!'));
              description = (lines[0] || '').slice(0, 180);
            } catch(e) {}
          }
        }
        const caps = [];
        if (fs.existsSync(path.join(pluginPath, 'skills'))) caps.push('skills');
        if (fs.existsSync(path.join(pluginPath, 'agents'))) caps.push('agents');
        if (fs.existsSync(path.join(pluginPath, 'hooks'))) caps.push('hooks');
        if (fs.existsSync(path.join(pluginPath, '.mcp.json'))) caps.push('mcp');
        if (fs.existsSync(path.join(pluginPath, 'commands'))) caps.push('commands');
        items.push({ id: mktName + ':' + pe.name, name: pe.name, description, author, type: 'plugin',
          marketplace: mktName, sourcePath: pluginPath, mcpConfig: null,
          isInstalled: installedPlugins.has(pe.name), capabilities: caps });
      }
    }
    const extDir = path.join(mktPath, 'external_plugins');
    if (fs.existsSync(extDir)) {
      for (const ee of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (!ee.isDirectory()) continue;
        const extPath = path.join(extDir, ee.name);
        const manifestPath = path.join(extPath, '.claude-plugin', 'plugin.json');
        const mcpPath = path.join(extPath, '.mcp.json');
        let description = '', author = '', mcpConfig = null;
        if (fs.existsSync(manifestPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            description = m.description || '';
            author = (m.author && m.author.name) ? m.author.name : '';
          } catch(e) {}
        }
        if (fs.existsSync(mcpPath)) {
          try { mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')); } catch(e) {}
        }
        const mcpKeys = mcpConfig ? Object.keys(mcpConfig) : [];
        const isInstalled = mcpKeys.length > 0 && mcpKeys.every(k => installedMcpNames.has(k));
        items.push({ id: mktName + ':ext:' + ee.name, name: ee.name, description, author, type: 'mcp',
          marketplace: mktName, sourcePath: extPath, mcpConfig, isInstalled, capabilities: ['mcp'] });
      }
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

describe('getMarketplaceItems', () => {
  test('returns empty array when marketplaces dir does not exist', () => {
    const tmp = makeTmpDir();
    try { assert.deepEqual(getMarketplaceItems(tmp, new Set()), []); } finally { rimraf(tmp); }
  });

  test('returns empty array when marketplace dir is empty', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'plugins', 'marketplaces'), { recursive: true });
      assert.deepEqual(getMarketplaceItems(tmp, new Set()), []);
    } finally { rimraf(tmp); }
  });

  test('parses a plugin with plugin.json manifest', () => {
    const tmp = makeTmpDir();
    try {
      const pluginDir = path.join(tmp, 'plugins', 'marketplaces', 'mymarket', 'plugins', 'cool-plugin', '.claude-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'cool-plugin', description: 'Does cool things', author: { name: 'Alice' }
      }));
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items.length, 1);
      assert.equal(items[0].name, 'cool-plugin');
      assert.equal(items[0].description, 'Does cool things');
      assert.equal(items[0].author, 'Alice');
      assert.equal(items[0].type, 'plugin');
      assert.equal(items[0].marketplace, 'mymarket');
    } finally { rimraf(tmp); }
  });

  test('falls back to README.md for description when plugin.json absent', () => {
    const tmp = makeTmpDir();
    try {
      const pluginDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', 'readme-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'README.md'), '# readme-plugin\n\nThis plugin does something useful.');
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items.length, 1);
      assert.ok(items[0].description.includes('something useful'));
    } finally { rimraf(tmp); }
  });

  test('detects capability subdirectories', () => {
    const tmp = makeTmpDir();
    try {
      const pluginDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', 'full-plugin');
      fs.mkdirSync(path.join(pluginDir, 'skills'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'agents'));
      fs.mkdirSync(path.join(pluginDir, 'hooks'));
      const items = getMarketplaceItems(tmp, new Set());
      assert.ok(items[0].capabilities.includes('skills'));
      assert.ok(items[0].capabilities.includes('agents'));
      assert.ok(items[0].capabilities.includes('hooks'));
      assert.ok(!items[0].capabilities.includes('mcp'));
    } finally { rimraf(tmp); }
  });

  test('detects mcp capability when .mcp.json present in plugin', () => {
    const tmp = makeTmpDir();
    try {
      const pluginDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', 'mcp-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
      const items = getMarketplaceItems(tmp, new Set());
      assert.ok(items[0].capabilities.includes('mcp'));
    } finally { rimraf(tmp); }
  });

  test('marks plugin as installed when same-named dir exists in plugins/', () => {
    const tmp = makeTmpDir();
    try {
      const pluginDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', 'installed-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      // Simulate already installed
      fs.mkdirSync(path.join(tmp, 'plugins', 'installed-plugin'), { recursive: true });
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items[0].isInstalled, true);
    } finally { rimraf(tmp); }
  });

  test('marks plugin as not installed when absent from plugins/', () => {
    const tmp = makeTmpDir();
    try {
      const pluginDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', 'not-installed');
      fs.mkdirSync(pluginDir, { recursive: true });
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items[0].isInstalled, false);
    } finally { rimraf(tmp); }
  });

  test('parses external_plugins with .mcp.json config', () => {
    const tmp = makeTmpDir();
    try {
      const extDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'external_plugins', 'gitnexus');
      fs.mkdirSync(extDir, { recursive: true });
      const mcpCfg = { gitnexus: { command: 'npx', args: ['gitnexus', 'mcp'] } };
      fs.writeFileSync(path.join(extDir, '.mcp.json'), JSON.stringify(mcpCfg));
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items.length, 1);
      assert.equal(items[0].type, 'mcp');
      assert.deepEqual(items[0].mcpConfig, mcpCfg);
      assert.ok(items[0].capabilities.includes('mcp'));
    } finally { rimraf(tmp); }
  });

  test('marks external mcp as installed when all mcp keys present in installedMcpNames', () => {
    const tmp = makeTmpDir();
    try {
      const extDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'external_plugins', 'myserver');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(extDir, '.mcp.json'), JSON.stringify({ myserver: { command: 'npx', args: [] } }));
      const items = getMarketplaceItems(tmp, new Set(['myserver']));
      assert.equal(items[0].isInstalled, true);
    } finally { rimraf(tmp); }
  });

  test('marks external mcp as not installed when keys missing from installedMcpNames', () => {
    const tmp = makeTmpDir();
    try {
      const extDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'external_plugins', 'myserver');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(extDir, '.mcp.json'), JSON.stringify({ myserver: { command: 'npx', args: [] } }));
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items[0].isInstalled, false);
    } finally { rimraf(tmp); }
  });

  test('handles malformed plugin.json without crashing', () => {
    const tmp = makeTmpDir();
    try {
      const manifestDir = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', 'bad-plugin', '.claude-plugin');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(path.join(manifestDir, 'plugin.json'), 'NOT VALID JSON {{{');
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items.length, 1);
      assert.equal(items[0].description, '');
    } finally { rimraf(tmp); }
  });

  test('sorts items alphabetically by name across marketplaces', () => {
    const tmp = makeTmpDir();
    try {
      for (const name of ['zebra', 'alpha', 'mango']) {
        const d = path.join(tmp, 'plugins', 'marketplaces', 'mkt', 'plugins', name);
        fs.mkdirSync(d, { recursive: true });
      }
      const items = getMarketplaceItems(tmp, new Set());
      assert.deepEqual(items.map(i => i.name), ['alpha', 'mango', 'zebra']);
    } finally { rimraf(tmp); }
  });

  test('id includes marketplace name and plugin name', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'plugins', 'marketplaces', 'acme', 'plugins', 'my-tool');
      fs.mkdirSync(d, { recursive: true });
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items[0].id, 'acme:my-tool');
    } finally { rimraf(tmp); }
  });

  test('external plugin id includes :ext: segment', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'plugins', 'marketplaces', 'acme', 'external_plugins', 'ext-tool');
      fs.mkdirSync(d, { recursive: true });
      const items = getMarketplaceItems(tmp, new Set());
      assert.equal(items[0].id, 'acme:ext:ext-tool');
    } finally { rimraf(tmp); }
  });
});

// ── hlJson (JSON syntax highlighter regression) ───────────────────────────────

// Inlined from the client-side hlJson in the generated dashboard.
// Tests that key spans don't corrupt class attribute quotes (the ordering bug).
function hlJson(s) {
  let h = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  h = h.replace(/"([^"]*)"/g, '<span class="str">"$1"</span>');
  h = h.replace(/<span class="str">"([^"]*)"<\/span>(\s*):/g, '<span class="key">"$1"</span>$2:');
  h = h.replace(/\b(true|false)\b/g, '<span class="bool">$1</span>');
  h = h.replace(/\b(null)\b/g, '<span class="kw">$1</span>');
  h = h.replace(/\b(-?\d+\.?\d*)\b/g, '<span class="num">$1</span>');
  return h;
}

describe('hlJson', () => {
  test('wraps string values in str span', () => {
    const result = hlJson('{ "key": "value" }');
    assert.ok(result.includes('<span class="str">"value"</span>'));
  });

  test('wraps keys in key span', () => {
    const result = hlJson('{ "command": "npx" }');
    assert.ok(result.includes('<span class="key">"command"</span>'));
  });

  test('key span does not contain nested str span (ordering regression)', () => {
    const result = hlJson('{ "command": "npx" }');
    // Old buggy code produced: <span class="key"><span class="str">"command"</span></span>
    assert.ok(!result.includes('<span class="key"><span class="str">'));
  });

  test('class attribute quotes are not wrapped as str spans', () => {
    const result = hlJson('{ "cmd": "npx" }');
    // Resulting HTML should not have class=<span... patterns
    assert.ok(!result.includes('class=<span'));
  });

  test('colon appears after key span, not inside it', () => {
    const result = hlJson('{ "args": [] }');
    assert.ok(result.includes('</span>:'));
  });

  test('wraps booleans', () => {
    const result = hlJson('{ "ok": true, "fail": false }');
    assert.ok(result.includes('<span class="bool">true</span>'));
    assert.ok(result.includes('<span class="bool">false</span>'));
  });

  test('wraps null', () => {
    assert.ok(hlJson('{ "x": null }').includes('<span class="kw">null</span>'));
  });

  test('wraps numbers', () => {
    assert.ok(hlJson('{ "port": 3200 }').includes('<span class="num">3200</span>'));
  });

  test('HTML-escapes < and > in values', () => {
    const result = hlJson('{ "tag": "<script>" }');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });

  test('handles nested objects without corrupting output', () => {
    const input = JSON.stringify({ a: { b: 'c' } }, null, 2);
    assert.doesNotThrow(() => hlJson(input));
    const result = hlJson(input);
    assert.ok(result.includes('<span class="key">'));
    assert.ok(result.includes('<span class="str">'));
  });
});

// ── generated dashboard JS syntax ────────────────────────────────────────────

describe('generated dashboard', () => {
  test('inline JS has no syntax errors', () => {
    const root = path.join(import.meta.dirname, '..');
    const html = execSync('node src/generate.js --no-open 2>/dev/null && cat dashboard.html', { cwd: root }).toString();
    const start = html.indexOf('<script>') + 8;
    const end = html.lastIndexOf('</script>');
    assert.ok(start > 8, 'should find <script> tag');
    const js = html.slice(start, end);

    const tmp = path.join(os.tmpdir(), 'hud-syntax-check.js');
    fs.writeFileSync(tmp, js);
    try {
      execSync('node --check ' + tmp, { stdio: 'pipe' });
    } catch (e) {
      assert.fail('Generated dashboard JS has syntax errors:\n' + e.stderr.toString().slice(0, 500));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
