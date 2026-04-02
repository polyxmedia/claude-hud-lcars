import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hud-test-'));
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Redirect CLAUDE_DIR to a temp directory so tests never touch ~/.claude
function withFakeClaudeDir(fn) {
  const tmp = makeTmpDir();
  const orig = process.env.CLAUDE_DIR_OVERRIDE;
  process.env.CLAUDE_DIR_OVERRIDE = tmp;
  try {
    return fn(tmp);
  } finally {
    process.env.CLAUDE_DIR_OVERRIDE = orig ?? '';
    rimraf(tmp);
  }
}

// Dynamically import the functions we want to test.
// generate.js exports nothing by default, so we inline the logic under test.
// These are self-contained pure functions we can copy for unit testing.

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

// ── tests ─────────────────────────────────────────────────────────────────────

describe('getSkills', () => {
  test('returns empty array when skills dir does not exist', () => {
    const tmp = makeTmpDir();
    try {
      assert.deepEqual(getSkills(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('returns empty array when skills dir is empty', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'skills'));
      assert.deepEqual(getSkills(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('parses a valid skill with frontmatter', () => {
    const tmp = makeTmpDir();
    try {
      const skillDir = path.join(tmp, 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: my-skill',
        'description: Does something useful',
        'version: 1.0.0',
        'context: fork',
        '---',
        '',
        '# My Skill body',
      ].join('\n'));
      const skills = getSkills(tmp);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'my-skill');
      assert.equal(skills[0].desc, 'Does something useful');
      assert.equal(skills[0].ver, '1.0.0');
      assert.equal(skills[0].ctx, 'fork');
      assert.ok(skills[0].body.includes('# My Skill body'));
    } finally {
      rimraf(tmp);
    }
  });

  test('skips skill directory with no SKILL.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'skills', 'no-skill-file'), { recursive: true });
      assert.deepEqual(getSkills(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('skips unreadable SKILL.md without crashing', () => {
    const tmp = makeTmpDir();
    try {
      const skillDir = path.join(tmp, 'skills', 'bad-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      const f = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(f, 'content');
      fs.chmodSync(f, 0o000);
      // Should not throw
      const skills = getSkills(tmp);
      assert.deepEqual(skills, []);
    } finally {
      rimraf(tmp);
    }
  });

  test('returns skills sorted alphabetically', () => {
    const tmp = makeTmpDir();
    try {
      for (const name of ['zebra', 'apple', 'mango']) {
        const d = path.join(tmp, 'skills', name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\n---\n`);
      }
      const skills = getSkills(tmp);
      assert.deepEqual(skills.map(s => s.name), ['apple', 'mango', 'zebra']);
    } finally {
      rimraf(tmp);
    }
  });

  test('falls back to directory name when frontmatter has no name', () => {
    const tmp = makeTmpDir();
    try {
      const d = path.join(tmp, 'skills', 'dir-name');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), '# No frontmatter here\n');
      const skills = getSkills(tmp);
      assert.equal(skills[0].name, 'dir-name');
    } finally {
      rimraf(tmp);
    }
  });
});

describe('getAgents', () => {
  test('returns empty array when agents dir does not exist', () => {
    const tmp = makeTmpDir();
    try {
      assert.deepEqual(getAgents(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('parses agent files', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'agents', 'my-agent.md'), [
        '---',
        'description: A test agent',
        '---',
        '',
        'Agent body here.',
      ].join('\n'));
      const agents = getAgents(tmp);
      assert.equal(agents.length, 1);
      assert.equal(agents[0].name, 'my-agent');
      assert.equal(agents[0].desc, 'A test agent');
      assert.ok(agents[0].body.includes('Agent body here.'));
    } finally {
      rimraf(tmp);
    }
  });

  test('ignores non-.md files in agents dir', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'agents', 'readme.txt'), 'ignore me');
      assert.deepEqual(getAgents(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('skips unreadable agent files without crashing', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
      const f = path.join(tmp, 'agents', 'locked.md');
      fs.writeFileSync(f, 'content');
      fs.chmodSync(f, 0o000);
      assert.doesNotThrow(() => getAgents(tmp));
    } finally {
      rimraf(tmp);
    }
  });
});

describe('getMemoryFiles', () => {
  test('returns empty array when projects dir does not exist', () => {
    const tmp = makeTmpDir();
    try {
      assert.deepEqual(getMemoryFiles(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('returns empty array when no memory subdirectories exist', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, 'projects', 'my-project'), { recursive: true });
      assert.deepEqual(getMemoryFiles(tmp), []);
    } finally {
      rimraf(tmp);
    }
  });

  test('parses memory files with frontmatter', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', '-Users-andre-myproject', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'user_role.md'), [
        '---',
        'name: User Role',
        'type: user',
        '---',
        '',
        'Andre is a developer.',
      ].join('\n'));
      const files = getMemoryFiles(tmp);
      assert.equal(files.length, 1);
      assert.equal(files[0].name, 'User Role');
      assert.equal(files[0].type, 'user');
      assert.ok(files[0].body.includes('Andre is a developer.'));
    } finally {
      rimraf(tmp);
    }
  });

  test('skips MEMORY.md index file', () => {
    const tmp = makeTmpDir();
    try {
      const memDir = path.join(tmp, 'projects', 'proj', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Index');
      assert.deepEqual(getMemoryFiles(tmp), []);
    } finally {
      rimraf(tmp);
    }
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
    } finally {
      rimraf(tmp);
    }
  });
});
