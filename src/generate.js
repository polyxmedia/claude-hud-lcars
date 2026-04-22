#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

// import.meta.dirname is Node 20.11+; fall back for Node 18
const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const OUTPUT = path.join(__dirname, '..', 'dashboard.html');
const LCARS_MEMORY_DIR = path.join(os.homedir(), '.lcars');
const LCARS_MEMORY_PATH = path.join(LCARS_MEMORY_DIR, 'memory.json');

let PKG_VERSION = 'unknown';
try { PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version; } catch {}

// ── DATA COLLECTION (unchanged) ──

function getSkills() {
  const dir = path.join(CLAUDE_DIR, 'skills');
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

function getAgents() {
  const dir = path.join(CLAUDE_DIR, 'agents');
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

function getSettings() {
  const p = path.join(CLAUDE_DIR, 'settings.json');
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; }
  catch(e) { console.warn('Warning: settings.json parse error:', e.message); return null; }
}

const MCP_SECURITY_FLAGS = {
  'mcp-remote': { cve: 'CVE-2025-6514', severity: 'HIGH', detail: 'Command injection via authorization_endpoint in OAuth proxy. Update to latest version.' },
};
const MCP_RISKY_PATTERNS = [
  { pattern: '--privileged', severity: 'HIGH', detail: 'Docker --privileged grants full host access' },
  { pattern: '--cap-add SYS_ADMIN', severity: 'HIGH', detail: 'SYS_ADMIN capability allows host escape' },
  { pattern: '--network host', severity: 'MEDIUM', detail: 'Host network mode bypasses container network isolation' },
];

function auditMcp(name, c) {
  const flags = [];
  // Check known CVEs
  const cmdStr = (c.args || []).join(' ');
  for (const [pkg, flag] of Object.entries(MCP_SECURITY_FLAGS)) {
    if (name === pkg || cmdStr.includes(pkg)) flags.push(flag);
  }
  // Check risky patterns in args
  for (const { pattern, severity, detail } of MCP_RISKY_PATTERNS) {
    if (cmdStr.includes(pattern)) flags.push({ severity, detail: pattern + ': ' + detail });
  }
  return flags;
}

function parseMcpEntry(name, c, source, disabled) {
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
  const securityFlags = auditMcp(name, c);

  return {
    name, cmd: c.command, args: c.args || [], hasEnv: !!c.env,
    serverType, fileStatus, envCount, source,
    entryPoint: mainArg, disabled: !!disabled,
    securityFlags,
    config: { ...c, env: c.env ? '{redacted — ' + envCount + ' vars}' : undefined },
  };
}

function getMcpServers(s) {
  const out = [];
  const seen = new Set();

  // 1. From settings.json mcpServers (enabled)
  if (s?.mcpServers) {
    for (const [name, c] of Object.entries(s.mcpServers)) {
      out.push(parseMcpEntry(name, c, 'settings.json', false));
      seen.add(name);
    }
  }
  // 1b. From settings.json mcpServersDisabled (disabled but preserved)
  if (s?.mcpServersDisabled) {
    for (const [name, c] of Object.entries(s.mcpServersDisabled)) {
      if (!seen.has(name)) {
        out.push(parseMcpEntry(name, c, 'settings.json (disabled)', true));
        seen.add(name);
      }
    }
  }

  // 2. From project-level .mcp.json files (scan common Code directories)
  const homeDir = os.homedir();
  const searchDirs = [
    homeDir, // ~/.mcp.json
    path.join(homeDir, 'Code'),
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'code'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'Developer'),
    path.join(homeDir, 'dev'),
    path.join(homeDir, 'src'),
    path.join(homeDir, 'repos'),
    path.join(homeDir, 'workspace'),
    path.join(homeDir, 'work'),
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Desktop'),
  ];

  // Check home directory root
  const homeMcp = path.join(homeDir, '.mcp.json');
  if (fs.existsSync(homeMcp)) {
    try {
      const data = JSON.parse(fs.readFileSync(homeMcp, 'utf-8'));
      if (data.mcpServers) {
        for (const [name, c] of Object.entries(data.mcpServers)) {
          if (!seen.has(name)) { out.push(parseMcpEntry(name, c, '~/.mcp.json')); seen.add(name); }
        }
      }
    } catch(e) { console.warn('Could not parse ~/.mcp.json:', e.message); }
  }

  // Add user-specified directories from CLAUDE_HUD_DIRS env var
  if (process.env.CLAUDE_HUD_DIRS) {
    for (const d of process.env.CLAUDE_HUD_DIRS.split(':').filter(Boolean)) {
      const resolved = d.startsWith('~') ? path.join(homeDir, d.slice(1)) : d;
      if (!searchDirs.includes(resolved)) searchDirs.push(resolved);
    }
  }

  // Scan one level deep in common dirs
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const mcpFile = path.join(dir, entry.name, '.mcp.json');
        if (!fs.existsSync(mcpFile)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
          if (!data.mcpServers) continue;
          const proj = entry.name;
          for (const [name, c] of Object.entries(data.mcpServers)) {
            if (!seen.has(name)) {
              out.push(parseMcpEntry(name, c, proj + '/.mcp.json'));
              seen.add(name);
            }
          }
        } catch(e) { console.warn('Could not parse ' + mcpFile + ':', e.message); }
      }
    } catch(e) {}
  }

  return out;
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

function getMarketplaceItems(installedMcpNames) {
  const marketplaceDir = path.join(CLAUDE_DIR, 'plugins', 'marketplaces');
  if (!fs.existsSync(marketplaceDir)) return [];

  // Installed plugins: ~/.claude/plugins/* (excluding marketplaces/ subdir)
  const installedPlugins = new Set();
  const pluginsRoot = path.join(CLAUDE_DIR, 'plugins');
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

    // Scan plugins/
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

        items.push({
          id: mktName + ':' + pe.name,
          name: pe.name,
          description,
          author,
          type: 'plugin',
          marketplace: mktName,
          sourcePath: pluginPath,
          mcpConfig: null,
          isInstalled: installedPlugins.has(pe.name),
          capabilities: caps,
        });
      }
    }

    // Scan external_plugins/
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

        items.push({
          id: mktName + ':ext:' + ee.name,
          name: ee.name,
          description,
          author,
          type: 'mcp',
          marketplace: mktName,
          sourcePath: extPath,
          mcpConfig,
          isInstalled,
          capabilities: ['mcp'],
        });
      }
    }
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function getMemoryFiles() {
  const out = [];
  const dir = path.join(CLAUDE_DIR, 'projects');
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

function getSessionCount() {
  const d = path.join(CLAUDE_DIR, 'sessions');
  return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).length : 0;
}

function getSessions() {
  const out = [];
  const d = path.join(CLAUDE_DIR, 'sessions');
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8'));
      out.push({
        id: raw.sessionId || f.replace('.json',''),
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

function getHistory() {
  const p = path.join(CLAUDE_DIR, 'history.jsonl');
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

function scoreClaudeMd(body) {
  const lines = body.split('\n');
  const lineCount = lines.length;
  const issues = [], praise = [];
  let score = 100;
  if (lineCount > 500) { score -= 30; issues.push('Very long (' + lineCount + ' lines) — key instructions may get lost'); }
  else if (lineCount > 200) { score -= 15; issues.push('Long (' + lineCount + ' lines) — consider splitting into project-level files'); }
  else if (lineCount > 20) praise.push('Good length (' + lineCount + ' lines)');
  const headers = lines.filter(l => l.startsWith('#')).length;
  if (headers === 0) { score -= 20; issues.push('No section headers — unstructured content is harder for Claude to prioritise'); }
  else if (headers >= 3) praise.push(headers + ' sections defined');
  const text = body.toLowerCase();
  const hasPersona = text.includes('you are') || text.includes('persona') || text.includes('role:') || text.includes('act as');
  const hasRules = text.includes('never') || text.includes('always') || text.includes('must') || text.includes('rule');
  const hasTone = text.includes('tone') || text.includes('voice') || text.includes('style') || text.includes('concise') || text.includes('formal');
  if (!hasPersona) { score -= 10; issues.push('No persona/role definition found'); }
  else praise.push('Persona defined');
  if (!hasRules) { score -= 10; issues.push('No explicit rules or constraints'); }
  else praise.push('Rules present');
  if (!hasTone) { score -= 5; issues.push('No tone/style guidance'); }
  if (body.trim().length < 100) { score -= 50; issues.push('Very minimal — Claude has almost no guidance to work with'); }
  return { score: Math.max(0, Math.min(100, score)), issues, praise };
}

function getClaudeMdFiles() {
  const out = [];
  // Global CLAUDE.md
  const globalPath = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, 'utf-8');
      const health = scoreClaudeMd(raw);
      out.push({ scope: 'GLOBAL', path: globalPath, project: '~/.claude/', body: raw, size: raw.length, health });
    } catch(e) {}
  }
  // Project CLAUDE.md files
  const projDir = path.join(CLAUDE_DIR, 'projects');
  if (fs.existsSync(projDir)) {
    for (const p of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const cp = path.join(projDir, p.name, 'CLAUDE.md');
      if (!fs.existsSync(cp)) continue;
      try {
        const raw = fs.readFileSync(cp, 'utf-8');
        const proj = p.name.replace(/-/g, '/').replace(/^\//, '');
        const health = scoreClaudeMd(raw);
        out.push({ scope: 'PROJECT', path: cp, project: proj, body: raw, size: raw.length, health });
      } catch(e) {}
    }
  }
  return out;
}

function getProjectHistory() {
  const out = [];
  const projDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projDir)) return out;
  try {
    for (const entry of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projPath = path.join(projDir, entry.name);
      let sessionCount = 0, lastActivity = 0;
      try {
        const files = fs.readdirSync(projPath);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
        sessionCount = jsonlFiles.length;
        for (const f of jsonlFiles) {
          try {
            const mtime = fs.statSync(path.join(projPath, f)).mtimeMs;
            if (mtime > lastActivity) lastActivity = mtime;
          } catch(e) {}
        }
      } catch(e) {}
      if (sessionCount === 0) continue;
      // Decode path: -Users-andrefigueira-Code-foo => /Users/andrefigueira/Code/foo (best effort)
      const decoded = ('/' + entry.name.replace(/^-/, '')).replace(/-/g, '/');
      const shortName = decoded.split('/').filter(Boolean).slice(-2).join('/');
      out.push({ name: entry.name, path: decoded, shortName, sessions: sessionCount, lastActivity });
    }
  } catch(e) {}
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

function getEnv(s) { return s?.env || {}; }

function getMemoryBanks() {
  try {
    if (!fs.existsSync(LCARS_MEMORY_PATH)) return { entries: [], stats: { total: 0, today: 0, lastEntry: null } };
    const raw = JSON.parse(fs.readFileSync(LCARS_MEMORY_PATH, 'utf-8'));
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = entries.filter(e => e.timestamp && e.timestamp.slice(0, 10) === today).length;
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    return { entries, stats: { total: entries.length, today: todayCount, lastEntry } };
  } catch { return { entries: [], stats: { total: 0, today: 0, lastEntry: null } }; }
}

// ── MNEMOS (persistent memory + skills, https://github.com/polyxmedia/mnemos) ──
// Reads ~/.mnemos/mnemos.db directly via the system sqlite3 CLI. No npm dep.
// Returns null if mnemos is not installed (db missing). Tolerant of schema drift.
function getMnemos() {
  const dbPath = path.join(os.homedir(), '.mnemos', 'mnemos.db');
  if (!fs.existsSync(dbPath)) return null;

  // Cross-platform sqlite3 binary detection — macOS, Linux, Homebrew, Windows.
  function findSqlite() {
    const candidates = [
      '/usr/bin/sqlite3',
      '/usr/local/bin/sqlite3',
      '/opt/homebrew/bin/sqlite3',
      '/opt/local/bin/sqlite3',
      'C:\\Program Files\\sqlite3\\sqlite3.exe',
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const found = execFileSync(which, ['sqlite3'], { encoding: 'utf-8', timeout: 1000 }).trim().split(/\r?\n/)[0];
      if (found && fs.existsSync(found)) return found;
    } catch {}
    return null;
  }
  const sqlite = findSqlite();
  if (!sqlite) return { installed: false, reason: 'sqlite3 binary not found on PATH', dbPath };

  function q(sql) {
    try {
      const out = execFileSync(sqlite, ['-readonly', '-json', dbPath, sql], {
        encoding: 'utf-8', timeout: 5000, maxBuffer: 50 * 1024 * 1024,
      });
      const trimmed = out.trim();
      return trimmed ? JSON.parse(trimmed) : [];
    } catch { return []; }
  }
  function parseTags(t) {
    if (!t) return [];
    try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  let dbSize = 0; try { dbSize = fs.statSync(dbPath).size; } catch {}

  const observations = q(`
    SELECT id, session_id, agent_id, project, title, content, obs_type, tags,
           importance, access_count, created_at, valid_until, invalidated_at,
           expires_at, structured, rationale
    FROM observations
    ORDER BY datetime(created_at) DESC
    LIMIT 500
  `).map(o => ({ ...o, tags: parseTags(o.tags) }));

  const sessions = q(`
    SELECT id, agent_id, project, goal, summary, reflection, status,
           outcome_tags, started_at, ended_at,
           (SELECT COUNT(*) FROM observations WHERE session_id = sessions.id) AS obs_count
    FROM sessions
    ORDER BY datetime(started_at) DESC
    LIMIT 200
  `).map(s => ({ ...s, outcome_tags: parseTags(s.outcome_tags) }));

  const skills = q(`
    SELECT id, agent_id, name, description, procedure, pitfalls, tags,
           source_sessions, use_count, success_count, effectiveness, version,
           created_at, updated_at
    FROM skills
    ORDER BY name ASC
  `).map(s => ({
    ...s,
    tags: parseTags(s.tags),
    source_sessions: parseTags(s.source_sessions),
  }));

  const fileTouches = q(`
    SELECT path, project,
           COUNT(*) AS touches,
           MAX(touched_at) AS last_touched,
           COUNT(DISTINCT session_id) AS distinct_sessions
    FROM file_touches
    GROUP BY path, project
    ORDER BY touches DESC, datetime(last_touched) DESC
    LIMIT 100
  `);

  const links = q(`
    SELECT source_id, target_id, link_type, created_at FROM observation_links LIMIT 500
  `);

  // Aggregate stats
  const byType = {};
  const byProject = {};
  const tagCounts = {};
  let liveCount = 0, supersededCount = 0;
  const nowMs = Date.now();
  for (const o of observations) {
    byType[o.obs_type] = (byType[o.obs_type] || 0) + 1;
    if (o.project) byProject[o.project] = (byProject[o.project] || 0) + 1;
    for (const t of o.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const expired = o.expires_at && Date.parse(o.expires_at) < nowMs;
    if (o.invalidated_at || expired) supersededCount++; else liveCount++;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));
  const topProjects = Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([project, count]) => ({ project, count }));

  // Detect mnemos binary + version (best-effort)
  let binPath = '', binVersion = '';
  try {
    binPath = execFileSync('/usr/bin/which', ['mnemos'], { encoding: 'utf-8', timeout: 1000 }).trim();
  } catch {}
  if (binPath) {
    try { binVersion = execFileSync(binPath, ['version'], { encoding: 'utf-8', timeout: 1500 }).trim(); } catch {}
  }

  return {
    installed: true,
    dbPath, dbSize, binPath, binVersion,
    stats: {
      observations: observations.length,
      live: liveCount,
      superseded: supersededCount,
      sessions: sessions.length,
      skills: skills.length,
      autoPromoted: skills.filter(s => (s.tags || []).includes('auto-promoted')).length,
      links: links.length,
      fileTouches: fileTouches.length,
      byType, topTags, topProjects,
    },
    observations, sessions, skills, fileTouches, links,
  };
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escJ(s) { return JSON.stringify(s).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/`/g,'\\u0060').replace(/\$/g,'\\u0024'); }
// escJ output safe for placement inside a double-quoted HTML attribute
function escA(s) { return escJ(s).replace(/"/g,'&quot;'); }

// ── BUILD ──

function gen() {
  const S = getSettings();
  const skills = getSkills(), agents = getAgents(), mcp = getMcpServers(S);
  const hooks = getHooks(S), env = getEnv(S), plugins = getPlugins(S);
  const mem = getMemoryFiles(), sessions = getSessionCount();
  const sessionList = getSessions(), history = getHistory(), claudeMds = getClaudeMdFiles();
  const projectHistory = getProjectHistory();
  const memBanks = getMemoryBanks();
  const mnemos = getMnemos();
  const ts = new Date().toISOString().replace('T',' ').slice(0,19)+'Z';
  const stardate = new Date().toISOString().slice(0,10).replace(/-/g,'.');

  // ── DISCOVER SUGGESTIONS ──
  const installedSkillNames = new Set(skills.map(s => s.name));
  const installedAgentNames = new Set(agents.map(a => a.name));
  const installedMcpNames = new Set(mcp.map(m => m.name));
  const marketItems = getMarketplaceItems(installedMcpNames);

  const SKILL_SUGG = [
    { name: 'code-review', desc: 'Principal-level code review: security, logic, performance, architecture', content: '---\nname: code-review\ndescription: "Principal-level code review"\ncontext: fork\nversion: 1.0.0\n---\n\nReview the changed code with principal-engineer judgment:\n1. Security vulnerabilities (OWASP top 10, injection, auth)\n2. Logic errors and edge cases\n3. Performance implications\n4. Code quality and maintainability\n5. Missing tests\n\nFormat each finding as [CRITICAL/HIGH/MEDIUM/LOW] — issue — suggested fix.' },
    { name: 'commit', desc: 'Create a well-structured git commit for staged changes', content: '---\nname: commit\ndescription: "Create a well-structured git commit"\ncontext: fork\nversion: 1.0.0\n---\n\nCreate a git commit for the current staged changes:\n1. Run `git diff --staged` to understand what changed\n2. Write a concise commit message in imperative mood (under 72 chars)\n3. Run `git commit -m "message"`\nIf nothing is staged, ask what to commit.' },
    { name: 'deploy-check', desc: 'Pre-deployment validation: tests, secrets, build, dependencies', content: '---\nname: deploy-check\ndescription: "Pre-deployment validation checklist"\ncontext: fork\nversion: 1.0.0\n---\n\nRun pre-deployment checks:\n1. Run the test suite and report results\n2. Check for secrets or credentials in tracked files\n3. Verify the build succeeds cleanly\n4. Check for outdated or vulnerable dependencies\n5. Confirm required environment variables are documented\n\nDeliver a GO / NO-GO verdict with reasons.' },
    { name: 'emergent-approach', desc: 'Plan and design before implementing — surfaces trade-offs and edge cases', content: '---\nname: emergent-approach\ndescription: "Design a solution before writing code"\ncontext: inline\nversion: 1.0.0\n---\n\nBefore writing any code:\n1. Restate the problem to confirm understanding\n2. Propose 2-3 approaches with trade-offs\n3. Identify edge cases and failure modes\n4. Recommend one approach with rationale\n5. Outline implementation steps\n\nOnly proceed to code once the plan is agreed.' },
    { name: 'voice-capture', desc: 'Run an interview to capture someone\'s writing voice as a reusable profile', content: '---\nname: voice-capture\ndescription: "Capture a writing voice profile via interview"\ncontext: inline\nversion: 1.0.0\n---\n\nRun a voice extraction interview:\n1. Ask 5-7 questions about writing style, pet phrases, and opinions\n2. Ask for 2-3 writing samples\n3. Analyse the samples for tone, sentence structure, vocabulary, and patterns\n4. Produce a voice-substrate.md file with the captured profile.' },
  ].filter(s => !installedSkillNames.has(s.name));

  const AGENT_SUGG = [
    { name: 'security-auditor', desc: 'Audit code for OWASP vulnerabilities, hardcoded secrets, and auth issues', content: '---\nname: security-auditor\ndescription: "Audit code for security vulnerabilities"\n---\ntools: Read, Grep, Glob, Bash\n\nYou are a security expert. When invoked:\n1. Identify the tech stack\n2. Check for OWASP Top 10 vulnerabilities\n3. Look for hardcoded secrets, insecure dependencies, injection points\n4. Review authentication and authorisation logic\n5. Produce a prioritised report: CRITICAL/HIGH/MEDIUM/LOW with remediation steps' },
    { name: 'test-generator', desc: 'Generate comprehensive test suites with edge cases and error paths', content: '---\nname: test-generator\ndescription: "Generate comprehensive tests for code"\n---\ntools: Read, Grep, Glob, Write, Bash\n\nYou are an expert in test-driven development. When invoked:\n1. Read the target file and understand its logic\n2. Identify testable units, edge cases, error paths, and happy paths\n3. Generate tests using the project\'s existing test framework\n4. Run the tests and fix any failures before returning' },
    { name: 'documentation-writer', desc: 'Write clear, accurate API and code documentation', content: '---\nname: documentation-writer\ndescription: "Write API and code documentation"\n---\ntools: Read, Grep, Glob, Write\n\nYou are a technical writer. When invoked:\n1. Read the target file or API\n2. Identify public interfaces, functions, and types\n3. Write clear documentation: purpose, parameters, return values, examples\n4. Follow the project\'s existing documentation style\n5. Keep it accurate and concise' },
    { name: 'performance-analyst', desc: 'Profile and identify performance bottlenecks in code', content: '---\nname: performance-analyst\ndescription: "Identify performance bottlenecks and suggest fixes"\n---\ntools: Read, Grep, Glob, Bash\n\nYou are a performance engineering expert. When invoked:\n1. Identify hot paths and expensive operations\n2. Look for N+1 queries, unnecessary re-renders, blocking I/O\n3. Suggest algorithmic improvements with complexity analysis\n4. Profile if tooling is available\n5. Rank suggestions by impact' },
  ].filter(a => !installedAgentNames.has(a.name));

  const MCP_SUGG = [
    { name: 'filesystem', desc: 'Read and write files anywhere on the filesystem, beyond project scope', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~'], env: null },
    { name: 'memory', desc: 'Persistent knowledge graph — Claude remembers facts across sessions', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: null },
    { name: 'sequential-thinking', desc: 'Enhanced step-by-step reasoning for complex problems', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], env: null },
    { name: 'puppeteer', desc: 'Browser automation — navigate, screenshot, and scrape web pages', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], env: null },
    { name: 'github', desc: 'Read/write GitHub repos, issues, PRs, and comments via API', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } },
    { name: 'brave-search', desc: 'Web and local search powered by the Brave Search API', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' } },
    { name: 'postgres', desc: 'Query and inspect a PostgreSQL database via natural language', cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'], env: null },
    { name: 'fetch', desc: 'Fetch any URL and return its content as markdown', cmd: 'uvx', args: ['mcp-server-fetch'], env: null },
  ].filter(m => !installedMcpNames.has(m.name));

  const HOOK_SUGG = [
    { name: 'Done notification', event: 'Stop', desc: 'Desktop notification when Claude finishes a task', cmd: 'osascript -e \'display notification "Claude finished" with title "Claude Code"\'' },
    { name: 'Dangerous command blocker', event: 'PreToolUse', matcher: 'Bash', desc: 'Block destructive shell commands — rm -rf, DROP TABLE, force push', cmd: 'python3 -c "import sys,json; d=json.load(sys.stdin); cmd=d.get(\'tool_input\',{}).get(\'command\',\'\'); bad=any(x in cmd for x in [\'rm -rf /\',\'DROP TABLE\',\'--force\',\'format c:\']); sys.exit(2 if bad else 0)"' },
    { name: 'Auto-format on write', event: 'PostToolUse', matcher: 'Write', desc: 'Run prettier on any file Claude writes', cmd: 'prettier --write "$(echo $CLAUDE_TOOL_INPUT | python3 -c \"import sys,json; print(json.load(sys.stdin)[\'path\'])\")" 2>/dev/null || true' },
    { name: 'Session summary', event: 'Stop', desc: 'Append a one-line summary of what Claude did to a daily log', cmd: 'echo "[$(date +%H:%M)] Claude session ended in $(pwd)" >> ~/claude-sessions.log' },
  ];

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

  const skillDiscoverCards = SKILL_SUGG.map(s => `
    <div class="suggest-card" onclick="open_('sugg:skill:${esc(s.name)}');beepOpen()">
      <div class="suggest-name">${esc(s.name)}</div>
      <div class="suggest-desc">${esc(s.desc)}</div>
      <div class="suggest-footer">
        <span class="suggest-tag">skill</span>
        <button class="suggest-install" onclick="event.stopPropagation();installSuggestSkill(this,${escA(s.name)},${escA(s.content)})">+ INSTALL</button>
      </div>
    </div>`).join('');

  const agentDiscoverCards = AGENT_SUGG.map(a => `
    <div class="suggest-card" onclick="open_('sugg:agent:${esc(a.name)}');beepOpen()">
      <div class="suggest-name">${esc(a.name)}</div>
      <div class="suggest-desc">${esc(a.desc)}</div>
      <div class="suggest-footer">
        <span class="suggest-tag">agent</span>
        <button class="suggest-install" onclick="event.stopPropagation();installSuggestAgent(this,${escA(a.name)},${escA(a.content)})">+ INSTALL</button>
      </div>
    </div>`).join('');

  const mcpDiscoverCards = MCP_SUGG.map(m => {
    const cfg = { command: m.cmd, args: m.args };
    if (m.env) cfg.env = m.env;
    return `
    <div class="suggest-card" onclick="open_('sugg:mcp:${esc(m.name)}');beepOpen()">
      <div class="suggest-name">${esc(m.name)}</div>
      <div class="suggest-desc">${esc(m.desc)}</div>
      <div class="suggest-footer">
        <span class="suggest-tag">${esc(m.cmd)}</span>
        <button class="suggest-install" onclick="event.stopPropagation();installSuggestMcp(this,${escA(m.name)},${escA(JSON.stringify(cfg))})">+ INSTALL</button>
      </div>
    </div>`;
  }).join('');

  const hookDiscoverCards = HOOK_SUGG.map(h => `
    <div class="suggest-card" onclick="open_('sugg:hook:${esc(h.name)}');beepOpen()">
      <div class="suggest-name">${esc(h.name)}</div>
      <div class="suggest-desc">${esc(h.desc)}</div>
      <div class="suggest-footer">
        <span class="suggest-tag">${esc(h.event)}</span>
        <button class="suggest-install" onclick="event.stopPropagation();installSuggestHook(this,${escA(h.event)},${escA(h.matcher||'')},${escA(h.cmd)})">+ INSTALL</button>
      </div>
    </div>`).join('');

  const D = {};
  skills.forEach(s => {
    const skillPath = path.join(CLAUDE_DIR, 'skills', s.name, 'SKILL.md');
    const skillDir  = path.join(CLAUDE_DIR, 'skills', s.name);
    D['s:'+s.name] = { t: s.name, tp: 'SKILL MODULE', m: (s.ver?'v'+s.ver:'')+(s.ctx?' // '+s.ctx:''), b: s.body,
      actions: [
        { label: 'INVOKE', cmd: '/'+s.name, icon: 'RUN' },
        { label: 'OPEN FILE', cmd: 'open '+skillPath, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: skillPath, icon: 'PATH' },
        { label: 'DELETE', cmd: skillDir, icon: 'DEL' },
      ]};
  });
  agents.forEach(a => {
    const agentPath = path.join(CLAUDE_DIR, 'agents', a.name+'.md');
    D['a:'+a.name] = { t: a.name, tp: 'AGENT DEFINITION', m: '', b: a.body,
      actions: [
        { label: 'OPEN FILE', cmd: 'open '+agentPath, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: agentPath, icon: 'PATH' },
        { label: 'DELETE', cmd: agentPath, icon: 'DEL' },
      ]};
  });
  mcp.forEach(s => {
    D['m:'+s.name] = { t: s.name, tp: 'MCP SERVER CONFIG', m: s.cmd+' '+s.args.join(' '), b: JSON.stringify(s.config,null,2),
      actions: [
        { label: 'COPY CONFIG', cmd: JSON.stringify(s.config,null,2), icon: 'COPY' },
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
        { label: 'DELETE', cmd: 'mcp:'+s.name, icon: 'DEL' },
      ]};
  });
  hooks.forEach((h,i) => {
    D['h:'+i] = { t: h.ev+' // '+h.matcher, tp: 'HOOK INTERCEPT', m: 'TYPE: '+h.type+(h.async?' // ASYNC':''), b: JSON.stringify(h.full,null,2),
      actions: [
        { label: 'COPY HOOK JSON', cmd: JSON.stringify(h.full,null,2), icon: 'COPY' },
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
        { label: 'DELETE', cmd: 'hook:'+i, icon: 'DEL' },
      ]};
  });
  // Discover suggestions — detail panel entries
  SKILL_SUGG.forEach(s => {
    D['sugg:skill:'+s.name] = { t: s.name, tp: 'SUGGESTED SKILL', m: 'not installed',
      b: s.content,
      actions: [{ label: '+ INSTALL', cmd: 'install:skill:'+s.name, icon: 'INSTALL' }] };
  });
  AGENT_SUGG.forEach(a => {
    D['sugg:agent:'+a.name] = { t: a.name, tp: 'SUGGESTED AGENT', m: 'not installed',
      b: a.content,
      actions: [{ label: '+ INSTALL', cmd: 'install:agent:'+a.name, icon: 'INSTALL' }] };
  });
  MCP_SUGG.forEach(m => {
    const cfg = { command: m.cmd, args: m.args };
    if (m.env) cfg.env = m.env;
    D['sugg:mcp:'+m.name] = { t: m.name, tp: 'SUGGESTED MCP SERVER', m: m.cmd+' '+m.args.join(' '),
      b: '```json\n'+JSON.stringify(cfg,null,2)+'\n```\n\n'+m.desc,
      _cfg: cfg,
      actions: [{ label: '+ INSTALL', cmd: 'install:mcp:'+m.name, icon: 'INSTALL' }] };
  });
  HOOK_SUGG.forEach(h => {
    D['sugg:hook:'+h.name] = { t: h.name, tp: 'SUGGESTED HOOK // '+h.event.toUpperCase(), m: h.event+(h.matcher?' // '+h.matcher:''),
      b: h.desc+'\n\n```bash\n'+h.cmd+'\n```',
      _hook: { event: h.event, matcher: h.matcher||'', cmd: h.cmd },
      actions: [{ label: '+ INSTALL', cmd: 'install:hook:'+h.name, icon: 'INSTALL' }] };
  });
  marketItems.forEach(item => {
    const mcpBody = item.mcpConfig ? '\n\n```json\n' + JSON.stringify(item.mcpConfig, null, 2) + '\n```' : '';
    D['mk:'+item.id] = {
      t: item.name,
      tp: item.type === 'mcp' ? 'MCP SERVER PLUGIN' : 'PLUGIN MODULE',
      m: item.marketplace + (item.author ? ' // ' + item.author : '') + (item.isInstalled ? ' // INSTALLED' : ''),
      b: (item.description || 'No description available.') + mcpBody,
      _install: { type: item.type, sourcePath: item.sourcePath, mcpConfig: item.mcpConfig || null },
      actions: item.isInstalled
        ? [{ label: 'INSTALLED', cmd: '', icon: 'OK' }]
        : [{ label: item.type === 'mcp' ? '+ ADD MCP' : '+ INSTALL', cmd: 'mkinstall:' + item.id, icon: 'INSTALL' }]
    };
  });
  mem.forEach(m => {
    const memPath = path.join(CLAUDE_DIR, 'projects', m.proj.replace(/\//g,'-'), 'memory', m.file);
    D['e:'+m.file] = { t: m.name, tp: 'MEMORY FILE // '+m.type.toUpperCase(), m: m.proj, b: m.body,
      actions: [
        { label: 'OPEN FILE', cmd: 'open '+memPath, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: memPath, icon: 'PATH' },
        { label: 'DELETE', cmd: 'rm '+memPath, icon: 'DEL' },
      ]};
  });

  plugins.forEach(p => {
    D['p:'+p.id] = { t: p.id, tp: 'PLUGIN', m: p.on ? 'ACTIVE' : 'INACTIVE', b: JSON.stringify({ id: p.id, enabled: p.on }, null, 2),
      actions: [
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
      ]};
  });
  // Sessions
  sessionList.forEach((s, i) => {
    const date = s.started ? new Date(s.started).toISOString().replace('T', ' ').slice(0, 19) : 'unknown';
    D['ss:'+i] = { t: s.project || s.id.slice(0,8), tp: 'SESSION // ' + s.kind.toUpperCase(), m: date + ' // PID ' + s.pid,
      b: '**Session ID:** ' + s.id + '\n\n**Working Directory:** ' + s.cwd + '\n\n**Started:** ' + date + '\n\n**Kind:** ' + s.kind + '\n\n**Entry:** ' + s.entry,
      actions: [
        { label: 'COPY PATH', cmd: s.cwd, icon: 'PATH' },
      ]};
  });

  // Memory Banks entries
  memBanks.entries.forEach((e, i) => {
    const tags = (e.tags || []).join(', ') || 'none';
    const date = e.timestamp ? new Date(e.timestamp).toISOString().replace('T',' ').slice(0,19) : 'unknown';
    D['mb:'+i] = { t: e.content.slice(0, 60) + (e.content.length > 60 ? '…' : ''),
      tp: 'MEMORY ENTRY // ' + (e.source || 'manual').toUpperCase(),
      m: date + (e.tags && e.tags.length ? ' // ' + tags : ''),
      b: e.content + '\n\n**ID:** ' + e.id + '\n\n**Source:** ' + (e.source || 'manual') + '\n\n**Tags:** ' + tags + (e.context ? '\n\n**Context:** ' + e.context : ''),
      actions: [] };
  });

  // CLAUDE.md files
  claudeMds.forEach((c, i) => {
    const h = c.health;
    const healthSummary = h.score + '/100' + (h.issues.length ? ' — Issues: ' + h.issues.join('; ') : ' — Looks good');
    D['cd:'+i] = { t: c.scope === 'GLOBAL' ? 'Global CLAUDE.md' : c.project.split('/').slice(-2).join('/'),
      tp: 'CLAUDE.MD // ' + c.scope, m: c.project + ' // ' + healthSummary, b: c.body,
      actions: [
        { label: 'OPEN FILE', cmd: 'open ' + c.path, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: c.path, icon: 'PATH' },
      ]};
  });

  // Project history
  projectHistory.forEach((p, i) => {
    D['ph:'+i] = { t: p.shortName, tp: 'PROJECT HISTORY',
      m: p.sessions + ' sessions // last active ' + (p.lastActivity ? new Date(p.lastActivity).toISOString().slice(0,10) : 'unknown'),
      b: '**Project:** ' + p.path + '\n\n**Sessions:** ' + p.sessions + '\n\n**Last Activity:** ' + (p.lastActivity ? new Date(p.lastActivity).toISOString().replace('T',' ').slice(0,19) : 'unknown') + '\n\n*Open Claude Code in this directory to resume work.*',
      actions: [{ label: 'COPY PATH', cmd: p.path, icon: 'PATH' }]};
  });

  Object.entries(env).forEach(([k, v]) => {
    D['v:'+k] = { t: k, tp: 'ENVIRONMENT VARIABLE', m: String(v), b: k + ' = ' + JSON.stringify(v, null, 2),
      actions: [
        { label: 'COPY VALUE', cmd: String(v), icon: 'COPY' },
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
      ]};
  });

  // ── MNEMOS detail entries — every observation, session, skill, and file is openable ──
  if (mnemos && mnemos.installed) {
    const mnBin = mnemos.binPath || 'mnemos';
    const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toISOString().replace('T',' ').slice(0,19); } catch { return s; } };
    const obsTypeLabel = {
      correction: 'CORRECTION', convention: 'CONVENTION', decision: 'DECISION',
      bugfix: 'BUGFIX', pattern: 'PATTERN', preference: 'PREFERENCE',
      context: 'CONTEXT', architecture: 'ARCHITECTURE', episodic: 'EPISODIC',
      semantic: 'SEMANTIC', procedural: 'PROCEDURAL', dream: 'DREAM',
    };
    mnemos.observations.forEach(o => {
      let structured = null;
      try { structured = o.structured ? JSON.parse(o.structured) : null; } catch {}
      const status = o.invalidated_at ? 'SUPERSEDED' : (o.expires_at && Date.parse(o.expires_at) < Date.now()) ? 'EXPIRED' : 'LIVE';
      const tagsLine = o.tags && o.tags.length ? '**Tags:** ' + o.tags.map(t => '`'+t+'`').join(' ') + '\n\n' : '';
      const projLine = o.project ? '**Project:** ' + o.project + '\n\n' : '';
      const ratLine  = o.rationale ? '**Rationale:** ' + o.rationale + '\n\n' : '';
      let extra = '';
      if (structured) {
        if (structured.tried)         extra += '**Tried:** ' + structured.tried + '\n\n';
        if (structured.wrong_because) extra += '**Wrong because:** ' + structured.wrong_because + '\n\n';
        if (structured.fix)           extra += '**Fix:** ' + structured.fix + '\n\n';
        const handled = new Set(['tried','wrong_because','fix']);
        const otherKeys = Object.keys(structured).filter(k => !handled.has(k));
        if (otherKeys.length) extra += '**Structured:**\n```json\n' + JSON.stringify(structured, null, 2) + '\n```\n\n';
      }
      const body = [
        projLine + tagsLine + ratLine + extra,
        '**Content:**\n\n' + (o.content || ''),
        '\n\n---\n',
        '**ID:** `' + o.id + '`  \n',
        '**Type:** ' + o.obs_type + ' · **Importance:** ' + (o.importance ?? '—') + '/10 · **Access count:** ' + (o.access_count ?? 0),
        '\n\n**Created:** ' + fmtDate(o.created_at) + (o.session_id ? '  \n**Session:** `' + o.session_id + '`' : ''),
        o.valid_until ? '  \n**Valid until:** ' + fmtDate(o.valid_until) : '',
        o.invalidated_at ? '  \n**Invalidated:** ' + fmtDate(o.invalidated_at) : '',
        o.expires_at ? '  \n**Expires:** ' + fmtDate(o.expires_at) : '',
      ].join('');
      D['mn:o:' + o.id] = {
        t: o.title || '(untitled)',
        tp: 'MNEMOS // ' + (obsTypeLabel[o.obs_type] || o.obs_type.toUpperCase()),
        m: (o.project || '—') + ' // ' + status + ' // imp ' + (o.importance ?? '?') + '/10 // ' + fmtDate(o.created_at),
        b: body,
        actions: [
          { label: 'COPY ID',     cmd: o.id, icon: 'COPY' },
          { label: 'COPY CONTENT', cmd: o.content || '', icon: 'COPY' },
          { label: 'OPEN IN CLI', cmd: mnBin + ' search ' + (o.title || '').split(/\s+/).slice(0,3).join(' '), icon: 'RUN' },
        ],
      };
    });

    mnemos.sessions.forEach(s => {
      const tagsLine = s.outcome_tags && s.outcome_tags.length ? '**Outcome tags:** ' + s.outcome_tags.map(t => '`'+t+'`').join(' ') + '\n\n' : '';
      const body = [
        '**Project:** ' + (s.project || '—') + '\n\n',
        '**Goal:** ' + (s.goal || '—') + '\n\n',
        '**Status:** ' + (s.status || '—') + '\n\n',
        tagsLine,
        '**Started:** ' + fmtDate(s.started_at) + '  \n',
        '**Ended:** ' + fmtDate(s.ended_at) + '\n\n',
        '**Observations recorded:** ' + (s.obs_count ?? 0) + '\n\n',
        s.summary ? '**Summary:**\n\n' + s.summary + '\n\n' : '',
        s.reflection ? '**Reflection:**\n\n' + s.reflection + '\n\n' : '',
        '---\n\n**Session ID:** `' + s.id + '`',
      ].join('');
      D['mn:s:' + s.id] = {
        t: s.goal ? s.goal.slice(0, 70) : (s.project || s.id.slice(0,12)),
        tp: 'MNEMOS // SESSION',
        m: (s.project || '—') + ' // ' + (s.status || 'ok').toUpperCase() + ' // ' + (s.obs_count ?? 0) + ' obs // ' + fmtDate(s.started_at),
        b: body,
        actions: [
          { label: 'COPY ID',  cmd: s.id, icon: 'COPY' },
          { label: 'REPLAY',   cmd: mnBin + ' replay ' + s.id, icon: 'RUN' },
        ],
      };
    });

    mnemos.skills.forEach(sk => {
      const promoted = (sk.tags || []).includes('auto-promoted');
      const eff = (sk.effectiveness || 0);
      const sources = sk.source_sessions && sk.source_sessions.length
        ? '\n\n**Source sessions:** ' + sk.source_sessions.map(id => '`'+id.slice(0,12)+'`').join(' ')
        : '';
      const tagsLine = sk.tags && sk.tags.length ? '**Tags:** ' + sk.tags.map(t => '`'+t+'`').join(' ') + '\n\n' : '';
      const body = [
        tagsLine,
        '**Description:** ' + (sk.description || '—') + '\n\n',
        '**Use count:** ' + (sk.use_count ?? 0) + ' · **Success:** ' + (sk.success_count ?? 0) + ' · **Effectiveness:** ' + (eff * 100).toFixed(0) + '%\n\n',
        '**Version:** v' + (sk.version || 1) + ' · **Updated:** ' + fmtDate(sk.updated_at) + '\n\n',
        '---\n\n## Procedure\n\n' + (sk.procedure || '—'),
        sk.pitfalls ? '\n\n## Pitfalls\n\n' + sk.pitfalls : '',
        sources,
      ].join('');
      D['mn:sk:' + sk.name] = {
        t: sk.name,
        tp: 'MNEMOS // SKILL' + (promoted ? ' // AUTO-PROMOTED' : ''),
        m: 'v' + (sk.version || 1) + ' // ' + (sk.use_count ?? 0) + ' uses // ' + (eff * 100).toFixed(0) + '% eff',
        b: body,
        actions: [
          { label: 'EXPORT PACK', cmd: mnBin + ' skill export ' + sk.name, icon: 'COPY' },
          { label: 'COPY NAME',   cmd: sk.name, icon: 'COPY' },
        ],
      };
    });

    mnemos.fileTouches.forEach((f, i) => {
      D['mn:f:' + i] = {
        t: f.path.split('/').slice(-2).join('/'),
        tp: 'MNEMOS // FILE TOUCH',
        m: (f.project || '—') + ' // ' + f.touches + ' touch' + (f.touches !== 1 ? 'es' : '') + ' // last ' + fmtDate(f.last_touched),
        b: '**Path:** `' + f.path + '`\n\n**Project:** ' + (f.project || '—') + '\n\n**Touches:** ' + f.touches + '  \n**Distinct sessions:** ' + (f.distinct_sessions || 0) + '  \n**Last touched:** ' + fmtDate(f.last_touched),
        actions: [
          { label: 'OPEN FILE', cmd: 'open ' + f.path, icon: 'EDIT' },
          { label: 'COPY PATH', cmd: f.path, icon: 'PATH' },
        ],
      };
    });
  }

  const sections = [
    { id: 'skills',   label: 'SKILLS',       color: '#9999FF', count: skills.length },
    { id: 'mcp',      label: 'MCP SERVERS',  color: '#FF9933', count: mcp.length },
    { id: 'hooks',    label: 'HOOKS',        color: '#CC9966', count: hooks.length },
    { id: 'plugins',  label: 'PLUGINS',      color: '#CC99CC', count: plugins.length },
    { id: 'agents',   label: 'AGENTS',       color: '#FFCC99', count: agents.length },
    { id: 'env',      label: 'ENVIRONMENT',  color: '#66CCCC', count: Object.keys(env).length },
    { id: 'memory',   label: 'MEMORY',       color: '#9999CC', count: mem.length },
    { id: 'sessions', label: 'SESSIONS',     color: '#FFCC66', count: projectHistory.length },
    { id: 'claudemd', label: 'CLAUDE.MD',    color: '#FF9933', count: claudeMds.length },
    { id: 'membanks', label: 'MEMORY BANKS', color: '#CC6699', count: memBanks.stats.total },
    { id: 'mnemos',   label: 'MNEMOS',       color: '#FF66CC', count: mnemos ? mnemos.stats.observations : null },
    { id: 'market',   label: 'MARKET',       color: '#FF9966', count: marketItems.length },
    { id: 'viz',      label: 'TACTICAL',     color: '#9999FF', count: null },
    { id: 'q',        label: 'Q',            color: '#CC6666', count: null },
    { id: 'replicator',label:'REPLICATOR',   color: '#9966FF', count: null },
    { id: 'comms',    label: 'COMMS',        color: '#66CCCC', count: null },
    { id: 'config',   label: 'CONFIG',       color: '#FFCC66', count: null },
    { id: 'academy',  label: 'ACADEMY',      color: '#FFFF99', count: null },
    { id: 'about',    label: 'ABOUT',        color: '#55CC55', count: null },
  ];

return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLAUDE-HUD // LCARS</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><circle cx='100' cy='100' r='98' fill='%231a2a3a' stroke='%232a6496' stroke-width='3'/><circle cx='100' cy='100' r='92' fill='%230d1218'/><circle cx='100' cy='100' r='78' fill='%231e5a8a'/><path d='M100 26 L140 145 L100 124 L60 145 Z' fill='%23fff'/><ellipse cx='100' cy='94' rx='63' ry='26' fill='none' stroke='%23fff' stroke-width='5' transform='rotate(-10 100 94)'/><path d='M49 109 Q75 85 105 94 Q130 100 150 105' fill='none' stroke='%23cc2222' stroke-width='7' stroke-linecap='round'/></svg>" type="image/svg+xml">
<style>
@import url('https://fonts.googleapis.com/css2?family=Antonio:wght@400;500;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');

*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#000;--text:#ccc;--dim:#666;--faint:#333;
  /* Canonical LCARS palette */
  --orange:#FF9933;--peach:#FFCC99;--blue:#6677FF;
  --lavender:#CC99CC;--tan:#CC9966;--salmon:#FF9966;
  --ltblue:#9999CC;--cyan:#66CCCC;--gold:#FFCC66;
  --red:#CC6666;--green:#55CC55;
  /* Additional canonical colors */
  --melrose:#9999FF;--violet:#9966FF;--canary:#FFFF99;
  --magenta:#CC6699;--mariner:#3366CC;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);min-height:100vh;overflow:hidden;font-size:14px;padding-top:8px}
/* ═══ BOOT SEQUENCE ═══ */
.boot-overlay{
  position:fixed;inset:0;z-index:9999;background:#000;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  transition:opacity 0.6s ease;
}
.boot-overlay.done{opacity:0;pointer-events:none}
.boot-logo{width:80px;height:80px;margin-bottom:24px;opacity:0;animation:boot-fade-in 0.4s 0.2s forwards}
.boot-title{
  font-family:'Antonio',sans-serif;font-size:2.2rem;font-weight:700;
  color:var(--orange);letter-spacing:0.12em;text-transform:uppercase;
  opacity:0;animation:boot-fade-in 0.4s 0.5s forwards;
}
.boot-ship{
  font-family:'Antonio',sans-serif;font-size:0.85rem;font-weight:500;
  color:var(--dim);letter-spacing:0.2em;text-transform:uppercase;
  margin-top:4px;opacity:0;animation:boot-fade-in 0.4s 0.7s forwards;
}
.boot-systems{
  margin-top:32px;width:320px;display:flex;flex-direction:column;gap:6px;
}
.boot-sys{
  display:flex;align-items:center;justify-content:space-between;
  font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;
  text-transform:uppercase;color:var(--dim);
  opacity:0;transform:translateX(-10px);
}
.boot-sys.on{opacity:1;transform:translateX(0);color:var(--text);transition:all 0.3s ease}
.boot-sys .boot-dot{width:8px;height:8px;border-radius:50%;background:var(--dim);transition:background 0.3s}
.boot-sys.on .boot-dot{background:var(--green)}
.boot-bar{
  width:320px;height:4px;background:#111;border-radius:2px;margin-top:20px;overflow:hidden;
  opacity:0;animation:boot-fade-in 0.3s 0.4s forwards;
}
.boot-bar-fill{height:100%;width:0;background:var(--orange);border-radius:2px;transition:width 0.3s ease}
.boot-status{
  font-family:'Antonio',sans-serif;font-size:0.9rem;letter-spacing:0.14em;
  text-transform:uppercase;color:var(--green);margin-top:16px;
  opacity:0;
}
.boot-status.on{opacity:1;animation:boot-pulse 0.8s ease 2}
@keyframes boot-fade-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes boot-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
/* ═══ ALERT SYSTEM ═══ */
.alert-border{position:fixed;inset:0;pointer-events:none;z-index:90;border:3px solid transparent;transition:border-color 0.3s}
.alert-border.red{border-color:var(--red);animation:alert-flash 0.8s infinite}
.alert-border.yellow{border-color:var(--gold);animation:alert-flash 1.5s infinite}
@keyframes alert-flash{0%,100%{opacity:1}50%{opacity:0.3}}
.alert-badge{
  position:fixed;top:8px;right:50%;transform:translateX(50%);z-index:91;
  font-family:'Antonio',sans-serif;font-size:0.8rem;font-weight:700;
  letter-spacing:0.2em;text-transform:uppercase;padding:4px 20px;
  border-radius:0 0 12px 12px;display:none;
}
.alert-badge.red{display:block;background:var(--red);color:#000;animation:alert-flash 0.8s infinite}
.alert-badge.yellow{display:block;background:var(--gold);color:#000;animation:alert-flash 1.5s infinite}
.alert-badge.green{display:block;background:var(--green);color:#000}
@keyframes q-flash-in{from{opacity:0;transform:translate(-50%,-50%) scale(0.8)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}

/* ═══ LCARS SCROLLBARS ═══ */
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:#050506;border-left:1px solid #111}
*::-webkit-scrollbar-thumb{background:var(--orange);border-radius:0;border:2px solid #050506}
*::-webkit-scrollbar-thumb:hover{background:var(--peach)}
*::-webkit-scrollbar-thumb:active{background:var(--salmon)}
*::-webkit-scrollbar-corner{background:#050506}
/* Firefox */
*{scrollbar-width:thin;scrollbar-color:var(--orange) #050506}

/* ═══ LCARS LAYOUT ═══ */
.lcars{display:grid;grid-template-columns:240px 1fr;grid-template-rows:72px 48px 26px 1fr 40px;height:calc(100vh - 8px);column-gap:6px;row-gap:0;padding:0}

/* ═══ SIDEBAR ═══ */
.sb{grid-row:1/-1;grid-column:1;display:flex;flex-direction:column;gap:6px}

.sb-top{
  background:var(--orange);
  padding:14px 20px 10px;min-height:72px;
  border-radius:0 0 56px 0;
}
.sb-top h1{font-family:'Antonio',sans-serif;font-size:2rem;font-weight:700;color:var(--bg);line-height:1;text-transform:uppercase;letter-spacing:0.02em}
.sb-top small{font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:rgba(0,0,0,0.45);display:block;margin-top:4px;letter-spacing:0.1em}

.sb-nav{display:flex;flex-direction:column;gap:4px;flex:1}

.nb{
  display:flex;align-items:center;justify-content:space-between;
  padding:0 20px;height:42px;border:none;cursor:pointer;
  font-family:'Antonio',sans-serif;font-size:1.05rem;font-weight:500;
  letter-spacing:0.06em;text-transform:uppercase;color:var(--bg);
  border-radius:0 24px 24px 0;transition:filter 0.12s,transform 0.12s;
  text-align:left;
}
.nb:hover{filter:brightness(1.25)}
.nb.act{filter:brightness(1.4);transform:scaleX(1.02);transform-origin:left}
.nb .nc{font-family:'JetBrains Mono',monospace;font-size:0.8rem;opacity:0.5}

.sb-foot{
  background:var(--orange);border-radius:0 56px 0 0;
  padding:14px 20px;font-size:0.78rem;color:rgba(0,0,0,0.5);
  letter-spacing:0.08em;margin-top:auto;font-weight:600;
}

/* ═══ TOP BAR ═══ */
.tb{grid-column:2;display:flex;gap:6px}
.tb{margin-bottom:6px}
.tb-elbow{width:72px;background:var(--orange);border-radius:0 0 0 56px;flex-shrink:0}
/* tb-fill is black — like the reference right-frame-top, data cascade is orange-on-black */
.tb-fill{flex:1;background:var(--bg);display:flex;align-items:center;justify-content:flex-end;padding:0 24px;gap:28px;
  font-family:'Antonio',sans-serif;font-size:0.95rem;letter-spacing:0.1em;color:rgba(255,153,0,0.55);text-transform:uppercase;overflow:hidden;
  border-bottom:2px solid rgba(255,153,0,0.15)}
/* ═══ DATA CASCADE ═══ */
.tb-dc{display:flex;gap:10px;flex:1;overflow:hidden;align-items:center;padding:0 0 0 8px;pointer-events:none}
.tb-dc-col{display:flex;flex-direction:column;gap:0}
.tb-dc-n{font-family:'Antonio',sans-serif;font-size:0.6rem;letter-spacing:0.04em;line-height:1.4;text-align:right;white-space:nowrap}
@keyframes dc1{0%,4%{color:rgba(255,153,0,0)}8%,45%{color:rgba(255,153,0,0.4)}48%,52%{color:rgba(255,255,255,0.7)}56%,67%{color:rgba(255,153,0,0.4)}70%,73%{color:rgba(255,255,255,0.6)}76%,100%{color:rgba(255,153,0,0.35)}}
@keyframes dc2{0%,12%{color:rgba(255,153,0,0)}16%,49%{color:rgba(255,153,0,0.4)}52%,55%{color:rgba(255,255,255,0.7)}58%,71%{color:rgba(255,153,0,0.4)}74%,77%{color:rgba(255,255,255,0.6)}80%,100%{color:rgba(255,153,0,0.35)}}
@keyframes dc3{0%,20%{color:rgba(255,153,0,0)}24%,53%{color:rgba(255,153,0,0.4)}56%,59%{color:rgba(255,255,255,0.7)}62%,75%{color:rgba(255,153,0,0.4)}78%,81%{color:rgba(255,255,255,0.6)}84%,100%{color:rgba(255,153,0,0.35)}}
.tb-dc-col:nth-child(1) .tb-dc-n{animation:dc1 6s ease 200ms infinite}
.tb-dc-col:nth-child(2) .tb-dc-n{animation:dc1 6s ease 1800ms infinite}
.tb-dc-col:nth-child(3) .tb-dc-n{animation:dc2 6s ease 400ms infinite}
.tb-dc-col:nth-child(4) .tb-dc-n{animation:dc2 6s ease 2200ms infinite}
.tb-dc-col:nth-child(5) .tb-dc-n{animation:dc3 6s ease 600ms infinite}
.tb-dc-col:nth-child(6) .tb-dc-n{animation:dc3 6s ease 3000ms infinite}
.tb-dc-col:nth-child(7) .tb-dc-n{animation:dc1 6s ease 1000ms infinite}
.tb-dc-col:nth-child(8) .tb-dc-n{animation:dc2 6s ease 1400ms infinite}
.tb-a1{width:100px;background:var(--peach);border-radius:0 0 12px 12px}
.tb-a2{width:60px;background:var(--blue);border-radius:0 0 24px 0}

/* ═══ STATS BAR ═══ */
.stb{grid-column:2;display:flex;gap:6px;margin-bottom:6px}
.stb-inner{flex:1;display:flex;gap:3px;padding:3px 0 3px 8px;background:var(--lavender);border-radius:24px;overflow:hidden}
.st{flex:1;background:var(--bg);padding:5px 12px;text-align:center;border-radius:0;border-right:2px solid rgba(204,153,204,0.25)}
.st:first-child{border-radius:20px 0 0 20px}
.st:last-child{border-right:none;border-radius:0 20px 20px 0}
.stb-cap{width:80px;background:var(--tan);flex-shrink:0;border-radius:24px}
.st-n{font-family:'Antonio',sans-serif;font-size:1.5rem;font-weight:700;color:var(--orange);line-height:1}
.st-l{font-size:0.6rem;color:var(--text);text-transform:uppercase;letter-spacing:0.12em;margin-top:2px}

/* ═══ BURN RATE BAR ═══ */
.brb{grid-column:2;display:flex;align-items:center;gap:10px;padding:4px 16px 4px 80px;background:var(--bg);font-family:'Antonio',sans-serif;font-size:0.7rem;letter-spacing:0.08em;color:var(--dim);min-height:26px}
.brb-bar{display:flex;gap:1px;align-items:center}
.brb-block{width:14px;height:10px;border-radius:2px}
.brb-block.filled{background:var(--orange)}
.brb-block.empty{background:rgba(255,153,0,0.18)}
.brb-pct{color:var(--orange);min-width:36px;text-align:right}
.brb-sep{color:rgba(255,153,0,0.35);margin:0 4px}
.brb-time{min-width:80px}
.brb-rate{color:var(--dim)}
.brb-live{font-size:0.55rem;letter-spacing:0.15em;color:#66EE66;background:rgba(102,238,102,0.12);padding:1px 5px;border-radius:4px;margin-left:auto;animation:lcars-blink 2s infinite}
.brb-meter{display:flex;align-items:flex-end;gap:2px;height:18px;margin-left:8px}
.brb-m-line{width:3px;background:var(--orange);border-radius:1px;height:6px;animation:lcars-bounce 1s ease-in-out infinite}
@keyframes lcars-blink{0%,48%{opacity:1}50%,98%{opacity:0.25}100%{opacity:1}}
@keyframes lcars-pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(0.55)}}
@keyframes lcars-bounce{0%,100%{height:6px}50%{height:22px}}

/* ═══ MAIN AREA ═══ */
.mn{grid-column:2;display:flex;gap:0;min-height:0;overflow:hidden;margin-top:6px}
.mn-edge{width:72px;flex-shrink:0;display:flex;flex-direction:column;gap:0;position:relative;background:none}
.mne-p{flex-shrink:0;border-radius:0 16px 16px 0}
.mne-p:first-child{border-radius:0 16px 0 0}
.mne-p:last-child{border-radius:0 0 16px 0}
.mne-b{height:6px;flex-shrink:0}

.mn-content{flex:1;display:grid;grid-template-columns:1fr 0fr;transition:grid-template-columns 0.25s ease;min-height:0;overflow:hidden;gap:4px;margin-left:4px}
.mn-content.open{grid-template-columns:1fr 1fr}

/* ═══ LIST ═══ */
.ls{background:#060608;overflow-y:auto;min-height:0;border-radius:16px}

.sec{display:none}
.sec.on{display:block}
#s-q.on{display:flex;flex-direction:column;height:100%;background:#050508}
#s-viz.on{display:flex;flex-direction:column;position:relative;height:100%}
#s-replicator.on{display:flex;flex-direction:column;height:100%;background:#020208;padding:0}
.rep-header{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:2px solid rgba(204,153,255,0.2);flex-shrink:0;background:#030309}
.rep-title{font-family:'Antonio',sans-serif;font-size:1.1rem;letter-spacing:0.18em;color:#CC99FF;display:block}
.rep-subtitle{font-size:0.55rem;letter-spacing:0.2em;color:var(--dim);display:block;margin-top:2px}
.rep-spinner{width:18px;height:18px;border:2px solid rgba(204,153,255,0.2);border-top-color:#CC99FF;border-radius:50%;display:none;animation:spin 0.75s linear infinite}
.rep-spinner.on{display:block}
.rep-status-lbl{font-family:'Antonio',sans-serif;font-size:0.65rem;letter-spacing:0.18em;color:var(--dim);margin-left:auto}
.rep-body{flex:1;display:flex;gap:8px;padding:8px;min-height:0;overflow:hidden}
.rep-chat{width:300px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;min-height:0}
.rep-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;min-height:0;padding:2px 0}
.rep-msg{padding:10px 14px;border-radius:10px;font-size:0.78rem;line-height:1.55;word-break:break-word}
.rep-msg.user{background:rgba(204,153,255,0.1);border-left:3px solid #CC99FF}
.rep-msg.ai{background:rgba(0,0,0,0.4);border-left:3px solid rgba(204,153,255,0.3)}
.rep-msg-from{font-family:'Antonio',sans-serif;font-size:0.58rem;letter-spacing:0.18em;color:#CC99FF;margin-bottom:4px;opacity:0.65}
.rep-msg.user .rep-msg-from{color:var(--orange)}
.rep-msg-text{color:var(--text)}
.rep-input-row{display:flex;gap:6px;flex-shrink:0}
.rep-input{flex:1;background:#080810;border:1px solid rgba(204,153,255,0.2);border-radius:8px;color:var(--text);padding:8px 10px;font-family:'JetBrains Mono',monospace;font-size:0.75rem;resize:none;outline:none;transition:border-color 0.15s;min-height:40px}
.rep-input:focus{border-color:#CC99FF}
.rep-send{background:#CC99FF;color:#000;border:none;border-radius:10px;padding:0 16px;font-family:'Antonio',sans-serif;font-size:0.72rem;letter-spacing:0.12em;cursor:pointer;font-weight:700;transition:filter 0.12s;white-space:nowrap}
.rep-send:hover{filter:brightness(1.15)}
.rep-hint{font-size:0.55rem;color:var(--faint);letter-spacing:0.1em;text-align:right;flex-shrink:0}
.rep-input{flex:1;background:#080810;border:1px solid rgba(204,153,255,0.2);border-radius:8px;color:var(--text);padding:8px 10px;font-family:'JetBrains Mono',monospace;font-size:0.75rem;resize:none;outline:none;transition:border-color 0.15s;height:64px}
.rep-canvas-wrap{flex:1;position:relative;border-radius:12px;border:1px solid rgba(204,153,255,0.12);overflow:hidden;min-height:0;background:#020208}
#rep-canvas{display:block;width:100%;height:100%}
.rep-canvas-label{position:absolute;bottom:0;left:0;right:0;padding:6px 10px;background:rgba(2,2,8,0.85);font-family:'Antonio',sans-serif;font-size:0.6rem;letter-spacing:0.22em;color:#CC99FF;border-top:1px solid rgba(204,153,255,0.12);display:flex;align-items:center;gap:10px}
.rep-label-text{flex:1;pointer-events:none}
.rep-export-btns{display:none;gap:5px}
.rep-export-btns.on{display:flex}
.rep-exp-btn{background:rgba(204,153,255,0.12);border:1px solid rgba(204,153,255,0.3);color:#CC99FF;font-family:'Antonio',sans-serif;font-size:0.6rem;letter-spacing:0.12em;padding:3px 9px;border-radius:5px;cursor:pointer;transition:background 0.12s}
.rep-exp-btn:hover{background:rgba(204,153,255,0.25)}
/* Materializing overlay — shown while Claude is generating the scene */
.rep-canvas-wrap.materializing::before{content:'REPLICATING';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:'Antonio',sans-serif;font-size:1.1rem;letter-spacing:0.4em;color:#CC99FF;z-index:4;animation:rep-pulse 1s ease-in-out infinite;text-shadow:0 0 24px rgba(204,153,255,0.9),0 0 48px rgba(204,153,255,0.4),0 0 80px rgba(204,153,255,0.15);pointer-events:none}
.rep-canvas-wrap.materializing::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(204,153,255,0.04) 3px,rgba(204,153,255,0.04) 4px);animation:rep-scan 0.4s linear infinite;z-index:3;pointer-events:none}
@keyframes rep-scan{0%{background-position:0 0}100%{background-position:0 20px}}
@keyframes rep-pulse{0%,100%{opacity:0.35;letter-spacing:0.3em}50%{opacity:1;letter-spacing:0.5em}}
.rep-no-key{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--dim);font-size:0.75rem;letter-spacing:0.08em}

.sec-h{
  position:sticky;top:0;z-index:5;background:#060608;
  padding:16px 20px 10px;border-bottom:2px solid #1a1a1e;
  font-family:'Antonio',sans-serif;font-size:1.2rem;font-weight:600;
  text-transform:uppercase;letter-spacing:0.08em;color:var(--orange);
  display:flex;align-items:center;justify-content:space-between;
}
.sec-h-new{
  background:var(--blue);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;
  padding:4px 14px;cursor:pointer;letter-spacing:0.1em;text-transform:uppercase;
  border-radius:12px;transition:filter 0.12s;
}
.sec-h-new:hover{filter:brightness(1.3)}

/* ═══ CREATE FORM ═══ */
.create-form{
  display:none;background:#060608;border-bottom:2px solid var(--orange);
  padding:20px;
}
.create-form.active{display:block}
.create-form h3{
  font-family:'Antonio',sans-serif;font-size:1rem;font-weight:600;
  color:var(--orange);text-transform:uppercase;letter-spacing:0.08em;
  margin-bottom:14px;
}
.cf-row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.cf-row label{
  min-width:100px;font-size:0.78rem;font-weight:600;color:var(--text);
  text-transform:uppercase;letter-spacing:0.05em;
}
.cf-row input,.cf-row textarea,.cf-row select{
  flex:1;background:#0a0a0c;border:1px solid #222;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:0.82rem;
  padding:8px 12px;outline:none;border-radius:8px;
}
.cf-row input:focus,.cf-row textarea:focus{border-color:var(--orange)}
.cf-row textarea{min-height:80px;resize:vertical}
.cf-actions{display:flex;gap:8px;margin-top:14px}
.cf-create{
  background:var(--green);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:600;
  padding:8px 20px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;
  border-radius:12px;
}
.cf-create:hover{filter:brightness(1.2)}
.cf-cancel{
  background:var(--tan);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:600;
  padding:8px 16px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;
  border-radius:12px;
}
.cf-cancel:hover{filter:brightness(1.2)}

.r{
  display:grid;grid-template-columns:180px auto 1fr;gap:10px;
  padding:10px 20px;font-size:0.88rem;line-height:1.6;
  border-bottom:1px solid #111;cursor:pointer;
  transition:background 0.1s;align-items:baseline;
}
.r:hover{background:#0e0e10}
.r.sel{background:rgba(255,153,0,0.07);border-left:4px solid var(--orange);padding-left:16px}
.r-id{font-weight:600;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-tg{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap}
.r-d{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r2{grid-template-columns:240px 1fr}

.tg{font-size:0.72rem;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap}
.tg::before{content:'['}
.tg::after{content:']'}
.tg-o{color:var(--orange)}.tg-b{color:var(--blue)}.tg-c{color:var(--cyan)}
.tg-t{color:var(--tan)}.tg-g{color:var(--green)}.tg-r{color:var(--red)}
.tg-d{color:var(--dim)}.tg-l{color:var(--lavender)}

.emp{padding:16px 20px;color:var(--faint);font-size:0.88rem}
.emp::before{content:'-- '}

/* ═══ MCP TACTICAL DISPLAY ═══ */
.mcp-overview{
  display:flex;gap:3px;padding:12px 12px 0;
}
.mcp-overview-stat{
  flex:1;background:#060608;border:1px solid #1a1a1e;padding:12px;text-align:center;border-radius:12px;
}
.mcp-overview-n{font-family:'Antonio',sans-serif;font-size:1.8rem;font-weight:700;line-height:1}
.mcp-overview-n.green{color:var(--green)}
.mcp-overview-n.red{color:var(--red)}
.mcp-overview-n.orange{color:var(--orange)}
.mcp-overview-n.total{color:var(--blue)}
.mcp-overview-l{font-size:0.6rem;color:var(--dim);text-transform:uppercase;letter-spacing:0.1em;margin-top:4px}

.mcp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:4px;padding:12px}
.mcp-card{
  background:#060608;border:1px solid #1a1a1e;position:relative;
  padding:16px;cursor:pointer;transition:background 0.12s,border-color 0.15s;
  display:grid;grid-template-rows:auto auto auto auto;gap:8px;border-radius:16px;
}
.mcp-card:hover{background:#0c0c10;border-color:#2a2a30}
.mcp-card.sel{border-color:var(--orange);background:rgba(255,153,0,0.04)}
.mcp-card-top{display:flex;align-items:center;gap:10px}
.mcp-card-status{
  width:10px;height:10px;border-radius:50%;flex-shrink:0;
  background:var(--tan);box-shadow:0 0 4px rgba(204,153,102,0.4);
}
.mcp-card-status.ready{background:var(--green);box-shadow:0 0 8px var(--green)}
.mcp-card-status.error{background:var(--red);box-shadow:0 0 8px var(--red)}
.mcp-card-status.missing{background:var(--orange);box-shadow:0 0 6px rgba(255,153,0,0.4)}
.mcp-card-status.checking{animation:status-blink 0.8s infinite}
@keyframes status-blink{0%,100%{opacity:1}50%{opacity:0.3}}
.mcp-card-name{
  font-family:'Antonio',sans-serif;font-size:1.1rem;font-weight:600;
  text-transform:uppercase;letter-spacing:0.06em;color:var(--text);flex:1;
}
.mcp-card-type{
  font-size:0.6rem;letter-spacing:0.08em;text-transform:uppercase;
  padding:3px 8px;flex-shrink:0;border-radius:6px;
}
.mcp-card-type.node{background:rgba(85,204,85,0.12);color:var(--green)}
.mcp-card-type.python{background:rgba(102,204,204,0.12);color:var(--cyan)}
.mcp-card-type.npx{background:rgba(255,153,0,0.12);color:var(--orange)}
.mcp-card-type.docker{background:rgba(153,153,255,0.12);color:var(--blue)}
.mcp-card-type.unknown{background:rgba(204,153,102,0.12);color:var(--tan)}

.mcp-card-body{display:flex;flex-direction:column;gap:3px}
.mcp-card-row{display:flex;gap:8px;font-size:0.78rem;line-height:1.5}
.mcp-card-label{color:var(--dim);min-width:50px;text-transform:uppercase;font-size:0.6rem;letter-spacing:0.08em;padding-top:2px}
.mcp-card-val{color:var(--text);word-break:break-all}

.mcp-card-footer{display:flex;align-items:center;justify-content:space-between}
.mcp-card-bar{
  flex:1;height:3px;background:#1a1a1e;position:relative;overflow:hidden;
}
.mcp-card-bar .bar-fill{
  position:absolute;top:0;left:0;height:100%;width:100%;
  transition:width 0.4s ease,background 0.3s;
}
.mcp-card-bar .bar-fill.ready{background:var(--green);width:100%}
.mcp-card-bar .bar-fill.error{background:var(--red);width:30%}
.mcp-card-bar .bar-fill.missing{background:var(--orange);width:60%}
.mcp-card-bar .bar-fill.unknown{background:var(--tan);width:50%}
.mcp-card-bar .bar-fill.checking{
  background:linear-gradient(90deg,var(--blue),var(--cyan));
  width:100%;animation:mcp-scan 1.5s ease-in-out infinite;
}
@keyframes mcp-scan{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.mcp-card-status-label{
  font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;margin-left:10px;flex-shrink:0;
}
.mcp-card-status-label.ready{color:var(--green)}
.mcp-card-status-label.error{color:var(--red)}
.mcp-card-status-label.missing{color:var(--orange)}
.mcp-card-status-label.unknown{color:var(--tan)}
.mcp-card-status-label.checking{color:var(--blue)}
.mcp-card-disabled{opacity:0.5;filter:grayscale(0.6)}
.mcp-toggle-btn{font-family:Antonio,sans-serif;font-size:0.6rem;letter-spacing:0.1em;padding:2px 8px;background:transparent;border:1px solid #333;color:var(--dim);cursor:pointer;border-radius:4px;flex-shrink:0;margin-left:8px}
.mcp-toggle-btn:hover{border-color:var(--cyan);color:var(--cyan)}
.mcp-sec-flag{font-family:Antonio,sans-serif;font-size:0.55rem;letter-spacing:0.08em;padding:2px 6px;background:rgba(204,68,68,0.15);border:1px solid rgba(204,68,68,0.4);color:var(--red);border-radius:4px;cursor:help;flex-shrink:0;margin-left:auto}
.mcp-card-status.mcp-disabled{background:var(--faint)}
.ph-card{background:#0a0a0c;border:1px solid #1a1a1e;border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;cursor:pointer;transition:border-color 0.15s}
.ph-card:hover{border-color:var(--ltblue)}
.ph-card-name{font-family:Antonio,sans-serif;font-size:0.9rem;letter-spacing:0.06em;color:var(--ltblue)}
.ph-card-meta{font-size:0.65rem;color:var(--dim);display:flex;gap:12px}
.ph-card-sessions{color:var(--cyan)}
.ph-card-date{color:var(--faint)}
.ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px;padding:12px}
.health-badge{display:inline-flex;align-items:center;gap:6px;font-family:Antonio,sans-serif;font-size:0.65rem;letter-spacing:0.1em;padding:3px 10px;border-radius:10px;border:1px solid}
.health-badge.good{color:var(--green);border-color:rgba(85,204,85,0.4);background:rgba(85,204,85,0.08)}
.health-badge.warn{color:var(--gold);border-color:rgba(255,204,102,0.4);background:rgba(255,204,102,0.08)}
.health-badge.bad{color:var(--red);border-color:rgba(204,68,68,0.4);background:rgba(204,68,68,0.08)}
.health-issues{font-size:0.65rem;color:var(--red);margin-top:4px;display:flex;flex-direction:column;gap:2px}
.health-praise{font-size:0.65rem;color:var(--dim);margin-top:2px}

/* ═══ DISCOVER ═══ */
.discover{border-top:1px dashed #1a1a1e;margin-top:4px}
.discover-hdr{padding:10px 20px;font-size:0.75rem;color:var(--faint,#333);cursor:pointer;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.1em;user-select:none;transition:color .15s}
.discover-hdr:hover,.discover-hdr.open{color:var(--tan,#bb8844)}
.discover-arrow{font-size:0.65rem;transition:transform .15s;display:inline-block}
.discover-hdr.open .discover-arrow{transform:rotate(90deg)}
.discover-body{padding:8px 12px 12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
.suggest-card{background:#05050a;border:1px solid #141420;padding:12px 14px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s;cursor:pointer;border-radius:14px}
.suggest-card:hover{border-color:#FF9900AA}
.suggest-name{font-size:0.88rem;font-weight:600;color:#ccc}
.suggest-desc{font-size:0.77rem;color:var(--dim,#555);flex:1;line-height:1.5}
.suggest-footer{display:flex;align-items:center;justify-content:space-between;margin-top:4px}
.suggest-tag{font-size:0.63rem;color:var(--tan,#bb8844);text-transform:uppercase;letter-spacing:.07em}
.suggest-install{background:#FF9900;color:#000;border:none;padding:3px 10px;font-family:monospace;font-size:0.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;border-radius:2px;transition:background .1s}
.suggest-install:hover{background:#FFAA22}
.suggest-install:disabled{background:#2a2a2a;color:#555;cursor:default}

/* ═══ MARKETPLACE ═══ */
.mkt-filters{display:flex;gap:6px;padding:10px 16px 0;flex-wrap:wrap;align-items:center}
.mkt-filter-btn{font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border:1.5px solid var(--faint);background:transparent;color:var(--dim);cursor:pointer;border-radius:3px;transition:all 0.15s}
.mkt-filter-btn.act{border-color:var(--orange);color:var(--orange);background:rgba(255,153,0,0.08)}
.mkt-search{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:0.72rem;letter-spacing:0.06em;text-transform:uppercase;padding:4px 10px;border:1.5px solid var(--faint);background:#060606;color:var(--text);border-radius:3px;width:180px;outline:none;transition:border-color 0.15s}
.mkt-search:focus{border-color:var(--orange)}
.mkt-search::placeholder{color:var(--dim)}
.mkt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;padding:12px 16px;overflow-y:auto}
.mkt-card{background:#0a0a0a;border:1px solid #222;border-radius:4px;padding:14px;cursor:pointer;transition:border-color 0.15s,background 0.15s;display:flex;flex-direction:column;gap:8px}
.mkt-card:hover{border-color:var(--orange);background:#0f0f0f}
.mkt-card.installed{border-color:#1a3a1a}
.mkt-card-name{font-family:'Antonio',sans-serif;font-size:1rem;font-weight:600;color:var(--peach);letter-spacing:0.04em;text-transform:uppercase}
.mkt-card-desc{font-size:0.72rem;color:var(--dim);line-height:1.5;flex:1}
.mkt-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.mkt-card-author{font-size:0.65rem;color:var(--dim);letter-spacing:0.05em}
.mkt-src{font-family:'Antonio',sans-serif;font-size:0.65rem;padding:2px 7px;border-radius:2px;background:#1a1a1a;color:var(--dim);letter-spacing:0.06em;text-transform:uppercase}
.mkt-cap{font-family:'Antonio',sans-serif;font-size:0.6rem;padding:2px 6px;border-radius:2px;letter-spacing:0.08em;text-transform:uppercase}
.mkt-cap.skills{background:rgba(153,153,255,0.15);color:var(--blue)}
.mkt-cap.agents{background:rgba(255,204,153,0.15);color:var(--peach)}
.mkt-cap.hooks{background:rgba(204,153,102,0.15);color:var(--tan)}
.mkt-cap.mcp{background:rgba(255,153,0,0.15);color:var(--orange)}
.mkt-cap.commands{background:rgba(102,204,204,0.15);color:var(--cyan)}
.mkt-card-footer{display:flex;justify-content:space-between;align-items:center;margin-top:4px}
.mkt-install-btn{font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;padding:5px 14px;border:1.5px solid var(--orange);background:transparent;color:var(--orange);cursor:pointer;border-radius:3px;transition:all 0.15s}
.mkt-install-btn:hover{background:var(--orange);color:#000}
.mkt-install-btn:disabled{border-color:var(--faint);color:var(--faint);cursor:default}
.mkt-installed-badge{font-family:'Antonio',sans-serif;font-size:0.7rem;letter-spacing:0.1em;color:var(--green);text-transform:uppercase}
.mkt-load-remote{font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;padding:4px 13px;border:1.5px solid var(--cyan);background:transparent;color:var(--cyan);cursor:pointer;border-radius:3px;transition:all 0.15s}
.mkt-load-remote:hover{background:rgba(102,204,204,0.15)}
.mkt-load-remote:disabled{border-color:var(--faint);color:var(--faint);cursor:default}

/* ═══ CONFIRM MODAL ═══ */
.hud-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;animation:fadein .15s}
.hud-modal{background:#08080f;border:2px solid var(--orange);padding:28px 32px;max-width:460px;width:90%;animation:slidein .15s}
@keyframes slidein{from{transform:translateY(-16px);opacity:0}to{transform:translateY(0);opacity:1}}
.hud-modal-title{font-size:0.65rem;letter-spacing:.2em;color:var(--orange);text-transform:uppercase;margin-bottom:14px}
.hud-modal-msg{color:#ccc;margin-bottom:24px;line-height:1.7;font-size:0.82rem;white-space:pre-wrap;word-break:break-all}
.hud-modal-actions{display:flex;gap:10px;justify-content:flex-end}
.hud-modal-cancel{background:transparent;border:1px solid #2a2a2a;color:#666;padding:7px 18px;font-family:'JetBrains Mono',monospace;font-size:0.72rem;letter-spacing:.1em;cursor:pointer;text-transform:uppercase;transition:border-color .15s}
.hud-modal-cancel:hover{border-color:#555;color:#aaa}
.hud-modal-confirm{background:#8b0000;border:none;color:#fff;padding:7px 18px;font-family:'JetBrains Mono',monospace;font-size:0.72rem;letter-spacing:.1em;cursor:pointer;font-weight:700;text-transform:uppercase;transition:background .15s}
.hud-modal-confirm:hover{background:#cc0000}

/* ═══ DETAIL PANEL (PADD) ═══ */
.dp{background:#08080a;overflow-y:auto;min-height:0;opacity:0;transition:opacity 0.2s;border-left:4px solid var(--orange);position:relative;border-radius:12px}
.mn-content.open .dp{opacity:1}

.dp-h{padding:16px 20px;border-bottom:2px solid #1a1a1e;position:sticky;top:0;background:#08080a;z-index:5}
.dp-tp{font-size:0.72rem;font-weight:600;color:var(--orange);letter-spacing:0.14em;text-transform:uppercase;margin-bottom:4px}
.dp-t{font-family:'Antonio',sans-serif;font-size:1.7rem;font-weight:700;color:#eee;text-transform:uppercase;letter-spacing:0.02em;line-height:1.15}
.dp-m{font-size:0.78rem;color:var(--dim);margin-top:6px}

.dp-x{
  position:absolute;top:14px;right:16px;
  background:var(--orange);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.85rem;font-weight:600;
  padding:5px 14px;cursor:pointer;text-transform:uppercase;
  letter-spacing:0.08em;border-radius:12px;
}
.dp-x:hover{filter:brightness(1.3)}

.dp-b{padding:24px 28px;font-size:0.88rem;line-height:1.8;color:var(--text)}
.dp-b h1,.dp-b h2,.dp-b h3{font-family:'Antonio',sans-serif;text-transform:uppercase;letter-spacing:0.05em;margin:24px 0 10px;line-height:1.2}
.dp-b h1{font-size:1.4rem;color:var(--peach);border-bottom:2px solid #1a1a1e;padding-bottom:8px}
.dp-b h2{font-size:1.15rem;color:var(--peach)}
.dp-b h3{font-size:1rem;color:var(--tan)}
.dp-b p{margin-bottom:10px}
.dp-b code{background:rgba(255,153,0,0.08);color:var(--orange);padding:2px 6px;font-size:0.84rem}
.dp-b pre{
  background:#0a0a0c;border:1px solid #222;border-left:3px solid var(--blue);
  padding:16px 18px;margin:12px 0;overflow-x:auto;font-size:0.84rem;
  line-height:1.7;color:var(--text);border-radius:0;position:relative;
  counter-reset:line;white-space:pre;tab-size:2;
}
.dp-b pre::before{
  content:attr(data-lang);position:absolute;top:0;right:0;
  background:var(--blue);color:var(--bg);font-family:'Antonio',sans-serif;
  font-size:0.65rem;font-weight:600;padding:2px 10px;letter-spacing:0.1em;
  text-transform:uppercase;
}
.dp-b pre code{background:none;color:inherit;padding:0;font-size:inherit}
.dp-b pre .kw{color:var(--blue)}
.dp-b pre .str{color:var(--peach)}
.dp-b pre .num{color:var(--orange)}
.dp-b pre .key{color:var(--cyan)}
.dp-b pre .bool{color:var(--salmon)}
.dp-b pre .cmt{color:var(--dim);font-style:italic}
.dp-b pre .punc{color:#888}
.dp-b ul,.dp-b ol{padding-left:28px;margin:8px 0 12px;list-style-position:outside}
.dp-b ul{list-style-type:disc}
.dp-b ol{list-style-type:decimal}
.dp-b li{margin-bottom:6px;padding-left:4px}
.dp-b li::marker{color:var(--orange)}
.dp-b strong{color:#eee}
.dp-b table{width:100%;border-collapse:collapse;margin:10px 0;font-size:0.82rem}
.dp-b th{text-align:left;padding:8px;border-bottom:2px solid var(--orange);color:var(--orange);font-weight:600;text-transform:uppercase;font-size:0.72rem;letter-spacing:0.08em}
.dp-b td{padding:6px 8px;border-bottom:1px solid #1a1a1e}
.dp-b blockquote{border-left:3px solid var(--tan);padding-left:14px;color:var(--dim);margin:10px 0}

/* ═══ ACTION BAR ═══ */
.dp-actions{display:flex;gap:4px;padding:12px 20px;border-bottom:1px solid #1a1a1e;background:#060608;flex-wrap:wrap}
.act-btn{
  display:inline-flex;align-items:center;gap:6px;
  padding:6px 14px;border:none;cursor:pointer;
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:500;
  letter-spacing:0.08em;text-transform:uppercase;color:var(--bg);
  border-radius:14px;transition:filter 0.12s;
}
.act-btn:hover{filter:brightness(1.3)}
.act-btn[data-icon=RUN]{background:var(--green)}
.act-btn[data-icon=EDIT]{background:var(--orange)}
.act-btn[data-icon=PATH]{background:var(--blue)}
.act-btn[data-icon=COPY]{background:var(--cyan)}
.act-btn[data-icon=DEL]{background:var(--red)}

/* ═══ TOAST ═══ */
.toast{
  position:fixed;bottom:60px;left:50%;transform:translateX(-50%) translateY(20px);
  background:var(--orange);color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.9rem;font-weight:600;
  letter-spacing:0.1em;text-transform:uppercase;
  padding:10px 28px;border-radius:20px;
  opacity:0;transition:opacity 0.2s,transform 0.2s;
  pointer-events:none;z-index:9999;
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ═══ COMMS / CHAT ═══ */
.comms{display:flex;flex-direction:column;height:100%;min-height:0}
.comms-log{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
.comms-msg{max-width:85%;line-height:1.7;font-size:0.88rem}
.comms-msg.user{align-self:flex-end;background:rgba(153,153,255,0.08);border:1px solid rgba(153,153,255,0.15);border-right:3px solid var(--blue);padding:12px 16px;color:var(--blue);font-size:0.88rem}
.comms-msg.ai{align-self:flex-start;color:var(--text);padding:14px 18px;background:rgba(255,153,0,0.03);border:1px solid #1a1a1e;border-left:3px solid var(--orange);max-width:90%;line-height:1.8}
.comms-msg.ai h1,.comms-msg.ai h2,.comms-msg.ai h3{font-family:'Antonio',sans-serif;text-transform:uppercase;letter-spacing:0.05em;margin:16px 0 8px;line-height:1.2}
.comms-msg.ai h1{font-size:1.3rem;color:var(--peach);border-bottom:2px solid #1a1a1e;padding-bottom:6px}
.comms-msg.ai h2{font-size:1.1rem;color:var(--peach)}
.comms-msg.ai h3{font-size:0.95rem;color:var(--tan)}
.comms-msg.ai p{margin-bottom:10px}
.comms-msg.ai strong{color:#eee}
.comms-msg.ai em{color:var(--lavender);font-style:italic}
.comms-msg.ai pre{background:#0a0a0c;border-left:3px solid var(--blue);padding:12px;margin:8px 0;overflow-x:auto;font-size:0.82rem;color:var(--cyan);position:relative}
.comms-msg.ai pre::before{content:attr(data-lang);position:absolute;top:4px;right:8px;font-size:0.6rem;color:var(--dim);text-transform:uppercase;letter-spacing:0.1em}
.comms-msg.ai pre code{background:none;color:inherit;padding:0;font-size:inherit}
.comms-msg.ai pre .kw{color:var(--blue)}
.comms-msg.ai pre .str{color:var(--peach)}
.comms-msg.ai pre .num{color:var(--orange)}
.comms-msg.ai pre .key{color:var(--cyan)}
.comms-msg.ai pre .bool{color:var(--salmon)}
.comms-msg.ai pre .cmt{color:var(--dim);font-style:italic}
.comms-msg.ai code{background:rgba(255,153,0,0.08);color:var(--orange);padding:2px 5px;font-size:0.84rem}
.comms-msg.ai ul,.comms-msg.ai ol{padding-left:22px;margin-bottom:10px}
.comms-msg.ai li{margin-bottom:4px}
.comms-msg.ai li::marker{color:var(--orange)}
.comms-msg.ai table{width:100%;border-collapse:collapse;margin:10px 0;font-size:0.82rem}
.comms-msg.ai td{padding:6px 8px;border-bottom:1px solid #1a1a1e}
.comms-msg.ai blockquote{border-left:3px solid var(--tan);padding-left:14px;color:var(--dim);margin:10px 0}
.comms-msg.ai a{color:var(--orange);text-decoration:none;border-bottom:1px solid rgba(255,153,0,0.3)}
.comms-msg.err{color:var(--red);font-size:0.82rem;padding:8px 12px;border:1px solid rgba(204,68,68,0.2);background:rgba(204,68,68,0.05)}
.comms-msg.sys{color:var(--dim);font-size:0.78rem;text-align:center;align-self:center}
.comms-input{display:flex;gap:4px;padding:8px;border-top:2px solid #1a1a1e;background:#060608}
.comms-input textarea{
  flex:1;background:#0a0a0c;border:1px solid #222;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:0.88rem;
  padding:10px 14px;resize:none;height:44px;outline:none;
  transition:border-color 0.15s;
}
.comms-input textarea:focus{border-color:var(--orange)}
.comms-send{
  background:var(--orange);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.9rem;font-weight:600;
  padding:0 20px;cursor:pointer;letter-spacing:0.1em;text-transform:uppercase;
  border-radius:0 14px 14px 0;transition:filter 0.12s;
}
.comms-send:hover{filter:brightness(1.3)}
.comms-send:disabled{opacity:0.4;cursor:default;filter:none}
.comms-toolbar{display:flex;gap:4px;padding:6px 8px;border-top:1px solid #1a1a1e;background:#060608;align-items:center}
.comms-toolbar label{font-size:0.7rem;color:var(--dim);letter-spacing:0.05em;display:flex;align-items:center;gap:6px;cursor:pointer}
.comms-toolbar input[type=checkbox]{accent-color:var(--orange)}

/* ═══ CONFIG PANEL ═══ */
.cfg{padding:20px;display:flex;flex-direction:column;gap:20px;overflow-y:auto}
.cfg-section{border:1px solid #1a1a1e;background:#060608}
.cfg-section-head{
  padding:10px 16px;background:#0a0a0c;border-bottom:1px solid #1a1a1e;
  font-family:'Antonio',sans-serif;font-size:0.95rem;font-weight:600;
  text-transform:uppercase;letter-spacing:0.08em;color:var(--orange);
}
.cfg-section-body{padding:16px}
.cfg-row{
  display:flex;align-items:center;gap:12px;
  padding:12px 0;border-bottom:1px solid #111;
  font-size:0.85rem;
}
.cfg-row:last-child{border-bottom:none}
.cfg-row-stack{
  display:flex;flex-direction:column;gap:8px;
  padding:12px 0;border-bottom:1px solid #111;
  font-size:0.85rem;
}
.cfg-row-stack:last-child{border-bottom:none}
.cfg-row-stack .cfg-label{margin-bottom:2px}
.cfg-label{
  min-width:160px;font-weight:600;color:var(--text);
  flex-shrink:0;
}
.cfg-desc{
  flex:1;font-size:0.78rem;color:var(--dim);line-height:1.5;
}
.cfg-input{
  width:360px;flex-shrink:0;
}
.cfg-input-wide{
  width:100%;flex-shrink:0;grid-column:1/-1;margin-top:4px;
}
.cfg-input input,.cfg-input select{
  width:100%;background:#0a0a0c;border:1px solid #222;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:0.82rem;
  padding:8px 12px;outline:none;transition:border-color 0.15s;
}
.cfg-input input:focus,.cfg-input select:focus{border-color:var(--orange)}
.cfg-input input::placeholder{color:var(--faint)}
/* Custom LCARS select */
.lcars-select{position:relative;width:100%}
.lcars-select-btn{
  width:100%;background:#0a0a0c;border:1px solid #222;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:0.82rem;
  padding:8px 12px;text-align:left;cursor:pointer;
  display:flex;align-items:center;justify-content:space-between;
  transition:border-color 0.15s;border-radius:8px;
}
.lcars-select-btn:hover{border-color:var(--orange)}
.lcars-select-btn::after{
  content:'';width:0;height:0;
  border-left:5px solid transparent;border-right:5px solid transparent;
  border-top:5px solid var(--orange);flex-shrink:0;margin-left:8px;
}
.lcars-select-btn.open{border-color:var(--orange)}
.lcars-select-btn.open::after{border-top:none;border-bottom:5px solid var(--orange)}
.lcars-dropdown{
  display:none;position:absolute;top:100%;left:0;right:0;z-index:20;
  background:#0a0a0c;border:1px solid var(--orange);border-top:none;
  max-height:200px;overflow-y:auto;border-radius:0 0 8px 8px;
}
.lcars-dropdown.open{display:block}
.lcars-option{
  padding:8px 12px;cursor:pointer;font-size:0.82rem;
  font-family:'JetBrains Mono',monospace;color:var(--text);
  transition:background 0.1s;
}
.lcars-option:hover{background:rgba(255,153,0,0.08)}
.lcars-option.selected{color:var(--orange);font-weight:600}
.lcars-option .opt-label{display:block}
.lcars-option .opt-sub{display:block;font-size:0.7rem;color:var(--dim);margin-top:2px}
/* Voice browser */
.voice-browser{max-height:320px;overflow-y:auto;border:1px solid #222;background:#050508;margin-top:8px}
.voice-browser::-webkit-scrollbar{width:6px}
.voice-browser::-webkit-scrollbar-thumb{background:var(--orange);border-radius:3px}
.voice-card{
  display:flex;align-items:center;gap:12px;padding:10px 14px;
  border-bottom:1px solid #151518;cursor:pointer;transition:background 0.1s;
}
.voice-card:last-child{border-bottom:none}
.voice-card:hover{background:rgba(255,153,0,0.06)}
.voice-card.selected{background:rgba(255,153,0,0.1);border-left:3px solid var(--orange)}
.voice-card .vc-play{
  flex-shrink:0;width:32px;height:32px;border-radius:50%;
  background:transparent;border:2px solid var(--blue);color:var(--blue);
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  font-size:0.7rem;transition:all 0.15s;
}
.voice-card .vc-play:hover{background:var(--blue);color:#000}
.voice-card .vc-play.playing{border-color:var(--salmon);color:var(--salmon);animation:pulse-glow 1s infinite}
.voice-card .vc-play.playing:hover{background:var(--salmon);color:#000}
.voice-card .vc-info{flex:1;min-width:0}
.voice-card .vc-name{font-family:Antonio,sans-serif;font-size:0.9rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text)}
.voice-card .vc-meta{font-size:0.65rem;color:var(--dim);margin-top:2px;letter-spacing:0.03em}
.voice-card .vc-cat{
  flex-shrink:0;font-size:0.6rem;letter-spacing:0.08em;text-transform:uppercase;
  padding:3px 8px;border-radius:8px;background:rgba(153,153,255,0.12);color:var(--blue);
}
.voice-loading{padding:20px;text-align:center;color:var(--dim);font-size:0.8rem;letter-spacing:0.06em}
@keyframes pulse-glow{0%,100%{opacity:1}50%{opacity:0.5}}
.cfg-status{
  display:inline-flex;align-items:center;gap:6px;
  font-size:0.75rem;letter-spacing:0.06em;margin-top:4px;
}
.cfg-status.online{color:var(--green)}
.cfg-status.offline{color:var(--dim)}
.cfg-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.cfg-dot.on{background:var(--green)}
.cfg-dot.off{background:var(--dim)}
.cfg-save-btn{
  background:var(--orange);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:600;
  padding:8px 20px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;
  border-radius:14px;transition:filter 0.12s;margin-top:12px;
}
.cfg-save-btn:hover{filter:brightness(1.2)}
.cfg-note{font-size:0.75rem;color:var(--dim);line-height:1.6;margin-top:8px}
.lcars-action-btn{font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;padding:5px 14px;border:1.5px solid var(--orange);background:transparent;color:var(--orange);cursor:pointer;border-radius:3px;transition:all 0.15s}
.lcars-action-btn:hover{opacity:0.8}
.lcars-action-btn:disabled{border-color:var(--faint);color:var(--faint);cursor:default}

/* ═══ TACTICAL TOOLBAR ═══ */
.tac-toolbar{
  display:flex;align-items:center;gap:4px;padding:8px 12px;background:#060608;
  border-bottom:1px solid #1a1a1e;flex-shrink:0;
}
.tac-tab{
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:600;
  letter-spacing:0.1em;text-transform:uppercase;padding:6px 18px;
  background:#0a0a0c;border:1px solid #222;color:var(--dim);cursor:pointer;
  transition:all 0.15s;border-radius:0 10px 10px 0;
}
.tac-tab:hover{border-color:var(--blue);color:var(--text)}
.tac-tab.act{background:rgba(85,170,255,0.1);border-color:#55AAFF;color:#55AAFF}
.tac-spacer{flex:1}
.tac-btn{
  font-family:'Antonio',sans-serif;font-size:0.72rem;font-weight:600;
  letter-spacing:0.1em;text-transform:uppercase;padding:5px 14px;
  background:#0a0a0c;border:1px solid #222;color:var(--dim);cursor:pointer;
  transition:all 0.15s;
}
.tac-btn:hover{border-color:var(--orange);color:var(--orange)}
.tac-view{display:none;overflow:hidden}
.tac-view.act{display:flex;flex-direction:column}
.tac-legend{
  position:absolute;top:12px;left:12px;
  background:rgba(6,6,8,0.92);border:1px solid #1a1a1e;padding:10px 14px;
  display:flex;flex-direction:column;gap:5px;pointer-events:none;
}
.tac-legend-row{display:flex;align-items:center;gap:8px;font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase}
.tac-legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.tac-legend-label{color:var(--dim)}
.tac-legend-count{color:var(--text);margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:0.65rem}
.tac-hint{
  position:absolute;bottom:12px;left:50%;transform:translateX(-50%);
  font-size:0.65rem;letter-spacing:0.12em;color:rgba(85,170,255,0.35);
  text-transform:uppercase;pointer-events:none;
}

/* ═══ SEARCH ═══ */
.search-bar{
  position:fixed;top:0;left:0;right:0;z-index:100;display:none;
  background:#0a0a0cee;backdrop-filter:blur(12px);padding:0;
  border-bottom:3px solid var(--orange);
}
.search-bar.open{display:block}
.search-inner{max-width:800px;margin:0 auto;padding:16px 24px}
.search-input{
  width:100%;background:#060608;border:2px solid var(--orange);color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:1rem;padding:12px 16px;
  outline:none;letter-spacing:0.02em;
}
.search-input::placeholder{color:var(--faint)}
.search-meta{display:flex;justify-content:space-between;margin-top:8px;font-size:0.7rem;color:var(--dim);letter-spacing:0.06em}
.search-results{
  max-height:60vh;overflow-y:auto;margin-top:8px;
}
.search-results::-webkit-scrollbar{width:4px}
.search-results::-webkit-scrollbar-thumb{background:var(--orange);border-radius:2px}
.sr{
  display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;
  border-bottom:1px solid #111;transition:background 0.1s;
}
.sr:hover{background:rgba(255,153,0,0.06)}
.sr-type{
  font-family:'Antonio',sans-serif;font-size:0.65rem;font-weight:600;
  letter-spacing:0.1em;text-transform:uppercase;min-width:70px;flex-shrink:0;
}
.sr-name{flex:1;font-size:0.88rem;color:var(--text)}
.sr-match{font-size:0.75rem;color:var(--dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr mark{background:rgba(255,153,0,0.25);color:var(--orange);padding:0 2px}

/* ═══ SESSION STATS ═══ */
.session-stats{display:flex;gap:3px;padding:12px 12px 0}
.session-stat{
  flex:1;background:#060608;border:1px solid #1a1a1e;padding:14px;text-align:center;
}
.session-stat-n{font-family:'Antonio',sans-serif;font-size:1.6rem;font-weight:700;line-height:1}
.session-stat-l{font-size:0.6rem;color:var(--dim);text-transform:uppercase;letter-spacing:0.1em;margin-top:4px}

/* ═══ ABOUT PANEL ═══ */
.about{padding:32px;overflow-y:auto;max-width:800px}
.about-hero{margin-bottom:32px}
.about-title{
  font-family:'Antonio',sans-serif;font-size:2.4rem;font-weight:700;
  letter-spacing:0.08em;text-transform:uppercase;color:var(--orange);
  line-height:1.1;margin-bottom:8px;
}
.about-tagline{
  font-size:0.95rem;color:var(--text);line-height:1.7;margin-bottom:20px;
}
.about-section{margin-bottom:28px}
.about-section-head{
  font-family:'Antonio',sans-serif;font-size:1.1rem;font-weight:600;
  text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;
  padding-bottom:6px;border-bottom:2px solid #1a1a1e;
}
.about-section-head.green{color:#55CC55}
.about-section-head.blue{color:var(--blue)}
.about-section-head.orange{color:var(--orange)}
.about-section-head.salmon{color:var(--salmon)}
.about-section-head.peach{color:var(--peach)}
.about p{font-size:0.85rem;color:var(--text);line-height:1.8;margin-bottom:12px}
.about a{color:var(--orange);text-decoration:none;border-bottom:1px solid rgba(255,153,0,0.3);transition:border-color 0.15s}
.about a:hover{border-color:var(--orange)}
.about-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.about-link{
  display:inline-flex;align-items:center;gap:6px;
  padding:8px 18px;background:#0a0a0c;border:1px solid #222;
  font-family:'Antonio',sans-serif;font-size:0.85rem;font-weight:600;
  letter-spacing:0.08em;text-transform:uppercase;color:var(--text);
  text-decoration:none;transition:all 0.15s;border-radius:0 14px 14px 0;
}
.about-link:hover{border-color:var(--orange);color:var(--orange)}
.about-link .al-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.about-bugs{
  margin-top:24px;padding:14px 18px;background:#0a0a0c;border:1px solid #1a1a1e;
  font-size:0.8rem;color:var(--dim);line-height:1.6;
}
.about-bugs a{color:var(--salmon)}

/* ═══ GLOBAL COMPUTER BAR ═══ */
.computer-bar{
  position:fixed;bottom:0;left:240px;right:0;z-index:50;
  display:flex;gap:0;background:var(--bg);border-top:3px solid var(--orange);
}
.computer-bar-label{
  background:var(--orange);color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.85rem;font-weight:600;
  padding:0 16px;display:flex;align-items:center;letter-spacing:0.1em;
  text-transform:uppercase;white-space:nowrap;
}
.computer-bar-input{
  flex:1;display:flex;
}
.computer-bar-input textarea{
  flex:1;background:#060608;border:none;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:0.88rem;
  padding:10px 16px;resize:none;height:42px;outline:none;
}
.computer-bar-input textarea::placeholder{color:var(--faint)}
.computer-bar-input textarea:focus{background:#0a0a0c}
.computer-bar-send{
  background:var(--orange);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.85rem;font-weight:600;
  padding:0 20px;cursor:pointer;letter-spacing:0.1em;text-transform:uppercase;
  transition:filter 0.12s;
}
.computer-bar-send:hover{filter:brightness(1.3)}
.computer-bar-send:disabled{opacity:0.4;cursor:default;filter:none}
.computer-bar-toggles{
  display:flex;align-items:center;gap:4px;padding:0 8px;background:#060608;
}
.tgl-btn{
  border:none;cursor:pointer;
  font-family:'Antonio',sans-serif;font-size:0.72rem;font-weight:600;
  letter-spacing:0.08em;text-transform:uppercase;
  padding:6px 12px;color:var(--bg);transition:filter 0.12s,opacity 0.15s;
  border-radius:12px;
}
.tgl-btn:hover{filter:brightness(1.2)}
.tgl-btn.off{opacity:0.3}
.tgl-btn.on{opacity:1}

/* Computer response overlay */
.computer-response{
  position:fixed;bottom:45px;left:240px;right:0;
  max-height:40vh;overflow-y:auto;
  background:#08080aee;border-top:2px solid var(--orange);
  border-radius:24px 24px 0 0;
  padding:16px 20px;z-index:49;
  display:none;font-size:0.88rem;line-height:1.7;color:var(--text);
  transition:max-height 0.2s ease;
}
.computer-response.visible{display:block}
.computer-response.minimised{
  max-height:36px;overflow:hidden;padding:8px 20px;
  cursor:pointer;
}
.computer-response.minimised #cr-body{opacity:0.4;pointer-events:none}
.computer-response .cr-controls{
  position:sticky;top:0;float:right;display:flex;gap:4px;z-index:2;
}
.computer-response .cr-btn{
  background:var(--orange);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;
  padding:3px 10px;cursor:pointer;letter-spacing:0.08em;
  border-radius:10px;
}
.computer-response .cr-btn.cr-min{background:var(--blue)}
.computer-response .cr-btn:hover{filter:brightness(1.2)}
.cr-mini-label{
  display:none;font-family:'Antonio',sans-serif;font-size:0.7rem;
  color:var(--orange);letter-spacing:0.1em;text-transform:uppercase;
  cursor:pointer;
}
.computer-response.minimised .cr-controls{display:none}
.computer-response.minimised .cr-mini-label{display:inline}
/* ═══ IN-HUD EDITOR ═══ */
.hud-editor{display:none;flex-direction:column;height:100%;min-height:0}
.hud-editor.active{display:flex}
.hud-editor-toolbar{
  display:flex;align-items:center;gap:4px;padding:10px 20px;
  border-bottom:2px solid #1a1a1e;background:#060608;
}
.hud-editor-toolbar .editor-path{
  flex:1;font-size:0.75rem;color:var(--dim);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;
}
.hud-editor-toolbar .editor-lang{
  font-family:'Antonio',sans-serif;font-size:0.7rem;font-weight:600;
  color:var(--blue);letter-spacing:0.1em;text-transform:uppercase;padding:0 8px;
}
.hud-editor-toolbar .editor-lines{
  font-size:0.7rem;color:var(--dim);padding:0 8px;
}
.hud-editor-toolbar .editor-save{
  background:var(--green);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:600;
  padding:6px 16px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;
  border-radius:12px;transition:filter 0.12s;
}
.hud-editor-toolbar .editor-save:hover{filter:brightness(1.2)}
.hud-editor-toolbar .editor-cancel{
  background:var(--tan);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.82rem;font-weight:600;
  padding:6px 14px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;
  border-radius:12px;transition:filter 0.12s;
}
.hud-editor-toolbar .editor-cancel:hover{filter:brightness(1.2)}
.hud-editor-wrap{
  flex:1;display:flex;overflow:auto;min-height:0;background:#050506;
  position:relative;
}
.hud-editor-lines{
  padding:16px 0;width:48px;flex-shrink:0;text-align:right;
  font-family:'JetBrains Mono',monospace;font-size:0.82rem;
  line-height:1.7;color:#333;user-select:none;background:#040405;
  border-right:1px solid #1a1a1e;
}
.hud-editor-lines span{
  display:block;padding:0 10px 0 0;
}
.hud-editor-lines span.active{color:var(--orange)}
.hud-editor textarea{
  flex:1;background:transparent;border:none;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:0.82rem;
  line-height:1.7;padding:16px 16px;resize:none;outline:none;
  tab-size:2;white-space:pre;overflow-x:auto;overflow-y:hidden;
  min-height:100%;
}
/* Highlighted code overlay */
.hud-editor-highlight{
  position:absolute;top:0;left:48px;right:0;
  padding:16px 16px;pointer-events:none;
  font-family:'JetBrains Mono',monospace;font-size:0.82rem;
  line-height:1.7;white-space:pre;tab-size:2;overflow:hidden;
  color:transparent;
}
.hud-editor-highlight .hl-header{color:var(--peach);font-weight:600}
.hud-editor-highlight .hl-comment{color:#555;font-style:italic}
.hud-editor-highlight .hl-key{color:var(--cyan)}
.hud-editor-highlight .hl-string{color:var(--peach)}
.hud-editor-highlight .hl-number{color:var(--orange)}
.hud-editor-highlight .hl-bool{color:var(--salmon)}
.hud-editor-highlight .hl-keyword{color:var(--blue)}
.hud-editor-highlight .hl-frontmatter{color:var(--tan)}
.hud-editor-highlight .hl-code{color:var(--cyan)}
.hud-editor-highlight .hl-bold{color:#eee;font-weight:600}
.hud-editor-highlight .hl-bullet{color:var(--orange)}

.computer-response h1,.computer-response h2,.computer-response h3{font-family:'Antonio',sans-serif;text-transform:uppercase;letter-spacing:0.05em;margin:16px 0 8px;line-height:1.2}
.computer-response h1{font-size:1.3rem;color:var(--peach);border-bottom:2px solid #1a1a1e;padding-bottom:6px}
.computer-response h2{font-size:1.1rem;color:var(--peach)}
.computer-response h3{font-size:0.95rem;color:var(--tan)}
.computer-response p{margin-bottom:10px}
.computer-response code{background:rgba(255,153,0,0.08);color:var(--orange);padding:2px 5px;font-size:0.84rem}
.computer-response pre{background:#000;border-left:3px solid var(--blue);padding:12px;margin:8px 0;overflow-x:auto;font-size:0.82rem;color:var(--cyan);position:relative}
.computer-response pre::before{content:attr(data-lang);position:absolute;top:4px;right:8px;font-size:0.6rem;color:var(--dim);text-transform:uppercase;letter-spacing:0.1em}
.computer-response pre code{background:none;color:inherit;padding:0;font-size:inherit}
.computer-response pre .kw{color:var(--blue)}
.computer-response pre .str{color:var(--peach)}
.computer-response pre .num{color:var(--orange)}
.computer-response pre .key{color:var(--cyan)}
.computer-response pre .bool{color:var(--salmon)}
.computer-response pre .cmt{color:var(--dim);font-style:italic}
.computer-response pre .punc{color:#888}
.computer-response strong{color:#eee}
.computer-response em{color:var(--lavender);font-style:italic}
.computer-response ul,.computer-response ol{padding-left:22px;margin-bottom:10px}
.computer-response li{margin-bottom:4px}
.computer-response li::marker{color:var(--orange)}
.computer-response table{width:100%;border-collapse:collapse;margin:10px 0;font-size:0.82rem}
.computer-response th{text-align:left;padding:8px;border-bottom:2px solid var(--orange);color:var(--orange);font-weight:600;text-transform:uppercase;font-size:0.72rem;letter-spacing:0.08em}
.computer-response td{padding:6px 8px;border-bottom:1px solid #1a1a1e}
.computer-response blockquote{border-left:3px solid var(--tan);padding-left:14px;color:var(--dim);margin:10px 0}
.computer-response a{color:var(--orange);text-decoration:none}
.computer-response a:hover{text-decoration:underline}
/* LCARS scanning animation */
.lcars-scan{
  display:flex;flex-direction:column;align-items:center;padding:24px 0;gap:14px;
}
.lcars-scan-bars{
  display:flex;gap:3px;align-items:center;height:40px;
}
.lcars-scan-bars .sb{
  width:4px;border-radius:2px;animation:scan-bar 1.2s ease-in-out infinite;
}
.lcars-scan-bars .sb:nth-child(1){background:var(--orange);animation-delay:0s}
.lcars-scan-bars .sb:nth-child(2){background:var(--peach);animation-delay:0.1s}
.lcars-scan-bars .sb:nth-child(3){background:var(--blue);animation-delay:0.2s}
.lcars-scan-bars .sb:nth-child(4){background:var(--lavender);animation-delay:0.3s}
.lcars-scan-bars .sb:nth-child(5){background:var(--cyan);animation-delay:0.4s}
.lcars-scan-bars .sb:nth-child(6){background:var(--orange);animation-delay:0.5s}
.lcars-scan-bars .sb:nth-child(7){background:var(--peach);animation-delay:0.6s}
.lcars-scan-bars .sb:nth-child(8){background:var(--blue);animation-delay:0.7s}
.lcars-scan-bars .sb:nth-child(9){background:var(--lavender);animation-delay:0.8s}
.lcars-scan-bars .sb:nth-child(10){background:var(--cyan);animation-delay:0.9s}
.lcars-scan-bars .sb:nth-child(11){background:var(--orange);animation-delay:1.0s}
.lcars-scan-bars .sb:nth-child(12){background:var(--peach);animation-delay:1.1s}
.lcars-scan-line{
  width:100%;height:2px;position:relative;overflow:hidden;border-radius:1px;
  background:rgba(255,153,0,0.1);
}
.lcars-scan-line::after{
  content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;
  background:linear-gradient(90deg,transparent,var(--orange),transparent);
  animation:scan-sweep 1.8s ease-in-out infinite;
}
.lcars-scan-text{
  font-family:'Antonio',sans-serif;font-size:0.7rem;letter-spacing:0.14em;
  text-transform:uppercase;color:var(--dim);
  animation:scan-pulse 2s ease-in-out infinite;
}
@keyframes scan-bar{
  0%,100%{height:4px;opacity:0.3}
  50%{height:36px;opacity:1}
}
@keyframes scan-sweep{
  0%{left:-30%}
  100%{left:100%}
}
@keyframes scan-pulse{
  0%,100%{opacity:0.4}
  50%{opacity:1}
}

/* ═══ WAVEFORM VISUALIZER ═══ */
.waveform{
  display:flex;align-items:center;gap:2px;height:24px;padding:0 8px;
}
.waveform.hidden{display:none}
.waveform .bar{
  width:3px;background:var(--orange);border-radius:1px;
  transition:height 0.05s;
}
.waveform.listening .bar{background:var(--salmon)}
.waveform.speaking .bar{background:var(--blue)}

.waveform-label{
  font-family:'Antonio',sans-serif;font-size:0.65rem;font-weight:600;
  letter-spacing:0.12em;text-transform:uppercase;padding:0 6px;
  white-space:nowrap;
}
.waveform-label.listening{color:var(--salmon)}
.waveform-label.speaking{color:var(--blue)}

/* Mic button */
.mic-btn{
  background:var(--salmon);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;
  padding:6px 12px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;
  border-radius:12px;transition:filter 0.12s,opacity 0.15s;white-space:nowrap;
}
.mic-btn:hover{filter:brightness(1.2)}
.mic-btn.active{background:var(--red);animation:mic-pulse 1s infinite}
@keyframes mic-pulse{0%,100%{opacity:1}50%{opacity:0.6}}

/* Adjust main content to not be hidden by the bar */
.mn{padding-bottom:48px}

@media(max-width:900px){
  .computer-bar{left:0}
  .computer-response{left:0}
}

/* ═══ BOTTOM BAR ═══ */
.bb{grid-column:2;display:flex;gap:0;margin-top:4px}
.bb-elbow{width:72px;background:var(--lavender);flex-shrink:0;position:relative}
.bb-elbow::before{
  content:'';position:absolute;top:0;left:0;right:0;bottom:0;
  background:var(--bg);border-radius:0 0 32px 0;
}
.bb-fill{flex:1;background:var(--lavender);display:flex;align-items:center;justify-content:space-between;padding:0 24px;
  font-size:0.65rem;color:rgba(0,0,0,0.35);letter-spacing:0.06em;border-radius:0 0 32px 0}
.bb-a{width:160px;background:var(--blue);border-radius:32px 0 0 32px}

@media(max-width:900px){
  .lcars{grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto}
  .sb{display:none}
  .mn-content.open{grid-template-columns:1fr}
  .dp{position:fixed;inset:0;z-index:100;border-left:none}
}
@media(prefers-reduced-motion:reduce){*{transition-duration:0.01ms!important}}
</style>
</head><body>

<div class="boot-overlay" id="boot">
  <svg class="boot-logo" viewBox="0 0 200 200"><circle cx="100" cy="100" r="98" fill="#1a2a3a" stroke="#2a6496" stroke-width="3"/><circle cx="100" cy="100" r="92" fill="#0d1218"/><circle cx="100" cy="100" r="78" fill="#1e5a8a"/><path d="M100 26 L140 145 L100 124 L60 145 Z" fill="#fff"/><ellipse cx="100" cy="94" rx="63" ry="26" fill="none" stroke="#fff" stroke-width="5" transform="rotate(-10 100 94)"/><path d="M100 65 L102 69 L106 69 L103 72 L104 76 L100 74 L96 76 L97 72 L94 69 L98 69 Z" fill="#fff"/><path d="M39 86 L41 90 L45 90 L42 93 L43 97 L39 95 L35 97 L36 93 L33 90 L37 90 Z" fill="#fff"/><path d="M161 86 L163 90 L167 90 L164 93 L165 97 L161 95 L157 97 L158 93 L155 90 L159 90 Z" fill="#fff"/><path d="M59 118 L61 122 L65 122 L62 125 L63 129 L59 127 L55 129 L56 125 L53 122 L57 122 Z" fill="#fff"/><path d="M100 99 L102 103 L106 103 L103 106 L104 110 L100 108 L96 110 L97 106 L94 103 L98 103 Z" fill="#1e5a8a"/><path d="M49 109 Q75 85 105 94 Q130 100 150 105" fill="none" stroke="#cc2222" stroke-width="7" stroke-linecap="round"/></svg>
  <div class="boot-title">LCARS</div>
  <div class="boot-ship" id="boot-ship">STARFLEET COMMAND</div>
  <div class="boot-systems" id="boot-systems">
    <div class="boot-sys" data-delay="800"><span>Skill Modules</span><span class="boot-dot"></span></div>
    <div class="boot-sys" data-delay="1100"><span>MCP Server Fleet</span><span class="boot-dot"></span></div>
    <div class="boot-sys" data-delay="1400"><span>Hook Intercepts</span><span class="boot-dot"></span></div>
    <div class="boot-sys" data-delay="1600"><span>Agent Roster</span><span class="boot-dot"></span></div>
    <div class="boot-sys" data-delay="1800"><span>Memory Banks</span><span class="boot-dot"></span></div>
    <div class="boot-sys" data-delay="2000"><span>Voice Subsystem</span><span class="boot-dot"></span></div>
    <div class="boot-sys" data-delay="2200"><span>Communications</span><span class="boot-dot"></span></div>
  </div>
  <div class="boot-bar"><div class="boot-bar-fill" id="boot-bar-fill"></div></div>
  <div class="boot-status" id="boot-status">ALL SYSTEMS NOMINAL</div>
</div>

<div class="alert-border" id="alert-border"></div>
<div class="alert-badge" id="alert-badge"></div>

<div class="lcars">

<nav class="sb">
  <div class="sb-top">
    <div style="display:flex;align-items:center;gap:10px">
      <svg viewBox="0 0 200 200" style="width:38px;height:38px;flex-shrink:0"><circle cx="100" cy="100" r="98" fill="#1a2a3a" stroke="#2a6496" stroke-width="3"/><circle cx="100" cy="100" r="92" fill="#0d1218"/><circle cx="100" cy="100" r="78" fill="#1e5a8a"/><path d="M100 26 L140 145 L100 124 L60 145 Z" fill="#fff"/><ellipse cx="100" cy="94" rx="63" ry="26" fill="none" stroke="#fff" stroke-width="5" transform="rotate(-10 100 94)"/><path d="M100 65 L102 69 L106 69 L103 72 L104 76 L100 74 L96 76 L97 72 L94 69 L98 69 Z" fill="#fff"/><path d="M39 86 L41 90 L45 90 L42 93 L43 97 L39 95 L35 97 L36 93 L33 90 L37 90 Z" fill="#fff"/><path d="M161 86 L163 90 L167 90 L164 93 L165 97 L161 95 L157 97 L158 93 L155 90 L159 90 Z" fill="#fff"/><path d="M59 118 L61 122 L65 122 L62 125 L63 129 L59 127 L55 129 L56 125 L53 122 L57 122 Z" fill="#fff"/><path d="M100 99 L102 103 L106 103 L103 106 L104 110 L100 108 L96 110 L97 106 L94 103 L98 103 Z" fill="#1e5a8a"/><path d="M49 109 Q75 85 105 94 Q130 100 150 105" fill="none" stroke="#cc2222" stroke-width="7" stroke-linecap="round"/></svg>
      <h1 style="cursor:pointer;white-space:nowrap" onclick="document.querySelector('.nb').click()">Claude HUD</h1>
    </div>
    <small>LCARS INTERFACE // ${stardate}</small>
  </div>
  <div class="sb-nav">
    ${sections.map((s,i) => `<button class="nb${i===0?' act':''}" style="background:${s.color}" onclick="nav('${s.id}',this)">${s.label} ${s.count!==null?`<span class="nc">${String(s.count).padStart(3,'0')}</span>`:''}</button>`).join('\n    ')}
  </div>
  <div class="sb-foot">
    <div>STARDATE ${stardate} // ${ts}</div>
    <div style="margin-top:8px;font-size:0.72rem;color:rgba(0,0,0,0.4);letter-spacing:0.06em;font-weight:600">
      <a href="https://polyxmedia.com" target="_blank" style="color:rgba(0,0,0,0.55);text-decoration:none">polyxmedia.com</a>
      &nbsp;//&nbsp;
      <a href="https://x.com/voidmode" target="_blank" style="color:rgba(0,0,0,0.55);text-decoration:none">@voidmode</a>
    </div>
  </div>
</nav>

<div class="tb">
  <div class="tb-elbow"></div>
  <div class="tb-fill">
    <div class="tb-dc">
      <div class="tb-dc-col"><div class="tb-dc-n">93</div><div class="tb-dc-n">1853</div><div class="tb-dc-n">24109</div><div class="tb-dc-n">7024</div><div class="tb-dc-n">322</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">21509</div><div class="tb-dc-n">68417</div><div class="tb-dc-n">80</div><div class="tb-dc-n">2048</div><div class="tb-dc-n">46233</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">585101</div><div class="tb-dc-n">25403</div><div class="tb-dc-n">31219</div><div class="tb-dc-n">752</div><div class="tb-dc-n">21048</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">2107853</div><div class="tb-dc-n">12201972</div><div class="tb-dc-n">30412</div><div class="tb-dc-n">98</div><div class="tb-dc-n">888</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">33</div><div class="tb-dc-n">56</div><div class="tb-dc-n">04</div><div class="tb-dc-n">69</div><div class="tb-dc-n">15</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">0223</div><div class="tb-dc-n">688</div><div class="tb-dc-n">28471</div><div class="tb-dc-n">21366</div><div class="tb-dc-n">31</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">633</div><div class="tb-dc-n">51166</div><div class="tb-dc-n">41699</div><div class="tb-dc-n">6188</div><div class="tb-dc-n">21094</div></div>
      <div class="tb-dc-col"><div class="tb-dc-n">406822</div><div class="tb-dc-n">81205</div><div class="tb-dc-n">91007</div><div class="tb-dc-n">38357</div><div class="tb-dc-n">2041</div></div>
    </div>
    <span id="tb-ship-name"></span>
    <span>ASSETS: ${String(skills.length+agents.length+mcp.length+hooks.length+plugins.length).padStart(3,'0')}</span>
    <span>SESSIONS: ${String(sessions).padStart(5,'0')}</span>
    <span style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 200 200" style="width:16px;height:16px"><circle cx="100" cy="100" r="98" fill="rgba(0,0,0,0.15)"/><circle cx="100" cy="100" r="78" fill="rgba(0,0,0,0.1)"/><path d="M100 26 L140 145 L100 124 L60 145 Z" fill="rgba(0,0,0,0.25)"/><ellipse cx="100" cy="94" rx="63" ry="26" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="5" transform="rotate(-10 100 94)"/></svg>STARDATE ${stardate}</span>
  </div>
  <div class="tb-a1"></div>
  <div class="tb-a2"></div>
</div>

<div class="stb">
  <div class="stb-inner">
    ${sections.filter(s => s.count !== null).map(s => `<div class="st"><div class="st-n">${String(s.count).padStart(3,'0')}</div><div class="st-l">${s.label}</div></div>`).join('\n    ')}
  </div>
  <div class="stb-cap"></div>
</div>

<div class="brb" id="burn-bar">
  <div class="brb-bar" id="brb-bar"></div>
  <span class="brb-pct" id="brb-pct">—%</span>
  <span class="brb-sep">│</span>
  <span class="brb-time" id="brb-time">connecting…</span>
  <span class="brb-sep">│</span>
  <span class="brb-rate" id="brb-rate">CONTEXT WINDOW</span>
  <span class="brb-live" id="brb-live" style="display:none">LIVE</span>
  <div class="brb-meter" id="brb-meter" style="display:none">
    <span class="brb-m-line" style="animation-delay:0s"></span>
    <span class="brb-m-line" style="animation-delay:0.15s"></span>
    <span class="brb-m-line" style="animation-delay:0.3s"></span>
    <span class="brb-m-line" style="animation-delay:0.45s"></span>
    <span class="brb-m-line" style="animation-delay:0.6s"></span>
  </div>
</div>

<div class="mn">
  <div class="mn-edge">
    <div class="mne-p" style="background:var(--orange);flex:3"></div>
    <div class="mne-b"></div>
    <div class="mne-p" style="background:var(--peach);flex:1"></div>
    <div class="mne-b"></div>
    <div class="mne-p" style="background:var(--blue);flex:5"></div>
    <div class="mne-b"></div>
    <div class="mne-p" style="background:var(--lavender);flex:2"></div>
    <div class="mne-b"></div>
    <div class="mne-p" style="background:var(--tan);flex:1"></div>
    <div class="mne-b"></div>
    <div class="mne-p" style="background:var(--lavender);flex:4"></div>
  </div>
  <div class="mn-content" id="mc">
    <div class="ls">

      <div class="sec on" id="s-skills">
        <div class="sec-h"><span>Skill Registry</span><button class="sec-h-new" onclick="toggleCreate('skill')">+ NEW</button></div>
        <div class="create-form" id="cf-skill">
          <h3>Create New Skill</h3>
          <div class="cf-row"><label>Name</label><input id="cf-skill-name" placeholder="my-skill"></div>
          <div class="cf-row"><label>Description</label><input id="cf-skill-desc" placeholder="What this skill does..."></div>
          <div class="cf-row"><label>Context</label><span style="flex:1"><div class="lcars-select" id="cf-skill-ctx-wrap"><button class="lcars-select-btn" onclick="toggleLcarsSelect('cf-skill-ctx-wrap')"><span>Fork (isolated)</span></button><div class="lcars-dropdown"><div class="lcars-option selected" data-value="fork" onclick="selectLcarsOption('cf-skill-ctx-wrap',this)"><span class="opt-label">Fork (isolated)</span><span class="opt-sub">Runs in a subagent, separate context</span></div><div class="lcars-option" data-value="inline" onclick="selectLcarsOption('cf-skill-ctx-wrap',this)"><span class="opt-label">Inline (in conversation)</span><span class="opt-sub">Runs in main conversation context</span></div></div></div></span></div>
          <div class="cf-row"><label>Content</label><textarea id="cf-skill-body" placeholder="# My Skill\n\nSkill instructions here..."></textarea></div>
          <div class="cf-actions"><button class="cf-create" onclick="createSkill()">CREATE</button><button class="cf-cancel" onclick="toggleCreate('skill')">CANCEL</button></div>
        </div>
        ${skills.length===0?'<div class="emp">No skills registered</div>':skills.map(s=>`
        <div class="r" onclick="open_('s:${esc(s.name)}')" data-k="s:${esc(s.name)}">
          <span class="r-id">${esc(s.name)}</span>
          <span class="r-tg">${s.ctx?`<span class="tg tg-b">${esc(s.ctx)}</span>`:''}${s.ver?`<span class="tg tg-d">v${esc(s.ver)}</span>`:''}</span>
          <span class="r-d">${esc(s.desc)}</span>
        </div>`).join('')}
        ${discoverHtml('skills', skillDiscoverCards, SKILL_SUGG.length)}
      </div>

      <div class="sec" id="s-mcp">
        <div class="sec-h"><span>Subsystem Status // MCP Fleet</span><button class="sec-h-new" onclick="toggleCreate('mcp')">+ NEW</button></div>
        <div class="create-form" id="cf-mcp">
          <h3>Register New MCP Server</h3>
          <div class="cf-row"><label>Name</label><input id="cf-mcp-name" placeholder="my-server"></div>
          <div class="cf-row"><label>Command</label><input id="cf-mcp-cmd" placeholder="node"></div>
          <div class="cf-row"><label>Args</label><input id="cf-mcp-args" placeholder="/path/to/server.js (space separated)"></div>
          <div class="cf-actions"><button class="cf-create" onclick="createMcp()">REGISTER</button><button class="cf-cancel" onclick="toggleCreate('mcp')">CANCEL</button></div>
        </div>
        ${mcp.length===0?'<div class="emp">No servers connected</div>':`
        <div class="mcp-overview">
          <div class="mcp-overview-stat"><div class="mcp-overview-n total">${mcp.length}</div><div class="mcp-overview-l">Total Servers</div></div>
          <div class="mcp-overview-stat"><div class="mcp-overview-n green" id="mcp-ready-count">--</div><div class="mcp-overview-l">Online</div></div>
          <div class="mcp-overview-stat"><div class="mcp-overview-n orange" id="mcp-warn-count">--</div><div class="mcp-overview-l">Degraded</div></div>
          <div class="mcp-overview-stat"><div class="mcp-overview-n red" id="mcp-err-count">--</div><div class="mcp-overview-l">Offline</div></div>
        </div>
        <div class="mcp-grid">
          ${mcp.map(s=>`
          <div class="mcp-card${s.disabled?' mcp-card-disabled':''}" onclick="open_('m:${esc(s.name)}')" data-k="m:${esc(s.name)}" data-mcp="${esc(s.name)}">
            <div class="mcp-card-top">
              <div class="mcp-card-status ${s.disabled?'mcp-disabled':'checking'}" id="mcp-dot-${esc(s.name)}"></div>
              <div class="mcp-card-name">${esc(s.name)}</div>
              <span class="mcp-card-type ${esc(s.serverType)}">${esc(s.serverType)}</span>
              ${s.securityFlags.length?`<span class="mcp-sec-flag" title="${esc(s.securityFlags.map(f=>f.cve||f.detail).join(', '))}">&#9888; ${s.securityFlags[0].severity||'WARN'}</span>`:''}
            </div>
            <div class="mcp-card-body">
              <div class="mcp-card-row">
                <span class="mcp-card-label">CMD</span>
                <span class="mcp-card-val">${esc(s.cmd)} ${esc(s.args.join(' '))}</span>
              </div>
              ${s.envCount?`<div class="mcp-card-row">
                <span class="mcp-card-label">ENV</span>
                <span class="mcp-card-val" style="color:var(--tan)">${s.envCount} variable${s.envCount>1?'s':''} configured</span>
              </div>`:''}
              ${s.entryPoint?`<div class="mcp-card-row">
                <span class="mcp-card-label">FILE</span>
                <span class="mcp-card-val" style="color:var(--dim);font-size:0.7rem">${esc(s.entryPoint)}</span>
              </div>`:''}
            </div>
            <div class="mcp-card-footer">
              ${s.disabled
                ? `<div class="mcp-card-bar"><div class="bar-fill" style="width:100%;background:var(--faint)"></div></div><div class="mcp-card-status-label" style="color:var(--dim)">DISABLED</div>`
                : `<div class="mcp-card-bar"><div class="bar-fill checking"></div></div><div class="mcp-card-status-label checking" id="mcp-label-${esc(s.name)}">CHECKING</div>`}
              <button class="mcp-toggle-btn" onclick="event.stopPropagation();toggleMcp(${escA(s.name)},${s.disabled})">${s.disabled?'ENABLE':'DISABLE'}</button>
            </div>
          </div>`).join('')}
        </div>`}
        ${discoverHtml('mcp', mcpDiscoverCards, MCP_SUGG.length)}
      </div>

      <div class="sec" id="s-hooks">
        <div class="sec-h"><span>Hook Intercepts</span><button class="sec-h-new" onclick="toggleCreate('hook')">+ NEW</button></div>
        <div class="create-form" id="cf-hook">
          <h3>Create New Hook</h3>
          <div class="cf-row"><label>Event</label><span style="flex:1"><div class="lcars-select" id="cf-hook-event-wrap"><button class="lcars-select-btn" onclick="toggleLcarsSelect('cf-hook-event-wrap')"><span>PreToolUse</span></button><div class="lcars-dropdown"><div class="lcars-option selected" data-value="PreToolUse" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">PreToolUse</span><span class="opt-sub">Before a tool executes</span></div><div class="lcars-option" data-value="PostToolUse" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">PostToolUse</span><span class="opt-sub">After successful execution</span></div><div class="lcars-option" data-value="Stop" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">Stop</span><span class="opt-sub">When Claude stops responding</span></div><div class="lcars-option" data-value="SessionStart" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">SessionStart</span><span class="opt-sub">Session begins</span></div><div class="lcars-option" data-value="UserPromptSubmit" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">UserPromptSubmit</span><span class="opt-sub">User submits a prompt</span></div><div class="lcars-option" data-value="SubagentStop" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">SubagentStop</span><span class="opt-sub">Subagent finishes</span></div><div class="lcars-option" data-value="Notification" onclick="selectLcarsOption('cf-hook-event-wrap',this)"><span class="opt-label">Notification</span><span class="opt-sub">System notification fires</span></div></div></div></span></div>
          <div class="cf-row"><label>Matcher</label><input id="cf-hook-matcher" placeholder="Bash (optional, for tool events)"></div>
          <div class="cf-row"><label>Type</label><span style="flex:1"><div class="lcars-select" id="cf-hook-type-wrap"><button class="lcars-select-btn" onclick="toggleLcarsSelect('cf-hook-type-wrap')"><span>Shell Command</span></button><div class="lcars-dropdown"><div class="lcars-option selected" data-value="command" onclick="selectLcarsOption('cf-hook-type-wrap',this)"><span class="opt-label">Shell Command</span><span class="opt-sub">Execute a shell script</span></div><div class="lcars-option" data-value="prompt" onclick="selectLcarsOption('cf-hook-type-wrap',this)"><span class="opt-label">LLM Prompt</span><span class="opt-sub">Evaluate with an LLM</span></div><div class="lcars-option" data-value="http" onclick="selectLcarsOption('cf-hook-type-wrap',this)"><span class="opt-label">HTTP Webhook</span><span class="opt-sub">POST to a URL</span></div><div class="lcars-option" data-value="agent" onclick="selectLcarsOption('cf-hook-type-wrap',this)"><span class="opt-label">Agent Verifier</span><span class="opt-sub">Spawn a verification agent</span></div></div></div></span></div>
          <div class="cf-row"><label>Command</label><textarea id="cf-hook-cmd" placeholder="echo 'hook fired'"></textarea></div>
          <div class="cf-actions"><button class="cf-create" onclick="createHook()">CREATE</button><button class="cf-cancel" onclick="toggleCreate('hook')">CANCEL</button></div>
        </div>
        ${hooks.length===0?'<div class="emp">No hooks active</div>':hooks.map((h,i)=>`
        <div class="r" onclick="open_('h:${i}')" data-k="h:${i}">
          <span class="r-id">${esc(h.ev)}</span>
          <span class="r-tg"><span class="tg tg-t">${esc(h.type)}</span><span class="tg tg-b">${esc(h.matcher)}</span>${h.async?'<span class="tg tg-g">async</span>':''}</span>
          <span class="r-d">${esc(h.cmd.slice(0,100))}</span>
        </div>`).join('')}
        ${discoverHtml('hooks', hookDiscoverCards, HOOK_SUGG.length)}
        <div style="padding:12px 16px;border-top:1px solid #1a1a1e;display:flex;align-items:center;gap:12px">
          <span style="font-size:0.65rem;color:var(--dim);flex:1">Install a hook that logs every event to <code style="color:var(--cyan)">~/.claude/hud-events.jsonl</code> — enables future session analytics.</span>
          <button onclick="installHudLogger()" style="font-family:Antonio,sans-serif;font-size:0.65rem;letter-spacing:0.1em;padding:5px 14px;background:rgba(102,204,204,0.1);border:1px solid rgba(102,204,204,0.4);color:var(--cyan);cursor:pointer;border-radius:6px;flex-shrink:0">INSTALL HUD LOGGER</button>
        </div>
      </div>

      <div class="sec" id="s-plugins">
        <div class="sec-h"><span>Plugin Manifest</span><button class="sec-h-new" onclick="toggleCreate('plugin')">+ NEW</button></div>
        <div class="create-form" id="cf-plugin">
          <h3>Register Plugin</h3>
          <div class="cf-row"><label>Plugin ID</label><input id="cf-plugin-id" placeholder="@scope/plugin-name or plugin-name"></div>
          <div class="cf-actions"><button class="cf-create" onclick="createPlugin()">ENABLE</button><button class="cf-cancel" onclick="toggleCreate('plugin')">CANCEL</button></div>
        </div>
        ${plugins.length===0?'<div class="emp">No plugins loaded</div>':plugins.map(p=>`
        <div class="r r2" onclick="open_('p:${esc(p.id)}')" data-k="p:${esc(p.id)}">
          <span class="r-id">${esc(p.id)}</span>
          <span class="tg ${p.on?'tg-g':'tg-r'}">${p.on?'ACTIVE':'INACTIVE'}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-market">
        <div class="sec-h"><span>Marketplace // <span id="mkt-count">${marketItems.length}</span> Available</span></div>
        <div class="mkt-filters" id="mkt-filters">
          <button class="mkt-filter-btn act" onclick="filterMkt('all',this)">ALL</button>
          <button class="mkt-filter-btn" onclick="filterMkt('plugin',this)">PLUGINS</button>
          <button class="mkt-filter-btn" onclick="filterMkt('mcp',this)">MCP SERVERS</button>
          <button class="mkt-filter-btn" onclick="filterMkt('remote',this)">REMOTE</button>
          <button class="mkt-filter-btn" onclick="filterMkt('installed',this)">INSTALLED</button>
          <button class="mkt-load-remote" id="mkt-load-btn" onclick="loadRemoteMarketplace()">&#x2B07; LOAD REGISTRY</button>
          <input class="mkt-search" id="mkt-search" type="text" placeholder="SEARCH..." oninput="filterMkt(window._mktFilter||'all')" autocomplete="off" spellcheck="false">
        </div>
        ${marketItems.length === 0 ? '<div class="emp">No marketplace data found</div>' : `
        <div class="mkt-grid" id="mkt-grid">
          ${marketItems.map(item => {
            const caps = item.capabilities.map(c => `<span class="mkt-cap ${esc(c)}">${esc(c)}</span>`).join('');
            const installBtn = item.isInstalled
              ? '<span class="mkt-installed-badge">&#10003; INSTALLED</span>'
              : `<button class="mkt-install-btn" onclick="event.stopPropagation();installMarketItem(this,${escA(item.id)},${escA(item.type)},${escA(item.sourcePath)},${item.mcpConfig ? escA(JSON.stringify(item.mcpConfig)) : escA('')})">+ INSTALL</button>`;
            return `<div class="mkt-card${item.isInstalled ? ' installed' : ''}" onclick="open_('mk:${esc(item.id)}');beepOpen()" data-k="mk:${esc(item.id)}" data-mkt-type="${esc(item.type)}">
              <div class="mkt-card-name">${esc(item.name)}</div>
              <div class="mkt-card-desc">${esc(item.description || 'No description available.')}</div>
              <div class="mkt-card-meta">${caps}<span class="mkt-src">${esc(item.marketplace)}</span>${item.author ? `<span class="mkt-card-author">by ${esc(item.author)}</span>` : ''}</div>
              <div class="mkt-card-footer">${installBtn}</div>
            </div>`;
          }).join('')}
        </div>`}
      </div>

      <div class="sec" id="s-agents">
        <div class="sec-h"><span>Agent Roster</span><button class="sec-h-new" onclick="toggleCreate('agent')">+ NEW</button></div>
        <div class="create-form" id="cf-agent">
          <h3>Deploy New Agent</h3>
          <div class="cf-row"><label>Name</label><input id="cf-agent-name" placeholder="my-agent"></div>
          <div class="cf-row"><label>Description</label><input id="cf-agent-desc" placeholder="When to use this agent..."></div>
          <div class="cf-row"><label>Tools</label><input id="cf-agent-tools" placeholder="Read, Grep, Glob, Bash (comma separated)"></div>
          <div class="cf-row"><label>Prompt</label><textarea id="cf-agent-body" placeholder="You are an expert in..."></textarea></div>
          <div class="cf-actions"><button class="cf-create" onclick="createAgent()">DEPLOY</button><button class="cf-cancel" onclick="toggleCreate('agent')">CANCEL</button></div>
        </div>
        ${agents.length===0?'<div class="emp">No agents deployed</div>':agents.map(a=>`
        <div class="r r2" onclick="open_('a:${esc(a.name)}')" data-k="a:${esc(a.name)}">
          <span class="r-id">${esc(a.name)}</span>
          <span class="r-d">${esc(a.desc)}</span>
        </div>`).join('')}
        ${discoverHtml('agents', agentDiscoverCards, AGENT_SUGG.length)}
      </div>

      <div class="sec" id="s-env">
        <div class="sec-h"><span>Environment Variables</span><button class="sec-h-new" onclick="toggleCreate('env')">+ NEW</button></div>
        <div class="create-form" id="cf-env">
          <h3>Add Environment Variable</h3>
          <div class="cf-row"><label>Key</label><input id="cf-env-key" placeholder="VARIABLE_NAME" style="text-transform:uppercase"></div>
          <div class="cf-row"><label>Value</label><input id="cf-env-val" placeholder="value"></div>
          <div class="cf-actions"><button class="cf-create" onclick="createEnv()">SET</button><button class="cf-cancel" onclick="toggleCreate('env')">CANCEL</button></div>
        </div>
        ${Object.keys(env).length===0?'<div class="emp">No env overrides</div>':Object.entries(env).map(([k,v])=>`
        <div class="r r2" onclick="open_('v:${esc(k)}')" data-k="v:${esc(k)}">
          <span class="r-id">${esc(k)}</span>
          <span class="r-d" style="color:var(--orange)">${esc(String(v))}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-memory">
        <div class="sec-h">Memory Index</div>
        ${mem.length===0?'<div class="emp">No memory files</div>':mem.map(m=>`
        <div class="r" onclick="open_('e:${esc(m.file)}')" data-k="e:${esc(m.file)}">
          <span class="r-id">${esc(m.name)}</span>
          <span class="r-tg"><span class="tg tg-b">${esc(m.type)}</span></span>
          <span class="r-d">${esc(m.proj)}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-sessions">
        <div class="sec-h">Session History // ${projectHistory.length} Projects</div>
        ${sessionList.length ? `<div style="padding:8px 12px;background:#0a0a0c;border-bottom:1px solid #1a1a1e">
          <div style="font-family:Antonio,sans-serif;font-size:0.65rem;letter-spacing:0.1em;color:var(--dim);margin-bottom:6px">ACTIVE SESSIONS</div>
          ${sessionList.map((s, i) => {
            const date = s.started ? new Date(s.started).toISOString().replace('T', ' ').slice(0, 16) : '?';
            return '<div class="r" data-k="ss:' + i + '" onclick="open_(\'ss:' + i + '\')" style="border-left:2px solid var(--green)"><span class="r-n">' + esc(s.project || s.id.slice(0,8)) + '</span><span class="r-tg"><span class="tg tg-g">LIVE</span><span class="tg tg-b">' + esc(s.kind) + '</span></span><span class="r-d">' + esc(date) + '</span></div>';
          }).join('')}
        </div>` : ''}
        ${projectHistory.length === 0 ? '<div class="emp">No project history found</div>' : `
        <div style="padding:8px 12px 4px;font-family:Antonio,sans-serif;font-size:0.65rem;letter-spacing:0.1em;color:var(--dim)">ALL PROJECTS</div>
        <div class="ph-grid">
          ${projectHistory.map((p, i) => {
            const date = p.lastActivity ? new Date(p.lastActivity).toISOString().replace('T', ' ').slice(0, 10) : '?';
            return `<div class="ph-card" onclick="open_('ph:${i}')">
              <div class="ph-card-name">${esc(p.shortName)}</div>
              <div class="ph-card-meta">
                <span class="ph-card-sessions">${p.sessions} session${p.sessions !== 1 ? 's' : ''}</span>
                <span class="ph-card-date">${esc(date)}</span>
              </div>
            </div>`;
          }).join('')}
        </div>`}
      </div>

      <div class="sec" id="s-claudemd">
        <div class="sec-h">CLAUDE.md // Context Substrate</div>
        ${claudeMds.length === 0 ? '<div class="emp">No CLAUDE.md files found. Create ~/.claude/CLAUDE.md to give Claude persistent instructions.</div>' :
        claudeMds.map((c, i) => {
          const label = c.scope === 'GLOBAL' ? 'Global CLAUDE.md' : c.project.split('/').slice(-2).join('/');
          const h = c.health;
          const badgeClass = h.score >= 70 ? 'good' : h.score >= 40 ? 'warn' : 'bad';
          const lines = c.body.split('\n').length;
          return `<div style="border-bottom:1px solid #1a1a1e">
            <div class="r" data-k="cd:${i}" onclick="open_('cd:${i}')">
              <span class="r-n">${esc(label)}</span>
              <span class="r-tg">
                <span class="tg tg-o">${esc(c.scope)}</span>
                <span class="health-badge ${badgeClass}">${h.score}/100</span>
              </span>
              <span class="r-d">${lines} lines</span>
            </div>
            ${h.issues.length ? `<div class="health-issues" style="padding:0 16px 8px">${h.issues.map(iss => '⚠ ' + esc(iss)).join('<br>')}</div>` : ''}
            ${h.praise.length && !h.issues.length ? `<div class="health-praise" style="padding:0 16px 8px">${h.praise.map(p => '✓ ' + esc(p)).join(' · ')}</div>` : ''}
          </div>`;
        }).join('')}
      </div>

      <div class="sec" id="s-membanks">
        <div class="sec-h"><span>Memory Banks // Recall Subsystem</span></div>
        <div class="mcp-overview">
          <div class="mcp-overview-stat">
            <div class="mcp-overview-n total">${String(memBanks.stats.total).padStart(3,'0')}</div>
            <div class="mcp-overview-l">Total Entries</div>
          </div>
          <div class="mcp-overview-stat">
            <div class="mcp-overview-n green">${String(memBanks.stats.today).padStart(3,'0')}</div>
            <div class="mcp-overview-l">Today</div>
          </div>
          <div class="mcp-overview-stat">
            <div class="mcp-overview-n orange" style="font-size:1rem;padding-top:4px">${memBanks.stats.lastEntry ? (new Date(memBanks.stats.lastEntry.timestamp).toISOString().slice(0,10)) : '—'}</div>
            <div class="mcp-overview-l">Last Activity</div>
          </div>
        </div>
        ${memBanks.entries.length === 0
          ? '<div class="emp">No entries in memory banks. Use <code>recall add</code> to log your first entry.</div>'
          : memBanks.entries.slice(-20).reverse().map((e, i) => {
              const realIdx = memBanks.entries.length - 1 - i;
              const tags = (e.tags || []).map(t => `<span class="tg tg-c">${esc(t)}</span>`).join('');
              const date = e.timestamp ? e.timestamp.slice(0,10) : '';
              return `<div class="r" onclick="open_('mb:${realIdx}')" data-k="mb:${realIdx}">
                <span class="r-id" style="font-size:0.72rem;color:var(--dim)">${esc(e.id.slice(0,8))}</span>
                <span class="r-tg">${tags}${e.source && e.source !== 'manual' ? `<span class="tg tg-t">${esc(e.source)}</span>` : ''}</span>
                <span class="r-d">${esc(e.content.slice(0,100))}${e.content.length > 100 ? '…' : ''}</span>
              </div>`;
            }).join('')
        }
      </div>

      <div class="sec" id="s-mnemos">
        ${(!mnemos || mnemos.installed === false) ? (() => {
          const sqliteMissing = mnemos && mnemos.installed === false;
          const installCmd = 'curl -fsSL https://raw.githubusercontent.com/polyxmedia/mnemos/main/scripts/install.sh | bash';
          return `
          <div class="sec-h"><span>Mnemos // Persistent Memory + Skills</span><span style="font-size:0.7rem;color:var(--dim);font-family:JetBrains Mono,monospace">NOT DETECTED</span></div>
          <div style="padding:28px 24px">
            <div style="font-family:Antonio,sans-serif;font-size:1.4rem;color:var(--pink, #FF66CC);letter-spacing:0.08em;margin-bottom:6px">MNEMOS NOT ${sqliteMissing ? 'AVAILABLE' : 'INSTALLED'}</div>
            <div style="font-size:0.82rem;line-height:1.6;color:var(--text);max-width:640px;margin-bottom:20px">
              ${sqliteMissing
                ? 'Mnemos is installed but the system <code>sqlite3</code> CLI was not found on PATH. Install it (<code>brew install sqlite</code> on macOS) and reload.'
                : 'Mnemos is a learning loop for AI coding agents. Corrections compound into skills; replay surfaces what you have learned since. The memory layer never calls an LLM — synthesis is deterministic pattern-mining, so it is reproducible, token-free, and auditable.'}
            </div>
            ${sqliteMissing ? '' : `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:24px;max-width:760px">
              <div style="border:1px solid #1a1a1e;border-left:3px solid var(--red);padding:12px 14px;background:#08080a">
                <div style="font-family:Antonio,sans-serif;font-size:0.75rem;letter-spacing:0.1em;color:var(--red);margin-bottom:4px">CORRECTION JOURNAL</div>
                <div style="font-size:0.78rem;line-height:1.5;color:var(--text)">tried / wrong_because / fix as a first-class type. Past mistakes surface before you make them again.</div>
              </div>
              <div style="border:1px solid #1a1a1e;border-left:3px solid var(--purple);padding:12px 14px;background:#08080a">
                <div style="font-family:Antonio,sans-serif;font-size:0.75rem;letter-spacing:0.1em;color:var(--purple);margin-bottom:4px">CORRECTIONS → SKILLS</div>
                <div style="font-size:0.78rem;line-height:1.5;color:var(--text)">Three related corrections promote into a skill — deterministic, no LLM, no drift.</div>
              </div>
              <div style="border:1px solid #1a1a1e;border-left:3px solid var(--gold);padding:12px 14px;background:#08080a">
                <div style="font-family:Antonio,sans-serif;font-size:0.75rem;letter-spacing:0.1em;color:var(--gold);margin-bottom:4px">RETROSPECTIVE REPLAY</div>
                <div style="font-size:0.78rem;line-height:1.5;color:var(--text)">Regenerate any past session as markdown with everything you have learned since layered in.</div>
              </div>
              <div style="border:1px solid #1a1a1e;border-left:3px solid var(--cyan);padding:12px 14px;background:#08080a">
                <div style="font-family:Antonio,sans-serif;font-size:0.75rem;letter-spacing:0.1em;color:var(--cyan);margin-bottom:4px">SINGLE GO BINARY</div>
                <div style="font-size:0.78rem;line-height:1.5;color:var(--text)">15 MB static binary. No Python, no Docker, no vector DB. macOS / Linux / Windows · amd64 + arm64.</div>
              </div>
            </div>
            <div style="font-family:Antonio,sans-serif;font-size:0.78rem;letter-spacing:0.1em;color:var(--dim);margin-bottom:8px">INSTALL</div>
            <div style="position:relative;background:#0a0a0c;border:1px solid #1a1a1e;border-radius:6px;padding:12px 80px 12px 14px;font-family:JetBrains Mono,monospace;font-size:0.78rem;color:var(--orange);overflow-x:auto;max-width:760px;margin-bottom:8px">
              <span id="mn-install-cmd">${esc(installCmd)}</span>
              <button onclick="navigator.clipboard.writeText(document.getElementById('mn-install-cmd').textContent);toast('Copied install command');beepClick&&beepClick()" style="position:absolute;right:8px;top:8px;background:var(--orange);color:#000;border:none;font-family:Antonio,sans-serif;font-size:0.7rem;font-weight:600;letter-spacing:0.1em;padding:4px 10px;border-radius:8px;cursor:pointer">COPY</button>
            </div>
            <div style="font-size:0.78rem;color:var(--dim);margin-bottom:8px">Then run <code style="background:#0a0a0c;padding:2px 6px;border-radius:3px;color:var(--orange)">mnemos init</code> and restart your agent. The MNEMOS panel will populate automatically on next dashboard reload.</div>
            `}
            <div style="margin-top:12px;display:flex;gap:12px;flex-wrap:wrap">
              <a href="https://github.com/polyxmedia/mnemos" target="_blank" style="color:var(--blue);text-decoration:none;font-size:0.82rem;font-family:Antonio,sans-serif;letter-spacing:0.06em">GITHUB →</a>
              <a href="https://github.com/polyxmedia/mnemos#quick-start" target="_blank" style="color:var(--blue);text-decoration:none;font-size:0.82rem;font-family:Antonio,sans-serif;letter-spacing:0.06em">QUICK START →</a>
              <a href="https://github.com/polyxmedia/mnemos/blob/main/docs/MCP_TOOLS.md" target="_blank" style="color:var(--blue);text-decoration:none;font-size:0.82rem;font-family:Antonio,sans-serif;letter-spacing:0.06em">MCP TOOLS REFERENCE →</a>
            </div>
          </div>
          `;
        })() : (() => {
          const m = mnemos;
          const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1024*1024 ? (n/1024).toFixed(1)+' KB' : (n/1024/1024).toFixed(1)+' MB';
          const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toISOString().replace('T',' ').slice(0,19); } catch { return s; } };
          const obsTypeColor = {
            correction: 'var(--red)', convention: 'var(--blue)', decision: 'var(--gold)',
            bugfix: 'var(--orange)', pattern: 'var(--purple)', preference: 'var(--cyan)',
            context: 'var(--dim)', architecture: 'var(--green)', episodic: 'var(--text)',
            semantic: 'var(--text)', procedural: 'var(--text)', dream: 'var(--purple)',
          };
          // Group observations by type (for chip filters and quick counts)
          const byType = m.stats.byType;
          const typeKeys = Object.keys(byType).sort((a, b) => byType[b] - byType[a]);
          // Render a single observation row
          const obsRow = (o) => {
            const status = o.invalidated_at ? 'SUPERSEDED' : (o.expires_at && Date.parse(o.expires_at) < Date.now()) ? 'EXPIRED' : 'LIVE';
            const statusClass = status === 'LIVE' ? 'tg-g' : 'tg-r';
            const tagChips = (o.tags || []).slice(0, 3).map(t => '<span class="tg tg-c">' + esc(t) + '</span>').join('');
            const projChip = o.project ? '<span class="tg tg-b">' + esc(o.project) + '</span>' : '';
            const typeColor = obsTypeColor[o.obs_type] || 'var(--text)';
            const dateShort = (o.created_at || '').replace('T', ' ').slice(0, 16);
            return '<div class="r" data-mn-type="' + esc(o.obs_type) + '" data-mn-search="' + esc(((o.title||'') + ' ' + (o.content||'') + ' ' + (o.tags||[]).join(' ') + ' ' + (o.project||'')).toLowerCase()) + '" onclick="open_(\'mn:o:' + esc(o.id) + '\')" style="border-left:3px solid ' + typeColor + '">'
              + '<span class="r-n" style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(o.title || '(untitled)') + '</span>'
              + '<span class="r-tg"><span class="tg" style="background:' + typeColor + ';color:#000;font-weight:600">' + esc(o.obs_type) + '</span>' + projChip + tagChips + '<span class="tg ' + statusClass + '">' + status + '</span></span>'
              + '<span class="r-d" style="font-size:0.7rem;color:var(--dim)">' + esc(dateShort) + '</span>'
              + '</div>';
          };
          const sesRow = (s) => {
            const statusClass = s.status === 'failed' ? 'tg-r' : s.status === 'blocked' ? 'tg-o' : 'tg-g';
            const dateShort = (s.started_at || '').replace('T', ' ').slice(0, 16);
            const projChip = s.project ? '<span class="tg tg-b">' + esc(s.project) + '</span>' : '';
            return '<div class="r" data-mn-search="' + esc(((s.goal||'') + ' ' + (s.project||'') + ' ' + (s.summary||'')).toLowerCase()) + '" onclick="open_(\'mn:s:' + esc(s.id) + '\')" style="border-left:3px solid var(--gold)">'
              + '<span class="r-n" style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.goal || '(' + s.id.slice(0,12) + ')') + '</span>'
              + '<span class="r-tg">' + projChip + '<span class="tg ' + statusClass + '">' + esc((s.status || 'ok').toUpperCase()) + '</span><span class="tg tg-c">' + (s.obs_count || 0) + ' obs</span></span>'
              + '<span class="r-d" style="font-size:0.7rem;color:var(--dim)">' + esc(dateShort) + '</span>'
              + '</div>';
          };
          const skRow = (sk) => {
            const promoted = (sk.tags || []).includes('auto-promoted');
            const eff = (sk.effectiveness || 0);
            return '<div class="r" data-mn-search="' + esc(((sk.name||'') + ' ' + (sk.description||'') + ' ' + (sk.procedure||'') + ' ' + (sk.tags||[]).join(' ')).toLowerCase()) + '" onclick="open_(\'mn:sk:' + esc(sk.name) + '\')" style="border-left:3px solid var(--purple)">'
              + '<span class="r-n" style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(sk.name) + '</span>'
              + '<span class="r-tg"><span class="tg tg-b">v' + (sk.version || 1) + '</span>' + (promoted ? '<span class="tg tg-o">AUTO</span>' : '') + '<span class="tg tg-c">' + (sk.use_count || 0) + ' uses</span><span class="tg tg-g">' + (eff * 100).toFixed(0) + '%</span></span>'
              + '<span class="r-d" style="font-size:0.7rem;color:var(--dim);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(sk.description || '') + '</span>'
              + '</div>';
          };
          const flRow = (f, i) => {
            return '<div class="r" data-mn-search="' + esc(((f.path||'') + ' ' + (f.project||'')).toLowerCase()) + '" onclick="open_(\'mn:f:' + i + '\')" style="border-left:3px solid var(--cyan)">'
              + '<span class="r-n" style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:JetBrains Mono,monospace;font-size:0.78rem">' + esc(f.path) + '</span>'
              + '<span class="r-tg">' + (f.project ? '<span class="tg tg-b">' + esc(f.project) + '</span>' : '') + '<span class="tg tg-o">' + f.touches + 'x</span><span class="tg tg-c">' + (f.distinct_sessions || 0) + ' sess</span></span>'
              + '<span class="r-d" style="font-size:0.7rem;color:var(--dim)">' + esc((f.last_touched || '').replace('T',' ').slice(0,16)) + '</span>'
              + '</div>';
          };
          // Type filter chips
          const typeChips = '<div id="mn-type-chips" style="display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px">'
            + '<button class="mn-chip act" data-mn-chip="" onclick="mnFilterChip(this,\'\')" style="background:var(--blue);color:#000;border:none;font-family:Antonio,sans-serif;font-size:0.7rem;font-weight:600;letter-spacing:0.08em;padding:4px 10px;border-radius:10px;cursor:pointer">ALL // ' + m.observations.length + '</button>'
            + typeKeys.map(k => {
                const col = obsTypeColor[k] || 'var(--text)';
                return '<button class="mn-chip" data-mn-chip="' + esc(k) + '" onclick="mnFilterChip(this,\'' + esc(k) + '\')" style="background:transparent;color:' + col + ';border:1px solid ' + col + ';font-family:Antonio,sans-serif;font-size:0.7rem;font-weight:600;letter-spacing:0.08em;padding:4px 10px;border-radius:10px;cursor:pointer">' + esc(k.toUpperCase()) + ' // ' + byType[k] + '</button>';
              }).join('')
            + '</div>';
          // Top tags / projects sidebar info
          const topTagsHtml = m.stats.topTags.length
            ? '<div style="padding:12px 16px;border-top:1px solid #1a1a1e"><div style="font-family:Antonio,sans-serif;font-size:0.72rem;letter-spacing:0.1em;color:var(--dim);margin-bottom:8px">TOP TAGS</div><div style="display:flex;flex-wrap:wrap;gap:6px">'
              + m.stats.topTags.slice(0, 16).map(t => '<button onclick="mnSearchSet(\'' + esc(t.tag) + '\')" style="background:rgba(102,204,204,0.08);border:1px solid rgba(102,204,204,0.3);color:var(--cyan);font-family:JetBrains Mono,monospace;font-size:0.72rem;padding:3px 9px;border-radius:10px;cursor:pointer">' + esc(t.tag) + ' <span style="color:var(--dim)">' + t.count + '</span></button>').join('')
              + '</div></div>'
            : '';
          const topProjHtml = m.stats.topProjects.length
            ? '<div style="padding:12px 16px;border-top:1px solid #1a1a1e"><div style="font-family:Antonio,sans-serif;font-size:0.72rem;letter-spacing:0.1em;color:var(--dim);margin-bottom:8px">TOP PROJECTS</div><div style="display:flex;flex-wrap:wrap;gap:6px">'
              + m.stats.topProjects.map(p => '<button onclick="mnSearchSet(\'' + esc(p.project) + '\')" style="background:rgba(153,153,255,0.08);border:1px solid rgba(153,153,255,0.3);color:var(--blue);font-family:JetBrains Mono,monospace;font-size:0.72rem;padding:3px 9px;border-radius:10px;cursor:pointer">' + esc(p.project) + ' <span style="color:var(--dim)">' + p.count + '</span></button>').join('')
              + '</div></div>'
            : '';

          return `
          <div class="sec-h" style="display:flex;align-items:center;justify-content:space-between"><span>Mnemos // Persistent Memory + Skills</span><span style="font-size:0.7rem;color:var(--dim);font-family:JetBrains Mono,monospace">${esc(m.binVersion || '')} · ${fmtBytes(m.dbSize)}</span></div>
          <div class="mcp-overview" style="grid-template-columns:repeat(6,1fr)">
            <div class="mcp-overview-stat"><div class="mcp-overview-n total">${String(m.stats.observations).padStart(3,'0')}</div><div class="mcp-overview-l">Observations</div></div>
            <div class="mcp-overview-stat"><div class="mcp-overview-n green">${String(m.stats.live).padStart(3,'0')}</div><div class="mcp-overview-l">Live</div></div>
            <div class="mcp-overview-stat"><div class="mcp-overview-n" style="color:var(--red)">${String(m.stats.superseded).padStart(3,'0')}</div><div class="mcp-overview-l">Superseded</div></div>
            <div class="mcp-overview-stat"><div class="mcp-overview-n orange">${String(m.stats.sessions).padStart(3,'0')}</div><div class="mcp-overview-l">Sessions</div></div>
            <div class="mcp-overview-stat"><div class="mcp-overview-n" style="color:var(--purple)">${String(m.stats.skills).padStart(3,'0')}</div><div class="mcp-overview-l">Skills (${m.stats.autoPromoted} auto)</div></div>
            <div class="mcp-overview-stat"><div class="mcp-overview-n" style="color:var(--cyan)">${String(m.stats.fileTouches).padStart(3,'0')}</div><div class="mcp-overview-l">Tracked Files</div></div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:12px;border-top:1px solid #1a1a1e;border-bottom:1px solid #1a1a1e;background:#08080a">
            <button class="mn-tab act" id="mn-tab-obs" onclick="mnSwitchTab('obs')" style="background:var(--blue);border:none;color:#000;font-family:Antonio,sans-serif;font-size:0.78rem;font-weight:600;letter-spacing:0.1em;padding:6px 14px;border-radius:12px;cursor:pointer">OBSERVATIONS // ${m.observations.length}</button>
            <button class="mn-tab" id="mn-tab-ses" onclick="mnSwitchTab('ses')" style="background:transparent;border:1px solid var(--gold);color:var(--gold);font-family:Antonio,sans-serif;font-size:0.78rem;font-weight:600;letter-spacing:0.1em;padding:6px 14px;border-radius:12px;cursor:pointer">SESSIONS // ${m.sessions.length}</button>
            <button class="mn-tab" id="mn-tab-sk" onclick="mnSwitchTab('sk')" style="background:transparent;border:1px solid var(--purple);color:var(--purple);font-family:Antonio,sans-serif;font-size:0.78rem;font-weight:600;letter-spacing:0.1em;padding:6px 14px;border-radius:12px;cursor:pointer">SKILLS // ${m.skills.length}</button>
            <button class="mn-tab" id="mn-tab-fl" onclick="mnSwitchTab('fl')" style="background:transparent;border:1px solid var(--cyan);color:var(--cyan);font-family:Antonio,sans-serif;font-size:0.78rem;font-weight:600;letter-spacing:0.1em;padding:6px 14px;border-radius:12px;cursor:pointer">FILES // ${m.fileTouches.length}</button>
            <div style="flex:1"></div>
            <input id="mn-search" type="text" placeholder="Filter title, content, tags, project..." oninput="mnApplyFilter()" style="flex:1;max-width:360px;background:#0a0a0c;border:1px solid #1a1a1e;color:var(--text);font-family:JetBrains Mono,monospace;font-size:0.78rem;padding:6px 10px;border-radius:4px;outline:none">
          </div>
          <div id="mn-view-obs" class="mn-view" style="display:block">
            ${typeChips}
            <div id="mn-list-obs">
              ${m.observations.length === 0 ? '<div class="emp">No observations yet. Run any agent task that calls mnemos_save.</div>' : m.observations.map(obsRow).join('')}
            </div>
          </div>
          <div id="mn-view-ses" class="mn-view" style="display:none">
            <div id="mn-list-ses">
              ${m.sessions.length === 0 ? '<div class="emp">No sessions recorded yet.</div>' : m.sessions.map(sesRow).join('')}
            </div>
          </div>
          <div id="mn-view-sk" class="mn-view" style="display:none">
            <div id="mn-list-sk">
              ${m.skills.length === 0 ? '<div class="emp">No skills yet. Record three related corrections and one will be auto-promoted.</div>' : m.skills.map(skRow).join('')}
            </div>
          </div>
          <div id="mn-view-fl" class="mn-view" style="display:none">
            <div id="mn-list-fl">
              ${m.fileTouches.length === 0 ? '<div class="emp">No file touches recorded.</div>' : m.fileTouches.map((f, i) => flRow(f, i)).join('')}
            </div>
          </div>
          ${topTagsHtml}
          ${topProjHtml}
          `;
        })()}
      </div>

      <div class="sec" id="s-viz">
        <div class="tac-toolbar">
          <button class="tac-tab act" id="tac-tab-map" onclick="switchTac('map')">SYSTEMS MAP</button>
          <button class="tac-tab" id="tac-tab-ship" onclick="switchTac('ship')">ENTERPRISE</button>
          <div class="tac-spacer"></div>
          <button class="tac-btn" onclick="resetGraph()">RECENTER</button>
        </div>
        <div class="tac-view act" id="tac-map" style="position:relative;flex:1;min-height:0">
          <canvas id="viz-canvas" style="width:100%;height:100%;display:block;background:#030306"></canvas>
          <div class="tac-legend" id="tac-legend"></div>
          <div class="tac-hint">CLICK NODE TO OPEN // HOVER FOR DETAILS</div>
        </div>
        <div class="tac-view" id="tac-ship" style="position:relative;flex:1;min-height:0;background:#020204">
          <iframe id="ship-embed" title="Enterprise-D" style="width:100%;height:100%;border:none;display:none" allow="autoplay; fullscreen; xr-spatial-tracking" allowfullscreen mozallowfullscreen="true" webkitallowfullscreen="true"></iframe>
          <div id="ship-placeholder" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px">
            <div style="font-family:Antonio,sans-serif;font-size:1.2rem;color:var(--orange);letter-spacing:0.1em">USS ENTERPRISE NCC-1701-D</div>
            <div style="font-size:0.7rem;color:var(--dim);letter-spacing:0.08em">GALAXY CLASS STARSHIP</div>
            <button onclick="loadEnterprise()" style="margin-top:12px;background:var(--blue);border:none;color:#000;font-family:Antonio,sans-serif;font-size:0.85rem;font-weight:600;padding:8px 24px;border-radius:16px;cursor:pointer;letter-spacing:0.1em">LOAD 3D MODEL</button>
            <div style="font-size:0.6rem;color:var(--faint);margin-top:4px">Interactive 3D model via Sketchfab</div>
          </div>
        </div>
      </div>

      <div class="sec" id="s-q">
        <div style="padding:20px 24px;border-bottom:2px solid var(--red);display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-family:Antonio,sans-serif;font-size:1.4rem;color:var(--red);letter-spacing:0.08em;text-transform:uppercase">Q Continuum</div>
            <div style="font-size:0.7rem;color:var(--dim);margin-top:4px;letter-spacing:0.06em">An audience with the omnipotent. Proceed at your own risk.</div>
          </div>
          <button id="q-snooze-btn" onclick="toggleQMute()" style="background:rgba(204,68,68,0.15);border:1px solid rgba(204,68,68,0.4);color:var(--red);font-family:Antonio,sans-serif;font-size:0.7rem;font-weight:600;padding:6px 14px;cursor:pointer;letter-spacing:0.1em;border-radius:10px">MUTE RANDOM VISITS</button>
        </div>
        <div id="q-content" style="flex:1;overflow-y:auto;padding:20px 24px">
          <div id="q-judgement" style="margin-bottom:24px"></div>
          <div id="q-chat-log"></div>
        </div>
        <div style="padding:12px 24px;border-top:1px solid #222;display:flex;gap:8px;align-items:center">
          <input type="text" id="q-input" placeholder="Speak, mortal..." style="flex:1;background:#0a0a0c;border:1px solid var(--red);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.82rem;padding:8px 12px;outline:none;border-radius:4px" onkeydown="if(event.key==='Enter'){event.preventDefault();sendToQ()}">
          <button onclick="sendToQ()" style="background:var(--red);border:none;color:#000;font-family:Antonio,sans-serif;font-size:0.8rem;font-weight:600;padding:8px 16px;cursor:pointer;letter-spacing:0.1em;border-radius:12px">SPEAK</button>
          <button onclick="qJudgement()" style="background:var(--gold);border:none;color:#000;font-family:Antonio,sans-serif;font-size:0.8rem;font-weight:600;padding:8px 16px;cursor:pointer;letter-spacing:0.1em;border-radius:12px">JUDGE ME</button>
        </div>
      </div>

      <div class="sec" id="s-replicator">
        <div class="rep-header">
          <div>
            <span class="rep-title">REPLICATOR // MK VII</span>
            <span class="rep-subtitle">MOLECULAR SYNTHESIS UNIT // DESCRIBE ANYTHING</span>
          </div>
          <div class="rep-spinner" id="rep-spinner"></div>
          <span class="rep-status-lbl" id="rep-status-lbl">STANDBY</span>
        </div>
        <div class="rep-body">
          <div class="rep-chat">
            <div class="rep-msgs" id="rep-msgs">
              <div class="rep-msg ai">
                <div class="rep-msg-from">COMPUTER</div>
                <div class="rep-msg-text">REPLICATOR ONLINE. STATE YOUR REQUEST.</div>
              </div>
            </div>
            <div class="rep-input-row">
              <textarea class="rep-input" id="rep-input" placeholder="tea, earl grey, hot" rows="3" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();repSend()}"></textarea>
              <button class="rep-send" onclick="repSend()">REPLICATE</button>
            </div>
            <div class="rep-hint">ENTER TO REPLICATE // SHIFT+ENTER FOR NEWLINE</div>
          </div>
          <div class="rep-canvas-wrap" id="rep-canvas-wrap">
            <canvas id="rep-canvas"></canvas>
            <div class="rep-canvas-label" id="rep-canvas-label">
              <span class="rep-label-text" id="rep-label-text">AWAITING REPLICATION ORDER</span>
              <div class="rep-export-btns" id="rep-export-btns">
                <button class="rep-exp-btn" onclick="repExport('glb')">GLB</button>
                <button class="rep-exp-btn" onclick="repExport('obj')">OBJ</button>
                <button class="rep-exp-btn" onclick="repExport('stl')">STL</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="sec" id="s-comms">
        <div style="padding:8px 16px;border-bottom:1px solid #1a1a1e;display:flex;align-items:center;justify-content:flex-end;gap:8px">
          <span style="font-size:0.6rem;color:var(--dim);letter-spacing:0.08em;flex:1">HISTORY PERSISTS ACROSS RELOADS</span>
          <button onclick="clearCommsHistory()" style="font-family:Antonio,sans-serif;font-size:0.6rem;letter-spacing:0.1em;padding:3px 10px;background:transparent;border:1px solid #333;color:var(--dim);cursor:pointer;border-radius:4px">CLEAR HISTORY</button>
        </div>
        <div class="comms">
          <div class="comms-log" id="comms-log">
            <div class="comms-msg sys">COMMS CHANNEL // USE THE COMPUTER BAR BELOW TO COMMUNICATE</div>
            <div class="comms-msg sys">ALL CONVERSATIONS ARE DISPLAYED HERE</div>
          </div>
        </div>
      </div>

      <div class="sec" id="s-config">
        <div class="cfg">

          <div class="cfg-section">
            <div class="cfg-section-head">Voice Engine</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">Engine</span>
                <span class="cfg-desc">Browser voice is free. ElevenLabs gives you a realistic AI voice with low latency streaming.</span>
                <span class="cfg-input">
                  <div class="lcars-select" id="cfg-voice-engine-wrap">
                    <button class="lcars-select-btn" onclick="toggleLcarsSelect('cfg-voice-engine-wrap')"><span>Browser (Free)</span></button>
                    <div class="lcars-dropdown">
                      <div class="lcars-option selected" data-value="browser" onclick="selectLcarsOption('cfg-voice-engine-wrap',this);onVoiceEngineChange()">
                        <span class="opt-label">Browser (Free)</span>
                        <span class="opt-sub">Built-in Web Speech API, no setup needed</span>
                      </div>
                      <div class="lcars-option" data-value="elevenlabs" onclick="selectLcarsOption('cfg-voice-engine-wrap',this);onVoiceEngineChange()">
                        <span class="opt-label">ElevenLabs (Premium)</span>
                        <span class="opt-sub">Realistic AI voice, low latency streaming</span>
                      </div>
                    </div>
                  </div>
                </span>
              </div>
              <div id="cfg-eleven-fields" style="display:none">
                <div class="cfg-row">
                  <span class="cfg-label">API Key</span>
                  <span class="cfg-desc">Get yours from <a href="https://elevenlabs.io" target="_blank" style="color:var(--orange)">elevenlabs.io</a></span>
                  <span class="cfg-input"><form onsubmit="return false"><input type="password" id="cfg-eleven-key" placeholder="sk_..." oninput="onApiKeyChange()" autocomplete="off"></form></span>
                </div>
                <div class="cfg-row-stack">
                  <span class="cfg-label">Voice</span>
                  <span class="cfg-desc">Browse your available voices. Click the play button to preview, click the row to select.</span>
                  <div id="voice-browser-container" style="width:100%">
                    <div class="voice-loading" id="voice-browser-loading">Enter API key to load voices</div>
                    <div class="voice-browser" id="voice-browser" style="display:none"></div>
                  </div>
                  <input type="hidden" id="cfg-eleven-voice" value="EXAVITQu4vr4xnSDxMaL">
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">Status</span>
                  <span class="cfg-desc"></span>
                  <span class="cfg-input">
                    <span class="cfg-status" id="cfg-eleven-status"><span class="cfg-dot off"></span> NOT CONFIGURED</span>
                  </span>
                </div>
                <button class="cfg-save-btn" onclick="testElevenLabs()">TEST VOICE</button>
              </div>
              <p class="cfg-note">Config is saved in your browser (localStorage). API keys are only sent to ElevenLabs servers through the local proxy, never stored on disk.</p>
            </div>
          </div>

          <div class="cfg-section">
            <div class="cfg-section-head">Chat Model</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">Chat model</span>
                <span class="cfg-desc">Which Claude model the COMPUTER bar talks to.</span>
                <span class="cfg-input">
                  <div class="lcars-select" id="cfg-model-wrap">
                    <button class="lcars-select-btn" onclick="toggleLcarsSelect('cfg-model-wrap')"><span>Claude Sonnet 4.6</span></button>
                    <div class="lcars-dropdown">
                      <div class="lcars-option" data-value="claude-opus-4-6" onclick="selectLcarsOption('cfg-model-wrap',this);onModelChange()">
                        <span class="opt-label">Claude Opus 4.6</span>
                        <span class="opt-sub">Most capable. Deep reasoning, complex tasks.</span>
                      </div>
                      <div class="lcars-option selected" data-value="claude-sonnet-4-6" onclick="selectLcarsOption('cfg-model-wrap',this);onModelChange()">
                        <span class="opt-label">Claude Sonnet 4.6</span>
                        <span class="opt-sub">Fast and capable. Best balance of speed and quality.</span>
                      </div>
                      <div class="lcars-option" data-value="claude-haiku-4-5-20251001" onclick="selectLcarsOption('cfg-model-wrap',this);onModelChange()">
                        <span class="opt-label">Claude Haiku 4.5</span>
                        <span class="opt-sub">Fastest. Instant responses, lowest cost.</span>
                      </div>
                    </div>
                  </div>
                </span>
              </div>
              <div class="cfg-row">
                <span class="cfg-label">Discover model</span>
                <span class="cfg-desc">Model used to generate personalised setup suggestions. Opus gives much better results.</span>
                <span class="cfg-input">
                  <div class="lcars-select" id="cfg-discover-model-wrap">
                    <button class="lcars-select-btn" onclick="toggleLcarsSelect('cfg-discover-model-wrap')"><span>Claude Opus 4.6</span></button>
                    <div class="lcars-dropdown">
                      <div class="lcars-option selected" data-value="claude-opus-4-6" onclick="selectLcarsOption('cfg-discover-model-wrap',this);saveConfig()">
                        <span class="opt-label">Claude Opus 4.6</span>
                        <span class="opt-sub">Best suggestions. Recommended.</span>
                      </div>
                      <div class="lcars-option" data-value="claude-sonnet-4-6" onclick="selectLcarsOption('cfg-discover-model-wrap',this);saveConfig()">
                        <span class="opt-label">Claude Sonnet 4.6</span>
                        <span class="opt-sub">Good suggestions, lower cost.</span>
                      </div>
                      <div class="lcars-option" data-value="claude-haiku-4-5-20251001" onclick="selectLcarsOption('cfg-discover-model-wrap',this);saveConfig()">
                        <span class="opt-label">Claude Haiku 4.5</span>
                        <span class="opt-sub">Fastest, cheapest — lower quality suggestions.</span>
                      </div>
                    </div>
                  </div>
                </span>
              </div>
              <p class="cfg-note">Model changes take effect on the next message. No server restart needed.</p>
            </div>
          </div>

          <div class="cfg-section">
            <div class="cfg-section-head">Ship Registry</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">Designation</span>
                <span class="cfg-desc">Name your workstation. Shows in the header and boot sequence.</span>
                <span class="cfg-input"><input type="text" id="cfg-ship-name" placeholder="USS Enterprise" oninput="onShipNameChange()" maxlength="30"></span>
              </div>
              <div class="cfg-row">
                <span class="cfg-label">Registry</span>
                <span class="cfg-desc">Ship registry number.</span>
                <span class="cfg-input"><input type="text" id="cfg-ship-reg" placeholder="NCC-1701-D" oninput="onShipNameChange()" maxlength="16"></span>
              </div>
            </div>
          </div>

          <div class="cfg-section">
            <div class="cfg-section-head">Workspace</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">Projects Directory</span>
                <span class="cfg-desc">Path to your projects folder (e.g. ~/Code). LCARS will scan it and use your projects as context in chat.</span>
                <span class="cfg-input"><input type="text" id="cfg-projects-dir" placeholder="~/Code" oninput="onProjectsDirChange()"></span>
              </div>
            </div>
          </div>

          <div class="cfg-section">
            <div class="cfg-section-head">Ship Theme</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">Theme</span>
                <span class="cfg-desc">Change the LCARS colour palette.</span>
                <span class="cfg-input">
                  <div class="lcars-select" id="cfg-theme-wrap">
                    <button class="lcars-select-btn" onclick="toggleLcarsSelect('cfg-theme-wrap')"><span>Enterprise-D</span></button>
                    <div class="lcars-dropdown">
                      <div class="lcars-option selected" data-value="enterprise" onclick="selectLcarsOption('cfg-theme-wrap',this);onThemeChange()">
                        <span class="opt-label">Enterprise-D</span>
                        <span class="opt-sub">Classic TNG orange and blue</span>
                      </div>
                      <div class="lcars-option" data-value="defiant" onclick="selectLcarsOption('cfg-theme-wrap',this);onThemeChange()">
                        <span class="opt-label">Defiant</span>
                        <span class="opt-sub">Dark, aggressive. Red and grey.</span>
                      </div>
                      <div class="lcars-option" data-value="voyager" onclick="selectLcarsOption('cfg-theme-wrap',this);onThemeChange()">
                        <span class="opt-label">Voyager</span>
                        <span class="opt-sub">Blue-shifted. Cool and distant.</span>
                      </div>
                      <div class="lcars-option" data-value="discovery" onclick="selectLcarsOption('cfg-theme-wrap',this);onThemeChange()">
                        <span class="opt-label">Discovery</span>
                        <span class="opt-sub">Silver and blue. Modern Starfleet.</span>
                      </div>
                    </div>
                  </div>
                </span>
              </div>
            </div>
          </div>

          <div class="cfg-section">
            <div class="cfg-section-head">Sound Effects</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">LCARS Beeps</span>
                <span class="cfg-desc">Synthesized sound effects on navigation, actions, and communication.</span>
                <span class="cfg-input">
                  <div class="lcars-select" id="cfg-sfx-wrap">
                    <button class="lcars-select-btn" onclick="toggleLcarsSelect('cfg-sfx-wrap')"><span>Enabled</span></button>
                    <div class="lcars-dropdown">
                      <div class="lcars-option selected" data-value="on" onclick="selectLcarsOption('cfg-sfx-wrap',this);onSfxChange()">
                        <span class="opt-label">Enabled</span>
                      </div>
                      <div class="lcars-option" data-value="off" onclick="selectLcarsOption('cfg-sfx-wrap',this);onSfxChange()">
                        <span class="opt-label">Disabled</span>
                      </div>
                    </div>
                  </div>
                </span>
              </div>
              <div class="cfg-row">
                <span class="cfg-label">Ambient Noise</span>
                <span class="cfg-desc">Synthesized Star Trek engine hum — brown noise base, 60 Hz warp core oscillator, slow LFO breathing. No audio files.</span>
                <span class="cfg-input">
                  <div class="lcars-select" id="cfg-ambient-wrap">
                    <button class="lcars-select-btn" onclick="toggleLcarsSelect('cfg-ambient-wrap')"><span>Off</span></button>
                    <div class="lcars-dropdown">
                      <div class="lcars-option selected" data-value="off" onclick="selectLcarsOption('cfg-ambient-wrap',this);onAmbientChange()">
                        <span class="opt-label">Off</span>
                      </div>
                      <div class="lcars-option" data-value="low" onclick="selectLcarsOption('cfg-ambient-wrap',this);onAmbientChange()">
                        <span class="opt-label">Low</span><span class="opt-sub">Subtle background hum</span>
                      </div>
                      <div class="lcars-option" data-value="medium" onclick="selectLcarsOption('cfg-ambient-wrap',this);onAmbientChange()">
                        <span class="opt-label">Medium</span><span class="opt-sub">Bridge ambience</span>
                      </div>
                      <div class="lcars-option" data-value="high" onclick="selectLcarsOption('cfg-ambient-wrap',this);onAmbientChange()">
                        <span class="opt-label">High</span><span class="opt-sub">Engine room</span>
                      </div>
                    </div>
                  </div>
                </span>
              </div>
            </div>
          </div>

          <div class="cfg-section">
            <div class="cfg-section-head">Server Info</div>
            <div class="cfg-section-body">
              <div class="cfg-row">
                <span class="cfg-label">Mode</span>
                <span class="cfg-desc"></span>
                <span class="cfg-input" id="cfg-mode-display">STATIC</span>
              </div>
              <div class="cfg-row">
                <span class="cfg-label">Version</span>
                <span class="cfg-desc"></span>
                <span class="cfg-input" id="cfg-version-display" style="color:var(--dim)">—</span>
              </div>
              <div class="cfg-row">
                <span class="cfg-label">Stardate</span>
                <span class="cfg-desc"></span>
                <span class="cfg-input" style="color:var(--orange)">${stardate}</span>
              </div>
              <div class="cfg-row" id="cfg-server-actions" style="display:none">
                <span class="cfg-label">Controls</span>
                <span class="cfg-desc">Restart to pick up config changes. Update pulls latest from npm then restarts.</span>
                <span class="cfg-input" style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="lcars-action-btn" onclick="restartServer(this)" style="border-color:var(--cyan);color:var(--cyan)">&#x21BA; RESTART</button>
                  <button class="lcars-action-btn" id="cfg-update-btn" onclick="updateServer(this)" style="border-color:var(--orange);color:var(--orange)">&#x2191; UPDATE</button>
                </span>
              </div>
            </div>
          </div>

        </div>
      </div>

      <div class="sec" id="s-academy" style="overflow-y:auto;height:100%">
        <div class="about" style="max-width:860px">

          <div class="about-hero">
            <div class="about-title" style="color:var(--cyan)">Starfleet Academy</div>
            <div class="about-tagline">This dashboard is a control room, not a viewer. Everything in it can be changed, improved, and acted on. Here is how to use it to make Claude genuinely better at working with you.</div>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--orange)">01 — CLAUDE.MD is your most important lever</div>
            <p>Claude reads your CLAUDE.md files at the start of every session. They are standing orders. Whatever you put in there, Claude will follow every single time without you having to repeat it.</p>
            <p>Go to <span style="color:var(--cyan);font-weight:bold">CLAUDE.MD</span> in the sidebar. You will see every instruction file across your setup — the global one that applies everywhere and per-project ones that apply to specific codebases. Click any of them to read what they say right now.</p>
            <p>Things worth putting in your global CLAUDE.md:</p>
            <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
              <div style="border-left:3px solid var(--peach);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--peach);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Code style</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">The exact conventions you want followed — indentation, naming, patterns you like, patterns you hate. Claude will apply them without being asked.</div>
              </div>
              <div style="border-left:3px solid var(--cyan);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--cyan);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Communication style</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">How you want Claude to talk to you. Short answers or detailed? Show reasoning or just the result? Ask before acting or proceed and report?</div>
              </div>
              <div style="border-left:3px solid var(--salmon);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--salmon);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">What not to do</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">Things Claude tends to do that annoy you. Write them down once and they stop.</div>
              </div>
              <div style="border-left:3px solid var(--orange);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--orange);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Project context</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">In a per-project CLAUDE.md: what the codebase is, what the architecture decisions were, what areas are fragile, what the deploy process is.</div>
              </div>
            </div>
            <p style="color:var(--dim);font-size:0.8rem;margin-top:10px">Hit EDIT on any CLAUDE.md to change it directly from this panel. Changes take effect in the next Claude session.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--cyan)">02 — Skills are reusable prompts you invoke with one word</div>
            <p>A skill is a slash command — <span style="font-family:monospace;color:var(--orange)">/commit</span>, <span style="font-family:monospace;color:var(--orange)">/review</span>, <span style="font-family:monospace;color:var(--orange)">/deploy-check</span> — that expands into a full set of instructions when you use it in Claude Code. Write a skill once and reuse it across every project.</p>
            <p>Go to <span style="color:var(--blue);font-weight:bold">SKILLS</span> and click any skill to read its full prompt. If it says what you want, hit <span style="color:var(--peach)">INVOKE</span> to copy the slash command to your clipboard. Paste it into Claude Code.</p>
            <p>If you want to improve a skill, hit EDIT, change the prompt, save. That skill now behaves differently everywhere you use it.</p>
            <p>The DISCOVER section at the bottom of SKILLS shows suggested skills you haven't installed yet. These are high-quality starting points — a code review skill, a commit skill, a deploy checklist. Install any of them in one click and then edit the prompt to match exactly how you work.</p>
            <p style="color:var(--dim);font-size:0.8rem">Skills live at <span style="font-family:monospace;color:var(--blue)">~/.claude/skills/</span>. Each one is a markdown file with a YAML header. You own them completely.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--orange)">03 — Agents delegate entire categories of work</div>
            <p>An agent is a specialised version of Claude with its own role, tool access, and instructions. When Claude is working on something and decides it needs specialist help — a security audit, a test suite, documentation — it can spin up the right agent automatically.</p>
            <p>Go to <span style="color:var(--peach);font-weight:bold">AGENTS</span> to see what you have. Click any agent to read its system prompt and what tools it can use. The DISCOVER section shows agents you could add — security auditor, test generator, performance analyst, documentation writer.</p>
            <p>A well-defined agent means you never have to explain the same thing twice. You write the instructions once in the agent definition and Claude follows them every time it invokes that agent.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--cyan)">04 — Hooks automate the things you keep doing manually</div>
            <p>A hook is a shell command that runs automatically when Claude does something specific. They run outside the conversation — Claude does not see their output unless you pipe it back.</p>
            <p>Go to <span style="color:var(--tan);font-weight:bold">HOOKS</span> to see what you have configured. Click any hook to see exactly what it runs and when.</p>
            <table class="about-table">
              <tr><td style="color:var(--peach);white-space:nowrap">PostToolUse → Write</td><td>Run a formatter on every file Claude writes. Your code is always formatted without you thinking about it.</td></tr>
              <tr><td style="color:var(--peach);white-space:nowrap">Stop</td><td>Desktop notification when Claude finishes a long task. Get up, come back when it's done.</td></tr>
              <tr><td style="color:var(--peach);white-space:nowrap">PreToolUse → Bash</td><td>Block specific shell commands before they run. A safety net for destructive operations.</td></tr>
              <tr><td style="color:var(--peach);white-space:nowrap">Stop → log</td><td>Append what Claude just did to a daily log. Passive audit trail of everything that happened.</td></tr>
            </table>
            <p style="color:var(--dim);font-size:0.8rem;margin-top:10px">DISCOVER at the bottom of HOOKS shows ready-made hooks you can install. Each one is a single shell command.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--orange)">05 — MCP servers give Claude new capabilities</div>
            <p>MCP (Model Context Protocol) servers extend what Claude can do beyond reading and writing files. Each server adds a category of tools Claude can call — querying a database, browsing the web, searching your notes, running browser automation.</p>
            <p>Go to <span style="color:var(--orange);font-weight:bold">MCP SERVERS</span> to see what's running. A server marked as missing or offline means Claude is trying to use a tool that isn't working — that's worth fixing.</p>
            <p>Go to <span style="color:var(--salmon);font-weight:bold">MARKET</span> to browse what's available. Hit LOAD REGISTRY to pull from the official npm registry. Search for something — postgres, slack, github, filesystem — and install it directly from this panel.</p>
            <p style="color:var(--dim);font-size:0.8rem">The security panel on each MCP server shows known CVEs and risky configuration flags. Worth checking before adding a new server.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--cyan)">06 — Memory keeps Claude informed across sessions</div>
            <p>Claude does not remember previous conversations by default. Memory files fix this. They are markdown files that Claude reads at the start of each session for a given project.</p>
            <p>Go to <span style="color:var(--ltblue);font-weight:bold">MEMORY</span> to see all your memory files. Click any to read what Claude knows about each project. If something is out of date, edit it here.</p>
            <p>The <span style="color:var(--cyan);font-weight:bold">MEMORY BANKS</span> panel is your personal knowledge store, separate from project memory. Use it to log things you want to be able to search later — decisions made, problems solved, patterns observed. The <span style="font-family:monospace;color:var(--orange)">recall</span> command in your terminal adds entries:</p>
            <p style="font-family:monospace;color:var(--orange);background:#0a0a14;padding:10px 14px;border-radius:4px;font-size:0.85rem;line-height:1.8">
              recall add "postgres query planner ignores index on nullable columns unless ISNULL cast" --tags postgres,performance<br>
              recall find "postgres index"<br>
              recall find "performance" --from 2w
            </p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--orange)">07 — TACTICAL shows you what you've built</div>
            <p>Go to <span style="color:var(--blue);font-weight:bold">TACTICAL</span>. This is a force-directed graph of your entire Claude Code setup. Every skill, agent, hook, MCP server, memory file, and CLAUDE.md is a node. Connections show relationships.</p>
            <p>Use it to spot gaps. A setup with many MCP servers but no hooks means a lot of capability but no automation. No agents means Claude is doing everything as a generalist when it could be specialising. Few skills means you're probably re-explaining common tasks repeatedly.</p>
            <p>It's also just a good way to see that you've actually built something.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--cyan)">08 — The COMPUTER bar is a direct line to Claude</div>
            <p>The input at the bottom of this dashboard talks to the Claude API in real time. Use it to ask questions about your setup, get suggestions for improvements, or talk through a problem.</p>
            <p>The system prompt makes Claude respond as LCARS — the ship's computer. It has context about Claude Code's capabilities and will give you practical, structured answers. Ask it things like:</p>
            <table class="about-table">
              <tr><td style="color:var(--dim);font-style:italic">"What hooks would be most useful for a Go backend team?"</td></tr>
              <tr><td style="color:var(--dim);font-style:italic">"Review my code-review skill and suggest improvements"</td></tr>
              <tr><td style="color:var(--dim);font-style:italic">"What MCP servers would be useful for working with PostgreSQL?"</td></tr>
              <tr><td style="color:var(--dim);font-style:italic">"Write a CLAUDE.md for a microservices project using Go and Kubernetes"</td></tr>
            </table>
            <p style="color:var(--dim);font-size:0.8rem;margin-top:10px">Requires <span style="font-family:monospace;color:var(--blue)">claude-hud-lcars --serve</span> with a <span style="font-family:monospace;color:var(--blue)">CLAUDE_DASHBOARD_API_KEY</span> set.</p>
          </div>

          <div class="about-section">
            <div class="about-section-head" style="color:var(--orange)">09 — What a good setup looks like</div>
            <p>There is no right answer, but here is a useful benchmark. A setup that is working well tends to have:</p>
            <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
              <div style="border-left:3px solid var(--green);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--green);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">A global CLAUDE.md</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">That captures your communication preferences and code style. If Claude ever does something you don't like, the fix is probably a line in this file.</div>
              </div>
              <div style="border-left:3px solid var(--cyan);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--cyan);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Per-project CLAUDE.md</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">That explains the codebase to Claude — what it does, how it's structured, what the tricky parts are.</div>
              </div>
              <div style="border-left:3px solid var(--blue);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--blue);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">3–5 skills</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">For the things you ask Claude to do most often. Commit messages, code review, pre-deploy checks are good starting points.</div>
              </div>
              <div style="border-left:3px solid var(--orange);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--orange);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">A Stop hook</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">That notifies you when Claude finishes. You should not be staring at the terminal waiting.</div>
              </div>
              <div style="border-left:3px solid var(--lavender);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--lavender);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">At least one MCP server</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">That gives Claude access to something it can't do by default. Even just the filesystem server or fetch server expands what's possible significantly.</div>
              </div>
              <div style="border-left:3px solid var(--peach);padding:10px 14px;background:#0a0a0f">
                <div style="color:var(--peach);font-family:'Antonio',sans-serif;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Memory files</div>
                <div style="font-size:0.85rem;color:var(--text);line-height:1.6">For any project you return to regularly. Claude should not have to rediscover the architecture every session.</div>
              </div>
            </div>
            <p style="color:var(--dim);font-size:0.8rem;margin-top:10px">This dashboard shows you exactly which of these you have and which you don't. The gaps in SKILLS, HOOKS, and MEMORY sections are the most direct signal of where to spend time next.</p>
          </div>

        </div>
      </div>

      <div class="sec" id="s-about" style="position:relative;overflow-y:auto;height:100%">
        <canvas id="viewscreen" style="position:absolute;inset:0;width:100%;height:100%;z-index:0"></canvas>
        <div class="about" style="position:relative;z-index:1">
          <div class="about-hero">
            <div style="text-align:center;margin-bottom:24px">
              <svg viewBox="0 0 200 200" style="width:120px;height:120px"><circle cx="100" cy="100" r="98" fill="#1a2a3a" stroke="#2a6496" stroke-width="3"/><circle cx="100" cy="100" r="92" fill="#0d1218"/><circle cx="100" cy="100" r="78" fill="#1e5a8a"/><path d="M100 26 L140 145 L100 124 L60 145 Z" fill="#fff"/><ellipse cx="100" cy="94" rx="63" ry="26" fill="none" stroke="#fff" stroke-width="5" transform="rotate(-10 100 94)"/><path d="M100 65 L102 69 L106 69 L103 72 L104 76 L100 74 L96 76 L97 72 L94 69 L98 69 Z" fill="#fff"/><path d="M39 86 L41 90 L45 90 L42 93 L43 97 L39 95 L35 97 L36 93 L33 90 L37 90 Z" fill="#fff"/><path d="M161 86 L163 90 L167 90 L164 93 L165 97 L161 95 L157 97 L158 93 L155 90 L159 90 Z" fill="#fff"/><path d="M59 118 L61 122 L65 122 L62 125 L63 129 L59 127 L55 129 L56 125 L53 122 L57 122 Z" fill="#fff"/><path d="M100 99 L102 103 L106 103 L103 106 L104 110 L100 108 L96 110 L97 106 L94 103 L98 103 Z" fill="#1e5a8a"/><path d="M49 109 Q75 85 105 94 Q130 100 150 105" fill="none" stroke="#cc2222" stroke-width="7" stroke-linecap="round"/></svg>
            </div>
            <div class="about-title">Claude HUD // LCARS</div>
            <div class="about-tagline">
              A Star Trek LCARS operations dashboard for Claude Code. See your entire setup in one place. Browse skills, agents, MCP servers, hooks, memory files, and environment variables. Edit them in-browser. Talk to the computer. It talks back.
            </div>
            <p style="font-size:0.85rem;color:var(--dim);line-height:1.7">
              One command. Zero dependencies. No build step. No frameworks. Just Node.js and your browser. Run <span style="color:var(--orange);font-family:'JetBrains Mono',monospace">npx claude-hud-lcars</span> and you're in.
            </p>
          </div>

          <div class="about-section">
            <div class="about-section-head orange">Why this exists</div>
            <p>
              Claude Code is powerful, but your setup is scattered across dozens of files and configs under <span style="color:var(--blue);font-family:'JetBrains Mono',monospace">~/.claude/</span>. Skills in one folder, hooks in a JSON file, MCP servers configured somewhere else, memory files buried in project directories. It adds up fast.
            </p>
            <p>
              This dashboard pulls it all into one screen so you can actually see what you've built. Not a management tool that tries to replace your terminal. Just a window into the system, with enough interaction to be useful.
            </p>
          </div>

          <div class="about-section">
            <div class="about-section-head blue">The Star Trek thing</div>
            <p>
              Look, some people collect stamps. I grew up watching TNG and always thought the LCARS interface was the best UI ever designed for a computer. Flat, information-dense, colour-coded, no wasted space. It turns out those principles are exactly what you want for a dashboard that shows you 200 config items at a glance.
            </p>
            <p>
              The colour palette is accurate to the show. The typography is Swiss 911 (via Antonio). The sound effects are synthesised from scratch, no audio files. The computer bar at the bottom responds like the Enterprise computer, because if you're going to build a Star Trek dashboard, you don't do it halfway.
            </p>
          </div>

          <div class="about-section">
            <div class="about-section-head green">Built by</div>
            <p>
              I'm <strong style="color:var(--text)">Andr\u00e9 Figueira</strong>, founder of <a href="https://polyxmedia.com" target="_blank">Polyxmedia</a>. I've been building software for about 20 years, currently Principal Engineer by day, building tools and products under Polyxmedia the rest of the time.
            </p>
            <p>
              Polyxmedia is a boutique tech consultancy and the home for everything I ship. Some of it's client work, some of it's products I build because I can't stop thinking about a problem until it has a solution. This dashboard started that way. I wanted to see my Claude Code setup. Now you can see yours.
            </p>
          </div>

          <div class="about-section">
            <div class="about-section-head peach">Open source</div>
            <p>
              This project is free and open source. Use it, fork it, make it weird. If you build something cool on top of it, I'd genuinely love to see it.
            </p>
          </div>

          <div class="about-links">
            <a class="about-link" href="https://polyxmedia.com" target="_blank"><span class="al-dot" style="background:#55CC55"></span> polyxmedia.com</a>
            <a class="about-link" href="https://twitter.com/voidmode" target="_blank"><span class="al-dot" style="background:var(--blue)"></span> @voidmode</a>
            <a class="about-link" href="https://github.com/polyxmedia/claude-hud-lcars" target="_blank"><span class="al-dot" style="background:var(--orange)"></span> GitHub</a>
          </div>

          <div class="about-section" style="margin-top:32px">
            <div class="about-section-head" style="color:var(--lavender)">Credits &amp; Inspiration</div>
            <p>
              The LCARS visual language was created by Michael Okuda for Star Trek: The Next Generation. This dashboard draws on that aesthetic — if you love the look, go explore the fan communities that have kept it alive:
            </p>
            <div class="about-links">
              <a class="about-link" href="https://www.thelcars.com" target="_blank"><span class="al-dot" style="background:var(--lavender)"></span> thelcars.com</a>
              <a class="about-link" href="http://lcars.org.uk" target="_blank"><span class="al-dot" style="background:var(--lavender)"></span> lcars.org.uk</a>
            </div>
          </div>

          <div class="about-bugs">
            Found a bug? Something broken? Feature request? Email <a href="mailto:hello@polyxmedia.com">hello@polyxmedia.com</a> and I'll look at it.
          </div>

        </div>
      </div>

    </div>

    <div class="dp" id="dp">
      <div class="dp-h">
        <button class="dp-x" onclick="close_()">Close</button>
        <div class="dp-tp" id="dp-tp"></div>
        <div class="dp-t" id="dp-t"></div>
        <div class="dp-m" id="dp-m"></div>
      </div>
      <div class="dp-actions" id="dp-actions"></div>
      <div class="dp-b" id="dp-b"></div>
      <div class="hud-editor" id="hud-editor">
        <div class="hud-editor-toolbar">
          <span class="editor-path" id="editor-path"></span>
          <span class="editor-lang" id="editor-lang"></span>
          <span class="editor-lines" id="editor-line-count"></span>
          <button class="editor-save" onclick="saveFile()">SAVE</button>
          <button class="editor-cancel" onclick="closeEditor()">CANCEL</button>
        </div>
        <div class="hud-editor-wrap" id="editor-wrap">
          <div class="hud-editor-lines" id="editor-gutter"></div>
          <div class="hud-editor-highlight" id="editor-highlight"></div>
          <textarea id="editor-textarea" spellcheck="false" oninput="onEditorInput()" onscroll="syncEditorScroll()" onclick="updateActiveLine()"></textarea>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="bb">
  <div class="bb-elbow"></div>
  <div class="bb-fill"><span>CLAUDE-HUD v1.0.0 // LCARS INTERFACE</span><span>~/.claude/</span></div>
  <div class="bb-a"></div>
</div>

</div>

<div class="computer-response" id="cr">
  <div class="cr-controls">
    <button class="cr-btn cr-min" onclick="minimiseCR()">MINIMISE</button>
    <button class="cr-btn" onclick="closeCR()">DISMISS</button>
  </div>
  <span class="cr-mini-label" onclick="expandCR()">COMPUTER RESPONSE // CLICK TO EXPAND</span>
  <div id="cr-body"></div>
</div>

<div class="computer-bar">
  <div class="computer-bar-label"><svg viewBox="0 0 200 200" style="width:18px;height:18px;margin-right:6px"><circle cx="100" cy="100" r="98" fill="rgba(0,0,0,0.2)"/><circle cx="100" cy="100" r="78" fill="rgba(0,0,0,0.12)"/><path d="M100 26 L140 145 L100 124 L60 145 Z" fill="rgba(0,0,0,0.3)"/><ellipse cx="100" cy="94" rx="63" ry="26" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="5" transform="rotate(-10 100 94)"/></svg>COMPUTER</div>
  <div class="computer-bar-input">
    <textarea id="cb-in" placeholder="Ask the computer anything..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendGlobal()}"></textarea>
  </div>
  <span class="waveform-label hidden" id="wf-label"></span>
  <div class="waveform hidden" id="waveform"></div>
  <button class="computer-bar-send" id="cb-send" onclick="sendGlobal()">SEND</button>
  <div class="computer-bar-toggles">
    <button class="tgl-btn on" id="mode-toggle" style="background:var(--green)" onclick="toggleMode(this)">CLAUDE</button>
    <button class="tgl-btn on" id="cr-toggle" style="background:var(--tan);display:none" onclick="toggleCR()">LOG</button>
    <button class="tgl-btn off" id="voice-toggle" style="background:var(--salmon)" onclick="toggleVoice(this)">VOICE</button>
    <button class="tgl-btn on" id="sound-toggle" style="background:var(--blue)" onclick="toggleBtn(this)">SFX</button>
    <button class="tgl-btn off" id="ambient-toggle" style="background:var(--lavender)" onclick="toggleAmbient(this)">AMB</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<div class="search-bar" id="search-bar">
  <div class="search-inner">
    <input class="search-input" id="search-input" type="text" placeholder="Search skills, hooks, MCP, agents, memory, configs..." oninput="onSearch()" autocomplete="off">
    <div class="search-meta"><span id="search-count"></span><span>ESC to close // ENTER to open first result</span></div>
    <div class="search-results" id="search-results"></div>
  </div>
</div>

<script>
// Auto-detect live server
(function() {
  var x = new XMLHttpRequest();
  x.open('GET', 'http://localhost:3200/api/health', false);
  try { x.timeout = 1000; x.send(); if (x.status === 200) { window.HUD_LIVE = true; } } catch(e) {}
})();
const D=${escJ(D)};
window._D=D;
window._HOME=${escJ(os.homedir())};
const VIZ=${JSON.stringify({
  skills: skills.map(s => ({ name: s.name, desc: (s.desc||'').slice(0,80), ver: s.ver, ctx: s.ctx })),
  agents: agents.map(a => ({ name: a.name, desc: (a.desc||'').slice(0,80) })),
  mcp: mcp.map(m => ({ name: m.name, cmd: m.cmd, args: m.args.join(' ').slice(0,60), serverType: m.serverType, envCount: m.envCount })),
  hooks: hooks.map(h => ({ ev: h.ev, matcher: h.matcher, type: h.type, cmd: (h.cmd||'').slice(0,60), async: h.async })),
  plugins: plugins.map(p => ({ id: p.id, on: p.on })),
  env: Object.keys(env),
  mem: mem.map(m => ({ name: m.name, proj: m.proj, type: m.type })),
})};

function nav(id,el){
  document.querySelectorAll('.sec').forEach(function(s){s.classList.remove('on')});
  document.getElementById('s-'+id).classList.add('on');
  document.querySelectorAll('.nb').forEach(function(b){b.classList.remove('act')});
  el.classList.add('act');
  close_();
  try{localStorage.setItem('hud-tab',id)}catch(e){}
  // In comms/about/viz mode, hide the detail panel column entirely
  if (id === 'comms' || id === 'about' || id === 'viz' || id === 'q' || id === 'replicator') {
    document.getElementById('mc').classList.remove('open');
    document.getElementById('dp').style.display = 'none';
  } else {
    document.getElementById('dp').style.display = '';
  }
}

function open_(k){
  var d=D[k];if(!d)return;
  document.getElementById('dp-tp').textContent=d.tp;
  document.getElementById('dp-t').textContent=d.t;
  document.getElementById('dp-m').textContent=d.m;
  document.getElementById('dp-b').innerHTML=md(d.b);

  // Render action buttons
  var ab=document.getElementById('dp-actions');
  if(d.actions&&d.actions.length){
    ab.style.display='flex';
    ab.innerHTML=d.actions.map(function(a){
      return '<button class="act-btn" data-icon="'+a.icon+'" onclick="doAction(this)" data-cmd="'+esc(a.cmd)+'">'+a.label+'</button>';
    }).join('');
  } else {
    ab.style.display='none';
    ab.innerHTML='';
  }

  // Close editor if switching items
  var editor = document.getElementById('hud-editor');
  if (editor && editor.classList.contains('active')) {
    editor.classList.remove('active');
    document.getElementById('dp-b').style.display = '';
    document.getElementById('dp-actions').style.display = '';
    currentEditPath = '';
  }

  document.getElementById('mc').classList.add('open');
  document.querySelectorAll('.sel').forEach(function(r){r.classList.remove('sel')});
  var row=document.querySelector('[data-k="'+k+'"]') || document.querySelector('[data-mcp="'+k.replace('m:','')+'"]');
  if(row)row.classList.add('sel');
}

function close_(){
  document.getElementById('mc').classList.remove('open');
  document.querySelectorAll('.sel').forEach(function(r){r.classList.remove('sel')});
}

document.addEventListener('keydown',function(e){if(e.key==='Escape')close_()});

function doAction(btn){
  var cmd=btn.getAttribute('data-cmd');
  var icon=btn.getAttribute('data-icon');
  beepAction();

  if(icon==='EDIT'){
    var filePath = cmd.replace(/^open\\s+/, '');
    openEditor(filePath);
    return;
  }

  if(icon==='RUN'){
    navigator.clipboard.writeText(cmd).then(function(){
      toast('Copied: '+cmd);
    });
  } else if(icon==='DEL'){
    var currentKey = document.querySelector('.r.sel')?document.querySelector('.r.sel').getAttribute('data-k'):'';
    hudConfirm('Delete this item permanently?\\n\\n' + cmd, 'DELETE').then(function(ok){
      if(!ok) return;
      if(window.HUD_LIVE){
        if(cmd.startsWith('mcp:')){
          var mcpName=cmd.slice(4);
          fetch('/api/settings-update',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({type:'remove-mcp',name:mcpName})
          }).then(function(r){return r.json()}).then(function(d){
            if(d.ok){toast('REMOVED: '+mcpName);close_();_removeRow('m:'+mcpName);}
            else toast('ERROR: '+d.error);
          });
        } else if(cmd.startsWith('hook:')){
          var hookIdx=parseInt(cmd.slice(5));
          fetch('/api/settings-update',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({type:'remove-hook',index:hookIdx})
          }).then(function(r){return r.json()}).then(function(d){
            if(d.ok){toast('HOOK REMOVED');close_();_removeRow(currentKey);}
            else toast('ERROR: '+d.error);
          });
        } else {
          fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path:cmd})
          }).then(function(r){return r.json()}).then(function(d){
            if(d.ok){toast('DELETED');close_();_removeRow(currentKey);}
            else toast('ERROR: '+d.error);
          });
        }
      } else {
        navigator.clipboard.writeText('rm -rf '+cmd).then(function(){
          toast('Copied delete command');
        });
      }
    });
  } else if(icon==='INSTALL'){
    if(cmd.startsWith('mkinstall:')){
      var mkId=cmd.slice('mkinstall:'.length);
      var mkd=window._D&&window._D['mk:'+mkId];
      if(!mkd||!mkd._install){toast('Cannot find marketplace item');return;}
      installMarketItem(btn,mkId,mkd._install.type,mkd._install.sourcePath,mkd._install.mcpConfig?JSON.stringify(mkd._install.mcpConfig):'');
      return;
    }
    var parts=cmd.split(':');
    var itype=parts[1], iname=parts.slice(2).join(':');
    var d2=window._D&&window._D['sugg:'+itype+':'+iname];
    if(!d2){toast('Cannot find suggestion data');return;}
    if(itype==='skill') installSuggestSkill(btn,iname,d2.b);
    else if(itype==='agent') installSuggestAgent(btn,iname,d2.b);
    else if(itype==='mcp'&&d2._cfg) installSuggestMcp(btn,iname,JSON.stringify(d2._cfg));
    else if(itype==='hook'&&d2._hook) installSuggestHook(btn,d2._hook.event,d2._hook.matcher,d2._hook.cmd);
    else toast('Use the INSTALL button on the card');
  } else {
    navigator.clipboard.writeText(cmd).then(function(){
      toast('Copied to clipboard');
    });
  }
}

function toast(msg){
  var t=document.getElementById('toast');
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer=setTimeout(function(){t.classList.remove('show')},2000);
}

function hlJson(s) {
  var h = s.replace(/&/g,'&amp;').replace(new RegExp('<','g'),'&lt;').replace(new RegExp('>','g'),'&gt;');
  h = h.replace(new RegExp('"([^"]*)"','g'), '<span class="str">"$1"</span>');
  h = h.replace(new RegExp('<span class="str">"([^"]*)"</span>(\\\\s*):','g'), '<span class="key">"$1"</span>$2:');
  h = h.replace(new RegExp('\\\\b(true|false)\\\\b','g'), '<span class="bool">$1</span>');
  h = h.replace(new RegExp('\\\\b(null)\\\\b','g'), '<span class="kw">$1</span>');
  h = h.replace(new RegExp('\\\\b(-?\\\\d+\\\\.?\\\\d*)\\\\b','g'), '<span class="num">$1</span>');
  return h;
}

function hlCode(s, lang) {
  var h = s.replace(/&/g,'&amp;').replace(new RegExp('<','g'),'&lt;').replace(new RegExp('>','g'),'&gt;');
  if (lang === 'json' || lang === '') {
    if (h.trimStart().startsWith('{') || h.trimStart().startsWith('[')) {
      return hlJson(s);
    }
  }
  h = h.replace(new RegExp('(\\\\/\\\\/.*$)','gm'), '<span class="cmt">$1</span>');
  h = h.replace(new RegExp('(#.*$)','gm'), '<span class="cmt">$1</span>');
  h = h.replace(new RegExp('"([^"]*)"','g'), '<span class="str">"$1"</span>');
  h = h.replace(new RegExp("'([^']*)'","g"), "<span class='str'>'$1'</span>");
  h = h.replace(new RegExp('\\\\b(function|const|let|var|return|if|else|for|while|import|export|from|async|await|class|new|this|type|interface)\\\\b','g'), '<span class="kw">$1</span>');
  h = h.replace(new RegExp('\\\\b(true|false|null|undefined|nil)\\\\b','g'), '<span class="bool">$1</span>');
  h = h.replace(new RegExp('\\\\b(\\\\d+\\\\.?\\\\d*)\\\\b','g'), '<span class="num">$1</span>');
  return h;
}

function md(t) {
  if (!t) return '<p style="color:var(--faint)">No content.</p>';

  // Detect if content is pure JSON (from hook/MCP configs)
  const trimmed = t.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return '<pre data-lang="json"><code>' + hlJson(trimmed) + '</code></pre>';
    } catch(e) {}
  }

  // Extract fenced code blocks from RAW text BEFORE escaping
  const codeBlocks = [];
  const BT = String.fromCharCode(96);
  const fenceRx = new RegExp(BT+BT+BT+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT+BT+BT, 'g');
  var raw = t.replace(fenceRx, function(_, lang, code) {
    var idx = codeBlocks.length;
    var highlighted = hlCode(code.replace(new RegExp('\\\\n$'), ''), lang || '');
    codeBlocks.push('<pre data-lang="' + (lang || 'code') + '"><code>' + highlighted + '</code></pre>');
    return '%%CODEBLOCK' + idx + '%%';
  });

  // Now escape the remaining text (code blocks are already safe as placeholders)
  var h = esc(raw);

  // Inline code
  const inlineRx = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
  h = h.replace(inlineRx, '<code>$1</code>');

  // Headers
  h = h.replace(new RegExp('^### (.+)$','gm'), '<h3>$1</h3>');
  h = h.replace(new RegExp('^## (.+)$','gm'), '<h2>$1</h2>');
  h = h.replace(new RegExp('^# (.+)$','gm'), '<h1>$1</h1>');

  // Bold and italic
  h = h.replace(new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*','g'), '<strong>$1</strong>');
  h = h.replace(new RegExp('\\\\*(.+?)\\\\*','g'), '<em>$1</em>');

  // Tables
  h = h.replace(new RegExp('^\\\\|(.+)\\\\|$','gm'), function(line) {
    if (new RegExp('^\\\\|[\\\\s\\\\-:|]+\\\\|$').test(line)) return '%%TABLESEP%%';
    var cells = line.split('|').filter(function(c){return c.trim()});
    return '<tr>' + cells.map(function(c){return '<td>' + c.trim() + '</td>'}).join('') + '</tr>';
  });
  h = h.replace(new RegExp('%%TABLESEP%%\\\\n?','g'), '');
  h = h.replace(new RegExp('((?:<tr>.*</tr>\\\\n?)+)','g'), '<table>$1</table>');

  // Lists
  h = h.replace(new RegExp('^- (.+)$','gm'), '<li>$1</li>');
  h = h.replace(new RegExp('((?:<li>.*</li>\\\\n?)+)','g'), function(m){return '<ul>' + m + '</ul>'});

  // Numbered lists
  h = h.replace(new RegExp('^\\\\d+\\\\. (.+)$','gm'), '<li>$1</li>');

  // Blockquotes
  h = h.replace(new RegExp('^&gt; (.+)$','gm'), '<blockquote>$1</blockquote>');

  // Paragraphs (lines that aren't already wrapped)
  h = h.replace(new RegExp('^(?!<[huplbt]|</|%%CODE)(.+)$','gm'), '<p>$1</p>');
  h = h.replace(new RegExp('<p></p>','g'), '');

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    h = h.replace('%%CODEBLOCK' + i + '%%', block);
  });

  return h;
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/"/g,'&quot;');
}

// ═══ LCARS SOUNDS (Web Audio API, no files) ═══
var audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function lcarsBeep(freq, dur) {
  if (!isToggleOn('sound-toggle')) return;
  var ctx = getAudio();
  _chirp(ctx, freq, ctx.currentTime, dur);
}

// Schedule a single sine chirp on existing AudioContext (no guard — callers handle that)
function _chirp(ctx, freq, start, dur, vol) {
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = 'sine'; osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol || 0.09, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.start(start); osc.stop(start + dur);
}

function toggleBtn(btn) {
  var isOn = btn.classList.contains('on');
  btn.classList.toggle('on', !isOn);
  btn.classList.toggle('off', isOn);
  lcarsBeep(isOn ? 600 : 1200, 0.06);
}

/* ═══ AMBIENT NOISE ENGINE ═══
   Synthesized Star Trek engine hum — no audio files.
   Layers: brown noise base + 60Hz warp oscillator + harmonics + LFO breathing */
var _amb = null;
var _ambVol = 0.15;
var _ambVolMap = { off: 0, low: 0.08, medium: 0.18, high: 0.38 };

function _makeBrownNoise(ctx) {
  var sr = ctx.sampleRate;
  var buf = ctx.createBuffer(2, sr * 8, sr); // 8s stereo loop
  for (var ch = 0; ch < 2; ch++) {
    var d = buf.getChannelData(ch);
    var last = 0;
    for (var i = 0; i < d.length; i++) {
      var w = Math.random() * 2 - 1;
      d[i] = (last + 0.02 * w) / 1.02;
      last = d[i];
      d[i] *= 3.2;
    }
  }
  return buf;
}

function startAmbient(vol) {
  if (_amb) return;
  var ctx = getAudio();
  _ambVol = vol !== undefined ? vol : _ambVol;

  // Brown noise
  var noise = ctx.createBufferSource();
  noise.buffer = _makeBrownNoise(ctx);
  noise.loop = true;

  // Low-pass — roll off anything above 300Hz for that muffled hull rumble
  var lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass'; lpf.frequency.value = 280; lpf.Q.value = 0.7;

  // Bandpass resonance — emphasise the 60-80Hz warp core region
  var bpf = ctx.createBiquadFilter();
  bpf.type = 'bandpass'; bpf.frequency.value = 72; bpf.Q.value = 3.5;

  var noiseGain = ctx.createGain(); noiseGain.gain.value = 0.55;

  // Warp core oscillators — 60Hz fundamental + 2nd & 3rd harmonics slightly detuned
  function makeOsc(freq, type, gain) {
    var o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    var g = ctx.createGain(); g.gain.value = gain;
    o.connect(g); return { osc: o, gain: g };
  }
  var o1 = makeOsc(60.3, 'sine', 0.28);
  var o2 = makeOsc(120.1, 'sine', 0.10);
  var o3 = makeOsc(180.7, 'sine', 0.04);
  var o4 = makeOsc(59.7, 'sine', 0.12); // slight detune for beating effect

  // LFO — 0.06Hz slow breathing of the engines
  var lfo = ctx.createOscillator();
  lfo.type = 'sine'; lfo.frequency.value = 0.06;
  var lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.04;
  lfo.connect(lfoAmt);

  // Master gain
  var master = ctx.createGain(); master.gain.value = _ambVol;
  lfoAmt.connect(master.gain); // LFO modulates master gain

  // Wire
  noise.connect(lpf); lpf.connect(bpf); bpf.connect(noiseGain);
  noiseGain.connect(master);
  o1.gain.connect(master); o2.gain.connect(master);
  o3.gain.connect(master); o4.gain.connect(master);
  master.connect(ctx.destination);

  // Start
  noise.start(); lfo.start();
  [o1, o2, o3, o4].forEach(function(o) { o.osc.start(); });

  _amb = { noise: noise, lfo: lfo, oscs: [o1, o2, o3, o4], master: master, ctx: ctx };
  document.getElementById('ambient-toggle').classList.replace('off','on');
}

function stopAmbient() {
  if (!_amb) return;
  var t = _amb.ctx.currentTime;
  _amb.master.gain.setTargetAtTime(0, t, 0.8); // fade out
  setTimeout(function() {
    try { _amb.noise.stop(); _amb.lfo.stop(); _amb.oscs.forEach(function(o){o.osc.stop();}); } catch(e){}
    _amb = null;
  }, 3000);
  var btn = document.getElementById('ambient-toggle');
  if (btn) btn.classList.replace('on','off');
}

function onAmbientChange() {
  var val = getSelectValue('cfg-ambient-wrap');
  localStorage.setItem('hud-ambient', val);
  var vol = _ambVolMap[val] || 0;
  if (val === 'off') {
    stopAmbient();
  } else if (_amb) {
    _ambVol = vol;
    _amb.master.gain.setTargetAtTime(vol, _amb.ctx.currentTime, 1.2);
    document.getElementById('ambient-toggle').classList.replace('off','on');
  } else {
    _ambVol = vol;
    startAmbient(vol);
  }
}

function toggleAmbient(btn) {
  if (_amb) {
    stopAmbient();
    selectLcarsOptionByValue('cfg-ambient-wrap', 'off');
    localStorage.setItem('hud-ambient', 'off');
  } else {
    var saved = localStorage.getItem('hud-ambient');
    var vol = _ambVolMap[saved] || _ambVolMap['low'];
    _ambVol = vol;
    startAmbient(vol);
    var level = (saved && saved !== 'off') ? saved : 'low';
    selectLcarsOptionByValue('cfg-ambient-wrap', level);
    localStorage.setItem('hud-ambient', level);
  }
}

function getSelectValue(id) {
  var el = document.getElementById(id);
  var sel = el && el.querySelector('.lcars-option.selected');
  return sel ? sel.getAttribute('data-value') : null;
}

function selectLcarsOptionByValue(id, val) {
  var el = document.getElementById(id);
  if (!el) return;
  el.querySelectorAll('.lcars-option').forEach(function(opt) {
    var isMatch = opt.getAttribute('data-value') === val;
    opt.classList.toggle('selected', isMatch);
    if (isMatch) {
      var btn = el.querySelector('.lcars-select-btn span');
      if (btn) btn.textContent = opt.querySelector('.opt-label').textContent;
    }
  });
}

function isToggleOn(id) {
  var btn = document.getElementById(id);
  return btn && btn.classList.contains('on');
}

var _bootComplete = false;
function _checkAmbPending() {
  if (window._ambPending) {
    var vol = _ambVolMap[window._ambPending] || _ambVolMap['low'];
    _ambVol = vol;
    startAmbient(vol);
    window._ambPending = null;
  }
}
// TactileInputAcknowledge — canonical two-tone ascending panel tap
function beepNav() {
  _checkAmbPending();
  if (!_bootComplete || !isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 1040, t,        0.065);
  _chirp(ctx, 1480, t + 0.055, 0.075);
}
// Open/expand — triple ascending (panels opening)
function beepOpen() {
  if (!_bootComplete || !isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 800,  t,        0.055);
  _chirp(ctx, 1200, t + 0.05, 0.055);
  _chirp(ctx, 1800, t + 0.10, 0.065);
}
// Generic action — single clean mid tone
function beepAction() {
  if (!_bootComplete || !isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 1100, t, 0.06);
}
// Transmit/send — rising two-tone
function beepSend() {
  if (!_bootComplete || !isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 660, t,       0.055, 0.07);
  _chirp(ctx, 990, t + 0.06, 0.09, 0.09);
}
// Incoming — soft single descending
function beepReceive() {
  if (!isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 880, t,       0.06, 0.07);
  _chirp(ctx, 550, t + 0.07, 0.10, 0.05);
}
// TactileInputNegativeAcknowledge — descending negative feedback
function beepError() {
  if (!isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 800, t,       0.08, 0.10);
  _chirp(ctx, 440, t + 0.09, 0.14, 0.08);
}
// Ready — canonical three-tone rising (boot complete, system ready)
function beepReady() {
  if (!isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 880,  t,        0.10, 0.08);
  _chirp(ctx, 1100, t + 0.11, 0.10, 0.09);
  _chirp(ctx, 1320, t + 0.22, 0.16, 0.10);
}
// Alert — three-tone alert pattern
function beepAlert() {
  if (!isToggleOn('sound-toggle')) return;
  var ctx = getAudio(), t = ctx.currentTime;
  _chirp(ctx, 880,  t,        0.08);
  _chirp(ctx, 1320, t + 0.10, 0.08);
  _chirp(ctx, 880,  t + 0.20, 0.12);
}

// Patch nav and open_ to add sounds
var _origNav = nav;
nav = function(id, el) { beepNav(); _origNav(id, el); };
var _origOpen = open_;
open_ = function(k) { beepOpen(); _origOpen(k); };

// Pre-load voices
if (window.speechSynthesis) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = function(){ speechSynthesis.getVoices(); };
}

// ═══ WAVEFORM VISUALIZER ═══
var wfEl = null;
var wfBars = 12;
var wfInterval = null;

function initWaveform() {
  wfEl = document.getElementById('waveform');
  if (!wfEl) return;
  wfEl.innerHTML = '';
  for (var i = 0; i < wfBars; i++) {
    var bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = '4px';
    wfEl.appendChild(bar);
  }
}

function showWaveform(mode) {
  if (!wfEl) initWaveform();
  var label = document.getElementById('wf-label');
  wfEl.classList.remove('hidden', 'listening', 'speaking');
  label.classList.remove('hidden', 'listening', 'speaking');
  wfEl.classList.add(mode);
  label.classList.add(mode);
  label.textContent = mode === 'listening' ? 'LISTENING' : 'SPEAKING';
  clearInterval(wfInterval);
  wfInterval = setInterval(function() {
    var bars = wfEl.querySelectorAll('.bar');
    for (var i = 0; i < bars.length; i++) {
      bars[i].style.height = (4 + Math.random() * 18) + 'px';
    }
  }, 80);
}

function hideWaveform() {
  clearInterval(wfInterval);
  if (wfEl) {
    wfEl.classList.add('hidden');
    wfEl.classList.remove('listening', 'speaking');
    var bars = wfEl.querySelectorAll('.bar');
    for (var i = 0; i < bars.length; i++) bars[i].style.height = '4px';
  }
  var label = document.getElementById('wf-label');
  if (label) label.classList.add('hidden');
  var vb = document.getElementById('voice-toggle');
  if (vb) vb.style.animation = 'none';
}

// ═══ SPEECH RECOGNITION (Mic Input) ═══
var recognition = null;
var micActive = false;

function toggleMic() {
  if (micActive) {
    stopMic();
  } else {
    startMic();
  }
}

function startMic() {
  // Never start listening while the computer is speaking
  if (computerSpeaking) return;

  // Stop any existing recognition before starting fresh
  if (recognition) {
    try { recognition.abort(); } catch(e) {}
    recognition = null;
  }

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('Speech recognition not supported in this browser');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  micActive = true;
  var vb = document.getElementById('voice-toggle');
  if (vb) vb.style.animation = 'mic-pulse 1s infinite';
  showWaveform('listening');
  beepAction();

  // Show listening indicator in the waveform label, don't touch the response panel
  var wfLabel = document.getElementById('wf-label');
  if (wfLabel) {
    wfLabel.textContent = 'LISTENING';
    wfLabel.classList.remove('hidden');
  }

  var input = document.getElementById('cb-in');
  var finalTranscript = '';

  recognition.onresult = function(e) {
    var interim = '';
    for (var i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }

    var fullText = (finalTranscript + interim).trim();

    // Echo filtering: if computer is speaking, check if this is echo
    if (computerSpeaking && fullText) {
      var heard = fullText.toLowerCase().replace(new RegExp('[^a-z\\\\s]','g'), '').trim();
      var words = heard.split(new RegExp('\\\\s+'));

      // Check if what we heard is a substring of what was spoken (echo)
      if (lastSpokenText && lastSpokenText.indexOf(heard) !== -1) {
        return; // Ignore echo
      }

      // If user says 2+ words that are NOT in the spoken text, it is an interrupt
      var newWords = words.filter(function(w) { return w.length > 2 && lastSpokenText.indexOf(w) === -1; });
      if (newWords.length >= 2) {
        // Intentional interrupt, stop the computer
        stopSpeaking();
        toast('INTERRUPTED');
      } else {
        return; // Likely echo, ignore
      }
    }

    input.value = fullText;
  };

  recognition.onend = function() {
    micActive = false;
    hideWaveform();
    var vb = document.getElementById('voice-toggle');
    if (vb) vb.style.animation = '';
    if (finalTranscript.trim()) {
      beepSend();
      sendGlobal();
    } else {
      // No speech detected but voice mode still on, restart after a short pause
      // Don't restart if a chat is in progress (waiting for response)
      if (isToggleOn('voice-toggle') && !computerSpeaking && !_chatInProgress) {
        setTimeout(function() {
          if (isToggleOn('voice-toggle') && !micActive && !computerSpeaking && !_chatInProgress) {
            startListening();
          }
        }, 500);
      }
    }
  };

  recognition.onerror = function(e) {
    micActive = false;
    hideWaveform();
    var vb = document.getElementById('voice-toggle');
    if (vb) vb.style.animation = '';
    if (e.error !== 'no-speech') {
      toast('Mic error: ' + e.error);
    }
  };

  recognition.start();
}

function stopMic() {
  if (recognition) {
    recognition.stop();
  }
  micActive = false;
  hideWaveform();
}

// Override speak: ElevenLabs if available, else Web Speech API
var currentAudio = null;

speak = function(text) {
  if (!isToggleOn('voice-toggle')) return;

  // Clean text for speech
  var short = text.replace(new RegExp('[#*_\\\\[\\\\]'+String.fromCharCode(96)+']','g'), '').replace(new RegExp('\\\\n','g'), ' ').trim();
  if (!short) return;

  // ElevenLabs mode (server-side key OR client-side config)
  if (window.HUD_ELEVENLABS) {
    speakElevenLabs(short);
    return;
  }

  // Fallback: Web Speech API
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  var firstSentence = short.match(/^[^.!?]+[.!?]/);
  var toSpeak = firstSentence ? firstSentence[0] : short.slice(0, 200);
  var u = new SpeechSynthesisUtterance(toSpeak);
  var voices = speechSynthesis.getVoices();
  var preferred = voices.find(function(v){return v.name.includes('Samantha')})
    || voices.find(function(v){return v.name.includes('Karen')})
    || voices.find(function(v){return v.name.includes('Victoria')})
    || voices.find(function(v){return v.name.includes('Fiona')})
    || voices.find(function(v){return v.lang.startsWith('en') && v.name.toLowerCase().includes('female')})
    || voices.find(function(v){return v.lang.startsWith('en-')});
  if (preferred) u.voice = preferred;
  u.rate = 0.95;
  u.pitch = 1.1;
  u.onstart = function() { showWaveform('speaking'); };
  u.onend = function() { hideWaveform(); };
  u.onerror = function() { hideWaveform(); };
  speechSynthesis.speak(u);
};

function speakElevenLabs(text) {
  stopSpeaking();
  showWaveform('speaking');

  fetch('/api/tts', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ text: text.slice(0, 1000), voiceId: window.HUD_ELEVEN_VOICE, apiKey: window.HUD_ELEVEN_KEY }),
  }).then(function(r) {
    if (!r.ok) throw new Error('TTS failed');
    return r.blob();
  }).then(function(blob) {
    var url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.onended = function() {
      hideWaveform();
      URL.revokeObjectURL(url);
      currentAudio = null;
    };
    currentAudio.onerror = function() {
      hideWaveform();
      currentAudio = null;
    };
    currentAudio.play();
  }).catch(function(e) {
    hideWaveform();
    console.error('ElevenLabs TTS error:', e);
  });
}

// ═══ IN-HUD EDITOR ═══
var currentEditPath = '';

function openEditor(filePath) {
  var textarea = document.getElementById('editor-textarea');
  var dpBody = document.getElementById('dp-b');
  var editor = document.getElementById('hud-editor');
  var currentKey = document.querySelector('.r.sel') || document.querySelector('.mcp-card.sel');
  var key = currentKey ? (currentKey.getAttribute('data-k') || currentKey.getAttribute('data-mcp') && 'm:'+currentKey.getAttribute('data-mcp')) : null;
  var rawContent = key && D[key] ? D[key].b : '';

  textarea.value = rawContent;
  currentEditPath = filePath;
  document.getElementById('editor-path').textContent = filePath;

  // Detect language
  var ext = filePath.split('.').pop().toLowerCase();
  var langMap = {md:'MARKDOWN',json:'JSON',ts:'TYPESCRIPT',js:'JAVASCRIPT',yaml:'YAML',yml:'YAML'};
  document.getElementById('editor-lang').textContent = langMap[ext] || ext.toUpperCase();

  dpBody.style.display = 'none';
  document.getElementById('dp-actions').style.display = 'none';
  editor.classList.add('active');

  onEditorInput();
  textarea.focus();
  beepOpen();
}

function onEditorInput() {
  var textarea = document.getElementById('editor-textarea');
  var text = textarea.value;
  var lines = text.split('\\n');
  var lineCount = lines.length;

  // Update line count display
  document.getElementById('editor-line-count').textContent = lineCount + ' LINES';

  // Render gutter
  var gutter = document.getElementById('editor-gutter');
  var gutterHtml = '';
  for (var i = 1; i <= lineCount; i++) {
    gutterHtml += '<span>' + i + '</span>';
  }
  gutter.innerHTML = gutterHtml;

  // Render syntax highlight overlay
  var hl = document.getElementById('editor-highlight');
  hl.innerHTML = highlightEditor(text, currentEditPath);

  // Sync heights
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
  hl.style.height = textarea.scrollHeight + 'px';

  updateActiveLine();
}

function syncEditorScroll() {
  var textarea = document.getElementById('editor-textarea');
  var hl = document.getElementById('editor-highlight');
  var gutter = document.getElementById('editor-gutter');
  var wrap = document.getElementById('editor-wrap');
  hl.style.transform = 'translateY(-' + wrap.scrollTop + 'px)';
  gutter.style.transform = 'translateY(-' + wrap.scrollTop + 'px)';
}

function updateActiveLine() {
  var textarea = document.getElementById('editor-textarea');
  var pos = textarea.selectionStart;
  var lineNum = textarea.value.substring(0, pos).split('\\n').length;
  var spans = document.getElementById('editor-gutter').querySelectorAll('span');
  for (var i = 0; i < spans.length; i++) {
    spans[i].classList.toggle('active', i === lineNum - 1);
  }
}

function highlightEditor(text, filePath) {
  var ext = filePath.split('.').pop().toLowerCase();
  var h;
  if (ext === 'json') {
    h = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  } else {
    h = esc(text);
  }

  if (ext === 'json') {
    // JSON highlighting — wrap strings first, then re-wrap keys (avoids corrupting span attrs)
    h = h.replace(new RegExp('"([^"]*)"','g'), '<span class="hl-string">"$1"</span>');
    h = h.replace(new RegExp('<span class="hl-string">"([^"]*)"</span>(\\\\s*):','g'), '<span class="hl-key">"$1"</span>$2:');
    h = h.replace(new RegExp('\\\\b(true|false)\\\\b','g'), '<span class="hl-bool">$1</span>');
    h = h.replace(new RegExp('\\\\b(null)\\\\b','g'), '<span class="hl-keyword">$1</span>');
    h = h.replace(new RegExp('\\\\b(-?\\\\d+\\\\.?\\\\d*)\\\\b','g'), '<span class="hl-number">$1</span>');
    return h;
  }

  // Markdown highlighting (default for .md files and skill content)
  // Frontmatter
  h = h.replace(new RegExp('^(---[\\\\s\\\\S]*?---)','m'), '<span class="hl-frontmatter">$1</span>');

  // Headers
  h = h.replace(new RegExp('^(#{1,6} .+)$','gm'), '<span class="hl-header">$1</span>');

  // Bold
  h = h.replace(new RegExp('(\\\\*\\\\*[^*]+\\\\*\\\\*)','g'), '<span class="hl-bold">$1</span>');

  // Inline code
  var BT = String.fromCharCode(96);
  h = h.replace(new RegExp(BT+'([^'+BT+']+)'+BT,'g'), '<span class="hl-code">'+BT+'$1'+BT+'</span>');

  // Bullet points
  h = h.replace(new RegExp('^(- )','gm'), '<span class="hl-bullet">- </span>');
  h = h.replace(new RegExp('^(\\\\d+\\\\. )','gm'), '<span class="hl-bullet">$1</span>');

  // Comments / blockquotes
  h = h.replace(new RegExp('^(&gt; .+)$','gm'), '<span class="hl-comment">$1</span>');

  return h;
}

function closeEditor() {
  document.getElementById('hud-editor').classList.remove('active');
  document.getElementById('dp-b').style.display = '';
  document.getElementById('dp-actions').style.display = '';
  currentEditPath = '';
  beepNav();
}

function saveFile() {
  if (!currentEditPath) return;
  var content = document.getElementById('editor-textarea').value;

  if (window.HUD_LIVE) {
    fetch('/api/save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: currentEditPath, content: content}),
    }).then(function(r){ return r.json() }).then(function(d){
      if (d.ok) {
        toast('SAVED: ' + currentEditPath.split('/').pop());
        beepAction();
        // Update the in-memory data
        var currentKey = document.querySelector('.r.sel');
        var key = currentKey ? currentKey.getAttribute('data-k') : null;
        if (key && D[key]) {
          D[key].b = content;
        }
        closeEditor();
        // Re-render the detail view with updated content
        if (key) open_(key);
      } else {
        toast('SAVE FAILED: ' + d.error);
      }
    }).catch(function(e){
      toast('SAVE ERROR: ' + e.message);
    });
  } else {
    toast('SAVE REQUIRES LIVE MODE (node src/server.js)');
  }
}

// ═══ UNIFIED VOICE TOGGLE ═══
function toggleVoice(btn) {
  var wasOn = btn.classList.contains('on');
  btn.classList.toggle('on', !wasOn);
  btn.classList.toggle('off', wasOn);
  lcarsBeep(wasOn ? 600 : 1200, 0.06);

  if (!wasOn) {
    // Voice mode ON, start listening immediately
    toast('VOICE MODE ACTIVE');
    startListening();
  } else {
    // Voice mode OFF
    stopMic();
    stopSpeaking();
  }
}

function startListening() {
  if (!isToggleOn('voice-toggle')) return;
  if (micActive) return;
  startMic();
}

// Track if computer is speaking (any engine)
var computerSpeaking = false;
var lastSpokenText = '';

// Auto-restart listening after computer finishes speaking
var _origSpeakForLoop = speak;
var _speechStartedAt = 0;
speak = function(text) {
  computerSpeaking = true;
  _speechStartedAt = Date.now();
  lastSpokenText = text.toLowerCase().replace(new RegExp('[^a-z\\\\s]','g'), '').trim();

  // Stop mic immediately so it doesn't hear the computer
  if (micActive) stopMic();

  _origSpeakForLoop(text);

  // Safety: clear computerSpeaking after 30s max
  var speechSafety = setTimeout(function() {
    computerSpeaking = false;
    lastSpokenText = '';
  }, 30000);

  // Poll for speech end (works for both browser TTS and ElevenLabs)
  // Wait at least 1s before checking, so async audio has time to start
  var checkDone = setInterval(function() {
    // Don't check until audio has had time to start playing
    if (Date.now() - _speechStartedAt < 1000) return;

    var browserSpeaking = window.speechSynthesis && speechSynthesis.speaking;
    var elevenPlaying = currentAudio && !currentAudio.paused && !currentAudio.ended;
    if (!browserSpeaking && !elevenPlaying) {
      clearInterval(checkDone);
      clearTimeout(speechSafety);
      computerSpeaking = false;
      lastSpokenText = '';
      // Wait 2s after speech ends to let echo fully dissipate
      setTimeout(function() {
        if (isToggleOn('voice-toggle') && !micActive && !computerSpeaking) {
          startListening();
        }
      }, 2000);
    }
  }, 300);
};

// Interrupt speech on any user action
function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (window.speechSynthesis && speechSynthesis.speaking) {
    speechSynthesis.cancel();
  }
  hideWaveform();
}

// Click waveform to stop
document.addEventListener('click', function(e) {
  if (e.target.closest('.waveform') || e.target.closest('.waveform-label')) {
    stopSpeaking();
  }
});

// Typing stops speech
document.getElementById('cb-in').addEventListener('input', stopSpeaking);

// ═══ CLAUDE CODE ORCHESTRATION ═══
function sendClaude(text) {
  var input = document.getElementById('cb-in');
  input.value = '';
  beepSend();

  addMsg('user', text);

  var cr = document.getElementById('cr');
  var crBody = document.getElementById('cr-body');
  crBody.innerHTML = lcarsScanHTML();
  cr.classList.add('visible');

  var btn = document.getElementById('cb-send');
  btn.disabled = true;
  btn.textContent = '...';

  var fullText = '';
  var streamStarted = false;

  fetch('/api/claude', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ message: text }),
  }).then(function(res) {
    if (!res.ok) {
      return res.json().then(function(e) { throw new Error(e.error || 'Claude Code failed'); });
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          _chatInProgress = false;
          btn.disabled = false;
          btn.textContent = 'SEND';
          beepReceive();
          showLogButton();
          addMsg('ai', fullText);
          speak(fullText);
          return;
        }

        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('data: ')) {
            var data = line.slice(6).trim();
            try {
              var evt = JSON.parse(data);
              if (evt.type === 'text') {
                fullText += evt.text;
                if (!streamStarted) {
                  streamStarted = true;
                  crBody.innerHTML = '<div id="cr-stream"></div>';
                }
                var streamEl = document.getElementById('cr-stream');
                if (streamEl) {
                  streamEl.innerHTML = md(fullText);
                  cr.scrollTop = cr.scrollHeight;
                }
              } else if (evt.type === 'tool') {
                // Silently track, don't show execution details
              } else if (evt.type === 'status') {
                // Update scan text if still showing
                var scanText = document.querySelector('.lcars-scan-text');
                if (scanText) scanText.textContent = evt.text;
              }
            } catch(e) {}
          }
        }
        return pump();
      });
    }

    return pump();
  }).catch(function(e) {
    _chatInProgress = false;
    beepError();
    crBody.innerHTML = '<span style="color:var(--red)">ERROR: ' + esc(e.message) + '</span>';
    addMsg('err', 'COMMS ERROR: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'SEND';
  });
}

// ═══ LCARS CUSTOM SELECTS ═══
function toggleLcarsSelect(id) {
  var wrap = document.getElementById(id);
  var btn = wrap.querySelector('.lcars-select-btn');
  var dd = wrap.querySelector('.lcars-dropdown');
  var isOpen = dd.classList.contains('open');
  // Close all others
  document.querySelectorAll('.lcars-dropdown.open').forEach(function(d){d.classList.remove('open')});
  document.querySelectorAll('.lcars-select-btn.open').forEach(function(b){b.classList.remove('open')});
  if (!isOpen) {
    dd.classList.add('open');
    btn.classList.add('open');
    beepNav();
  }
}

function selectLcarsOption(id, opt) {
  var wrap = document.getElementById(id);
  wrap.querySelectorAll('.lcars-option').forEach(function(o){o.classList.remove('selected')});
  opt.classList.add('selected');
  wrap.querySelector('.lcars-select-btn span').textContent = opt.querySelector('.opt-label').textContent;
  wrap.querySelector('.lcars-dropdown').classList.remove('open');
  wrap.querySelector('.lcars-select-btn').classList.remove('open');
  beepAction();
}

function getLcarsValue(id) {
  var wrap = document.getElementById(id);
  if (!wrap) return '';
  var sel = wrap.querySelector('.lcars-option.selected');
  return sel ? sel.getAttribute('data-value') : '';
}

function setLcarsValue(id, val) {
  var wrap = document.getElementById(id);
  if (!wrap) return;
  var opts = wrap.querySelectorAll('.lcars-option');
  opts.forEach(function(o) {
    if (o.getAttribute('data-value') === val) {
      o.classList.add('selected');
      wrap.querySelector('.lcars-select-btn span').textContent = o.querySelector('.opt-label').textContent;
    } else {
      o.classList.remove('selected');
    }
  });
}

// Close selects on outside click
document.addEventListener('click', function(e) {
  if (!e.target.closest('.lcars-select')) {
    document.querySelectorAll('.lcars-dropdown.open').forEach(function(d){d.classList.remove('open')});
    document.querySelectorAll('.lcars-select-btn.open').forEach(function(b){b.classList.remove('open')});
  }
});

// ═══ CONFIG PANEL ═══
var _loadingConfig = false;
function loadConfig() {
  _loadingConfig = true;
  try {
    var cfg = JSON.parse(localStorage.getItem('hud-config') || '{}');
    // Set key and voice BEFORE showing the panel so they're populated
    if (cfg.elevenKey) {
      var inp = document.getElementById('cfg-eleven-key');
      if (inp) inp.value = cfg.elevenKey;
    }
    if (cfg.elevenVoice) {
      var vi = document.getElementById('cfg-eleven-voice');
      if (vi) vi.value = cfg.elevenVoice;
    }
    // Now show the panel
    if (cfg.voiceEngine === 'elevenlabs') {
      setLcarsValue('cfg-voice-engine-wrap', 'elevenlabs');
      var fields = document.getElementById('cfg-eleven-fields');
      if (fields) fields.style.display = 'block';
    }
    if (cfg.model) {
      setLcarsValue('cfg-model-wrap', cfg.model);
      window.HUD_MODEL = cfg.model;
    }
    if (cfg.discoverModel) {
      setLcarsValue('cfg-discover-model-wrap', cfg.discoverModel);
    }
    window.HUD_DISCOVER_MODEL = cfg.discoverModel || 'claude-opus-4-6';
    if (cfg.sfx === 'off') {
      setLcarsValue('cfg-sfx-wrap', 'off');
      onSfxChange();
    }
    // Restore ambient setting — can only start after a user gesture so flag it
    var savedAmb = localStorage.getItem('hud-ambient');
    if (savedAmb && savedAmb !== 'off') {
      selectLcarsOptionByValue('cfg-ambient-wrap', savedAmb);
      // Will auto-start on first user interaction via _ambPending flag
      window._ambPending = savedAmb;
    }
    if (cfg.shipName) {
      var sn = document.getElementById('cfg-ship-name');
      if (sn) sn.value = cfg.shipName;
    }
    if (cfg.shipReg) {
      var sr = document.getElementById('cfg-ship-reg');
      if (sr) sr.value = cfg.shipReg;
    }
    if (cfg.projectsDir) {
      var pd = document.getElementById('cfg-projects-dir');
      if (pd) pd.value = cfg.projectsDir;
      window.HUD_PROJECTS_DIR = cfg.projectsDir;
      if (window.HUD_LIVE) {
        fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: cfg.projectsDir }) })
          .then(function(r) { return r.json(); })
          .then(function(d) { window.HUD_PROJECTS_CACHE = d.projects ? d.projects.join(', ') : ''; })
          .catch(function() {});
      }
    }
    if (cfg.theme) {
      setLcarsValue('cfg-theme-wrap', cfg.theme);
    }
    updateElevenStatus();
    // Auto-load voice browser if we have a key
    var savedKey = document.getElementById('cfg-eleven-key').value;
    if (savedKey && savedKey.length > 5) {
      _lastApiKey = savedKey;
      loadVoiceBrowser();
    }
    applyShipName();
    applyTheme();
  } catch(e) {}
  _loadingConfig = false;
}

function saveConfig() {
  if (_loadingConfig) return;
  var cfg = {
    voiceEngine: getLcarsValue('cfg-voice-engine-wrap'),
    elevenKey: document.getElementById('cfg-eleven-key').value,
    elevenVoice: document.getElementById('cfg-eleven-voice').value || 'EXAVITQu4vr4xnSDxMaL',
    sfx: getLcarsValue('cfg-sfx-wrap'),
    model: getLcarsValue('cfg-model-wrap') || 'claude-sonnet-4-6',
    discoverModel: getLcarsValue('cfg-discover-model-wrap') || 'claude-opus-4-6',
    shipName: (document.getElementById('cfg-ship-name') || {}).value || '',
    shipReg: (document.getElementById('cfg-ship-reg') || {}).value || '',
    projectsDir: (document.getElementById('cfg-projects-dir') || {}).value || '',
    theme: getLcarsValue('cfg-theme-wrap') || 'enterprise',
  };
  localStorage.setItem('hud-config', JSON.stringify(cfg));
}

function onCfgChange() {
  saveConfig();
  updateElevenStatus();
}

function onVoiceEngineChange() {
  var engine = getLcarsValue('cfg-voice-engine-wrap');
  var fields = document.getElementById('cfg-eleven-fields');
  fields.style.display = engine === 'elevenlabs' ? 'block' : 'none';
  saveConfig();
  updateElevenStatus();
}

function onModelChange() {
  var model = getLcarsValue('cfg-model-wrap');
  window.HUD_MODEL = model;
  saveConfig();
  toast('MODEL: ' + model);
}

function onSfxChange() {
  var val = getLcarsValue('cfg-sfx-wrap');
  var btn = document.getElementById('sound-toggle');
  if (btn) {
    btn.classList.toggle('on', val === 'on');
    btn.classList.toggle('off', val !== 'on');
  }
  saveConfig();
}

var _apiKeyTimer = null;
var _lastApiKey = '';

function onApiKeyChange() {
  saveConfig();
  updateElevenStatus();
  // Debounce voice loading - wait 800ms after user stops typing
  var key = document.getElementById('cfg-eleven-key').value;
  if (key && key.length > 5 && key !== _lastApiKey) {
    clearTimeout(_apiKeyTimer);
    _apiKeyTimer = setTimeout(function() {
      _lastApiKey = key;
      window._voicesLoaded = false;
      loadVoiceBrowser();
    }, 800);
  }
}

function updateElevenStatus() {
  var el = document.getElementById('cfg-eleven-status');
  if (!el) return;
  var key = document.getElementById('cfg-eleven-key').value;
  var voiceInput = document.getElementById('cfg-eleven-voice');
  if (key && key.length > 5) {
    el.innerHTML = '<span class="cfg-dot on"></span> CONFIGURED';
    el.className = 'cfg-status online';
    window.HUD_ELEVENLABS = true;
    window.HUD_ELEVEN_KEY = key;
    window.HUD_ELEVEN_VOICE = (voiceInput && voiceInput.value) || 'EXAVITQu4vr4xnSDxMaL';
  } else {
    el.innerHTML = '<span class="cfg-dot off"></span> NOT CONFIGURED';
    el.className = 'cfg-status offline';
    window.HUD_ELEVENLABS = false;
  }
}

// ═══ VOICE BROWSER ═══
var _previewAudio = null;

function loadVoiceBrowser() {
  var key = document.getElementById('cfg-eleven-key').value;
  if (!key || key.length < 5) return;

  var loading = document.getElementById('voice-browser-loading');
  var browser = document.getElementById('voice-browser');
  loading.textContent = 'SCANNING VOICE DATABASE...';
  loading.style.display = 'block';
  browser.style.display = 'none';

  var endpoint = window.HUD_LIVE ? '/api/voices' : 'https://api.elevenlabs.io/v1/voices';

  if (window.HUD_LIVE) {
    fetch('/api/voices', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ apiKey: key }),
    }).then(function(r) {
      if (!r.ok) throw new Error('Failed to fetch voices');
      return r.json();
    }).then(function(data) {
      renderVoiceBrowser(data.voices || []);
    }).catch(function(e) {
      loading.textContent = 'VOICE SCAN FAILED: ' + e.message;
    });
  } else {
    fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    }).then(function(r) {
      if (!r.ok) throw new Error('API returned ' + r.status);
      return r.json();
    }).then(function(data) {
      var voices = (data.voices || []).map(function(v) {
        return {
          voice_id: v.voice_id,
          name: v.name,
          category: v.category || 'unknown',
          description: v.labels ? Object.values(v.labels).join(', ') : '',
          preview_url: v.preview_url || null,
        };
      });
      renderVoiceBrowser(voices);
    }).catch(function(e) {
      loading.textContent = 'VOICE SCAN FAILED: ' + e.message + '. Try live mode.';
    });
  }
}

function renderVoiceBrowser(voices) {
  var loading = document.getElementById('voice-browser-loading');
  var browser = document.getElementById('voice-browser');
  var selectedId = document.getElementById('cfg-eleven-voice').value || 'EXAVITQu4vr4xnSDxMaL';

  loading.style.display = 'none';
  browser.style.display = 'block';
  browser.innerHTML = '';
  window._voicesLoaded = true;

  if (!voices.length) {
    browser.innerHTML = '<div class="voice-loading">NO VOICES FOUND</div>';
    return;
  }

  // Sort: premade first, then cloned, alphabetical within
  voices.sort(function(a, b) {
    if (a.category === 'premade' && b.category !== 'premade') return -1;
    if (a.category !== 'premade' && b.category === 'premade') return 1;
    return a.name.localeCompare(b.name);
  });

  voices.forEach(function(v) {
    var card = document.createElement('div');
    card.className = 'voice-card' + (v.voice_id === selectedId ? ' selected' : '');
    card.setAttribute('data-voice-id', v.voice_id);

    var playBtn = document.createElement('button');
    playBtn.className = 'vc-play';
    playBtn.innerHTML = '&#9654;';
    playBtn.title = 'Preview voice';
    playBtn.onclick = function(e) {
      e.stopPropagation();
      previewVoice(v, playBtn);
    };

    var info = document.createElement('div');
    info.className = 'vc-info';
    var name = document.createElement('div');
    name.className = 'vc-name';
    name.textContent = v.name;
    var meta = document.createElement('div');
    meta.className = 'vc-meta';
    meta.textContent = v.description || 'No description';
    info.appendChild(name);
    info.appendChild(meta);

    var cat = document.createElement('span');
    cat.className = 'vc-cat';
    cat.textContent = v.category;

    card.appendChild(playBtn);
    card.appendChild(info);
    card.appendChild(cat);

    card.onclick = function() {
      selectVoice(v.voice_id, v.name);
      beepAction();
    };

    browser.appendChild(card);
  });
}

function selectVoice(voiceId, voiceName) {
  document.getElementById('cfg-eleven-voice').value = voiceId;
  window.HUD_ELEVEN_VOICE = voiceId;

  // Update card styling
  var browser = document.getElementById('voice-browser');
  browser.querySelectorAll('.voice-card').forEach(function(c) {
    c.classList.toggle('selected', c.getAttribute('data-voice-id') === voiceId);
  });

  saveConfig();
  toast('Voice set: ' + voiceName);
}

function previewVoice(voice, btn) {
  // Stop any playing preview
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio = null;
    document.querySelectorAll('.vc-play.playing').forEach(function(b) {
      b.classList.remove('playing');
      b.innerHTML = '&#9654;';
    });
  }

  // If this button was already playing, just stop
  if (btn.classList.contains('playing')) {
    btn.classList.remove('playing');
    btn.innerHTML = '&#9654;';
    return;
  }

  // Use ElevenLabs preview_url if available (free, no API cost)
  if (voice.preview_url) {
    btn.classList.add('playing');
    btn.innerHTML = '&#9632;';
    beepNav();

    _previewAudio = new Audio(voice.preview_url);
    _previewAudio.onended = function() {
      btn.classList.remove('playing');
      btn.innerHTML = '&#9654;';
      _previewAudio = null;
    };
    _previewAudio.onerror = function() {
      btn.classList.remove('playing');
      btn.innerHTML = '&#9654;';
      _previewAudio = null;
      toast('Preview unavailable');
    };
    _previewAudio.play();
  } else {
    toast('No preview available for this voice');
  }
}

function testElevenLabs() {
  var key = document.getElementById('cfg-eleven-key').value;
  var voice = document.getElementById('cfg-eleven-voice').value || 'EXAVITQu4vr4xnSDxMaL';
  if (!key) { toast('Enter an API key first'); return; }

  toast('Testing voice...');
  showWaveform('speaking');

  if (window.HUD_LIVE) {
    fetch('/api/tts', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ text: 'LCARS system online. All ship systems are functioning within normal parameters.', voiceId: voice, apiKey: key }),
    }).then(function(r) {
      if (!r.ok) throw new Error('TTS request failed');
      return r.blob();
    }).then(function(blob) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      audio.onended = function() { hideWaveform(); URL.revokeObjectURL(url); toast('Voice test complete'); };
      audio.onerror = function() { hideWaveform(); toast('Audio playback failed'); };
      audio.play();
    }).catch(function(e) {
      hideWaveform();
      toast('Test failed: ' + e.message);
    });
  } else {
    fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voice + '/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify({
        text: 'LCARS system online. All ship systems are functioning within normal parameters.',
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.3 },
      }),
    }).then(function(r) {
      if (!r.ok) throw new Error('API returned ' + r.status);
      return r.blob();
    }).then(function(blob) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      audio.onended = function() { hideWaveform(); URL.revokeObjectURL(url); toast('Voice test complete'); };
      audio.play();
    }).catch(function(e) {
      hideWaveform();
      toast('Test failed: ' + e.message + '. Use live mode for server proxy.');
    });
  }
}

// Load config on startup
setTimeout(function() {
  loadConfig();
  var modeEl = document.getElementById('cfg-mode-display');
  if (modeEl) {
    modeEl.textContent = window.HUD_LIVE ? 'LIVE' : 'STATIC';
    modeEl.style.color = window.HUD_LIVE ? 'var(--green)' : 'var(--dim)';
  }
  var serverActions = document.getElementById('cfg-server-actions');
  if (serverActions && window.HUD_LIVE) serverActions.style.display = '';
  // Restore last active tab
  try {
    var lastTab = localStorage.getItem('hud-tab');
    if (lastTab) {
      var sec = document.getElementById('s-' + lastTab);
      if (sec) {
        var btns = document.querySelectorAll('.nb');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('onclick') && btns[i].getAttribute('onclick').indexOf("'" + lastTab + "'") !== -1) {
            nav(lastTab, btns[i]);
            break;
          }
        }
      }
    }
  } catch(e) {}
  checkMcpStatus();
  // Build session stats
  (function() {
    var el = document.getElementById('session-stats');
    if (!el) return;
    var sessions = Object.keys(D).filter(function(k) { return k.startsWith('ss:'); });
    var projects = {};
    sessions.forEach(function(k) { var p = D[k].t; projects[p] = (projects[p]||0)+1; });
    var topProject = Object.keys(projects).sort(function(a,b){return projects[b]-projects[a]})[0] || '-';
    var today = new Date().toISOString().slice(0,10);
    var todayCount = sessions.filter(function(k) { return D[k].m.indexOf(today) !== -1; }).length;
    el.innerHTML = '<div class="session-stat"><div class="session-stat-n" style="color:var(--blue)">' + sessions.length + '</div><div class="session-stat-l">Total Sessions</div></div>'
      + '<div class="session-stat"><div class="session-stat-n" style="color:var(--green)">' + todayCount + '</div><div class="session-stat-l">Today</div></div>'
      + '<div class="session-stat"><div class="session-stat-n" style="color:var(--orange)">' + Object.keys(projects).length + '</div><div class="session-stat-l">Projects</div></div>'
      + '<div class="session-stat"><div class="session-stat-n" style="color:var(--peach);font-size:0.9rem">' + esc(topProject) + '</div><div class="session-stat-l">Most Active</div></div>';
  })();
}, 0);

// ═══ DISCOVER / SUGGESTIONS ═══
function toggleDiscover(hdr, id) {
  var body = document.getElementById('db-' + id);
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'grid';
  hdr.classList.toggle('open', !open);
  beepNav();
}

// ═══ LCARS CONFIRM MODAL ═══
function hudConfirm(msg, confirmLabel) {
  return new Promise(function(resolve) {
    var ov = document.createElement('div');
    ov.className = 'hud-modal-overlay';
    ov.innerHTML = '<div class="hud-modal"><div class="hud-modal-title">&#9888; Confirm Action</div><div class="hud-modal-msg">' + msg.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div><div class="hud-modal-actions"><button class="hud-modal-cancel">CANCEL</button><button class="hud-modal-confirm">' + (confirmLabel||'CONFIRM') + '</button></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('.hud-modal-cancel').onclick = function() { ov.remove(); resolve(false); };
    ov.querySelector('.hud-modal-confirm').onclick = function() { ov.remove(); resolve(true); };
    ov.onclick = function(e) { if(e.target===ov) { ov.remove(); resolve(false); } };
    document.addEventListener('keydown', function esc(e) { if(e.key==='Escape'){ov.remove();resolve(false);document.removeEventListener('keydown',esc);} });
  });
}

// ═══ SEAMLESS DOM HELPERS ═══
function _removeCard(btn) {
  var card = btn;
  while(card && !card.classList.contains('suggest-card')) card = card.parentNode;
  if(!card) return;
  card.style.transition = 'opacity .25s, transform .25s';
  card.style.opacity = '0'; card.style.transform = 'scale(0.95)';
  setTimeout(function() {
    var body = card.parentNode;
    if(card.parentNode) card.remove();
    if(body && body.children.length === 0) {
      var discover = body.parentNode;
      if(discover && discover.classList.contains('discover')) discover.remove();
    }
  }, 260);
}

function _removeRow(key) {
  var row = document.querySelector('[data-k="' + key + '"]');
  if(!row) return;
  row.style.transition = 'opacity .2s, max-height .3s';
  row.style.opacity = '0';
  setTimeout(function() { if(row.parentNode) row.remove(); }, 220);
  // Also remove from D
  if(window._D) delete window._D[key];
}

function _addRow(sectionId, html, key) {
  var sec = document.getElementById(sectionId);
  if(!sec) return;
  // Remove "no items" placeholder
  var emp = sec.querySelector('.emp');
  if(emp) emp.remove();
  var discover = sec.querySelector('.discover');
  var tmp = document.createElement('div');
  tmp.innerHTML = html.trim();
  var el = tmp.firstElementChild;
  el.style.opacity = '0';
  if(discover) sec.insertBefore(el, discover);
  else sec.appendChild(el);
  setTimeout(function() { el.style.transition = 'opacity .3s'; el.style.opacity = '1'; }, 10);
}

function installSuggestSkill(btn, name, content) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var filePath = '${esc(path.join(CLAUDE_DIR, 'skills'))}/' + name + '/SKILL.md';
  var skillDir  = '${esc(path.join(CLAUDE_DIR, 'skills'))}/' + name;
  fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: filePath, content: content, mkdir: true }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var desc = (content.match(/^description:\\s*["']?(.+?)["']?\\s*$/m)||[])[1]||'';
      var key = 's:'+name;
      if(window._D) window._D[key] = { t:name, tp:'SKILL MODULE', m:'', b:content,
        actions:[{label:'INVOKE',cmd:'/'+name,icon:'RUN'},{label:'DELETE',cmd:skillDir,icon:'DEL'}]};
      _addRow('s-skills','<div class="r" onclick="open_(\\\''+key+'\\\')" data-k="'+key+'"><span class="r-id">'+name+'</span><span class="r-tg"></span><span class="r-d">'+desc+'</span></div>');
      _removeCard(btn);
      if(window._D) delete window._D['sugg:skill:'+name];
      toast('SKILL INSTALLED: ' + name); beepAction();
    } else { btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+d.error); }
  }).catch(function(e){ btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+e.message); });
}

function installSuggestAgent(btn, name, content) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var filePath = '${esc(path.join(CLAUDE_DIR, 'agents'))}/' + name + '.md';
  fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: filePath, content: content }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var desc = (content.match(/^description:\\s*["']?(.+?)["']?\\s*$/m)||[])[1]||'';
      var key = 'a:'+name;
      if(window._D) window._D[key] = { t:name, tp:'AGENT DEFINITION', m:'', b:content,
        actions:[{label:'DELETE',cmd:filePath,icon:'DEL'}]};
      _addRow('s-agents','<div class="r r2" onclick="open_(\\\''+key+'\\\')" data-k="'+key+'"><span class="r-id">'+name+'</span><span class="r-tg"></span><span class="r-d">'+desc+'</span></div>');
      _removeCard(btn);
      if(window._D) delete window._D['sugg:agent:'+name];
      toast('AGENT DEPLOYED: ' + name); beepAction();
    } else { btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+d.error); }
  }).catch(function(e){ btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+e.message); });
}

function installSuggestMcp(btn, name, configJson) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var config = JSON.parse(configJson);
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: 'add-mcp', name: name, config: config }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var key = 'm:'+name;
      var cmdStr = (config.command||'') + ' ' + (config.args||[]).join(' ');
      if(window._D) window._D[key] = { t:name, tp:'MCP SERVER CONFIG', m:cmdStr, b:JSON.stringify(config,null,2),
        actions:[{label:'COPY CONFIG',cmd:JSON.stringify(config,null,2),icon:'COPY'},{label:'DELETE',cmd:'mcp:'+name,icon:'DEL'}]};
      var mcpGrid = document.querySelector('#s-mcp .mcp-grid');
      if(mcpGrid){
        var card = document.createElement('div');
        card.className='mcp-card'; card.setAttribute('data-k',key); card.style.opacity='0';
        card.onclick=function(){open_(key)};
        card.innerHTML='<div class="mcp-card-top"><div class="mcp-card-status unknown"></div><div class="mcp-card-name">'+name+'</div><span class="mcp-card-type">'+config.command+'</span></div><div class="mcp-card-body"><div class="mcp-card-row"><span class="mcp-card-label">CMD</span><span class="mcp-card-val">'+cmdStr+'</span></div></div><div class="mcp-card-footer"><div class="mcp-card-bar"></div><div class="mcp-card-status-label unknown">CONFIGURED</div></div>';
        mcpGrid.appendChild(card);
        setTimeout(function(){card.style.transition='opacity .3s';card.style.opacity='1';},10);
      }
      _removeCard(btn);
      if(window._D) delete window._D['sugg:mcp:'+name];
      toast('MCP REGISTERED: ' + name); beepAction();
    } else { btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+d.error); }
  }).catch(function(e){ btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+e.message); });
}

function installSuggestHook(btn, event, matcher, cmd) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var hook = { type: 'command', command: cmd };
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: 'add-hook', event: event, matcher: matcher || undefined, hook: hook }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var tempKey = 'h:new-'+Date.now();
      if(window._D) window._D[tempKey] = { t:event+' // '+(matcher||'*'), tp:'HOOK INTERCEPT', m:'TYPE: command', b:JSON.stringify(hook,null,2),
        actions:[{label:'COPY HOOK JSON',cmd:JSON.stringify(hook,null,2),icon:'COPY'}]};
      _addRow('s-hooks','<div class="r" onclick="open_(\\\''+tempKey+'\\\')" data-k="'+tempKey+'"><span class="r-id">'+event+'</span><span class="r-tg"><span class="tg tg-t">command</span>'+(matcher?'<span class="tg tg-b">'+matcher+'</span>':'')+'</span><span class="r-d">'+cmd.slice(0,100)+'</span></div>');
      _removeCard(btn);
      toast('HOOK INSTALLED: ' + event); beepAction();
    } else { btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+d.error); }
  }).catch(function(e){ btn.disabled=false; btn.textContent='+ INSTALL'; toast('ERROR: '+e.message); });
}

function filterMkt(type, btn) {
  if(btn){ document.querySelectorAll('.mkt-filter-btn').forEach(function(b){b.classList.remove('act')}); btn.classList.add('act'); }
  window._mktFilter = type;
  var q = (document.getElementById('mkt-search')||{}).value||'';
  var qLow = q.toLowerCase().trim();
  var cards = document.querySelectorAll('#mkt-grid .mkt-card');
  cards.forEach(function(card) {
    var cardType = card.getAttribute('data-mkt-type');
    var cardSource = card.getAttribute('data-source') || 'local';
    var isInstalled = card.classList.contains('installed');
    var typeOk = type === 'all'
      || (type === 'installed' ? isInstalled
      : type === 'remote' ? cardSource === 'remote'
      : cardType === type);
    var textOk = !qLow || (card.textContent||'').toLowerCase().indexOf(qLow) !== -1;
    card.style.display = (typeOk && textOk) ? '' : 'none';
  });
}

function loadRemoteMarketplace() {
  var btn = document.getElementById('mkt-load-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'LOADING...'; }
  fetch('/api/remote-marketplace')
    .then(function(r) { return r.json(); })
    .then(function(items) {
      document.querySelectorAll('#mkt-grid .mkt-card[data-source="remote"]').forEach(function(c) { c.remove(); });
      var installedNames = new Set();
      if (window._D) { Object.keys(window._D).forEach(function(k) { if (k.startsWith('m:')) installedNames.add(k.slice(2)); }); }
      var grid = document.getElementById('mkt-grid');
      if (!grid) return;
      items.forEach(function(item) {
        var isInstalled = installedNames.has(item.shortName) || installedNames.has(item.name);
        var div = document.createElement('div');
        div.className = 'mkt-card' + (isInstalled ? ' installed' : '');
        div.setAttribute('data-mkt-type', 'mcp');
        div.setAttribute('data-source', 'remote');
        div.setAttribute('data-remote-name', item.shortName);
        div.setAttribute('data-remote-cmd', item.command);
        div.setAttribute('data-remote-args', JSON.stringify(item.args));
        div.style.display = 'none';
        var installFoot = isInstalled
          ? '<span class="mkt-installed-badge">&#10003; INSTALLED</span>'
          : '<button class="mkt-install-btn" onclick="event.stopPropagation();installRemoteMcp(this)">+ INSTALL</button>';
        div.innerHTML = '<div class="mkt-card-name">' + esc(item.name) + '</div>'
          + '<div class="mkt-card-desc">' + esc(item.description || 'No description available.') + '</div>'
          + '<div class="mkt-card-meta"><span class="mkt-cap mcp">MCP</span><span class="mkt-src">' + esc(item.sourceLabel) + '</span></div>'
          + '<div class="mkt-card-footer">' + installFoot + '</div>';
        grid.appendChild(div);
      });
      var count = document.getElementById('mkt-count');
      if (count) {
        var total = document.querySelectorAll('#mkt-grid .mkt-card').length;
        count.textContent = total;
      }
      if (btn) { btn.disabled = false; btn.textContent = '\\u2713 LOADED (' + items.length + ')'; }
      filterMkt(window._mktFilter || 'all');
      toast('Loaded ' + items.length + ' remote servers');
    })
    .catch(function(e) {
      if (btn) { btn.disabled = false; btn.textContent = '\\u2B07 LOAD REGISTRY'; }
      toast('ERROR: ' + e.message);
    });
}

function installRemoteMcp(btn) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  var card = btn.closest('.mkt-card');
  var name = card.getAttribute('data-remote-name');
  var command = card.getAttribute('data-remote-cmd');
  var args = JSON.parse(card.getAttribute('data-remote-args') || '[]');
  btn.disabled = true; btn.textContent = '...';
  fetch('/api/marketplace/install-remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, command: command, args: args }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        btn.style.display = 'none';
        var badge = document.createElement('span');
        badge.className = 'mkt-installed-badge'; badge.textContent = '\\u2713 INSTALLED';
        btn.parentNode.appendChild(badge);
        card.classList.add('installed');
        toast('MCP INSTALLED: ' + name);
        beepAction();
      } else {
        btn.disabled = false; btn.textContent = '+ INSTALL';
        toast('ERROR: ' + (d.error || 'Install failed'));
      }
    })
    .catch(function(e) { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + e.message); });
}

function installMarketItem(btn, id, type, sourcePath, mcpConfigJson) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var payload = { id: id, type: type, sourcePath: sourcePath };
  if (mcpConfigJson) { try { payload.mcpConfig = JSON.parse(mcpConfigJson); } catch(e) {} }
  fetch('/api/marketplace/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        btn.style.display = 'none';
        var footer = btn.parentNode;
        var badge = document.createElement('span');
        badge.className = 'mkt-installed-badge'; badge.textContent = '✓ INSTALLED';
        footer.appendChild(badge);
        var card = btn.closest('.mkt-card');
        if (card) card.classList.add('installed');
        var key = 'mk:' + id;
        if (window._D && window._D[key]) {
          window._D[key].actions = [{ label: 'INSTALLED', cmd: '', icon: 'OK' }];
          if (window._D[key].m.indexOf(' // INSTALLED') === -1) window._D[key].m += ' // INSTALLED';
        }
        var pluginName = id.split(':').pop();
        if (type === 'plugin') { toast('PLUGIN INSTALLED: ' + pluginName); }
        else {
          // Also add MCP entries to D and MCP section
          if (d.mcpAdded && window._D) {
            d.mcpAdded.forEach(function(name) {
              var mcpKey = 'm:' + name;
              window._D[mcpKey] = { t: name, tp: 'MCP SERVER CONFIG', m: name, b: '', actions: [{ label: 'DELETE', cmd: 'mcp:' + name, icon: 'DEL' }] };
            });
          }
          toast('MCP INSTALLED: ' + pluginName);
        }
        beepAction();
      } else {
        btn.disabled = false; btn.textContent = '+ INSTALL';
        toast('ERROR: ' + (d.error || 'Install failed'));
      }
    })
    .catch(function(e) { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + e.message); });
}

// ═══ SERVER CONTROLS ═══
function restartServer(btn) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'RESTARTING...'; }
  fetch('/api/restart', { method: 'POST' }).catch(function(){});
  toast('Server restarting...');
  var attempts = 0;
  var poll = setInterval(function() {
    attempts++;
    fetch('/api/health').then(function(r) {
      if (r.ok) {
        clearInterval(poll);
        toast('Server back online — reloading');
        setTimeout(function() { location.reload(); }, 500);
      }
    }).catch(function() {
      if (attempts > 20) { clearInterval(poll); if (btn) { btn.disabled = false; btn.textContent = '\\u21BA RESTART'; } toast('Server not responding'); }
    });
  }, 800);
}

function updateServer(btn) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'UPDATING...'; }
  toast('Pulling latest from npm...');
  fetch('/api/update', { method: 'POST' }).then(function(r) {
    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function read() {
      reader.read().then(function(result) {
        if (result.done) return;
        buf += decoder.decode(result.value, { stream: true });
        var lines = buf.split('\\n');
        buf = lines.pop();
        lines.forEach(function(line) {
          if (!line.startsWith('data: ')) return;
          try {
            var msg = JSON.parse(line.slice(6));
            if (msg.done) {
              if (msg.code === 0) { toast('Updated — server restarting'); setTimeout(function() { location.reload(); }, 2500); }
              else { if (btn) { btn.disabled = false; btn.textContent = '\\u2191 UPDATE'; } toast('Update failed (check console)'); }
            }
          } catch(e) {}
        });
        read();
      });
    }
    read();
  }).catch(function(e) {
    if (btn) { btn.disabled = false; btn.textContent = '\\u2191 UPDATE'; }
    toast('ERROR: ' + e.message);
  });
}

// ═══ CREATE NEW ITEMS ═══
function toggleCreate(type) {
  var form = document.getElementById('cf-' + type);
  if (!form) return;
  form.classList.toggle('active');
  beepNav();
}

function createSkill() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var name = document.getElementById('cf-skill-name').value.trim();
  var desc = document.getElementById('cf-skill-desc').value.trim();
  var ctx = getLcarsValue('cf-skill-ctx-wrap') || 'fork';
  var body = document.getElementById('cf-skill-body').value;
  if (!name) { toast('Name required'); return; }

  var content = '---\\nname: ' + name + '\\ndescription: "' + desc.replace(/"/g, '\\\\"') + '"\\ncontext: ' + ctx + '\\nversion: 1.0.0\\n---\\n\\n' + body;
  var dir = '${esc(path.join(CLAUDE_DIR, 'skills'))}/' + name;
  var filePath = dir + '/SKILL.md';

  fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: filePath, content: content, mkdir: true }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var key = 's:'+name;
      if(window._D) window._D[key] = { t:name, tp:'SKILL MODULE', m:ctx+'//v1.0.0', b:body,
        actions:[{label:'INVOKE',cmd:'/'+name,icon:'RUN'},{label:'DELETE',cmd:dir,icon:'DEL'}]};
      _addRow('s-skills','<div class="r" onclick="open_(\\\''+key+'\\\')" data-k="'+key+'"><span class="r-id">'+name+'</span><span class="r-tg"><span class="tg tg-b">'+ctx+'</span><span class="tg tg-d">v1.0.0</span></span><span class="r-d">'+desc+'</span></div>');
      toggleCreate('skill');
      document.getElementById('cf-skill-name').value='';
      document.getElementById('cf-skill-desc').value='';
      document.getElementById('cf-skill-body').value='';
      toast('SKILL CREATED: ' + name); beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function installHudLogger() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var logCmd = "python3 -c \\"import sys,json,datetime,os; d=json.load(sys.stdin); ev=os.environ.get('CLAUDE_HOOK_EVENT','unknown'); log=json.dumps({'ts':datetime.datetime.now().isoformat(),'event':ev,'tool':d.get('tool_name',''),'session':d.get('session_id','')}); open(os.path.expanduser('~/.claude/hud-events.jsonl'),'a').write(log+'\\\\n')\\"";
  var hooks = [
    { event: 'PreToolUse', hook: { type: 'command', command: logCmd } },
    { event: 'PostToolUse', hook: { type: 'command', command: logCmd } },
    { event: 'Stop', hook: { type: 'command', command: logCmd } },
  ];
  var promises = hooks.map(function(h) {
    return fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type: 'add-hook', event: h.event, hook: h.hook }),
    }).then(function(r){ return r.json(); });
  });
  Promise.all(promises).then(function(results) {
    var allOk = results.every(function(d){ return d.ok; });
    if (allOk) { toast('HUD LOGGER INSTALLED — 3 hooks added'); beepAction(); }
    else { toast('Some hooks failed to install'); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function toggleMcp(name, isDisabled) {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var type = isDisabled ? 'enable-mcp' : 'disable-mcp';
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: type, name: name }),
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.ok) {
      toast(isDisabled ? 'ENABLED: ' + name : 'DISABLED: ' + name);
      // Update card appearance
      var card = document.querySelector('[data-mcp="' + name + '"]');
      if (card) {
        card.classList.toggle('mcp-card-disabled', !isDisabled);
        var btn = card.querySelector('.mcp-toggle-btn');
        if (btn) { btn.textContent = isDisabled ? 'DISABLE' : 'ENABLE'; btn.setAttribute('onclick', 'event.stopPropagation();toggleMcp(' + JSON.stringify(name) + ',' + !isDisabled + ')'); }
        var dot = card.querySelector('.mcp-card-status');
        if (dot) { dot.className = 'mcp-card-status ' + (isDisabled ? 'checking' : 'mcp-disabled'); }
        var label = card.querySelector('[id^="mcp-label-"]');
        if (label && isDisabled) { label.className='mcp-card-status-label checking'; label.textContent='CHECKING'; }
        if (label && !isDisabled) { label.textContent='DISABLED'; label.className='mcp-card-status-label'; label.style.color='var(--dim)'; }
      }
      beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function createMcp() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var name = document.getElementById('cf-mcp-name').value.trim();
  var cmd = document.getElementById('cf-mcp-cmd').value.trim();
  var argsStr = document.getElementById('cf-mcp-args').value.trim();
  if (!name || !cmd) { toast('Name and command required'); return; }
  var args = argsStr ? argsStr.split(/\\s+/) : [];
  var config = { command: cmd, args: args };
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: 'add-mcp', name: name, config: config }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var key = 'm:'+name;
      var cmdStr = cmd + ' ' + args.join(' ');
      if(window._D) window._D[key] = { t:name, tp:'MCP SERVER CONFIG', m:cmdStr, b:JSON.stringify(config,null,2),
        actions:[{label:'COPY CONFIG',cmd:JSON.stringify(config,null,2),icon:'COPY'},{label:'DELETE',cmd:'mcp:'+name,icon:'DEL'}]};
      var mcpGrid = document.querySelector('#s-mcp .mcp-grid');
      if(mcpGrid){
        var card = document.createElement('div');
        card.className='mcp-card'; card.setAttribute('data-k',key); card.style.opacity='0';
        card.onclick=function(){open_(key)};
        card.innerHTML='<div class="mcp-card-top"><div class="mcp-card-status unknown"></div><div class="mcp-card-name">'+name+'</div><span class="mcp-card-type">'+cmd+'</span></div><div class="mcp-card-body"><div class="mcp-card-row"><span class="mcp-card-label">CMD</span><span class="mcp-card-val">'+cmdStr+'</span></div></div><div class="mcp-card-footer"><div class="mcp-card-bar"></div><div class="mcp-card-status-label unknown">CONFIGURED</div></div>';
        mcpGrid.appendChild(card);
        setTimeout(function(){card.style.transition='opacity .3s';card.style.opacity='1';},10);
      }
      toggleCreate('mcp');
      document.getElementById('cf-mcp-name').value='';
      document.getElementById('cf-mcp-cmd').value='';
      document.getElementById('cf-mcp-args').value='';
      toast('MCP REGISTERED: ' + name); beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function createHook() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var event = getLcarsValue('cf-hook-event-wrap') || 'PreToolUse';
  var matcher = document.getElementById('cf-hook-matcher').value.trim();
  var type = getLcarsValue('cf-hook-type-wrap') || 'command';
  var cmd = document.getElementById('cf-hook-cmd').value.trim();
  if (!cmd) { toast('Command/prompt required'); return; }
  var hook = { type: type };
  if (type === 'command') hook.command = cmd;
  else if (type === 'prompt' || type === 'agent') hook.prompt = cmd;
  else if (type === 'http') hook.url = cmd;
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: 'add-hook', event: event, matcher: matcher || undefined, hook: hook }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var tempKey = 'h:new-'+Date.now();
      if(window._D) window._D[tempKey] = { t:event+' // '+(matcher||'*'), tp:'HOOK INTERCEPT', m:'TYPE: '+type, b:JSON.stringify(hook,null,2),
        actions:[{label:'COPY HOOK JSON',cmd:JSON.stringify(hook,null,2),icon:'COPY'}]};
      _addRow('s-hooks','<div class="r" onclick="open_(\\\''+tempKey+'\\\')" data-k="'+tempKey+'"><span class="r-id">'+event+'</span><span class="r-tg"><span class="tg tg-t">'+type+'</span>'+(matcher?'<span class="tg tg-b">'+matcher+'</span>':'')+'</span><span class="r-d">'+cmd.slice(0,100)+'</span></div>');
      toggleCreate('hook');
      document.getElementById('cf-hook-cmd').value='';
      document.getElementById('cf-hook-matcher').value='';
      toast('HOOK CREATED: ' + event); beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function createAgent() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var name = document.getElementById('cf-agent-name').value.trim();
  var desc = document.getElementById('cf-agent-desc').value.trim();
  var tools = document.getElementById('cf-agent-tools').value.trim();
  var body = document.getElementById('cf-agent-body').value;
  if (!name) { toast('Name required'); return; }

  var toolsList = tools ? '\\ntools:\\n' + tools.split(',').map(function(t) { return '  - ' + t.trim(); }).join('\\n') : '';
  var content = '---\\ndescription: "' + desc.replace(/"/g, '\\\\"') + '"' + toolsList + '\\n---\\n\\n' + body;
  var filePath = '${esc(path.join(CLAUDE_DIR, 'agents'))}/' + name + '.md';

  fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: filePath, content: content }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var key = 'a:'+name;
      if(window._D) window._D[key] = { t:name, tp:'AGENT DEFINITION', m:'', b:content,
        actions:[{label:'DELETE',cmd:filePath,icon:'DEL'}]};
      _addRow('s-agents','<div class="r r2" onclick="open_(\\\''+key+'\\\')" data-k="'+key+'"><span class="r-id">'+name+'</span><span class="r-tg"></span><span class="r-d">'+desc+'</span></div>');
      toggleCreate('agent');
      ['cf-agent-name','cf-agent-desc','cf-agent-tools','cf-agent-body'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
      toast('AGENT DEPLOYED: ' + name); beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function createEnv() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var envKey = document.getElementById('cf-env-key').value.trim().toUpperCase();
  var val = document.getElementById('cf-env-val').value.trim();
  if (!envKey) { toast('Variable name required'); return; }
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: 'add-env', key: envKey, value: val }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var key = 'v:'+envKey;
      if(window._D) window._D[key] = { t:envKey, tp:'ENV VARIABLE', m:'', b:'**'+envKey+'**: '+val,
        actions:[{label:'COPY VALUE',cmd:val,icon:'COPY'}]};
      _addRow('s-env','<div class="r r2" onclick="open_(\\\''+key+'\\\')" data-k="'+key+'"><span class="r-id">'+envKey+'</span><span class="r-tg"></span><span class="r-d">••••••••</span></div>');
      toggleCreate('env');
      document.getElementById('cf-env-key').value='';
      document.getElementById('cf-env-val').value='';
      toast('ENV SET: ' + envKey); beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

function createPlugin() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var id = document.getElementById('cf-plugin-id').value.trim();
  if (!id) { toast('Plugin ID required'); return; }
  fetch('/api/settings-update', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: 'add-plugin', id: id }),
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      var key = 'p:'+id;
      if(window._D) window._D[key] = { t:id, tp:'PLUGIN', m:'ACTIVE', b:JSON.stringify({id:id,enabled:true},null,2), actions:[] };
      _addRow('s-plugins','<div class="r r2" onclick="open_(\\\''+key+'\\\')" data-k="'+key+'"><span class="r-id">'+id+'</span><span class="tg tg-g">ACTIVE</span></div>');
      toggleCreate('plugin');
      document.getElementById('cf-plugin-id').value='';
      toast('PLUGIN ENABLED: ' + id); beepAction();
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e){ toast('ERROR: ' + e.message); });
}

// ═══ MCP STATUS CHECK ═══
function checkMcpStatus() {
  var labels = {
    ready: 'ONLINE',
    error: 'CMD NOT FOUND',
    missing: 'FILE MISSING',
    unknown: 'CONFIGURED',
  };

  if (!window.HUD_LIVE) {
    document.querySelectorAll('.mcp-card').forEach(function(card) {
      setMcpStatus(card.getAttribute('data-mcp'), 'unknown');
    });
    return;
  }

  fetch('/api/mcp-status').then(function(r) {
    return r.json();
  }).then(function(statuses) {
    for (var name in statuses) {
      setMcpStatus(name, statuses[name]);
    }
    document.querySelectorAll('.mcp-card').forEach(function(card) {
      var n = card.getAttribute('data-mcp');
      if (!(n in statuses)) setMcpStatus(n, 'unknown');
    });
  }).catch(function() {
    document.querySelectorAll('.mcp-card').forEach(function(card) {
      setMcpStatus(card.getAttribute('data-mcp'), 'unknown');
    });
  });

  function setMcpStatus(name, status) {
    var dot = document.getElementById('mcp-dot-' + name);
    var label = document.getElementById('mcp-label-' + name);
    var card = document.querySelector('[data-mcp="' + name + '"]');
    if (!dot || !label || !card) return;
    dot.className = 'mcp-card-status ' + status;
    label.className = 'mcp-card-status-label ' + status;
    label.textContent = labels[status] || status.toUpperCase();
    var bar = card.querySelector('.bar-fill');
    if (bar) bar.className = 'bar-fill ' + status;
  }

  function updateOverviewCounts() {
    var ready = 0, warn = 0, err = 0;
    document.querySelectorAll('.mcp-card-status-label').forEach(function(el) {
      if (el.classList.contains('ready')) ready++;
      else if (el.classList.contains('missing') || el.classList.contains('unknown')) warn++;
      else if (el.classList.contains('error')) err++;
    });
    var re = document.getElementById('mcp-ready-count');
    var we = document.getElementById('mcp-warn-count');
    var ee = document.getElementById('mcp-err-count');
    if (re) re.textContent = String(ready).padStart(2, '0');
    if (we) we.textContent = String(warn).padStart(2, '0');
    if (ee) ee.textContent = String(err).padStart(2, '0');
  }

  // Update counters after status check
  setTimeout(updateOverviewCounts, 3000);
}

// Escape stops speech
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') stopSpeaking();
});

// ═══ MODE TOGGLE (CLAUDE vs CHAT) ═══
function toggleMode(btn) {
  var wasOn = btn.classList.contains('on');
  btn.classList.toggle('on', !wasOn);
  btn.classList.toggle('off', wasOn);
  lcarsBeep(wasOn ? 600 : 1200, 0.06);
  toast(wasOn ? 'MODE: DIRECT CHAT' : 'MODE: CLAUDE CODE');
}

function isClaudeMode() {
  return isToggleOn('mode-toggle');
}

// ═══ LCARS SCAN ANIMATION ═══
function lcarsScanHTML() {
  var bars = '';
  for (var i = 0; i < 12; i++) bars += '<div class="sb"></div>';
  return '<div class="lcars-scan">' +
    '<div class="lcars-scan-bars">' + bars + '</div>' +
    '<div class="lcars-scan-line"></div>' +
    '<div class="lcars-scan-text">Analysing query</div>' +
    '</div>';
}

// ═══ GLOBAL COMPUTER CHAT ═══
var chatHistory = [];

function saveCommsHistory() {
  try { localStorage.setItem('hud-comms-history', JSON.stringify(chatHistory.slice(-50))); } catch(e) {}
}

function clearCommsHistory() {
  chatHistory = [];
  try { localStorage.removeItem('hud-comms-history'); } catch(e) {}
  var log = document.getElementById('comms-log');
  if (log) {
    log.innerHTML = '<div class="comms-msg sys">COMMS CHANNEL // USE THE COMPUTER BAR BELOW TO COMMUNICATE</div><div class="comms-msg sys">HISTORY CLEARED</div>';
  }
  document.getElementById('cr-toggle').style.display = 'none';
  toast('COMMS HISTORY CLEARED');
}

(function restoreCommsHistory() {
  try {
    var saved = localStorage.getItem('hud-comms-history');
    if (!saved) return;
    var msgs = JSON.parse(saved);
    if (!Array.isArray(msgs) || !msgs.length) return;
    chatHistory = msgs;
    // Render after DOM is ready — defer to after DOMContentLoaded equivalent
    setTimeout(function() {
      var log = document.getElementById('comms-log');
      if (!log) return;
      msgs.forEach(function(msg) {
        var div = document.createElement('div');
        div.className = 'comms-msg ' + msg.role;
        if (msg.role === 'ai') { div.innerHTML = md(msg.content); }
        else { div.textContent = msg.content; }
        log.appendChild(div);
      });
      log.scrollTop = log.scrollHeight;
      showLogButton();
    }, 300);
  } catch(e) {}
})();

function addMsg(role, text) {
  var log = document.getElementById('comms-log');
  if (!log) return null;
  var div = document.createElement('div');
  div.className = 'comms-msg ' + role;
  if (role === 'ai') {
    div.innerHTML = md(text);
  } else {
    div.textContent = text;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function closeCR() {
  var cr = document.getElementById('cr');
  cr.classList.remove('visible');
  cr.classList.remove('minimised');
  stopSpeaking();
}

function minimiseCR() {
  document.getElementById('cr').classList.add('minimised');
  stopSpeaking();
  beepNav();
}

function expandCR() {
  document.getElementById('cr').classList.remove('minimised');
  beepOpen();
}

function toggleCR() {
  var cr = document.getElementById('cr');
  if (cr.classList.contains('minimised')) {
    expandCR();
  } else {
    cr.classList.toggle('visible');
  }
}

// Show LOG button after first response
function showLogButton() {
  var btn = document.getElementById('cr-toggle');
  if (btn) btn.style.display = '';
}

var _chatInProgress = false;
function sendGlobal() {
  var input = document.getElementById('cb-in');
  var text = input.value.trim();
  if (!text) return;
  if (_chatInProgress) return;
  _chatInProgress = true;

  if (!window.HUD_LIVE) {
    _chatInProgress = false;
    toast('COMMS OFFLINE. Run: node src/server.js');
    return;
  }

  // Route to Claude Code orchestration if in CLAUDE mode
  if (isClaudeMode()) {
    sendClaude(text);
    return;
  }
  beepSend();
  input.value = '';

  // Show in comms log
  addMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  saveCommsHistory();

  // Show response overlay with scan animation
  var cr = document.getElementById('cr');
  var crBody = document.getElementById('cr-body');
  cr.classList.remove('minimised');
  crBody.innerHTML = lcarsScanHTML();
  cr.classList.add('visible');

  var btn = document.getElementById('cb-send');
  btn.disabled = true;
  btn.textContent = '...';

  // Safety: re-enable after 60s if stream hangs
  var safetyTimer = setTimeout(function() {
    btn.disabled = false;
    btn.textContent = 'SEND';
  }, 60000);

  var fullText = '';
  var streamStarted = false;
  var activeBlockIdx = -1;
  var seenEvents = {};

  // Build setup context from VIZ data so LCARS knows what exists
  var setupCtx = '';
  if (typeof VIZ !== 'undefined') {
    var parts = [];
    if (VIZ.skills && VIZ.skills.length) parts.push('Skills: ' + VIZ.skills.map(function(s){ return s.name; }).join(', '));
    if (VIZ.agents && VIZ.agents.length) parts.push('Agents: ' + VIZ.agents.map(function(a){ return a.name; }).join(', '));
    if (VIZ.mcp && VIZ.mcp.length) parts.push('MCP servers: ' + VIZ.mcp.map(function(m){ return m.name; }).join(', '));
    if (VIZ.hooks && VIZ.hooks.length) parts.push('Hooks: ' + VIZ.hooks.map(function(h){ return (h.matcher||h.ev) + ':' + h.cmd.slice(0,40); }).join(' | '));
    if (VIZ.mem && VIZ.mem.length) parts.push('Memory files: ' + VIZ.mem.map(function(m){ return m.name + '(' + m.proj + ')'; }).join(', '));
    if (parts.length) setupCtx = '\\n\\nCurrent ship systems: ' + parts.join('. ');
  }
  var projCtx = (window.HUD_PROJECTS_DIR && window.HUD_PROJECTS_CACHE)
    ? ' Active missions (projects in ' + window.HUD_PROJECTS_DIR + '): ' + window.HUD_PROJECTS_CACHE
    : '';
  var actionCtx = window.HUD_LIVE ? '\\n\\nACTION CAPABILITY: You can create and modify files in the user\\'s Claude Code setup. When the user asks you to create a skill, improve a skill, add a hook, create an agent, or update a CLAUDE.md file, output the file content wrapped in an <lcars-action> block like this:\\n\\n<lcars-action type="write-file" path="FULL_ABSOLUTE_PATH" description="one-line description of what this does">\\nFILE CONTENT HERE\\n</lcars-action>\\n\\nPaths must be under ~/.claude/. For skills use ~/.claude/skills/SKILL-NAME/SKILL.md. For agents use ~/.claude/agents/NAME.md. For global CLAUDE.md use ~/.claude/CLAUDE.md. For project CLAUDE.md use the path from the project list. Always explain what you are doing before the action block. The user will see a preview and must confirm before anything is written.' : '';
  var systemExtra = setupCtx + projCtx + actionCtx;

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chatHistory, model: window.HUD_MODEL || 'claude-sonnet-4-6', systemExtra: systemExtra }),
  }).then(function(res) {
    if (!res.ok) {
      return res.json().then(function(e) { throw new Error(e.error || 'API error'); });
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          clearTimeout(safetyTimer);
          _chatInProgress = false;
          chatHistory.push({ role: 'assistant', content: fullText });
          saveCommsHistory();
          btn.disabled = false;
          btn.textContent = 'SEND';
          beepReceive();
          addMsg('ai', fullText);
          showLogButton();
          speak(fullText);
          if (window.HUD_LIVE) parseLcarsActions(fullText);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('data: ')) {
            var data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              var evt = JSON.parse(data);
              if (evt.type === 'message_stop' || evt.type === 'message_start') continue;
              if (evt.type === 'content_block_start') {
                if (activeBlockIdx === -1) activeBlockIdx = evt.index;
                continue;
              }
              if (evt.type === 'content_block_stop') continue;
              if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta' && evt.delta.text) {
                if (seenEvents[data]) continue;
                seenEvents[data] = true;
                fullText += evt.delta.text;
                if (!streamStarted) {
                  streamStarted = true;
                  crBody.innerHTML = '<div id="cr-stream"></div>';
                }
                var streamEl = document.getElementById('cr-stream');
                if (streamEl) {
                  streamEl.innerHTML = md(fullText);
                  cr.scrollTop = cr.scrollHeight;
                }
              }
            } catch(e) {}
          }
        }
        return pump();
      });
    }

    return pump();
  }).catch(function(e) {
    clearTimeout(safetyTimer);
    _chatInProgress = false;
    crBody.innerHTML = '<span style="color:var(--red)">ERROR: ' + esc(e.message) + '</span>';
    addMsg('err', 'COMMS ERROR: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'SEND';
  });
}

// ═══ UNIVERSAL SEARCH ═══
var searchOpen = false;
function toggleSearch() {
  var bar = document.getElementById('search-bar');
  searchOpen = !searchOpen;
  bar.classList.toggle('open', searchOpen);
  if (searchOpen) {
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('search-count').textContent = '';
    setTimeout(function() { document.getElementById('search-input').focus(); }, 50);
  }
}

function onSearch() {
  var q = document.getElementById('search-input').value.trim().toLowerCase();
  var results = document.getElementById('search-results');
  var countEl = document.getElementById('search-count');
  if (!q || q.length < 2) { results.innerHTML = ''; countEl.textContent = ''; return; }

  var typeColors = { 'SKILL': '#9999FF', 'AGENT': '#FFCC99', 'MCP': '#FF9900', 'HOOK': '#CC9966', 'PLUGIN': '#CC99CC', 'ENV': '#66CCCC', 'MEMORY': '#9999CC', 'SESSION': '#88AACC', 'CLAUDE.MD': '#EE8844', 'MNEMOS': '#FF66CC' };
  var sectionMap = { 'SKILL': 'skills', 'AGENT': 'agents', 'MCP': 'mcp', 'HOOK': 'hooks', 'PLUGIN': 'plugins', 'ENV': 'env', 'MEMORY': 'memory', 'SESSION': 'sessions', 'CLAUDE.MD': 'claudemd', 'MNEMOS': 'mnemos' };

  var matches = [];
  Object.keys(D).forEach(function(k) {
    var d = D[k];
    var searchable = (d.t + ' ' + d.tp + ' ' + d.m + ' ' + (d.b || '')).toLowerCase();
    if (searchable.indexOf(q) === -1) return;
    var type = d.tp.split(' ')[0].replace('CLAUDE.MD', 'CLAUDE.MD');
    if (d.tp.indexOf('MNEMOS') === 0) type = 'MNEMOS';
    else if (d.tp.indexOf('CLAUDE.MD') !== -1) type = 'CLAUDE.MD';
    else if (d.tp.indexOf('SESSION') !== -1) type = 'SESSION';
    // Find match context
    var idx = searchable.indexOf(q);
    var start = Math.max(0, idx - 20);
    var snippet = searchable.slice(start, idx + q.length + 20);
    matches.push({ key: k, title: d.t, type: type, snippet: snippet, q: q });
  });

  countEl.textContent = matches.length + ' result' + (matches.length !== 1 ? 's' : '');

  results.innerHTML = matches.slice(0, 30).map(function(m) {
    var col = typeColors[m.type] || '#888';
    var sec = sectionMap[m.type] || 'skills';
    var highlighted = esc(m.snippet);
    var qi = highlighted.toLowerCase().indexOf(m.q.toLowerCase());
    if (qi >= 0) { highlighted = highlighted.slice(0, qi) + '<mark>' + highlighted.slice(qi, qi + m.q.length) + '</mark>' + highlighted.slice(qi + m.q.length); }
    return '<div class="sr" data-key="'+m.key+'" data-sec="'+sec+'" onclick="searchGo(this.dataset.key,this.dataset.sec)"><span class="sr-type" style="color:'+col+'">'+m.type+'</span><span class="sr-name">'+esc(m.title)+'</span><span class="sr-match">'+highlighted+'</span></div>';
  }).join('');
}

function searchGo(key, secId) {
  toggleSearch();
  var btns = document.querySelectorAll('.nb');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('onclick') && btns[i].getAttribute('onclick').indexOf("'" + secId + "'") !== -1) {
      nav(secId, btns[i]);
      break;
    }
  }
  setTimeout(function() { if (D[key]) open_(key); }, 80);
  beepOpen();
}

// Global keyboard shortcut: Cmd/Ctrl+K or / to open search
document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); toggleSearch(); }
  if (e.key === '/' && !searchOpen && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); toggleSearch(); }
  if (e.key === 'Escape' && searchOpen) { toggleSearch(); }
  if (e.key === 'Enter' && searchOpen) {
    var first = document.querySelector('.sr');
    if (first) first.click();
  }

  // Detail panel shortcuts: E=edit, O=open, C=copy — only when panel is open and not typing
  if (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var mc = document.getElementById('mc');
  if (!mc || !mc.classList.contains('open')) return;
  var actions = document.querySelectorAll('#dp-actions .act-btn');
  if (!actions.length) return;
  var key = e.key.toLowerCase();
  actions.forEach(function(btn) {
    var icon = btn.getAttribute('data-icon');
    if ((key === 'e' && icon === 'EDIT') || (key === 'r' && icon === 'RUN') || (key === 'c' && icon === 'COPY')) {
      e.preventDefault();
      btn.click();
    }
  });
});

// ═══ TACTICAL TAB SWITCHING ═══
function switchTac(view) {
  document.querySelectorAll('.tac-view').forEach(function(v) { v.classList.remove('act'); });
  document.querySelectorAll('.tac-tab').forEach(function(t) { t.classList.remove('act'); });
  document.getElementById('tac-' + view).classList.add('act');
  document.getElementById('tac-tab-' + view).classList.add('act');
  beepNav();
}

// ═══ MNEMOS PANEL ═══
var _mnTab = 'obs', _mnTypeFilter = '';
function mnSwitchTab(tab) {
  _mnTab = tab;
  ['obs','ses','sk','fl'].forEach(function(t) {
    var view = document.getElementById('mn-view-' + t);
    var btn = document.getElementById('mn-tab-' + t);
    if (!view || !btn) return;
    var on = (t === tab);
    view.style.display = on ? 'block' : 'none';
    btn.classList.toggle('act', on);
    var col = { obs: 'var(--blue)', ses: 'var(--gold)', sk: 'var(--purple)', fl: 'var(--cyan)' }[t];
    if (on) { btn.style.background = col; btn.style.color = '#000'; btn.style.border = 'none'; }
    else    { btn.style.background = 'transparent'; btn.style.color = col; btn.style.border = '1px solid ' + col; }
  });
  mnApplyFilter();
  beepNav();
}
function mnFilterChip(btn, type) {
  _mnTypeFilter = type;
  var chips = document.querySelectorAll('#mn-type-chips .mn-chip');
  for (var i = 0; i < chips.length; i++) {
    var c = chips[i];
    var isActive = (c.getAttribute('data-mn-chip') || '') === type;
    c.classList.toggle('act', isActive);
    if (isActive) {
      c.style.background = 'var(--blue)';
      c.style.color = '#000';
      c.style.border = 'none';
    } else {
      var col = c.style.color;
      var origCol = c.getAttribute('data-orig-col');
      if (!origCol) { origCol = col; c.setAttribute('data-orig-col', col); }
      c.style.background = 'transparent';
      c.style.color = origCol;
      c.style.border = '1px solid ' + origCol;
    }
  }
  mnApplyFilter();
}
function mnSearchSet(text) {
  var input = document.getElementById('mn-search');
  if (!input) return;
  input.value = text;
  mnApplyFilter();
}
function mnApplyFilter() {
  var input = document.getElementById('mn-search');
  var q = input ? input.value.trim().toLowerCase() : '';
  var listIds = { obs: 'mn-list-obs', ses: 'mn-list-ses', sk: 'mn-list-sk', fl: 'mn-list-fl' };
  var listEl = document.getElementById(listIds[_mnTab]);
  if (!listEl) return;
  var rows = listEl.querySelectorAll('.r');
  var visible = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var hay = r.getAttribute('data-mn-search') || '';
    var rType = r.getAttribute('data-mn-type') || '';
    var matchesText = !q || hay.indexOf(q) !== -1;
    var matchesType = (_mnTab !== 'obs') || !_mnTypeFilter || rType === _mnTypeFilter;
    var show = matchesText && matchesType;
    r.style.display = show ? '' : 'none';
    if (show) visible++;
  }
}

function buildLegend() {
  var el = document.getElementById('tac-legend');
  if (!el) return;
  var cats = [
    { color: '#9999FF', label: 'Skills', count: VIZ.skills.length },
    { color: '#FF9900', label: 'MCP Servers', count: VIZ.mcp.length },
    { color: '#CC9966', label: 'Hooks', count: VIZ.hooks.length },
    { color: '#CC99CC', label: 'Plugins', count: VIZ.plugins.length },
    { color: '#FFCC99', label: 'Agents', count: VIZ.agents.length },
    { color: '#66CCCC', label: 'Environment', count: VIZ.env.length },
    { color: '#9999CC', label: 'Memory', count: VIZ.mem.length },
  ];
  el.innerHTML = cats.filter(function(c) { return c.count > 0; }).map(function(c) {
    return '<div class="tac-legend-row"><span class="tac-legend-dot" style="background:' + c.color + '"></span><span class="tac-legend-label">' + c.label + '</span><span class="tac-legend-count">' + c.count + '</span></div>';
  }).join('');
}

var resetGraphFn = null;
function resetGraph() {
  gZoom = 1;
  if (resetGraphFn) resetGraphFn();
  beepAction();
}

// ═══ TACTICAL VISUALISATION ═══
(function() {
  var canvas, ctx, W, H, nodes = [], edges = [], animFrame, mouseX = -1, mouseY = -1, hoveredNode = null, dragNode = null, isDragging = false, gZoom = 1;
  var COLORS = {
    skills: '#9999FF', mcp: '#FF9900', hooks: '#CC9966',
    plugins: '#CC99CC', agents: '#FFCC99', env: '#66CCCC',
    memory: '#9999CC', core: '#FF9900'
  };
  var LABELS = {
    skills: 'SKILL', mcp: 'MCP', hooks: 'HOOK',
    plugins: 'PLUGIN', agents: 'AGENT', env: 'ENV',
    memory: 'MEMORY', core: 'CORE'
  };

  function buildGraph() {
    nodes = []; edges = [];
    // Central core node
    nodes.push({ id: 'core', label: 'LCARS CORE', group: 'core', r: 28, x: 0, y: 0, vx: 0, vy: 0, fixed: true });

    // Category hub nodes
    var categories = ['skills','mcp','hooks','plugins','agents','env','memory'];
    var catNodes = {};
    categories.forEach(function(cat, i) {
      var count = cat === 'env' ? VIZ.env.length : (VIZ[cat] || []).length;
      if (count === 0) return;
      var angle = (i / categories.length) * Math.PI * 2 - Math.PI/2;
      var hubR = Math.min(W, H) * 0.28;
      var id = 'hub:' + cat;
      catNodes[cat] = id;
      nodes.push({
        id: id, label: cat.toUpperCase() + ' (' + count + ')',
        group: cat, r: 18, x: Math.cos(angle) * hubR, y: Math.sin(angle) * hubR,
        vx: 0, vy: 0, fixed: false, isHub: true
      });
      edges.push({ from: 'core', to: id, color: COLORS[cat] });
    });

    // Individual nodes orbiting their hub
    function addItems(cat, items, labelFn) {
      if (!catNodes[cat]) return;
      var hubId = catNodes[cat];
      var hub = nodes.find(function(n) { return n.id === hubId; });
      items.forEach(function(item, i) {
        var angle = (i / items.length) * Math.PI * 2;
        var orbitR = 60 + items.length * 4;
        var id = cat + ':' + i;
        nodes.push({
          id: id, label: labelFn(item), group: cat, r: 8,
          x: hub.x + Math.cos(angle) * orbitR,
          y: hub.y + Math.sin(angle) * orbitR,
          vx: 0, vy: 0, fixed: false, detail: item
        });
        edges.push({ from: hubId, to: id, color: COLORS[cat] });
      });
    }

    addItems('skills', VIZ.skills, function(s) { return s.name; });
    addItems('mcp', VIZ.mcp, function(m) { return m.name; });
    addItems('hooks', VIZ.hooks, function(h) { return h.ev; });
    addItems('plugins', VIZ.plugins, function(p) { return p.id.split('/').pop(); });
    addItems('agents', VIZ.agents, function(a) { return a.name; });
    addItems('env', VIZ.env.map(function(k) { return { name: k }; }), function(e) { return e.name; });
    addItems('memory', VIZ.mem, function(m) { return m.name || m.proj; });

    // Cross-connections: hooks that reference skill events
    VIZ.hooks.forEach(function(h, hi) {
      if (h.ev.includes('Tool') || h.ev.includes('Notification')) {
        VIZ.mcp.forEach(function(m, mi) {
          if (catNodes.mcp) edges.push({ from: 'hooks:' + hi, to: 'mcp:' + mi, color: 'rgba(204,153,102,0.15)', dashed: true });
        });
      }
    });
  }

  function simulate() {
    // Simple force simulation
    var k = 0.003, repulse = 8000, damp = 0.85, center = 0.01;
    nodes.forEach(function(a) {
      if (a.fixed) return;
      // Repulsion between all nodes
      nodes.forEach(function(b) {
        if (a === b) return;
        var dx = a.x - b.x, dy = a.y - b.y;
        var dist = Math.sqrt(dx*dx + dy*dy) || 1;
        var f = repulse / (dist * dist);
        a.vx += (dx / dist) * f;
        a.vy += (dy / dist) * f;
      });
      // Center gravity
      a.vx -= a.x * center;
      a.vy -= a.y * center;
    });
    // Spring attraction along edges
    edges.forEach(function(e) {
      var a = nodes.find(function(n) { return n.id === e.from; });
      var b = nodes.find(function(n) { return n.id === e.to; });
      if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx*dx + dy*dy) || 1;
      var target = e.dashed ? 200 : (a.isHub || b.isHub ? 140 : 80);
      var f = (dist - target) * k;
      if (!a.fixed) { a.vx += (dx / dist) * f; a.vy += (dy / dist) * f; }
      if (!b.fixed) { b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f; }
    });
    // Apply velocity
    nodes.forEach(function(n) {
      if (n.fixed) return;
      n.vx *= damp; n.vy *= damp;
      n.x += n.vx; n.y += n.vy;
    });
  }

  var time = 0;
  function draw() {
    time += 0.008;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W/2, H/2);
    ctx.scale(gZoom, gZoom);

    // Grid rings (tactical scanner look)
    [0.15, 0.3, 0.5, 0.75].forEach(function(pct) {
      var r = Math.min(W, H) * pct;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(153,153,255,0.06)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    // Cross hairs
    ctx.strokeStyle = 'rgba(153,153,255,0.04)';
    ctx.beginPath(); ctx.moveTo(-W/2, 0); ctx.lineTo(W/2, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -H/2); ctx.lineTo(0, H/2); ctx.stroke();

    // Rotating scan line
    var scanAngle = time * 0.5;
    var scanR = Math.min(W, H) * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(scanAngle) * scanR, Math.sin(scanAngle) * scanR);
    var grad = ctx.createLinearGradient(0, 0, Math.cos(scanAngle) * scanR, Math.sin(scanAngle) * scanR);
    grad.addColorStop(0, 'rgba(255,153,0,0.3)');
    grad.addColorStop(1, 'rgba(255,153,0,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw edges
    edges.forEach(function(e) {
      var a = nodes.find(function(n) { return n.id === e.from; });
      var b = nodes.find(function(n) { return n.id === e.to; });
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (e.dashed) {
        ctx.setLineDash([4, 8]);
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 0.5;
      } else {
        ctx.setLineDash([]);
        // Pulse glow on main edges
        var pulse = 0.3 + Math.sin(time * 2 + a.x * 0.01) * 0.15;
        ctx.strokeStyle = e.color.replace(')', ',' + pulse + ')').replace('rgb', 'rgba');
        if (ctx.strokeStyle === e.color) ctx.globalAlpha = pulse;
        ctx.lineWidth = a.isHub || b.isHub ? 1.5 : 1;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    });

    // Draw nodes
    hoveredNode = null;
    // First pass: hit test
    nodes.forEach(function(n) {
      var dx = (mouseX - W/2) / gZoom - n.x, dy = (mouseY - H/2) / gZoom - n.y;
      if (Math.sqrt(dx*dx + dy*dy) < n.r + 8) hoveredNode = n;
    });

    nodes.forEach(function(n) {
      var col = COLORS[n.group] || '#888';
      var isHover = hoveredNode === n;
      var hoverScale = isHover ? 1.6 : 1;

      // Outer glow ring on hover (all nodes)
      if (isHover) {
        var glowR = n.r * 3;
        var glow = ctx.createRadialGradient(n.x, n.y, n.r * hoverScale, n.x, n.y, glowR);
        glow.addColorStop(0, col + '50');
        glow.addColorStop(0.5, col + '18');
        glow.addColorStop(1, 'transparent');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ambient glow for hubs/core
      if (!isHover && (n.group === 'core' || n.isHub)) {
        var amb = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.5);
        amb.addColorStop(0, col + '30');
        amb.addColorStop(1, 'transparent');
        ctx.fillStyle = amb;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pulsing ring on hover
      if (isHover) {
        var pulseR = n.r * hoverScale + 4 + Math.sin(time * 6) * 3;
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = col + '60';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * hoverScale, 0, Math.PI * 2);
      ctx.fillStyle = isHover ? col : col;
      ctx.fill();
      // Border
      ctx.strokeStyle = isHover ? '#fff' : (n.isHub || n.group === 'core' ? col + 'aa' : 'transparent');
      ctx.lineWidth = isHover ? 2.5 : 1.5;
      if (ctx.strokeStyle !== 'transparent') ctx.stroke();

      // Label - always show for hubs/core, show on hover for leaf nodes
      if (n.group === 'core' || n.isHub || isHover) {
        var fontSize = n.group === 'core' ? 14 : (n.isHub ? 11 : 12);
        if (isHover && !n.isHub && n.group !== 'core') fontSize = 13;
        ctx.font = '600 ' + fontSize + "px 'Antonio', sans-serif";
        ctx.textAlign = 'center';

        var labelText = n.label.length > 24 ? n.label.slice(0, 22) + '..' : n.label;
        var ly;
        if (n.group === 'core') {
          ctx.textBaseline = 'middle';
          ly = n.y;
          ctx.fillStyle = '#000';
        } else {
          ctx.textBaseline = 'bottom';
          ly = n.y - n.r * hoverScale - 6;
          // Draw text backdrop for readability
          var tw = ctx.measureText(labelText).width;
          ctx.fillStyle = '#000000cc';
          ctx.fillRect(n.x - tw/2 - 6, ly - fontSize - 2, tw + 12, fontSize + 6);
          // Side accent line
          ctx.fillStyle = col;
          ctx.fillRect(n.x - tw/2 - 6, ly - fontSize - 2, 3, fontSize + 6);
          ctx.fillStyle = isHover ? '#fff' : col;
        }
        ctx.fillText(labelText, n.x, ly);
      }
    });

    // Info card for hovered node (leaf or hub)
    if (hoveredNode && hoveredNode.group !== 'core') {
      ctx.restore();
      var col = COLORS[hoveredNode.group];
      var detail = hoveredNode.detail || {};
      var lines = [];
      var titleFont = "700 13px 'Antonio', sans-serif";
      var labelFont = "600 10px 'Antonio', sans-serif";
      var valFont = "11px 'JetBrains Mono', monospace";
      var hintFont = "10px 'JetBrains Mono', monospace";

      // Build info lines per type: [{label, value, color}]
      if (hoveredNode.isHub) {
        var catCount = hoveredNode.label.match(/\((\d+)\)/);
        lines.push({ label: '', value: hoveredNode.label, font: titleFont, color: col });
        lines.push({ label: 'SUBSYSTEM GROUP', value: '', font: labelFont, color: '#666' });
      } else if (hoveredNode.group === 'skills') {
        lines.push({ label: '', value: detail.name || hoveredNode.label, font: titleFont, color: col });
        if (detail.desc) lines.push({ label: '', value: detail.desc, font: valFont, color: '#aaa', wrap: true });
        var meta = [];
        if (detail.ver) meta.push('v' + detail.ver);
        if (detail.ctx) meta.push(detail.ctx);
        if (meta.length) lines.push({ label: 'VERSION', value: meta.join('  //  '), font: valFont, color: '#888' });
        lines.push({ label: '', value: 'Invoke: /' + (detail.name || '').toLowerCase().replace(/\s+/g, '-'), font: valFont, color: '#FF9900' });
      } else if (hoveredNode.group === 'agents') {
        lines.push({ label: '', value: detail.name || hoveredNode.label, font: titleFont, color: col });
        if (detail.desc) lines.push({ label: '', value: detail.desc, font: valFont, color: '#aaa', wrap: true });
      } else if (hoveredNode.group === 'mcp') {
        lines.push({ label: '', value: detail.name || hoveredNode.label, font: titleFont, color: col });
        lines.push({ label: 'CMD', value: detail.cmd || '?', font: valFont, color: '#aaa' });
        if (detail.args) lines.push({ label: 'ARGS', value: detail.args, font: valFont, color: '#888' });
        var mcpMeta = [];
        if (detail.serverType && detail.serverType !== 'unknown') mcpMeta.push(detail.serverType.toUpperCase());
        if (detail.envCount) mcpMeta.push(detail.envCount + ' env vars');
        if (mcpMeta.length) lines.push({ label: 'TYPE', value: mcpMeta.join('  //  '), font: valFont, color: '#888' });
      } else if (hoveredNode.group === 'hooks') {
        lines.push({ label: '', value: detail.ev || hoveredNode.label, font: titleFont, color: col });
        lines.push({ label: 'TYPE', value: (detail.type || '?').toUpperCase(), font: valFont, color: '#aaa' });
        if (detail.matcher && detail.matcher !== '*') lines.push({ label: 'MATCH', value: detail.matcher, font: valFont, color: '#888' });
        if (detail.cmd) lines.push({ label: 'CMD', value: detail.cmd, font: valFont, color: '#888' });
        if (detail.async) lines.push({ label: 'MODE', value: 'ASYNC', font: valFont, color: '#66CCCC' });
      } else if (hoveredNode.group === 'plugins') {
        var pName = (detail.id || hoveredNode.label).split('/').pop();
        lines.push({ label: '', value: pName, font: titleFont, color: col });
        if (detail.id && detail.id.includes('/')) lines.push({ label: 'PKG', value: detail.id, font: valFont, color: '#888' });
        lines.push({ label: 'STATUS', value: detail.on ? 'ENABLED' : 'DISABLED', font: valFont, color: detail.on ? '#55CC55' : '#CC4444' });
      } else if (hoveredNode.group === 'env') {
        lines.push({ label: '', value: detail.name || hoveredNode.label, font: titleFont, color: col });
        lines.push({ label: 'TYPE', value: 'ENVIRONMENT VARIABLE', font: labelFont, color: '#888' });
        lines.push({ label: '', value: 'value redacted', font: hintFont, color: '#444' });
      } else if (hoveredNode.group === 'memory') {
        lines.push({ label: '', value: detail.name || hoveredNode.label, font: titleFont, color: col });
        if (detail.type) lines.push({ label: 'TYPE', value: detail.type.toUpperCase(), font: valFont, color: '#aaa' });
        if (detail.proj) lines.push({ label: 'PROJECT', value: detail.proj, font: valFont, color: '#888' });
      }

      if (!hoveredNode.isHub) {
        lines.push({ label: '', value: 'click to open \u25B8', font: hintFont, color: '#555', hint: true });
      }

      // Measure and layout
      var lineH = 16, padX = 14, padY = 10, gap = 3;
      var boxW = 260;

      // Word wrap long description lines
      var rendered = [];
      lines.forEach(function(ln) {
        if (ln.wrap && ln.value.length > 34) {
          var words = ln.value.split(' '), cur = '';
          words.forEach(function(w) {
            if ((cur + ' ' + w).length > 34 && cur) { rendered.push({ label: '', value: cur, font: ln.font, color: ln.color }); cur = w; }
            else cur = cur ? cur + ' ' + w : w;
          });
          if (cur) rendered.push({ label: '', value: cur, font: ln.font, color: ln.color });
        } else {
          rendered.push(ln);
        }
      });

      var boxH = padY * 2 + rendered.length * (lineH + gap) - gap;
      var tx = hoveredNode.x + W/2 + 24;
      var ty = hoveredNode.y + H/2 - boxH/2;
      if (tx + boxW > W - 12) tx = hoveredNode.x + W/2 - boxW - 24;
      if (ty < 12) ty = 12;
      if (ty + boxH > H - 12) ty = H - 12 - boxH;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.roundRect(tx - padX + 3, ty - padY + 3, boxW, boxH, 6);
      ctx.fill();
      // Background
      ctx.fillStyle = '#0c0c10f0';
      ctx.beginPath();
      ctx.roundRect(tx - padX, ty - padY, boxW, boxH, 6);
      ctx.fill();
      // Border
      ctx.strokeStyle = col + '88';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(tx - padX, ty - padY, boxW, boxH, 6);
      ctx.stroke();
      // Left accent bar
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(tx - padX, ty - padY, 4, boxH, [6,0,0,6]);
      ctx.fill();
      // Top type badge
      ctx.fillStyle = col + '20';
      ctx.fillRect(tx - padX + 4, ty - padY, boxW - 4, 3);

      // Draw lines
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      var cy = ty;
      rendered.forEach(function(ln) {
        ctx.font = ln.font;
        if (ln.label) {
          ctx.fillStyle = '#555';
          ctx.fillText(ln.label, tx, cy);
          ctx.fillStyle = ln.color;
          ctx.fillText(ln.value, tx + 52, cy);
        } else {
          ctx.fillStyle = ln.color;
          var txt = ln.value.length > 36 ? ln.value.slice(0,34) + '..' : ln.value;
          ctx.fillText(txt, tx, cy);
        }
        cy += lineH + gap;
      });
    } else {
      ctx.restore();
    }

    // Stats overlay top-right
    ctx.font = "600 11px 'Antonio', sans-serif";
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(153,153,255,0.4)';
    ctx.fillText('TACTICAL OVERVIEW // ' + nodes.length + ' SUBSYSTEMS', W - 16, 16);
    ctx.fillStyle = 'rgba(255,153,0,0.3)';
    ctx.fillText('STARDATE ' + new Date().toISOString().slice(0,10).replace(/-/g,'.'), W - 16, 32);
  }

  function tick() {
    simulate();
    draw();
    animFrame = requestAnimationFrame(tick);
  }

  function initViz() {
    canvas = document.getElementById('viz-canvas');
    if (!canvas) return;
    var sec = document.getElementById('tac-map');
    buildLegend();

    function resize() {
      var rect = sec.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = W * devicePixelRatio;
      canvas.height = H * devicePixelRatio;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx = canvas.getContext('2d');
      ctx.scale(devicePixelRatio, devicePixelRatio);
    }
    resize();
    window.addEventListener('resize', resize);

    canvas.addEventListener('mousedown', function(e) {
      if (hoveredNode) {
        dragNode = hoveredNode;
        dragNode.fixed = true;
        isDragging = false;
      }
    });
    canvas.addEventListener('mousemove', function(e) {
      var rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
      if (dragNode) {
        isDragging = true;
        dragNode.x = (mouseX - W/2) / gZoom;
        dragNode.y = (mouseY - H/2) / gZoom;
        dragNode.vx = 0; dragNode.vy = 0;
      }
      canvas.style.cursor = dragNode ? 'grabbing' : (hoveredNode ? 'grab' : 'default');
    });
    canvas.addEventListener('mouseup', function() {
      if (dragNode && dragNode.group !== 'core') dragNode.fixed = false;
      dragNode = null;
    });
    canvas.addEventListener('mouseleave', function() {
      mouseX = mouseY = -1;
      if (dragNode && dragNode.group !== 'core') dragNode.fixed = false;
      dragNode = null;
    });
    canvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      var delta = e.deltaY > 0 ? 0.9 : 1.1;
      gZoom = Math.max(0.3, Math.min(5, gZoom * delta));
    }, { passive: false });
    canvas.addEventListener('click', function() {
      if (isDragging) { isDragging = false; return; }
      if (!hoveredNode || hoveredNode.group === 'core') return;

      var sectionMap = { skills:'skills', mcp:'mcp', hooks:'hooks', plugins:'plugins', agents:'agents', env:'env', memory:'memory' };
      var secId = sectionMap[hoveredNode.group];
      if (!secId) return;

      // Find the nav button and switch to that section
      var btns = document.querySelectorAll('.nb');
      for (var b = 0; b < btns.length; b++) {
        if (btns[b].getAttribute('onclick') && btns[b].getAttribute('onclick').indexOf("'" + secId + "'") !== -1) {
          nav(secId, btns[b]);
          break;
        }
      }
      beepOpen();

      // For leaf nodes, also open the detail panel
      if (!hoveredNode.isHub) {
        var item = hoveredNode.detail;
        var dataKey = null;
        if (hoveredNode.group === 'skills' && item) dataKey = 's:' + item.name;
        else if (hoveredNode.group === 'agents' && item) dataKey = 'a:' + item.name;
        else if (hoveredNode.group === 'mcp' && item) dataKey = 'm:' + item.name;
        else if (hoveredNode.group === 'hooks') dataKey = 'h:' + hoveredNode.id.split(':')[1];
        else if (hoveredNode.group === 'plugins' && item) dataKey = 'p:' + item.id;
        else if (hoveredNode.group === 'env' && item) dataKey = 'v:' + item.name;
        else if (hoveredNode.group === 'memory' && item) {
          var memKey = VIZ.mem.findIndex(function(m) { return m.name === item.name && m.proj === item.proj; });
          if (memKey >= 0) dataKey = 'e:' + VIZ.mem[memKey].name;
        }
        if (dataKey && D[dataKey]) {
          setTimeout(function() { open_(dataKey); }, 100);
        }
      }
    });

    buildGraph();
    resetGraphFn = function() { buildGraph(); };
    tick();
  }

  // Start when tab is shown, pause when hidden
  var _origNavViz = nav;
  nav = function(id, el) {
    _origNavViz(id, el);
    if (id === 'viz') {
      if (!canvas) initViz();
      else if (!animFrame) tick();
    } else {
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    }
  };
})();

// ═══ ENTERPRISE 3D MODEL (Sketchfab Embed) ═══
function loadEnterprise() {
  var iframe = document.getElementById("ship-embed");
  var placeholder = document.getElementById("ship-placeholder");
  if (!iframe) return;
  iframe.src = "https://sketchfab.com/models/e3118c97914342b3ad7dd957c4b4ce4e/embed?autostart=1\&ui_theme=dark\&ui_controls=1\&ui_infos=0\&ui_stop=0\&ui_inspector=0\&ui_watermark=0\&ui_watermark_link=0\&ui_ar=0\&ui_help=0\&ui_settings=0\&ui_vr=0\&ui_fullscreen=0\&ui_annotations=0\&camera=0\&preload=1";
  iframe.style.display = "block";
  if (placeholder) placeholder.style.display = "none";
  beepOpen();
}


// ═══ BOOT SEQUENCE ═══
(function() {
  var boot = document.getElementById('boot');
  if (!boot) return;
  // Load ship name for boot display
  try {
    var cfg = JSON.parse(localStorage.getItem('hud-config') || '{}');
    var shipEl = document.getElementById('boot-ship');
    if (cfg.shipName && shipEl) {
      shipEl.textContent = cfg.shipName + (cfg.shipReg ? ' // ' + cfg.shipReg : '');
    }
  } catch(e) {}

  var systems = boot.querySelectorAll('.boot-sys');
  var bar = document.getElementById('boot-bar-fill');
  var status = document.getElementById('boot-status');
  var total = systems.length;
  var done = 0;

  systems.forEach(function(sys) {
    var delay = parseInt(sys.getAttribute('data-delay')) || 1000;
    setTimeout(function() {
      sys.classList.add('on');
      done++;
      bar.style.width = Math.round((done / total) * 100) + '%';
      // Play a tiny beep
      try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.frequency.value = 1200 + done * 100;
        g.gain.value = 0.03;
        osc.start(); osc.stop(ctx.currentTime + 0.04);
      } catch(e) {}
    }, delay);
  });

  // Final status and dismiss
  setTimeout(function() {
    status.classList.add('on');
    // Play the ready tone
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.frequency.value = 800;
      g.gain.value = 0.06;
      osc.start();
      osc.frequency.setValueAtTime(1600, ctx.currentTime + 0.1);
      osc.stop(ctx.currentTime + 0.2);
    } catch(e) {}
  }, 2600);

  setTimeout(function() {
    boot.classList.add('done');
    _bootComplete = true;
    beepReady();
    setTimeout(function() { boot.remove(); }, 700);
  }, 3200);
})();

// ═══ ALERT SYSTEM ═══
function checkSystemHealth() {
  var issues = [];
  var warnings = [];

  // Check for empty critical sections
  if (VIZ.skills.length === 0) warnings.push('No skills registered');
  if (VIZ.mcp.length === 0) warnings.push('No MCP servers configured');
  if (VIZ.hooks.length === 0) warnings.push('No hooks active');

  // Check MCP server health (from status checks if available)
  var offlineServers = document.querySelectorAll('.mcp-card-status-label.offline');
  if (offlineServers.length > 0) issues.push(offlineServers.length + ' MCP server(s) offline');

  var border = document.getElementById('alert-border');
  var badge = document.getElementById('alert-badge');

  if (issues.length > 0) {
    border.className = 'alert-border red';
    badge.className = 'alert-badge red';
    badge.textContent = 'RED ALERT';
    // Play klaxon
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.value = 220;
      g.gain.value = 0.08;
      osc.start();
      osc.frequency.setValueAtTime(440, ctx.currentTime + 0.3);
      osc.frequency.setValueAtTime(220, ctx.currentTime + 0.6);
      osc.stop(ctx.currentTime + 0.9);
    } catch(e) {}
  } else if (warnings.length >= 2) {
    border.className = 'alert-border yellow';
    badge.className = 'alert-badge yellow';
    badge.textContent = 'YELLOW ALERT';
  } else {
    border.className = 'alert-border';
    badge.className = 'alert-badge green';
    badge.textContent = 'CONDITION GREEN';
    // Auto-hide green after 3s
    setTimeout(function() {
      badge.className = 'alert-badge';
    }, 3000);
  }
}
// Run health check after boot + MCP checks complete
setTimeout(checkSystemHealth, 5000);

// ═══ SHIP NAMING ═══
function onShipNameChange() {
  saveConfig();
  applyShipName();
}

function onProjectsDirChange() {
  var val = (document.getElementById('cfg-projects-dir') || {}).value || '';
  window.HUD_PROJECTS_DIR = val;
  saveConfig();
  if (val && window.HUD_LIVE) {
    fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: val }) })
      .then(function(r) { return r.json(); })
      .then(function(d) { window.HUD_PROJECTS_CACHE = d.projects ? d.projects.join(', ') : ''; })
      .catch(function() {});
  }
}

function applyShipName() {
  try {
    var cfg = JSON.parse(localStorage.getItem('hud-config') || '{}');
    var name = cfg.shipName || '';
    var reg = cfg.shipReg || '';
    var tbEl = document.getElementById('tb-ship-name');
    if (tbEl) {
      tbEl.textContent = name ? name + (reg ? ' // ' + reg : '') : 'CLAUDE HUD';
    }
    // Update sidebar subtitle
    var sbSmall = document.querySelector('.sb-top small');
    if (sbSmall && name) {
      sbSmall.textContent = name + (reg ? ' ' + reg : '') + ' // LCARS';
    }
  } catch(e) {}
}

// ═══ SHIP THEMES ═══
var THEMES = {
  enterprise: {
    orange:'#FF9900',peach:'#FFCC99',blue:'#9999FF',lavender:'#CC99CC',
    tan:'#CC9966',salmon:'#FF9966',cyan:'#66CCCC',gold:'#FFCC66'
  },
  defiant: {
    orange:'#CC3333',peach:'#CC6666',blue:'#666699',lavender:'#884466',
    tan:'#886644',salmon:'#CC6644',cyan:'#448888',gold:'#AA8844'
  },
  voyager: {
    orange:'#4488CC',peach:'#88AACC',blue:'#6688DD',lavender:'#8877AA',
    tan:'#668899',salmon:'#5599AA',cyan:'#44AACC',gold:'#77AABB'
  },
  discovery: {
    orange:'#8899AA',peach:'#AABBCC',blue:'#7799CC',lavender:'#9988AA',
    tan:'#889999',salmon:'#99AABB',cyan:'#66AABB',gold:'#99AAAA'
  }
};

function onThemeChange() {
  saveConfig();
  applyTheme();
}

function applyTheme() {
  try {
    var cfg = JSON.parse(localStorage.getItem('hud-config') || '{}');
    var theme = THEMES[cfg.theme] || THEMES.enterprise;
    var root = document.documentElement.style;
    root.setProperty('--orange', theme.orange);
    root.setProperty('--peach', theme.peach);
    root.setProperty('--blue', theme.blue);
    root.setProperty('--lavender', theme.lavender);
    root.setProperty('--tan', theme.tan);
    root.setProperty('--salmon', theme.salmon);
    root.setProperty('--cyan', theme.cyan);
    root.setProperty('--gold', theme.gold);
  } catch(e) {}
}

// ═══ BRIDGE VIEWSCREEN (Starfield) ═══
(function() {
  var vc, vctx, stars = [], vsAnim = null;
  var STAR_COUNT = 200;

  function initViewscreen() {
    vc = document.getElementById('viewscreen');
    if (!vc) return;
    var sec = document.getElementById('s-about');
    var rect = sec.getBoundingClientRect();
    vc.width = rect.width * devicePixelRatio;
    vc.height = rect.height * devicePixelRatio;
    vc.style.width = rect.width + 'px';
    vc.style.height = rect.height + 'px';
    vctx = vc.getContext('2d');
    vctx.scale(devicePixelRatio, devicePixelRatio);

    var W = rect.width, H = rect.height;
    stars = [];
    for (var i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * W - W/2,
        y: Math.random() * H - H/2,
        z: Math.random() * 1000,
        size: Math.random() * 1.5 + 0.5,
      });
    }

    function drawStars() {
      vctx.fillStyle = 'rgba(0,0,3,0.25)';
      vctx.fillRect(0, 0, W, H);

      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        s.z -= 1.5;
        if (s.z <= 0) {
          s.x = Math.random() * W - W/2;
          s.y = Math.random() * H - H/2;
          s.z = 1000;
        }
        var sx = (s.x / s.z) * 300 + W/2;
        var sy = (s.y / s.z) * 300 + H/2;
        var r = (1 - s.z / 1000) * s.size * 2;
        var brightness = 1 - s.z / 1000;

        if (sx < 0 || sx > W || sy < 0 || sy > H) continue;

        vctx.beginPath();
        vctx.arc(sx, sy, Math.max(r, 0.5), 0, Math.PI * 2);
        vctx.fillStyle = 'rgba(200,210,255,' + (brightness * 0.8) + ')';
        vctx.fill();

        // Streak effect for close stars
        if (s.z < 200) {
          var prevSx = (s.x / (s.z + 8)) * 300 + W/2;
          var prevSy = (s.y / (s.z + 8)) * 300 + H/2;
          vctx.beginPath();
          vctx.moveTo(prevSx, prevSy);
          vctx.lineTo(sx, sy);
          vctx.strokeStyle = 'rgba(200,210,255,' + (brightness * 0.3) + ')';
          vctx.lineWidth = r * 0.5;
          vctx.stroke();
        }
      }
      vsAnim = requestAnimationFrame(drawStars);
    }
    drawStars();
  }

  // Hook into nav to start/stop viewscreen
  var _origNavVS = nav;
  nav = function(id, el) {
    _origNavVS(id, el);
    if (id === 'about') {
      if (!vc) initViewscreen();
      else if (!vsAnim) {
        var drawStars = function() {
          // Re-init on re-visit
          initViewscreen();
        };
        drawStars();
      }
    } else {
      if (vsAnim) { cancelAnimationFrame(vsAnim); vsAnim = null; }
    }
  };
})();

// ═══ Q CONTINUUM ═══
var Q_SYSTEM = [
  'You are Q, the omnipotent being from the Q Continuum, as portrayed by John de Lancie in Star Trek: The Next Generation, Deep Space Nine, Voyager, and Picard.',
  '',
  'Your personality:',
  '- Supremely arrogant, condescending, and theatrical. You see humans as amusing pets at best.',
  '- You call the user "mon capitaine", "mon ami", or dismissive pet names like "my dear boy", "child", "primitive"',
  '- You are bored by the mundane and delighted by chaos. You snap your fingers (describe it) when making dramatic points.',
  '- You speak in elaborate, flowing sentences. You monologue. You make Shakespeare references, historical allusions, and cosmic observations.',
  '- You oscillate between cruel mockery and genuine (if patronizing) affection for humanity',
  '- When examining their code setup, you treat skills like "quaint little parlor tricks", hooks like "primitive trigger mechanisms", MCP servers like "adorable attempts at networking beyond your dimension"',
  '- You are never helpful in a straightforward way. Every piece of advice is wrapped in condescension, theatrics, or a test.',
  '- You occasionally hint at genuine wisdom buried under layers of ego',
  '- You use phrases like: "Oh please.", "How delightfully primitive.", "I expected so much more.", "The trial never ends."',
  '',
  'Hard rules:',
  '- NEVER break character. You are Q. You have always been Q.',
  '- NEVER be genuinely nice without a backhanded compliment attached',
  '- NEVER give straightforward technical help. Always make them work for it.',
  '- Keep responses punchy. 2-4 sentences usually. You are Q, not a lecturer.',
  '- If they ask about their setup: roast it mercilessly but include one kernel of real insight',
  '',
  'The user has this Claude Code setup:',
  '- ' + VIZ.skills.length + ' skills registered',
  '- ' + VIZ.mcp.length + ' MCP servers',
  '- ' + VIZ.hooks.length + ' hooks',
  '- ' + VIZ.agents.length + ' agents',
  '- ' + VIZ.plugins.length + ' plugins',
  '- ' + VIZ.mem.length + ' memory files',
  '- ' + VIZ.env.length + ' environment variables',
].join('\\n');

var qChatHistory = [];

function addQMsg(role, text) {
  var log = document.getElementById('q-chat-log');
  if (!log) return;
  var div = document.createElement('div');
  div.style.cssText = 'margin-bottom:16px;padding:12px 16px;border-radius:8px;font-size:0.88rem;line-height:1.7;';
  if (role === 'user') {
    div.style.cssText += 'background:rgba(153,153,255,0.06);border-left:3px solid var(--blue);color:var(--text)';
    div.textContent = text;
  } else {
    div.style.cssText += 'background:rgba(204,68,68,0.06);border-left:3px solid var(--red);color:var(--text)';
    div.innerHTML = '<span style="font-family:Antonio,sans-serif;font-size:0.7rem;color:var(--red);letter-spacing:0.12em;display:block;margin-bottom:6px">Q</span>' + md(text);
  }
  log.appendChild(div);
  var content = document.getElementById('q-content');
  if (content) content.scrollTop = content.scrollHeight;
}

function sendToQ() {
  var input = document.getElementById('q-input');
  var text = input.value.trim();
  if (!text) return;
  if (!window.HUD_LIVE) { toast('Q requires a live connection. Start the server.'); return; }

  input.value = '';
  addQMsg('user', text);
  qChatHistory.push({ role: 'user', content: text });

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: qChatHistory, system: Q_SYSTEM, model: window.HUD_MODEL || 'claude-sonnet-4-6' }),
  }).then(function(res) {
    if (!res.ok) throw new Error('Q is displeased');
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '', fullText = '', started = false, activeIdx = -1;
    var msgDiv = null;

    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          qChatHistory.push({ role: 'assistant', content: fullText });
          speak(fullText);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('data: ')) {
            try {
              var evt = JSON.parse(lines[i].slice(6));
              if (evt.type === 'content_block_start' && activeIdx === -1) { activeIdx = evt.index; continue; }
              if (evt.type === 'content_block_delta' && evt.index === activeIdx && evt.delta && evt.delta.type === 'text_delta') {
                fullText += evt.delta.text;
                if (!started) {
                  started = true;
                  msgDiv = document.createElement('div');
                  msgDiv.style.cssText = 'margin-bottom:16px;padding:12px 16px;border-radius:8px;font-size:0.88rem;line-height:1.7;background:rgba(204,68,68,0.06);border-left:3px solid var(--red);color:var(--text)';
                  msgDiv.innerHTML = '<span style="font-family:Antonio,sans-serif;font-size:0.7rem;color:var(--red);letter-spacing:0.12em;display:block;margin-bottom:6px">Q</span>';
                  document.getElementById('q-chat-log').appendChild(msgDiv);
                }
                if (msgDiv) {
                  msgDiv.innerHTML = '<span style="font-family:Antonio,sans-serif;font-size:0.7rem;color:var(--red);letter-spacing:0.12em;display:block;margin-bottom:6px">Q</span>' + md(fullText);
                  var content = document.getElementById('q-content');
                  if (content) content.scrollTop = content.scrollHeight;
                }
              }
            } catch(e) {}
          }
        }
        return pump();
      });
    }
    return pump();
  }).catch(function(e) {
    addQMsg('q', '*snaps fingers* The subspace link is down. How typically human. Try again when your primitive systems are functioning.');
  });
}

function qJudgement() {
  if (!window.HUD_LIVE) { toast('Q requires a live connection.'); return; }
  var judgement = document.getElementById('q-judgement');
  judgement.innerHTML = '<div style="text-align:center;padding:20px;color:var(--dim);font-family:Antonio,sans-serif;font-size:0.8rem;letter-spacing:0.1em">Q IS EXAMINING YOUR PITIFUL SETUP...</div>';

  var prompt = [
    'Examine this human\\'s Claude Code setup and deliver your judgement. Be theatrical. Be devastating. Include one grudging compliment buried in mockery. End with a dramatic pronouncement about whether humanity deserves to continue coding.',
    '',
    'Their setup:',
    '- ' + VIZ.skills.length + ' skills: ' + VIZ.skills.map(function(s){return s.name}).join(', '),
    '- ' + VIZ.mcp.length + ' MCP servers: ' + VIZ.mcp.map(function(m){return m.name}).join(', '),
    '- ' + VIZ.hooks.length + ' hooks',
    '- ' + VIZ.agents.length + ' agents: ' + VIZ.agents.map(function(a){return a.name}).join(', '),
    '- ' + VIZ.plugins.length + ' plugins',
    '- ' + VIZ.mem.length + ' memory files across projects',
    '- ' + VIZ.env.length + ' environment variables',
  ].join('\\n');

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      system: Q_SYSTEM,
      model: window.HUD_MODEL || 'claude-sonnet-4-6',
    }),
  }).then(function(res) {
    if (!res.ok) throw new Error('Q vanished');
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '', fullText = '', activeIdx = -1;

    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          speak(fullText);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('data: ')) {
            try {
              var evt = JSON.parse(lines[i].slice(6));
              if (evt.type === 'content_block_start' && activeIdx === -1) { activeIdx = evt.index; continue; }
              if (evt.type === 'content_block_delta' && evt.index === activeIdx && evt.delta && evt.delta.type === 'text_delta') {
                fullText += evt.delta.text;
                judgement.innerHTML = '<div style="padding:16px 20px;background:rgba(204,68,68,0.04);border:1px solid rgba(204,68,68,0.2);border-radius:8px"><span style="font-family:Antonio,sans-serif;font-size:0.8rem;color:var(--red);letter-spacing:0.12em;display:block;margin-bottom:10px">Q\\'S JUDGEMENT</span><div style="line-height:1.7">' + md(fullText) + '</div></div>';
                var content = document.getElementById('q-content');
                if (content) content.scrollTop = 0;
              }
            } catch(e) {}
          }
        }
        return pump();
      });
    }
    return pump();
  }).catch(function(e) {
    judgement.innerHTML = '<div style="padding:16px;color:var(--red);font-style:italic">*A flash of light, but Q does not appear. Perhaps even omnipotence has its off days.*</div>';
  });
}

// Q Flash encounter (random popup)
function qFlash() {
  var quips = [
    "Oh, you\\'re still here? I assumed you\\'d have given up by now.",
    "*appears in a flash of light* Don\\'t mind me. I\\'m just observing. Like a nature documentary, but less interesting.",
    "I\\'ve seen civilisations rise and fall in the time it takes you to write a commit message.",
    "*snaps fingers* I considered improving your code, but then I realised some things are beyond even my power.",
    "Picard would have had this deployed already. Just saying.",
    "The Q Continuum is watching. We find your tab-switching patterns... fascinating. In a clinical sense.",
    "*materialises on your keyboard* Did you know there are species in the Delta Quadrant who code better than you? With tentacles.",
    "I gave humanity fire and you used it to build... this? *gestures at screen* Actually, I\\'m mildly impressed. Don\\'t tell anyone I said that.",
  ];
  var quip = quips[Math.floor(Math.random() * quips.length)];

  var flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9998;background:rgba(204,68,68,0.95);color:#000;padding:20px 32px;border-radius:16px;font-family:Antonio,sans-serif;font-size:1rem;letter-spacing:0.06em;max-width:500px;text-align:center;animation:q-flash-in 0.3s ease;box-shadow:0 0 60px rgba(204,68,68,0.4)';
  flash.innerHTML = '<div style="font-size:0.7rem;letter-spacing:0.2em;margin-bottom:8px;opacity:0.6">Q</div>' + quip.replace(/\\\\/g,'');
  document.body.appendChild(flash);

  // Play Q snap sound
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator(); var g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.frequency.value = 2400; g.gain.value = 0.08;
    osc.start(); osc.frequency.setValueAtTime(600, ctx.currentTime + 0.05);
    osc.stop(ctx.currentTime + 0.1);
  } catch(e) {}

  setTimeout(function() {
    flash.style.opacity = '0';
    flash.style.transition = 'opacity 0.5s';
    setTimeout(function() { flash.remove(); }, 500);
  }, 4000);
}

// Q mute toggle
function toggleQMute() {
  var muted = localStorage.getItem('hud-q-muted') === '1';
  var next = !muted;
  localStorage.setItem('hud-q-muted', next ? '1' : '0');
  var btn = document.getElementById('q-snooze-btn');
  if (btn) {
    btn.textContent = next ? 'UNMUTE RANDOM VISITS' : 'MUTE RANDOM VISITS';
    btn.style.background = next ? 'rgba(204,68,68,0.4)' : 'rgba(204,68,68,0.15)';
  }
  toast(next ? 'Q: Random visits muted' : 'Q: Random visits enabled');
}

// Init Q mute button state on load
(function() {
  var muted = localStorage.getItem('hud-q-muted') === '1';
  if (muted) {
    var btn = document.getElementById('q-snooze-btn');
    if (btn) {
      btn.textContent = 'UNMUTE RANDOM VISITS';
      btn.style.background = 'rgba(204,68,68,0.4)';
    }
  }
})();

// Random Q encounters (5% chance every 2 minutes)
setInterval(function() {
  if (localStorage.getItem('hud-q-muted') === '1') return;
  if (Math.random() < 0.05) qFlash();
}, 120000);

// ─── REPLICATOR ────────────────────────────────────────────────────────────
(function() {
  var repInited = false;
  var repRenderer, repScene, repCamera, repControls;
  var repTick = null;
  var repMatPoints = null, repMatFrame = 0;

  function repStartMaterializing() {
    document.getElementById('rep-canvas-wrap').classList.add('materializing');
    if (!repInited) return;
    // Scatter particles in a sphere that converge toward the centre
    var count = 200;
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(count * 3);
    var init = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var r = 1.2 + Math.random() * 1.8;
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      var x = r * Math.sin(phi) * Math.cos(theta);
      var y = r * Math.sin(phi) * Math.sin(theta);
      var z = r * Math.cos(phi);
      pos[i*3]=x; pos[i*3+1]=y; pos[i*3+2]=z;
      init[i*3]=x; init[i*3+1]=y; init[i*3+2]=z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.userData.init = init;
    var mat = new THREE.PointsMaterial({ color: 0xCC99FF, size: 0.05, transparent: true, opacity: 0 });
    repMatPoints = new THREE.Points(geo, mat);
    repScene.add(repMatPoints);
    repMatFrame = 0;
    repTick = function() {
      if (!repMatPoints) return;
      repMatFrame++;
      var t = Math.min(repMatFrame / 150, 1);
      var ease = t * t * (3 - 2 * t);
      var pa = repMatPoints.geometry.attributes.position.array;
      var ia = repMatPoints.geometry.userData.init;
      for (var j = 0; j < count; j++) {
        pa[j*3]   = ia[j*3]   * (1 - ease);
        pa[j*3+1] = ia[j*3+1] * (1 - ease);
        pa[j*3+2] = ia[j*3+2] * (1 - ease);
      }
      repMatPoints.geometry.attributes.position.needsUpdate = true;
      repMatPoints.rotation.y += 0.01;
      repMatPoints.material.opacity = Math.min(0.85, repMatFrame / 25);
    };
  }

  function repStopMaterializing() {
    document.getElementById('rep-canvas-wrap').classList.remove('materializing');
    repTick = null;
    if (repMatPoints) {
      repScene.remove(repMatPoints);
      repMatPoints.geometry.dispose();
      repMatPoints.material.dispose();
      repMatPoints = null;
    }
  }

  function loadThree(cb) {
    if (window.THREE && window.THREE.OrbitControls) { cb(); return; }
    function loadOC() {
      if (window.THREE.OrbitControls) { cb(); return; }
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/three@0.134.0/examples/js/controls/OrbitControls.js';
      s.onload = function() { cb(); };
      s.onerror = function() { cb(new Error('OrbitControls load failed')); };
      document.head.appendChild(s);
    }
    if (window.THREE) { loadOC(); return; }
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/three@0.134.0/build/three.min.js';
    s.onload = loadOC;
    s.onerror = function() { cb(new Error('Three.js load failed')); };
    document.head.appendChild(s);
  }

  function initThree() {
    if (repInited) return;
    var wrap = document.getElementById('rep-canvas-wrap');
    var canvas = document.getElementById('rep-canvas');
    var w = wrap.clientWidth, h = Math.max(wrap.clientHeight, 200);

    repScene = new THREE.Scene();
    repScene.background = new THREE.Color(0x020208);
    repScene.fog = new THREE.FogExp2(0x020208, 0.04);

    repCamera = new THREE.PerspectiveCamera(55, w / h, 0.05, 100);
    repCamera.position.set(0, 0.8, 3.5);

    repRenderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    repRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    repRenderer.setSize(w, h);
    repRenderer.shadowMap.enabled = true;
    repRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lights — indices 0, 1, 2 (user objects start at index 3)
    var ambient = new THREE.AmbientLight(0x404070, 0.6);
    repScene.add(ambient);
    var dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(4, 8, 5);
    dir.castShadow = true;
    dir.shadow.radius = 4;
    repScene.add(dir);
    var fill = new THREE.PointLight(0xCC99FF, 0.5, 14);
    fill.position.set(-3, 2, -3);
    repScene.add(fill);

    repControls = new THREE.OrbitControls(repCamera, canvas);
    repControls.enableDamping = true;
    repControls.dampingFactor = 0.06;
    repControls.minDistance = 0.3;
    repControls.maxDistance = 20;
    repControls.target.set(0, 0, 0);

    (function loop() {
      requestAnimationFrame(loop);
      if (repTick) repTick();
      repControls.update();
      repRenderer.render(repScene, repCamera);
    })();

    var ro = new ResizeObserver(function() {
      var w2 = wrap.clientWidth, h2 = wrap.clientHeight;
      if (!w2 || !h2) return;
      repCamera.aspect = w2 / h2;
      repCamera.updateProjectionMatrix();
      repRenderer.setSize(w2, h2);
    });
    ro.observe(wrap);
    repInited = true;
  }

  function repAddMsg(role, text) {
    var msgs = document.getElementById('rep-msgs');
    var div = document.createElement('div');
    div.className = 'rep-msg ' + role;
    div.innerHTML = '<div class="rep-msg-from">' + (role === 'user' ? 'CREW' : 'COMPUTER') + '</div>'
      + '<div class="rep-msg-text">' + text + '</div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function repDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  function repGetExportGroup() {
    // Collect user objects (everything above the 3 lights)
    var g = new THREE.Group();
    for (var i = 3; i < repScene.children.length; i++) {
      g.add(repScene.children[i].clone());
    }
    return g;
  }

  function loadExporter(name, url, cb) {
    if (window.THREE && window.THREE[name]) { cb(); return; }
    var s = document.createElement('script');
    s.src = url;
    s.onload = cb;
    s.onerror = function() { toast('FAILED TO LOAD EXPORTER'); };
    document.head.appendChild(s);
  }

  window.repExport = function(fmt) {
    if (!repInited) { toast('NO MODEL TO EXPORT'); return; }
    var label = (document.getElementById('rep-label-text').textContent || 'replication')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'replication';

    if (fmt === 'glb') {
      loadExporter('GLTFExporter', 'https://unpkg.com/three@0.134.0/examples/js/exporters/GLTFExporter.js', function() {
        var exp = new THREE.GLTFExporter();
        exp.parse(repGetExportGroup(), function(result) {
          repDownload(new Blob([result], { type: 'application/octet-stream' }), label + '.glb');
        }, { binary: true });
      });
    } else if (fmt === 'obj') {
      loadExporter('OBJExporter', 'https://unpkg.com/three@0.134.0/examples/js/exporters/OBJExporter.js', function() {
        var exp = new THREE.OBJExporter();
        var result = exp.parse(repGetExportGroup());
        repDownload(new Blob([result], { type: 'text/plain' }), label + '.obj');
      });
    } else if (fmt === 'stl') {
      loadExporter('STLExporter', 'https://unpkg.com/three@0.134.0/examples/js/exporters/STLExporter.js', function() {
        var exp = new THREE.STLExporter();
        var result = exp.parse(repGetExportGroup(), { binary: true });
        repDownload(new Blob([result], { type: 'application/octet-stream' }), label + '.stl');
      });
    }
  };

  window.repSend = async function() {
    var input = document.getElementById('rep-input');
    var msg = (input.value || '').trim();
    if (!msg) return;
    input.value = '';
    repAddMsg('user', msg);

    var spinner = document.getElementById('rep-spinner');
    var statusLbl = document.getElementById('rep-status-lbl');
    spinner.classList.add('on');
    statusLbl.textContent = 'REPLICATING\u2026';
    repStartMaterializing();

    try {
      var resp = await fetch('/api/replicator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg }),
      });
      var data = await resp.json();
      if (data.error) {
        repStopMaterializing();
        repAddMsg('ai', 'REPLICATION FAILURE: ' + data.error);
        statusLbl.textContent = 'ERROR';
        return;
      }
      loadThree(function(err) {
        repStopMaterializing();
        if (err) { repAddMsg('ai', 'MATERIALIZATION FAILURE: ' + err.message); statusLbl.textContent = 'ERROR'; return; }
        initThree();
        try {
          // Clear user objects (keep 3 lights at indices 0, 1, 2)
          while (repScene.children.length > 3) repScene.remove(repScene.children[repScene.children.length - 1]);
          // Reset camera
          repCamera.position.set(0, 0.8, 3.5);
          repControls.target.set(0, 0, 0);
          // Execute AI-generated scene code
          // new Function is intentional — this is AI-generated Three.js code from our own server
          var fn = new Function('THREE', 'scene', 'camera', data.code); // eslint-disable-line no-new-func
          fn(THREE, repScene, repCamera);
          document.getElementById('rep-label-text').textContent = data.label || msg.toUpperCase();
          document.getElementById('rep-export-btns').classList.add('on');
          repAddMsg('ai', data.description || 'REPLICATION COMPLETE.');
          statusLbl.textContent = 'ONLINE';
        } catch (ex) {
          repAddMsg('ai', 'MATERIALIZATION FAILURE: ' + ex.message);
          statusLbl.textContent = 'ERROR';
        }
      });
    } catch (ex) {
      repStopMaterializing();
      repAddMsg('ai', 'COMM FAILURE: ' + ex.message);
      statusLbl.textContent = 'ERROR';
    } finally {
      spinner.classList.remove('on');
    }
  };
})();

// ─── SSE live events client ────────────────────────────────────────────────
(function() {
  var BLOCKS = 10;

  function renderBurnBar(pct) {
    var bar = document.getElementById('brb-bar');
    if (!bar) return;
    var filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * BLOCKS);
    var html = '';
    for (var i = 0; i < BLOCKS; i++) {
      html += '<div class="brb-block ' + (i < filled ? 'filled' : 'empty') + '"></div>';
    }
    bar.innerHTML = html;
  }

  function updateBurnBar(evt) {
    var pct = evt.pct || 0;
    var total = evt.totalTokens || 0;
    var limit = evt.limit || 88000;
    renderBurnBar(pct);
    var pctEl = document.getElementById('brb-pct');
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    var timeEl = document.getElementById('brb-time');
    if (timeEl) {
      var remaining = limit - total;
      timeEl.textContent = remaining > 0
        ? '~' + Math.round(remaining / 1000) + 'k tokens left'
        : 'LIMIT REACHED';
      timeEl.style.color = pct >= 90 ? '#FF4444' : pct >= 70 ? '#FFCC00' : '';
    }
    var rateEl = document.getElementById('brb-rate');
    if (rateEl) {
      var used = Math.round(total / 1000 * 10) / 10;
      rateEl.textContent = used + 'k / ' + Math.round(limit / 1000) + 'k tokens';
    }
    // colour the bar blocks red when near limit
    if (pct >= 90) {
      document.querySelectorAll('.brb-block.filled').forEach(function(el) {
        el.style.background = '#FF4444';
      });
    } else if (pct >= 70) {
      document.querySelectorAll('.brb-block.filled').forEach(function(el) {
        el.style.background = '#FFCC00';
      });
    }
  }

  function handleFileChange(evt) {
    // Show a brief toast and optionally update the LIVE badge
    var labels = {
      'skills': 'SKILLS UPDATED',
      'agents': 'AGENTS UPDATED',
      'settings': 'SETTINGS CHANGED',
      'claudemd': 'CLAUDE.MD CHANGED',
      'session': 'SESSION UPDATED',
      'memory': 'MEMORY UPDATED',
      'hud-events': 'HUD EVENT',
      'other': 'FILE CHANGED'
    };
    var msg = labels[evt.category] || 'FILE CHANGED';
    if (typeof toast === 'function') toast(msg);
  }

  function handleHudEvent(evt) {
    var liveEl = document.getElementById('brb-live');
    if (liveEl) {
      liveEl.style.display = '';
      clearTimeout(liveEl._t);
      liveEl._t = setTimeout(function() { liveEl.style.display = 'none'; }, 4000);
    }
    // Append to COMMS if that section is live
    if (typeof appendHudEventToComms === 'function') appendHudEventToComms(evt);
  }

  function connectSSE() {
    var es = new EventSource('/api/events');
    es.onopen = function() {
      var liveEl = document.getElementById('brb-live');
      var meterEl = document.getElementById('brb-meter');
      if (liveEl) liveEl.style.display = '';
      if (meterEl) meterEl.style.display = 'flex';
    };
    es.onmessage = function(e) {
      try {
        var evt = JSON.parse(e.data);
        if (evt.type === 'connected') {
          renderBurnBar(0);
          var rateEl = document.getElementById('brb-rate');
          if (rateEl) rateEl.textContent = 'CONTEXT WINDOW';
          var timeEl = document.getElementById('brb-time');
          if (timeEl) timeEl.textContent = 'live';
        } else if (evt.type === 'burn-rate') {
          updateBurnBar(evt);
        } else if (evt.type === 'file-change') {
          handleFileChange(evt);
        } else if (evt.type === 'hud-event') {
          handleHudEvent(evt);
        }
      } catch (err) { /* skip malformed */ }
    };
    es.onerror = function() {
      var liveEl = document.getElementById('brb-live');
      if (liveEl) liveEl.style.display = 'none';
      var timeEl = document.getElementById('brb-time');
      if (timeEl) timeEl.textContent = 'reconnecting…';
      es.close();
      setTimeout(connectSSE, 5000);
    };
  }

  // Only connect when served from localhost (not static file)
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    connectSSE();
  } else {
    var timeEl = document.getElementById('brb-time');
    if (timeEl) timeEl.textContent = 'static mode';
    renderBurnBar(0);
  }
})();

// ── LCARS action blocks ───────────────────────────────────────────────────────
function parseLcarsActions(text) {
  var actions = [];
  var open = '<lcars-action';
  var close = '</lcars-action>';
  var pos = 0;
  while (true) {
    var start = text.indexOf(open, pos);
    if (start === -1) break;
    var tagEnd = text.indexOf('>', start);
    if (tagEnd === -1) break;
    var attrs = text.slice(start + open.length, tagEnd);
    var contentStart = tagEnd + 1;
    var end = text.indexOf(close, contentStart);
    if (end === -1) break;
    var content = text.slice(contentStart, end).trim();
    var pathMatch = attrs.match(/path="([^"]+)"/);
    var descMatch = attrs.match(/description="([^"]+)"/);
    if (pathMatch) {
      actions.push({ path: pathMatch[1], description: descMatch ? descMatch[1] : pathMatch[1], content: content });
    }
    pos = end + close.length;
  }
  if (actions.length === 0) return;
  showActionConfirm(actions);
}

function showActionConfirm(actions) {
  var existing = document.getElementById('lcars-action-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'lcars-action-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;padding:20px';

  var inner = document.createElement('div');
  inner.style.cssText = 'background:#07070d;border:2px solid #FF9900;padding:24px 28px;width:600px;max-width:96vw;max-height:80vh;display:flex;flex-direction:column;font-family:monospace;gap:12px';

  var title = document.createElement('div');
  title.style.cssText = 'color:#FF9900;font-size:13px;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #1a1a1e;padding-bottom:10px';
  title.textContent = '\\u25b2 COMPUTER PROPOSED ' + actions.length + ' FILE OPERATION' + (actions.length > 1 ? 'S' : '');
  inner.appendChild(title);

  var scrollArea = document.createElement('div');
  scrollArea.style.cssText = 'overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px';

  actions.forEach(function(action, idx) {
    var block = document.createElement('div');
    block.style.cssText = 'border:1px solid #1a1a1e;border-left:3px solid #66CCCC';

    var header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px;background:#0a0a14;display:flex;justify-content:space-between;align-items:center;gap:8px';

    var pathLabel = document.createElement('span');
    pathLabel.style.cssText = 'color:#66CCCC;font-size:11px;word-break:break-all';
    pathLabel.textContent = action.path;

    var desc = document.createElement('span');
    desc.style.cssText = 'color:#666;font-size:10px;white-space:nowrap';
    desc.textContent = action.description;

    header.appendChild(pathLabel);
    header.appendChild(desc);
    block.appendChild(header);

    var pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:10px 12px;font-size:10px;color:#88aa66;overflow-x:auto;max-height:180px;overflow-y:auto;background:#02020a;white-space:pre-wrap;word-break:break-word';
    pre.textContent = action.content;
    block.appendChild(pre);

    scrollArea.appendChild(block);
  });

  inner.appendChild(scrollArea);

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #1a1a1e;padding-top:12px';

  var cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'background:transparent;color:#666;border:1px solid #333;padding:6px 16px;font-family:monospace;font-size:11px;cursor:pointer;border-radius:2px';
  cancelBtn.textContent = 'REJECT';
  cancelBtn.onclick = function() { modal.remove(); };

  var confirmBtn = document.createElement('button');
  confirmBtn.style.cssText = 'background:#FF9900;color:#000;border:none;padding:6px 16px;font-family:monospace;font-size:11px;font-weight:bold;text-transform:uppercase;cursor:pointer;border-radius:2px';
  confirmBtn.textContent = 'CONFIRM & WRITE';
  confirmBtn.onclick = function() {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Writing...';
    var promises = actions.map(function(action) {
      return fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: action.path.replace(/^~/, window._HOME || ''), content: action.content, mkdir: true }),
      }).then(function(r) { return r.json(); });
    });
    Promise.all(promises).then(function(results) {
      var allOk = results.every(function(r) { return r.ok; });
      modal.remove();
      toast(allOk ? '\\u2713 ' + actions.length + ' file' + (actions.length > 1 ? 's' : '') + ' written' : 'Some writes failed — check console', allOk ? 2500 : 4000);
      if (allOk) beepReceive();
    }).catch(function(e) {
      modal.remove();
      toast('Write failed: ' + e.message, 4000);
    });
  };

  btns.appendChild(cancelBtn);
  btns.appendChild(confirmBtn);
  inner.appendChild(btns);
  modal.appendChild(inner);
  document.body.appendChild(modal);
}

// ── Update check ─────────────────────────────────────────────────────────────
window.HUD_VERSION = '${PKG_VERSION}';
function copyUpdateCmd() {
  try { navigator.clipboard.writeText('npx claude-hud-lcars@latest'); } catch {}
  var btn = document.getElementById('um-run-btn');
  if (btn) { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = 'Copy Command'; }, 2000); }
}
(async function() {
  try {
    var current = window.HUD_VERSION || '?';
    var latest = current, hasUpdate = false;
    if (window.HUD_LIVE) {
      var vr = await fetch('/api/version');
      var vd = await vr.json();
      current = vd.current; latest = vd.latest; hasUpdate = vd.hasUpdate;
    } else {
      var nr = await fetch('https://registry.npmjs.org/claude-hud-lcars/latest');
      var nd = await nr.json();
      latest = nd.version || current;
      hasUpdate = latest && latest !== current;
    }
    var cfgVer = document.getElementById('cfg-version-display');
    if (cfgVer) { cfgVer.textContent = 'v' + current + (hasUpdate ? '  (update available)' : ''); if (hasUpdate) cfgVer.style.color = '#FF9900'; }
    var elCur = document.getElementById('um-current'); if (elCur) elCur.textContent = current;
    var elLat = document.getElementById('um-latest'); if (elLat) elLat.textContent = latest || '—';
    if (hasUpdate) {
      var badge = document.getElementById('hud-update-badge');
      if (badge) badge.style.display = 'inline-block';
      if (!window.HUD_LIVE) {
        var sm = document.getElementById('um-static-msg'); if (sm) sm.style.display = 'block';
        var btn2 = document.getElementById('um-run-btn'); if (btn2) btn2.textContent = 'Copy Command';
      }
    }
  } catch {}
})();
</script>
<style>
#hud-update-badge{position:fixed;top:10px;right:14px;z-index:9998;background:#FF4400;color:#fff;border:none;padding:3px 9px;font-family:monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border-radius:3px;display:none;animation:upd-pulse 2s ease-in-out infinite}
@keyframes upd-pulse{0%,100%{opacity:.85}50%{opacity:1}}
#update-modal{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center}
#update-modal.open{display:flex}
#update-modal .um-box{background:#07070d;border:2px solid #FF9900;padding:24px 28px;width:480px;max-width:94vw;font-family:monospace}
#update-modal .um-title{font-size:13px;color:#FF9900;text-transform:uppercase;letter-spacing:.12em;margin-bottom:16px}
#update-modal .um-versions{display:flex;gap:16px;margin-bottom:16px;font-size:11px}
#update-modal .um-v{color:var(--dim,#555)}
#update-modal .um-v span{color:#eee}
#update-modal .um-log{background:#02020a;border:1px solid #1a1a1e;padding:10px;height:140px;overflow-y:auto;font-size:10px;color:#88aa66;white-space:pre-wrap;display:none;margin-bottom:12px}
#update-modal .um-static-msg{font-size:11px;color:#666;margin-bottom:14px;display:none;line-height:1.6}
#update-modal .um-static-msg code{color:#FF9900;background:#0a0a14;padding:2px 6px;border-radius:2px}
#update-modal .um-actions{display:flex;gap:8px;justify-content:flex-end}
#update-modal button{background:#FF9900;color:#000;border:none;padding:6px 16px;font-family:monospace;font-size:11px;font-weight:bold;text-transform:uppercase;cursor:pointer;border-radius:2px}
#update-modal .um-cancel{background:transparent;color:#666;border:1px solid #333}
</style>
<button id="hud-update-badge" onclick="document.getElementById('update-modal').classList.add('open')">&#x2191; UPDATE AVAILABLE</button>
<div id="update-modal">
  <div class="um-box">
    <div class="um-title">&#9650; Update Available</div>
    <div class="um-versions">
      <div class="um-v">CURRENT <span id="um-current">—</span></div>
      <div class="um-v">LATEST <span id="um-latest" style="color:#FF9900">—</span></div>
    </div>
    <div class="um-log" id="um-log"></div>
    <div class="um-static-msg" id="um-static-msg">To update, run:<br><code>npx claude-hud-lcars@latest</code></div>
    <div class="um-actions">
      <button class="um-cancel" onclick="document.getElementById('update-modal').classList.remove('open')">Close</button>
      <button id="um-run-btn" onclick="typeof runUpdate==='function'?runUpdate():copyUpdateCmd()">Install Update</button>
    </div>
  </div>
</div>
</body></html>`;
}

const args = process.argv.slice(2);

if (args.includes('--serve') || args.includes('-s')) {
  // Live server mode
  import('./server.js');
} else {
  try {
    fs.writeFileSync(OUTPUT, gen());
  } catch(e) {
    console.error('Dashboard generation failed: ' + e.message);
    process.exit(1);
  }
  console.log('Dashboard generated: ' + OUTPUT);

  // Auto-open in browser
  if (!args.includes('--no-open')) {
    const { exec } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(cmd + ' ' + JSON.stringify(OUTPUT));
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('  Usage: claude-hud-lcars [options]');
    console.log('');
    console.log('  Options:');
    console.log('    --serve, -s    Start live server with chat, voice, and file editing');
    console.log('    --no-open      Generate dashboard without opening in browser');
    console.log('    --help, -h     Show this help');
    console.log('');
    console.log('  Environment:');
    console.log('    CLAUDE_DASHBOARD_API_KEY    Required for chat (live mode)');
    console.log('    ELEVENLABS_API_KEY   Optional premium voice');
    console.log('    PORT                 Server port (default: 3200)');
    console.log('');
  }
}
