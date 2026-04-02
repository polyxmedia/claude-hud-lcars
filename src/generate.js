#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const OUTPUT = path.join(import.meta.dirname, '..', 'dashboard.html');

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

function getMcpServers(s) {
  const out = [];
  const seen = new Set();

  // 1. From settings.json mcpServers
  if (s?.mcpServers) {
    for (const [name, c] of Object.entries(s.mcpServers)) {
      out.push(parseMcpEntry(name, c, 'settings.json'));
      seen.add(name);
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

function getClaudeMdFiles() {
  const out = [];
  // Global CLAUDE.md
  const globalPath = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, 'utf-8');
      out.push({ scope: 'GLOBAL', path: globalPath, project: '~/.claude/', body: raw, size: raw.length });
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
        out.push({ scope: 'PROJECT', path: cp, project: proj, body: raw, size: raw.length });
      } catch(e) {}
    }
  }
  return out;
}

function getEnv(s) { return s?.env || {}; }

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
  const ts = new Date().toISOString().replace('T',' ').slice(0,19)+'Z';
  const stardate = new Date().toISOString().slice(0,10).replace(/-/g,'.');

  // ── DISCOVER SUGGESTIONS ──
  const installedSkillNames = new Set(skills.map(s => s.name));
  const installedAgentNames = new Set(agents.map(a => a.name));
  const installedMcpNames = new Set(mcp.map(m => m.name));

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
      actions: [{ label: '+ INSTALL', cmd: 'install:mcp:'+m.name, icon: 'INSTALL' }] };
  });
  HOOK_SUGG.forEach(h => {
    D['sugg:hook:'+h.name] = { t: h.name, tp: 'SUGGESTED HOOK // '+h.event.toUpperCase(), m: h.event+(h.matcher?' // '+h.matcher:''),
      b: h.desc+'\n\n```bash\n'+h.cmd+'\n```',
      actions: [{ label: '+ INSTALL', cmd: 'install:hook:'+h.name, icon: 'INSTALL' }] };
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

  // CLAUDE.md files
  claudeMds.forEach((c, i) => {
    D['cd:'+i] = { t: c.scope === 'GLOBAL' ? 'Global CLAUDE.md' : c.project.split('/').slice(-2).join('/'),
      tp: 'CLAUDE.MD // ' + c.scope, m: c.project + ' // ' + c.size + ' bytes', b: c.body,
      actions: [
        { label: 'OPEN FILE', cmd: 'open ' + c.path, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: c.path, icon: 'PATH' },
      ]};
  });

  Object.entries(env).forEach(([k, v]) => {
    D['v:'+k] = { t: k, tp: 'ENVIRONMENT VARIABLE', m: String(v), b: k + ' = ' + JSON.stringify(v, null, 2),
      actions: [
        { label: 'COPY VALUE', cmd: String(v), icon: 'COPY' },
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
      ]};
  });

  const sections = [
    { id: 'skills', label: 'SKILLS', color: '#9999FF', count: skills.length },
    { id: 'mcp', label: 'MCP SERVERS', color: '#FF9900', count: mcp.length },
    { id: 'hooks', label: 'HOOKS', color: '#CC9966', count: hooks.length },
    { id: 'plugins', label: 'PLUGINS', color: '#CC99CC', count: plugins.length },
    { id: 'agents', label: 'AGENTS', color: '#FFCC99', count: agents.length },
    { id: 'env', label: 'ENVIRONMENT', color: '#66CCCC', count: Object.keys(env).length },
    { id: 'memory', label: 'MEMORY', color: '#9999CC', count: mem.length },
    { id: 'sessions', label: 'SESSIONS', color: '#88AACC', count: sessionList.length },
    { id: 'claudemd', label: 'CLAUDE.MD', color: '#EE8844', count: claudeMds.length },
    { id: 'viz', label: 'TACTICAL', color: '#55AAFF', count: null },
    { id: 'q', label: 'Q', color: '#CC4444', count: null },
    { id: 'comms', label: 'COMMS', color: '#FF9966', count: null },
    { id: 'config', label: 'CONFIG', color: '#FFCC66', count: null },
    { id: 'about', label: 'ABOUT', color: '#55CC55', count: null },
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
  --orange:#FF9900;--peach:#FFCC99;--blue:#9999FF;
  --lavender:#CC99CC;--tan:#CC9966;--salmon:#FF9966;
  --ltblue:#9999CC;--cyan:#66CCCC;--gold:#FFCC66;
  --red:#CC4444;--green:#55CC55;--salmon:#FF9966;
}
body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);min-height:100vh;overflow:hidden;font-size:14px}
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
.lcars{display:grid;grid-template-columns:240px 1fr;grid-template-rows:72px 48px 1fr 40px;height:100vh;column-gap:4px;row-gap:0;padding:0}

/* ═══ SIDEBAR ═══ */
.sb{grid-row:1/-1;grid-column:1;display:flex;flex-direction:column;gap:4px}

.sb-top{
  background:var(--orange);border-radius:0 0 0 0;
  padding:14px 20px 10px;min-height:72px;
  border-radius:0 0 48px 0;
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
  background:var(--orange);border-radius:0 48px 0 0;
  padding:14px 20px;font-size:0.78rem;color:rgba(0,0,0,0.5);
  letter-spacing:0.08em;margin-top:auto;font-weight:600;
}

/* ═══ TOP BAR ═══ */
.tb{grid-column:2;display:flex;gap:4px}
.tb{margin-bottom:4px}
.tb-elbow{width:72px;background:var(--orange);border-radius:0 0 0 48px;flex-shrink:0}
.tb-fill{flex:1;background:var(--orange);display:flex;align-items:center;justify-content:flex-end;padding:0 24px;gap:28px;
  font-family:'Antonio',sans-serif;font-size:0.95rem;letter-spacing:0.1em;color:rgba(0,0,0,0.4);text-transform:uppercase}
.tb-a1{width:100px;background:var(--peach);border-radius:0 0 12px 12px}
.tb-a2{width:60px;background:var(--blue);border-radius:0 0 24px 0}

/* ═══ STATS BAR ═══ */
.stb{grid-column:2;display:flex;gap:0}
.stb-edge{width:72px;background:var(--lavender);flex-shrink:0;border-radius:0 0 0 24px}
.stb-inner{flex:1;display:flex;gap:3px;padding:3px 0 3px 4px;background:var(--lavender)}
.st{flex:1;background:var(--bg);padding:5px 12px;text-align:center;border-radius:0}
.stb-cap{width:80px;background:var(--tan);flex-shrink:0;border-radius:0 24px 24px 0}
.st-n{font-family:'Antonio',sans-serif;font-size:1.5rem;font-weight:700;color:var(--orange);line-height:1}
.st-l{font-size:0.55rem;color:var(--dim);text-transform:uppercase;letter-spacing:0.12em;margin-top:2px}

/* ═══ MAIN AREA ═══ */
.mn{grid-column:2;display:flex;gap:0;min-height:0;overflow:hidden;margin-top:4px}
.mn-edge{width:72px;background:var(--lavender);flex-shrink:0;position:relative;border-radius:0 24px 24px 0}

.mn-content{flex:1;display:grid;grid-template-columns:1fr 0fr;transition:grid-template-columns 0.25s ease;min-height:0;overflow:hidden;gap:4px;margin-left:4px}
.mn-content.open{grid-template-columns:1fr 1fr}

/* ═══ LIST ═══ */
.ls{background:#060608;overflow-y:auto;min-height:0;border-radius:12px}

.sec{display:none}
.sec.on{display:block}
#s-q.on{display:flex;flex-direction:column;height:100%;background:#050508}
#s-viz.on{display:flex;flex-direction:column;position:relative;height:100%}

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
  padding:8px 12px;outline:none;
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
  flex:1;background:#060608;border:1px solid #1a1a1e;padding:12px;text-align:center;
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
  display:grid;grid-template-rows:auto auto auto auto;gap:8px;
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
  padding:3px 8px;flex-shrink:0;
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

/* ═══ DISCOVER ═══ */
.discover{border-top:1px dashed #1a1a1e;margin-top:4px}
.discover-hdr{padding:10px 20px;font-size:0.75rem;color:var(--faint,#333);cursor:pointer;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.1em;user-select:none;transition:color .15s}
.discover-hdr:hover,.discover-hdr.open{color:var(--tan,#bb8844)}
.discover-arrow{font-size:0.65rem;transition:transform .15s;display:inline-block}
.discover-hdr.open .discover-arrow{transform:rotate(90deg)}
.discover-body{padding:8px 12px 12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
.suggest-card{background:#05050a;border:1px solid #141420;padding:12px 14px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s;cursor:pointer}
.suggest-card:hover{border-color:#FF9900AA}
.suggest-name{font-size:0.88rem;font-weight:600;color:#ccc}
.suggest-desc{font-size:0.77rem;color:var(--dim,#555);flex:1;line-height:1.5}
.suggest-footer{display:flex;align-items:center;justify-content:space-between;margin-top:4px}
.suggest-tag{font-size:0.63rem;color:var(--tan,#bb8844);text-transform:uppercase;letter-spacing:.07em}
.suggest-install{background:#FF9900;color:#000;border:none;padding:3px 10px;font-family:monospace;font-size:0.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;border-radius:2px;transition:background .1s}
.suggest-install:hover{background:#FFAA22}
.suggest-install:disabled{background:#2a2a2a;color:#555;cursor:default}

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

.dp-b{padding:20px;font-size:0.88rem;line-height:1.8;color:var(--text)}
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
.dp-b ul,.dp-b ol{padding-left:22px;margin-bottom:10px}
.dp-b li{margin-bottom:4px}
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
  transition:border-color 0.15s;
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
  max-height:200px;overflow-y:auto;
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
  background:var(--bg);border-radius:0 0 48px 0;
}
.bb-fill{flex:1;background:var(--lavender);display:flex;align-items:center;justify-content:space-between;padding:0 24px;
  font-size:0.65rem;color:rgba(0,0,0,0.35);letter-spacing:0.06em;border-radius:0 0 24px 0}
.bb-a{width:160px;background:var(--blue);border-radius:24px 0 0 24px}

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
    <span id="tb-ship-name"></span>
    <span>ASSETS: ${String(skills.length+agents.length+mcp.length+hooks.length+plugins.length).padStart(3,'0')}</span>
    <span>SESSIONS: ${String(sessions).padStart(5,'0')}</span>
    <span style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 200 200" style="width:16px;height:16px"><circle cx="100" cy="100" r="98" fill="rgba(0,0,0,0.15)"/><circle cx="100" cy="100" r="78" fill="rgba(0,0,0,0.1)"/><path d="M100 26 L140 145 L100 124 L60 145 Z" fill="rgba(0,0,0,0.25)"/><ellipse cx="100" cy="94" rx="63" ry="26" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="5" transform="rotate(-10 100 94)"/></svg>STARDATE ${stardate}</span>
  </div>
  <div class="tb-a1"></div>
  <div class="tb-a2"></div>
</div>

<div class="stb">
  <div class="stb-edge"></div>
  <div class="stb-inner">
    ${sections.filter(s => s.count !== null).map(s => `<div class="st"><div class="st-n">${String(s.count).padStart(3,'0')}</div><div class="st-l">${s.label}</div></div>`).join('\n    ')}
  </div>
  <div class="stb-cap"></div>
</div>

<div class="mn">
  <div class="mn-edge"></div>
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
          <div class="mcp-card" onclick="open_('m:${esc(s.name)}')" data-k="m:${esc(s.name)}" data-mcp="${esc(s.name)}">
            <div class="mcp-card-top">
              <div class="mcp-card-status checking" id="mcp-dot-${esc(s.name)}"></div>
              <div class="mcp-card-name">${esc(s.name)}</div>
              <span class="mcp-card-type ${esc(s.serverType)}">${esc(s.serverType)}</span>
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
              <div class="mcp-card-bar"><div class="bar-fill checking"></div></div>
              <div class="mcp-card-status-label checking" id="mcp-label-${esc(s.name)}">CHECKING</div>
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
        <div class="sec-h">Recent Sessions</div>
        <div class="session-stats" id="session-stats"></div>
        <div class="ls">
        ${sessionList.map((s, i) => {
          const date = s.started ? new Date(s.started).toISOString().replace('T', ' ').slice(0, 16) : '?';
          return '<div class="r" data-k="ss:' + i + '" onclick="open_(\'ss:' + i + '\')"><span class="r-n">' + esc(s.project || s.id.slice(0,8)) + '</span><span class="r-tg"><span class="tg tg-b">' + esc(s.kind) + '</span></span><span class="r-d">' + esc(date) + '</span></div>';
        }).join('')}
        </div>
      </div>

      <div class="sec" id="s-claudemd">
        <div class="sec-h">CLAUDE.md Files</div>
        <div class="ls">
        ${claudeMds.map((c, i) => {
          const label = c.scope === 'GLOBAL' ? 'Global CLAUDE.md' : c.project.split('/').slice(-2).join('/');
          return '<div class="r" data-k="cd:' + i + '" onclick="open_(\'cd:' + i + '\')"><span class="r-n">' + esc(label) + '</span><span class="r-tg"><span class="tg tg-o">' + esc(c.scope) + '</span></span><span class="r-d">' + c.size + ' bytes</span></div>';
        }).join('')}
        </div>
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
        <div style="padding:20px 24px;border-bottom:2px solid var(--red)">
          <div style="font-family:Antonio,sans-serif;font-size:1.4rem;color:var(--red);letter-spacing:0.08em;text-transform:uppercase">Q Continuum</div>
          <div style="font-size:0.7rem;color:var(--dim);margin-top:4px;letter-spacing:0.06em">An audience with the omnipotent. Proceed at your own risk.</div>
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

      <div class="sec" id="s-comms">
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
                  <span class="cfg-input"><input type="password" id="cfg-eleven-key" placeholder="sk_..." oninput="onApiKeyChange()"></span>
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
                <span class="cfg-label">Stardate</span>
                <span class="cfg-desc"></span>
                <span class="cfg-input" style="color:var(--orange)">${stardate}</span>
              </div>
            </div>
          </div>

        </div>
      </div>

      <div class="sec" id="s-about" style="position:relative;overflow:hidden;height:100%">
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
  if (id === 'comms' || id === 'about' || id === 'viz' || id === 'q') {
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
    if(!confirm('Delete this item permanently?\\n\\n'+cmd)) return;
    if(window.HUD_LIVE){
      if(cmd.startsWith('mcp:')){
        var mcpName=cmd.slice(4);
        fetch('/api/settings-update',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'remove-mcp',name:mcpName})
        }).then(function(r){return r.json()}).then(function(d){
          if(d.ok){toast('REMOVED: '+mcpName);close_();setTimeout(function(){location.reload()},600);}
          else toast('ERROR: '+d.error);
        });
      } else if(cmd.startsWith('hook:')){
        var hookIdx=parseInt(cmd.slice(5));
        fetch('/api/settings-update',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'remove-hook',index:hookIdx})
        }).then(function(r){return r.json()}).then(function(d){
          if(d.ok){toast('HOOK REMOVED');close_();setTimeout(function(){location.reload()},600);}
          else toast('ERROR: '+d.error);
        });
      } else {
        fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({path:cmd})
        }).then(function(r){return r.json()}).then(function(d){
          if(d.ok){toast('DELETED');close_();setTimeout(function(){location.reload()},600);}
          else toast('ERROR: '+d.error);
        });
      }
    } else {
      navigator.clipboard.writeText('rm -rf '+cmd).then(function(){
        toast('Copied delete command');
      });
    }
  } else if(icon==='INSTALL'){
    var parts=cmd.split(':');
    var itype=parts[1], iname=parts.slice(2).join(':');
    var d2=window._D&&window._D['sugg:'+itype+':'+iname];
    if(!d2){toast('Cannot find suggestion data');return;}
    if(itype==='skill') installSuggestSkill(btn,iname,d2.b);
    else if(itype==='agent') installSuggestAgent(btn,iname,d2.b);
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
  h = h.replace(new RegExp('"([^"]*)"\\\\s*:','g'), '<span class="key">"$1"</span>:');
  h = h.replace(new RegExp('"([^"]*)"','g'), '<span class="str">"$1"</span>');
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
  return d.innerHTML;
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
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = freq;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + dur);
}

function toggleBtn(btn) {
  var isOn = btn.classList.contains('on');
  btn.classList.toggle('on', !isOn);
  btn.classList.toggle('off', isOn);
  lcarsBeep(isOn ? 600 : 1200, 0.06);
}

function isToggleOn(id) {
  var btn = document.getElementById(id);
  return btn && btn.classList.contains('on');
}

var _bootComplete = false;
function beepNav() { if (_bootComplete) lcarsBeep(1200, 0.08); }
function beepOpen() { if (_bootComplete) { lcarsBeep(800, 0.06); setTimeout(function(){lcarsBeep(1600, 0.06)}, 60); } }
function beepAction() { if (_bootComplete) lcarsBeep(1000, 0.05); }
function beepSend() { if (_bootComplete) { lcarsBeep(600, 0.05); setTimeout(function(){lcarsBeep(900, 0.08)}, 80); } }
function beepReceive() { lcarsBeep(440, 0.12); }

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
  var h = esc(text);
  var ext = filePath.split('.').pop().toLowerCase();

  if (ext === 'json') {
    // JSON highlighting
    h = h.replace(new RegExp('"([^"]*)"\\\\s*:','g'), '<span class="hl-key">"$1"</span>:');
    h = h.replace(new RegExp('"([^"]*)"','g'), '<span class="hl-string">"$1"</span>');
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

function installSuggestSkill(btn, name, content) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var filePath = '${esc(path.join(CLAUDE_DIR, 'skills'))}/' + name + '/SKILL.md';
  fetch('/api/save', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ path: filePath, content: content, mkdir: true }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { btn.textContent = 'INSTALLED'; btn.style.background='#1a3a1a'; btn.style.color='#4a8a4a'; toast('SKILL INSTALLED: ' + name); setTimeout(function() { location.reload(); }, 800); }
    else { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + d.error); }
  }).catch(function(e) { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + e.message); });
}

function installSuggestAgent(btn, name, content) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var filePath = '${esc(path.join(CLAUDE_DIR, 'agents'))}/' + name + '.md';
  fetch('/api/save', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ path: filePath, content: content, mkdir: true }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { btn.textContent = 'INSTALLED'; btn.style.background='#1a3a1a'; btn.style.color='#4a8a4a'; toast('AGENT DEPLOYED: ' + name); setTimeout(function() { location.reload(); }, 800); }
    else { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + d.error); }
  }).catch(function(e) { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + e.message); });
}

function installSuggestMcp(btn, name, configJson) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var config = JSON.parse(configJson);
  fetch('/api/settings-update', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ type: 'add-mcp', name: name, config: config }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { btn.textContent = 'INSTALLED'; btn.style.background='#1a3a1a'; btn.style.color='#4a8a4a'; toast('MCP REGISTERED: ' + name); setTimeout(function() { location.reload(); }, 800); }
    else { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + d.error); }
  }).catch(function(e) { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + e.message); });
}

function installSuggestHook(btn, event, matcher, cmd) {
  if (!window.HUD_LIVE) { toast('Live mode required'); return; }
  btn.disabled = true; btn.textContent = '...';
  var hook = { type: 'command', command: cmd };
  fetch('/api/settings-update', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ type: 'add-hook', event: event, matcher: matcher || undefined, hook: hook }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { btn.textContent = 'INSTALLED'; btn.style.background='#1a3a1a'; btn.style.color='#4a8a4a'; toast('HOOK INSTALLED: ' + event); setTimeout(function() { location.reload(); }, 800); }
    else { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + d.error); }
  }).catch(function(e) { btn.disabled = false; btn.textContent = '+ INSTALL'; toast('ERROR: ' + e.message); });
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

  // Create directory first
  fetch('/api/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ path: filePath, content: content, mkdir: true }),
  }).then(function(r) { return r.json() }).then(function(d) {
    if (d.ok) {
      toast('SKILL CREATED: ' + name);
      beepAction();
      toggleCreate('skill');
      setTimeout(function() { location.reload(); }, 500);
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e) { toast('ERROR: ' + e.message); });
}

function createMcp() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var name = document.getElementById('cf-mcp-name').value.trim();
  var cmd = document.getElementById('cf-mcp-cmd').value.trim();
  var argsStr = document.getElementById('cf-mcp-args').value.trim();
  if (!name || !cmd) { toast('Name and command required'); return; }

  var args = argsStr ? argsStr.split(/\\s+/) : [];
  // Read current settings, add server, save back
  fetch('/api/settings-update', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ type: 'add-mcp', name: name, config: { command: cmd, args: args } }),
  }).then(function(r) { return r.json() }).then(function(d) {
    if (d.ok) {
      toast('MCP SERVER REGISTERED: ' + name);
      beepAction();
      toggleCreate('mcp');
      setTimeout(function() { location.reload(); }, 500);
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e) { toast('ERROR: ' + e.message); });
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

  fetch('/api/settings-update', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ type: 'add-hook', event: event, matcher: matcher || undefined, hook: hook }),
  }).then(function(r) { return r.json() }).then(function(d) {
    if (d.ok) {
      toast('HOOK CREATED: ' + event);
      beepAction();
      toggleCreate('hook');
      setTimeout(function() { location.reload(); }, 500);
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e) { toast('ERROR: ' + e.message); });
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

  fetch('/api/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ path: filePath, content: content }),
  }).then(function(r) { return r.json() }).then(function(d) {
    if (d.ok) {
      toast('AGENT DEPLOYED: ' + name);
      beepAction();
      toggleCreate('agent');
      setTimeout(function() { location.reload(); }, 500);
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e) { toast('ERROR: ' + e.message); });
}

function createEnv() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var key = document.getElementById('cf-env-key').value.trim().toUpperCase();
  var val = document.getElementById('cf-env-val').value.trim();
  if (!key) { toast('Variable name required'); return; }

  fetch('/api/settings-update', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ type: 'add-env', key: key, value: val }),
  }).then(function(r) { return r.json() }).then(function(d) {
    if (d.ok) {
      toast('ENV SET: ' + key);
      beepAction();
      toggleCreate('env');
      setTimeout(function() { location.reload(); }, 500);
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e) { toast('ERROR: ' + e.message); });
}

function createPlugin() {
  if (!window.HUD_LIVE) { toast('Requires live mode'); return; }
  var id = document.getElementById('cf-plugin-id').value.trim();
  if (!id) { toast('Plugin ID required'); return; }

  fetch('/api/settings-update', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ type: 'add-plugin', id: id }),
  }).then(function(r) { return r.json() }).then(function(d) {
    if (d.ok) {
      toast('PLUGIN ENABLED: ' + id);
      beepAction();
      toggleCreate('plugin');
      setTimeout(function() { location.reload(); }, 500);
    } else { toast('ERROR: ' + d.error); }
  }).catch(function(e) { toast('ERROR: ' + e.message); });
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

  var systemExtra = (window.HUD_PROJECTS_DIR && window.HUD_PROJECTS_CACHE)
    ? ' Active missions (projects in ' + window.HUD_PROJECTS_DIR + '): ' + window.HUD_PROJECTS_CACHE
    : '';

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
          btn.disabled = false;
          btn.textContent = 'SEND';
          beepReceive();
          addMsg('ai', fullText);
          showLogButton();
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

  var typeColors = { 'SKILL': '#9999FF', 'AGENT': '#FFCC99', 'MCP': '#FF9900', 'HOOK': '#CC9966', 'PLUGIN': '#CC99CC', 'ENV': '#66CCCC', 'MEMORY': '#9999CC', 'SESSION': '#88AACC', 'CLAUDE.MD': '#EE8844' };
  var sectionMap = { 'SKILL': 'skills', 'AGENT': 'agents', 'MCP': 'mcp', 'HOOK': 'hooks', 'PLUGIN': 'plugins', 'ENV': 'env', 'MEMORY': 'memory', 'SESSION': 'sessions', 'CLAUDE.MD': 'claudemd' };

  var matches = [];
  Object.keys(D).forEach(function(k) {
    var d = D[k];
    var searchable = (d.t + ' ' + d.tp + ' ' + d.m + ' ' + (d.b || '')).toLowerCase();
    if (searchable.indexOf(q) === -1) return;
    var type = d.tp.split(' ')[0].replace('CLAUDE.MD', 'CLAUDE.MD');
    if (d.tp.indexOf('CLAUDE.MD') !== -1) type = 'CLAUDE.MD';
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
});

// ═══ TACTICAL TAB SWITCHING ═══
function switchTac(view) {
  document.querySelectorAll('.tac-view').forEach(function(v) { v.classList.remove('act'); });
  document.querySelectorAll('.tac-tab').forEach(function(t) { t.classList.remove('act'); });
  document.getElementById('tac-' + view).classList.add('act');
  document.getElementById('tac-tab-' + view).classList.add('act');
  beepNav();
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

// Random Q encounters (5% chance every 2 minutes)
setInterval(function() {
  if (Math.random() < 0.05) qFlash();
}, 120000);
</script>
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
    console.log('    ANTHROPIC_API_KEY    Required for chat (live mode)');
    console.log('    ELEVENLABS_API_KEY   Optional premium voice');
    console.log('    PORT                 Server port (default: 3200)');
    console.log('');
  }
}
