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
function escJ(s) { return JSON.stringify(s).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/`/g,'\\u0060').replace(/\$/g,'\\u0024'); }

// ── BUILD ──

function gen() {
  const S = getSettings();
  const skills = getSkills(), agents = getAgents(), mcp = getMcpServers(S);
  const hooks = getHooks(S), env = getEnv(S), plugins = getPlugins(S);
  const mem = getMemoryFiles(), sessions = getSessionCount();
  const ts = new Date().toISOString().replace('T',' ').slice(0,19)+'Z';
  const stardate = new Date().toISOString().slice(0,10).replace(/-/g,'.');

  const D = {};
  skills.forEach(s => {
    const skillPath = path.join(CLAUDE_DIR, 'skills', s.name, 'SKILL.md');
    D['s:'+s.name] = { t: s.name, tp: 'SKILL MODULE', m: (s.ver?'v'+s.ver:'')+(s.ctx?' // '+s.ctx:''), b: s.body,
      actions: [
        { label: 'INVOKE', cmd: '/'+s.name, icon: 'RUN' },
        { label: 'OPEN FILE', cmd: 'open '+skillPath, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: skillPath, icon: 'PATH' },
      ]};
  });
  agents.forEach(a => {
    const agentPath = path.join(CLAUDE_DIR, 'agents', a.name+'.md');
    D['a:'+a.name] = { t: a.name, tp: 'AGENT DEFINITION', m: '', b: a.body,
      actions: [
        { label: 'OPEN FILE', cmd: 'open '+agentPath, icon: 'EDIT' },
        { label: 'COPY PATH', cmd: agentPath, icon: 'PATH' },
      ]};
  });
  mcp.forEach(s => {
    D['m:'+s.name] = { t: s.name, tp: 'MCP SERVER CONFIG', m: s.cmd+' '+s.args.join(' '), b: JSON.stringify(s.config,null,2),
      actions: [
        { label: 'COPY CONFIG', cmd: JSON.stringify(s.config,null,2), icon: 'COPY' },
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
      ]};
  });
  hooks.forEach((h,i) => {
    D['h:'+i] = { t: h.ev+' // '+h.matcher, tp: 'HOOK INTERCEPT', m: 'TYPE: '+h.type+(h.async?' // ASYNC':''), b: JSON.stringify(h.full,null,2),
      actions: [
        { label: 'COPY HOOK JSON', cmd: JSON.stringify(h.full,null,2), icon: 'COPY' },
        { label: 'EDIT SETTINGS', cmd: 'open '+path.join(CLAUDE_DIR,'settings.json'), icon: 'EDIT' },
      ]};
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

  const sections = [
    { id: 'skills', label: 'SKILLS', color: '#9999FF', count: skills.length },
    { id: 'mcp', label: 'MCP SERVERS', color: '#FF9900', count: mcp.length },
    { id: 'hooks', label: 'HOOKS', color: '#CC9966', count: hooks.length },
    { id: 'plugins', label: 'PLUGINS', color: '#CC99CC', count: plugins.length },
    { id: 'agents', label: 'AGENTS', color: '#FFCC99', count: agents.length },
    { id: 'env', label: 'ENVIRONMENT', color: '#66CCCC', count: Object.keys(env).length },
    { id: 'memory', label: 'MEMORY', color: '#9999CC', count: mem.length },
    { id: 'comms', label: 'COMMS', color: '#FF9966', count: null },
  ];

return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLAUDE-HUD // LCARS</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='4' fill='%23000'/><path d='M16 3 L26 28 L16 22 L6 28 Z' fill='%23FF9900'/><circle cx='16' cy='14' r='2.5' fill='%23000'/><line x1='8' y1='20' x2='24' y2='20' stroke='%23000' stroke-width='1.5'/></svg>" type="image/svg+xml">
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
.comms-msg.user{align-self:flex-end;background:rgba(153,153,255,0.1);border:1px solid rgba(153,153,255,0.2);padding:10px 14px;color:var(--blue)}
.comms-msg.ai{align-self:flex-start;color:var(--text);padding:10px 0}
.comms-msg.ai pre{background:#0a0a0c;border-left:3px solid var(--blue);padding:12px;margin:8px 0;overflow-x:auto;font-size:0.82rem;color:var(--cyan)}
.comms-msg.ai code{background:rgba(255,153,0,0.08);color:var(--orange);padding:2px 5px;font-size:0.84rem}
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
  padding:16px 20px;z-index:49;
  display:none;font-size:0.88rem;line-height:1.7;color:var(--text);
}
.computer-response.visible{display:block}
.computer-response .cr-close{
  position:sticky;top:0;float:right;
  background:var(--orange);border:none;color:var(--bg);
  font-family:'Antonio',sans-serif;font-size:0.75rem;font-weight:600;
  padding:3px 10px;cursor:pointer;letter-spacing:0.08em;
  border-radius:10px;margin-left:8px;
}
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

.computer-response h1,.computer-response h2,.computer-response h3{font-family:'Antonio',sans-serif;text-transform:uppercase;color:var(--peach);margin:16px 0 8px}
.computer-response code{background:rgba(255,153,0,0.08);color:var(--orange);padding:2px 5px}
.computer-response pre{background:#000;border-left:3px solid var(--blue);padding:12px;margin:8px 0;overflow-x:auto;font-size:0.82rem;color:var(--cyan)}
.computer-response pre code{background:none;color:inherit;padding:0}
.computer-response strong{color:#eee}

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
  <div class="sb-top">
    <div style="display:flex;align-items:center;gap:10px">
      <svg viewBox="0 0 40 48" style="width:28px;height:34px;flex-shrink:0"><path d="M20 2 L34 44 L20 35 L6 44 Z" fill="#000" opacity="0.3"/><path d="M20 4 L32 42 L20 34 L8 42 Z" fill="#000"/><circle cx="20" cy="18" r="3" fill="#FF9900" opacity="0.6"/></svg>
      <h1>Claude<br>HUD</h1>
    </div>
    <small>LCARS INTERFACE // ${stardate}</small>
  </div>
  <div class="sb-nav">
    ${sections.map((s,i) => `<button class="nb${i===0?' act':''}" style="background:${s.color}" onclick="nav('${s.id}',this)">${s.label} ${s.count!==null?`<span class="nc">${String(s.count).padStart(3,'0')}</span>`:''}</button>`).join('\n    ')}
  </div>
  <div class="sb-foot">STARDATE ${stardate} // ${ts}</div>
</nav>

<div class="tb">
  <div class="tb-elbow"></div>
  <div class="tb-fill">
    <span>MODEL: ${esc(S?.model||'DEFAULT')}</span>
    <span>ASSETS: ${String(skills.length+agents.length+mcp.length+hooks.length+plugins.length).padStart(3,'0')}</span>
    <span>SESSIONS: ${String(sessions).padStart(5,'0')}</span>
    <span style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 40 48" style="width:12px;height:15px"><path d="M20 4 L32 42 L20 34 L8 42 Z" fill="rgba(0,0,0,0.35)"/></svg>STARDATE ${stardate}</span>
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

      <div class="sec" id="s-comms">
        <div class="comms">
          <div class="comms-log" id="comms-log">
            <div class="comms-msg sys">COMMS CHANNEL // USE THE COMPUTER BAR BELOW TO COMMUNICATE</div>
            <div class="comms-msg sys">ALL CONVERSATIONS ARE DISPLAYED HERE</div>
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
  <button class="cr-close" onclick="closeCR()">DISMISS</button>
  <div id="cr-body"></div>
</div>

<div class="computer-bar">
  <div class="computer-bar-label"><svg viewBox="0 0 40 48" style="width:14px;height:17px;margin-right:6px"><path d="M20 4 L32 42 L20 34 L8 42 Z" fill="#000" opacity="0.4"/></svg>COMPUTER</div>
  <div class="computer-bar-input">
    <textarea id="cb-in" placeholder="Ask the computer anything..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendGlobal()}"></textarea>
  </div>
  <span class="waveform-label hidden" id="wf-label"></span>
  <div class="waveform hidden" id="waveform"></div>
  <button class="computer-bar-send" id="cb-send" onclick="sendGlobal()">SEND</button>
  <div class="computer-bar-toggles">
    <button class="tgl-btn off" id="voice-toggle" style="background:var(--salmon)" onclick="toggleVoice(this)">VOICE</button>
    <button class="tgl-btn on" id="sound-toggle" style="background:var(--blue)" onclick="toggleBtn(this)">SFX</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const D=${escJ(D)};

function nav(id,el){
  document.querySelectorAll('.sec').forEach(function(s){s.classList.remove('on')});
  document.getElementById('s-'+id).classList.add('on');
  document.querySelectorAll('.nb').forEach(function(b){b.classList.remove('act')});
  el.classList.add('act');
  close_();
  // In comms mode, hide the detail panel column entirely
  if (id === 'comms') {
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

  document.getElementById('mc').classList.add('open');
  document.querySelectorAll('.r.sel').forEach(function(r){r.classList.remove('sel')});
  var row=document.querySelector('[data-k="'+k+'"]');
  if(row)row.classList.add('sel');
}

function close_(){
  document.getElementById('mc').classList.remove('open');
  document.querySelectorAll('.r.sel').forEach(r=>r.classList.remove('sel'));
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
    if(confirm('Copy delete command to clipboard?\\n'+cmd)){
      navigator.clipboard.writeText(cmd).then(function(){
        toast('Copied delete command');
      });
    }
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

  // Markdown rendering
  let h = esc(t);
  const codeBlocks = [];

  // Extract fenced code blocks first to protect them
  const BT = String.fromCharCode(96);
  const fenceRx = new RegExp(BT+BT+BT+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT+BT+BT, 'g');
  h = h.replace(fenceRx, (_, lang, code) => {
    const idx = codeBlocks.length;
    const highlighted = hlCode(code.replace(new RegExp('\\\\n$'), ''), lang || '');
    codeBlocks.push('<pre data-lang="' + (lang || 'code') + '"><code>' + highlighted + '</code></pre>');
    return '%%CODEBLOCK' + idx + '%%';
  });

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

function beepNav() { lcarsBeep(1200, 0.08); }
function beepOpen() { lcarsBeep(800, 0.06); setTimeout(function(){lcarsBeep(1600, 0.06)}, 60); }
function beepAction() { lcarsBeep(1000, 0.05); }
function beepSend() { lcarsBeep(600, 0.05); setTimeout(function(){lcarsBeep(900, 0.08)}, 80); }
function beepReceive() { lcarsBeep(440, 0.12); }

// Patch nav and open_ to add sounds
var _origNav = nav;
nav = function(id, el) { beepNav(); _origNav(id, el); };
var _origOpen = open_;
open_ = function(k) { beepOpen(); _origOpen(k); };

// ═══ VOICE OUTPUT (Web Speech API) ═══
function speak(text) {
  if (!isToggleOn('voice-toggle')) return;
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  var u = new SpeechSynthesisUtterance(text.slice(0, 500));
  var voices = speechSynthesis.getVoices();
  // Prefer a female English voice
  var preferred = voices.find(function(v){return v.name.includes('Samantha')})
    || voices.find(function(v){return v.name.includes('Karen')})
    || voices.find(function(v){return v.name.includes('Victoria')})
    || voices.find(function(v){return v.name.includes('Fiona')})
    || voices.find(function(v){return v.lang.startsWith('en') && v.name.toLowerCase().includes('female')})
    || voices.find(function(v){return v.lang.startsWith('en-')});
  if (preferred) u.voice = preferred;
  u.rate = 0.95;
  u.pitch = 1.1;
  speechSynthesis.speak(u);
}

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

  // Show live transcription overlay
  var cr = document.getElementById('cr');
  var crBody = document.getElementById('cr-body');
  crBody.innerHTML = '<span style="color:var(--salmon);font-family:Antonio,sans-serif;font-size:0.75rem;letter-spacing:0.12em;text-transform:uppercase">VOICE INPUT ACTIVE</span><p id="live-transcript" style="color:var(--text);margin-top:10px;font-size:1rem;line-height:1.6;min-height:2em"></p>';
  cr.classList.add('visible');

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
    input.value = finalTranscript + interim;
    // Update live transcription display
    var liveEl = document.getElementById('live-transcript');
    if (liveEl) {
      liveEl.innerHTML = esc(finalTranscript) + '<span style="color:var(--dim)">' + esc(interim) + '</span>';
    }
  };

  recognition.onend = function() {
    micActive = false;
    hideWaveform();
    if (finalTranscript.trim()) {
      beepSend();
      sendGlobal();
    } else {
      cr.classList.remove('visible');
    }
  };

  recognition.onerror = function(e) {
    micActive = false;
    hideWaveform();
    cr.classList.remove('visible');
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

  // ElevenLabs mode
  if (window.HUD_ELEVENLABS && window.HUD_LIVE) {
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
    body: JSON.stringify({ text: text.slice(0, 1000) }),
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
  var currentKey = document.querySelector('.r.sel');
  var key = currentKey ? currentKey.getAttribute('data-k') : null;
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

// Auto-restart listening after computer finishes speaking (voice conversation loop)
var _origSpeakForLoop = speak;
speak = function(text) {
  _origSpeakForLoop(text);
  // After speech ends, restart listening if voice mode still on
  if (window.speechSynthesis && isToggleOn('voice-toggle')) {
    var checkDone = setInterval(function() {
      if (!speechSynthesis.speaking) {
        clearInterval(checkDone);
        setTimeout(function() {
          if (isToggleOn('voice-toggle') && !micActive) {
            startListening();
          }
        }, 500);
      }
    }, 200);
  }
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

// Escape stops speech
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') stopSpeaking();
});

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
  document.getElementById('cr').classList.remove('visible');
}

function sendGlobal() {
  var input = document.getElementById('cb-in');
  var text = input.value.trim();
  if (!text) return;

  if (!window.HUD_LIVE) {
    toast('COMMS OFFLINE. Run: node src/server.js');
    return;
  }

  beepSend();
  input.value = '';

  // Show in comms log
  addMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  // Show response overlay
  var cr = document.getElementById('cr');
  var crBody = document.getElementById('cr-body');
  crBody.innerHTML = '<span style="color:var(--dim)">Processing...</span>';
  cr.classList.add('visible');

  var btn = document.getElementById('cb-send');
  btn.disabled = true;
  btn.textContent = '...';

  var fullText = '';

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chatHistory }),
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
          chatHistory.push({ role: 'assistant', content: fullText });
          btn.disabled = false;
          btn.textContent = 'SEND';
          beepReceive();
          speak(fullText);
          addMsg('ai', fullText);
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
              if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
                fullText += evt.delta.text;
                crBody.innerHTML = md(fullText);
                cr.scrollTop = cr.scrollHeight;
              }
            } catch(e) {}
          }
        }
        return pump();
      });
    }

    return pump();
  }).catch(function(e) {
    crBody.innerHTML = '<span style="color:var(--red)">ERROR: ' + esc(e.message) + '</span>';
    addMsg('err', 'COMMS ERROR: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'SEND';
  });
}
</script>
</body></html>`;
}

fs.writeFileSync(OUTPUT, gen());
console.log('Dashboard generated: ' + OUTPUT);
