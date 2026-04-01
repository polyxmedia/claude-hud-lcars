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
    const raw = fs.readFileSync(f, 'utf-8');
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
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const name = f.replace('.md', '');
    const desc = raw.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.slice(0, 200) || '';
    out.push({ name, desc, body: raw.replace(/^---\n[\s\S]*?\n---\n*/, '') });
  }
  return out;
}

function getSettings() {
  const p = path.join(CLAUDE_DIR, 'settings.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

function getMcpServers(s) {
  if (!s?.mcpServers) return [];
  return Object.entries(s.mcpServers).map(([name, c]) => ({
    name, cmd: c.command, args: c.args || [], hasEnv: !!c.env,
    config: { ...c, env: c.env ? '{redacted}' : undefined },
  }));
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
      const raw = fs.readFileSync(path.join(md, f), 'utf-8');
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

function getEnv(s) { return s?.env || {}; }

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escJ(s) { return JSON.stringify(s).replace(/</g,'\\u003c').replace(/>/g,'\\u003e'); }

// ── BUILD ──

function gen() {
  const S = getSettings();
  const skills = getSkills(), agents = getAgents(), mcp = getMcpServers(S);
  const hooks = getHooks(S), env = getEnv(S), plugins = getPlugins(S);
  const mem = getMemoryFiles(), sessions = getSessionCount();
  const ts = new Date().toISOString().replace('T',' ').slice(0,19)+'Z';
  const stardate = new Date().toISOString().slice(0,10).replace(/-/g,'.');

  const D = {};
  skills.forEach(s => { D['s:'+s.name] = { t: s.name, tp: 'SKILL MODULE', m: (s.ver?'v'+s.ver:'')+(s.ctx?' // '+s.ctx:''), b: s.body }; });
  agents.forEach(a => { D['a:'+a.name] = { t: a.name, tp: 'AGENT DEFINITION', m: '', b: a.body }; });
  mcp.forEach(s => { D['m:'+s.name] = { t: s.name, tp: 'MCP SERVER CONFIG', m: s.cmd+' '+s.args.join(' '), b: JSON.stringify(s.config,null,2) }; });
  hooks.forEach((h,i) => { D['h:'+i] = { t: h.ev+' // '+h.matcher, tp: 'HOOK INTERCEPT', m: 'TYPE: '+h.type+(h.async?' // ASYNC':''), b: JSON.stringify(h.full,null,2) }; });
  mem.forEach(m => { D['e:'+m.file] = { t: m.name, tp: 'MEMORY FILE // '+m.type.toUpperCase(), m: m.proj, b: m.body }; });

  const sections = [
    { id: 'skills', label: 'SKILLS', color: '#9999FF', count: skills.length },
    { id: 'mcp', label: 'MCP SERVERS', color: '#FF9900', count: mcp.length },
    { id: 'hooks', label: 'HOOKS', color: '#CC9966', count: hooks.length },
    { id: 'plugins', label: 'PLUGINS', color: '#CC99CC', count: plugins.length },
    { id: 'agents', label: 'AGENTS', color: '#FFCC99', count: agents.length },
    { id: 'env', label: 'ENVIRONMENT', color: '#66CCCC', count: Object.keys(env).length },
    { id: 'memory', label: 'MEMORY', color: '#9999CC', count: mem.length },
  ];

return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLAUDE-HUD // LCARS</title>
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

/* ═══ LCARS LAYOUT ═══ */
.lcars{display:grid;grid-template-columns:240px 1fr;grid-template-rows:72px 48px 1fr 40px;height:100vh;gap:4px;padding:0}

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
  padding:10px 20px;font-size:0.6rem;color:rgba(0,0,0,0.4);
  letter-spacing:0.08em;margin-top:auto;
}

/* ═══ TOP BAR ═══ */
.tb{grid-column:2;display:flex;gap:4px}
.tb-elbow{width:72px;background:var(--orange);border-radius:0 0 0 48px;flex-shrink:0}
.tb-fill{flex:1;background:var(--orange);display:flex;align-items:center;justify-content:flex-end;padding:0 24px;gap:28px;
  font-family:'Antonio',sans-serif;font-size:0.95rem;letter-spacing:0.1em;color:rgba(0,0,0,0.4);text-transform:uppercase}
.tb-a1{width:100px;background:var(--peach)}
.tb-a2{width:60px;background:var(--blue);border-radius:0 0 24px 0}

/* ═══ STATS BAR ═══ */
.stb{grid-column:2;display:flex;gap:4px}
.stb-edge{width:72px;background:var(--blue);flex-shrink:0}
.stb-inner{flex:1;display:flex;gap:2px;background:var(--faint)}
.st{flex:1;background:#0a0a0c;padding:6px 12px;text-align:center}
.st-n{font-family:'Antonio',sans-serif;font-size:1.6rem;font-weight:700;color:var(--orange);line-height:1}
.st-l{font-size:0.55rem;color:var(--dim);text-transform:uppercase;letter-spacing:0.12em;margin-top:2px}

/* ═══ MAIN AREA ═══ */
.mn{grid-column:2;display:flex;gap:4px;min-height:0;overflow:hidden}
.mn-edge{width:72px;background:var(--blue);flex-shrink:0;border-radius:0;position:relative}
.mn-edge::after{content:'';position:absolute;bottom:0;left:0;right:0;height:48px;background:var(--lavender);border-radius:48px 0 0 0}

.mn-content{flex:1;display:grid;grid-template-columns:1fr 0fr;transition:grid-template-columns 0.25s ease;min-height:0;overflow:hidden;gap:4px}
.mn-content.open{grid-template-columns:1fr 1fr}

/* ═══ LIST ═══ */
.ls{background:#060608;overflow-y:auto;min-height:0}

.sec{display:none}
.sec.on{display:block}

.sec-h{
  position:sticky;top:0;z-index:5;background:#060608;
  padding:16px 20px 10px;border-bottom:2px solid #1a1a1e;
  font-family:'Antonio',sans-serif;font-size:1.2rem;font-weight:600;
  text-transform:uppercase;letter-spacing:0.08em;color:var(--orange);
}

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

/* ═══ DETAIL PANEL (PADD) ═══ */
.dp{background:#08080a;overflow-y:auto;min-height:0;opacity:0;transition:opacity 0.2s;border-left:4px solid var(--orange);position:relative}
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

/* ═══ BOTTOM BAR ═══ */
.bb{grid-column:2;display:flex;gap:4px}
.bb-elbow{width:72px;background:var(--lavender);border-radius:48px 0 0 0;flex-shrink:0}
.bb-fill{flex:1;background:var(--lavender);display:flex;align-items:center;justify-content:space-between;padding:0 24px;
  font-size:0.65rem;color:rgba(0,0,0,0.35);letter-spacing:0.06em}
.bb-a{width:160px;background:var(--blue)}

@media(max-width:900px){
  .lcars{grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto}
  .sb{display:none}
  .mn-content.open{grid-template-columns:1fr}
  .dp{position:fixed;inset:0;z-index:100;border-left:none}
}
@media(prefers-reduced-motion:reduce){*{transition-duration:0.01ms!important}}
</style>
</head><body>
<div class="lcars">

<nav class="sb">
  <div class="sb-top"><h1>Claude<br>HUD</h1><small>LCARS INTERFACE // ${stardate}</small></div>
  <div class="sb-nav">
    ${sections.map((s,i) => `<button class="nb${i===0?' act':''}" style="background:${s.color}" onclick="nav('${s.id}',this)">${s.label} <span class="nc">${String(s.count).padStart(3,'0')}</span></button>`).join('\n    ')}
  </div>
  <div class="sb-foot">STARDATE ${stardate} // ${ts}</div>
</nav>

<div class="tb">
  <div class="tb-elbow"></div>
  <div class="tb-fill">
    <span>MODEL: ${esc(S?.model||'DEFAULT')}</span>
    <span>ASSETS: ${String(skills.length+agents.length+mcp.length+hooks.length+plugins.length).padStart(3,'0')}</span>
    <span>SESSIONS: ${String(sessions).padStart(5,'0')}</span>
    <span>STARDATE ${stardate}</span>
  </div>
  <div class="tb-a1"></div>
  <div class="tb-a2"></div>
</div>

<div class="stb">
  <div class="stb-edge"></div>
  <div class="stb-inner">
    ${sections.map(s => `<div class="st"><div class="st-n">${String(s.count).padStart(3,'0')}</div><div class="st-l">${s.label}</div></div>`).join('\n    ')}
  </div>
</div>

<div class="mn">
  <div class="mn-edge"></div>
  <div class="mn-content" id="mc">
    <div class="ls">

      <div class="sec on" id="s-skills">
        <div class="sec-h">Skill Registry</div>
        ${skills.length===0?'<div class="emp">No skills registered</div>':skills.map(s=>`
        <div class="r" onclick="open_('s:${esc(s.name)}')" data-k="s:${esc(s.name)}">
          <span class="r-id">${esc(s.name)}</span>
          <span class="r-tg">${s.ctx?`<span class="tg tg-b">${esc(s.ctx)}</span>`:''}${s.ver?`<span class="tg tg-d">v${esc(s.ver)}</span>`:''}</span>
          <span class="r-d">${esc(s.desc)}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-mcp">
        <div class="sec-h">MCP Server Fleet</div>
        ${mcp.length===0?'<div class="emp">No servers connected</div>':mcp.map(s=>`
        <div class="r" onclick="open_('m:${esc(s.name)}')" data-k="m:${esc(s.name)}">
          <span class="r-id">${esc(s.name)}</span>
          <span class="r-tg"><span class="tg tg-g">${esc(s.cmd)}</span>${s.hasEnv?'<span class="tg tg-t">env</span>':''}</span>
          <span class="r-d">${esc(s.args.join(' '))}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-hooks">
        <div class="sec-h">Hook Intercepts</div>
        ${hooks.length===0?'<div class="emp">No hooks active</div>':hooks.map((h,i)=>`
        <div class="r" onclick="open_('h:${i}')" data-k="h:${i}">
          <span class="r-id">${esc(h.ev)}</span>
          <span class="r-tg"><span class="tg tg-t">${esc(h.type)}</span><span class="tg tg-b">${esc(h.matcher)}</span>${h.async?'<span class="tg tg-g">async</span>':''}</span>
          <span class="r-d">${esc(h.cmd.slice(0,100))}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-plugins">
        <div class="sec-h">Plugin Manifest</div>
        ${plugins.length===0?'<div class="emp">No plugins loaded</div>':plugins.map(p=>`
        <div class="r r2">
          <span class="r-id">${esc(p.id)}</span>
          <span class="tg ${p.on?'tg-g':'tg-r'}">${p.on?'ACTIVE':'INACTIVE'}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-agents">
        <div class="sec-h">Agent Roster</div>
        ${agents.length===0?'<div class="emp">No agents deployed</div>':agents.map(a=>`
        <div class="r r2" onclick="open_('a:${esc(a.name)}')" data-k="a:${esc(a.name)}">
          <span class="r-id">${esc(a.name)}</span>
          <span class="r-d">${esc(a.desc)}</span>
        </div>`).join('')}
      </div>

      <div class="sec" id="s-env">
        <div class="sec-h">Environment Variables</div>
        ${Object.keys(env).length===0?'<div class="emp">No env overrides</div>':Object.entries(env).map(([k,v])=>`
        <div class="r r2">
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

    </div>

    <div class="dp" id="dp">
      <div class="dp-h">
        <button class="dp-x" onclick="close_()">Close</button>
        <div class="dp-tp" id="dp-tp"></div>
        <div class="dp-t" id="dp-t"></div>
        <div class="dp-m" id="dp-m"></div>
      </div>
      <div class="dp-b" id="dp-b"></div>
    </div>
  </div>
</div>

<div class="bb">
  <div class="bb-elbow"></div>
  <div class="bb-fill"><span>CLAUDE-HUD v1.0.0 // LCARS INTERFACE</span><span>~/.claude/</span></div>
  <div class="bb-a"></div>
</div>

</div>

<script>
const D=${escJ(D)};

function nav(id,el){
  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('on'));
  document.getElementById('s-'+id).classList.add('on');
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('act'));
  el.classList.add('act');
  close_();
}

function open_(k){
  const d=D[k];if(!d)return;
  document.getElementById('dp-tp').textContent=d.tp;
  document.getElementById('dp-t').textContent=d.t;
  document.getElementById('dp-m').textContent=d.m;
  document.getElementById('dp-b').innerHTML=md(d.b);
  document.getElementById('mc').classList.add('open');
  document.querySelectorAll('.r.sel').forEach(r=>r.classList.remove('sel'));
  const row=document.querySelector('[data-k="'+k+'"]');
  if(row)row.classList.add('sel');
}

function close_(){
  document.getElementById('mc').classList.remove('open');
  document.querySelectorAll('.r.sel').forEach(r=>r.classList.remove('sel'));
}

document.addEventListener('keydown',e=>{if(e.key==='Escape')close_()});

function hlJson(s) {
  // Syntax highlight JSON
  return s
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\s*:/g, '<span class="key">"$1"</span>:')
    .replace(/"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"/g, '<span class="str">"$1"</span>')
    .replace(/\b(true|false)\b/g, '<span class="bool">$1</span>')
    .replace(/\b(null)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(-?\d+\.?\d*)\b/g, '<span class="num">$1</span>');
}

function hlCode(s, lang) {
  let h = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (lang === 'json' || lang === '') {
    // Try JSON highlight if it looks like JSON
    if (h.trimStart().startsWith('{') || h.trimStart().startsWith('[')) {
      return hlJson(s);
    }
  }
  // Generic: highlight strings, comments, numbers, common keywords
  h = h.replace(/(\/\/.*$)/gm, '<span class="cmt">$1</span>');
  h = h.replace(/(#.*$)/gm, '<span class="cmt">$1</span>');
  h = h.replace(/"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"/g, '<span class="str">"$1"</span>');
  h = h.replace(/'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'/g, "<span class='str'>'$1'</span>");
  h = h.replace(/\b(function|const|let|var|return|if|else|for|while|import|export|from|async|await|class|new|this|type|interface)\b/g, '<span class="kw">$1</span>');
  h = h.replace(/\b(true|false|null|undefined|nil)\b/g, '<span class="bool">$1</span>');
  h = h.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
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

  // Markdown rendering
  let h = esc(t);
  const codeBlocks = [];

  // Extract fenced code blocks first to protect them
  const fenceRx = new RegExp('\x60\x60\x60(\\w*)\\n([\\s\\S]*?)\x60\x60\x60', 'g');
  h = h.replace(fenceRx, (_, lang, code) => {
    const idx = codeBlocks.length;
    const highlighted = hlCode(code.replace(/\n$/, ''), lang || '');
    codeBlocks.push('<pre data-lang="' + (lang || 'code') + '"><code>' + highlighted + '</code></pre>');
    return '%%CODEBLOCK' + idx + '%%';
  });

  // Inline code
  const inlineRx = new RegExp('\x60([^\x60]+)\x60', 'g');
  h = h.replace(inlineRx, '<code>$1</code>');

  // Headers
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Tables
  h = h.replace(/^\|(.+)\|$/gm, line => {
    if (/^\|[\s\-:|]+\|$/.test(line)) return '%%TABLESEP%%';
    const cells = line.split('|').filter(c => c.trim());
    return '<tr>' + cells.map(c => '<td>' + c.trim() + '</td>').join('') + '</tr>';
  });
  h = h.replace(/%%TABLESEP%%\n?/g, '');
  h = h.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>');

  // Lists
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, m => '<ul>' + m + '</ul>');

  // Numbered lists
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Blockquotes
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs (lines that aren't already wrapped)
  h = h.replace(/^(?!<[huplbt]|<\/|%%CODE)(.+)$/gm, '<p>$1</p>');
  h = h.replace(/<p><\/p>/g, '');

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    h = h.replace('%%CODEBLOCK' + i + '%%', block);
  });

  return h;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
</script>
</body></html>`;
}

fs.writeFileSync(OUTPUT, gen());
console.log('Dashboard generated: ' + OUTPUT);
