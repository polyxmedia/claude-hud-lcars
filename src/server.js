#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { categorizeChange, resolveWatchPath, buildChangeEvent, buildHudEvent } from './lib/fileWatcher.js';
import { findActiveSessionJsonl, readSessionTotalTokens, readCurrentContextTokens, calcBurnRate, projectMinutesRemaining, formatBurnBar } from './lib/burnRate.js';

// CRC32 table built once at module load (used by solidPng)
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

// Minimal solid-color PNG generator (no external deps) — used for PWA icons
function solidPng(size, r, g, b) {
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
  const rowSize = 1 + size * 3;
  const raw = Buffer.alloc(size * rowSize);
  // LCARS elbow icon: orange L-shape with concave inner quarter-circle
  const sideW = Math.round(size * 0.292);  // left sidebar width  (~56/192)
  const topH  = Math.round(size * 0.302);  // top bar height       (~58/192)
  const elbowR = Math.round(size * 0.229); // concave radius       (~44/192)
  // elbow arc centre is at (sideW, topH)
  for (let y = 0; y < size; y++) {
    const base = y * rowSize + 1;
    for (let x = 0; x < size; x++) {
      const inSidebar = x < sideW;
      const inTopBar  = y < topH && !inSidebar;
      // concave cut-out: pixels in the bottom-right quadrant of the elbow arc that are NOT orange
      const inElbowZone = x >= sideW && y >= topH;
      const dx = x - sideW, dy = y - topH;
      const inConcave = inElbowZone && (dx * dx + dy * dy) < elbowR * elbowR;
      let pr = 0, pg = 0, pb = 0; // black default
      if ((inSidebar || inTopBar) && !inConcave) { pr = r; pg = g; pb = b; } // orange
      // Accent bars in content area (blue, lavender, tan)
      else if (!inSidebar && !inTopBar && !inConcave) {
        const cx = x - sideW - Math.round(size * 0.062); // content x offset
        const barX = Math.round(size * 0.062);
        if (cx >= barX) {
          const relY = y - topH - Math.round(size * 0.062);
          const barH = Math.round(size * 0.073);
          const gap  = Math.round(size * 0.031);
          if (relY >= 0 && relY < barH) { pr = 0x66; pg = 0x77; pb = 0xFF; }
          else if (relY >= barH + gap && relY < barH * 2 + gap) { pr = 0xCC; pg = 0x99; pb = 0xCC; }
          else if (relY >= barH * 2 + gap * 2 && relY < barH * 3 + gap * 2) { pr = 0xCC; pg = 0x99; pb = 0x66; }
        }
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

const PORT = parseInt(process.env.PORT || '3200', 10);
const API_KEY = process.env.CLAUDE_DASHBOARD_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // "Sarah" - clear, professional female

// Self-restart: if spawned with a delay flag, wait for the old process to release the port
if (process.env.CLAUDE_HUD_RESTART_DELAY) {
  await new Promise(r => setTimeout(r, parseInt(process.env.CLAUDE_HUD_RESTART_DELAY, 10) || 800));
}

let PKG_VERSION = 'unknown';
try { PKG_VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8')).version; } catch {}

// Import the dashboard generator
const dashboardPath = path.join(import.meta.dirname, '..', 'dashboard.html');

// Generate dashboard on startup
async function generateDashboard() {
  const { execSync } = await import('child_process');
  execSync('node ' + path.join(import.meta.dirname, 'generate.js') + ' --no-open', { stdio: 'pipe' });
}

// ─── SSE live-events system ────────────────────────────────────────────────
// Connected clients waiting for server-sent events
const sseClients = new Set();

function sseBroadcast(payload) {
  const data = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

// File watcher — recursive watch on ~/.claude/
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HUD_EVENTS_PATH = path.join(CLAUDE_DIR, 'hud-events.jsonl');
let hudEventsOffset = 0; // byte offset — track the tail of hud-events.jsonl

function initFileWatcher() {
  if (!fs.existsSync(CLAUDE_DIR)) return;
  // Debounce map: path → timer
  const debounce = new Map();
  try {
    fs.watch(CLAUDE_DIR, { recursive: true }, (eventType, filename) => {
      const filePath = resolveWatchPath(CLAUDE_DIR, filename);
      const key = filePath;
      if (debounce.has(key)) clearTimeout(debounce.get(key));
      debounce.set(key, setTimeout(() => {
        debounce.delete(key);
        const category = categorizeChange(filePath, CLAUDE_DIR);
        // For hud-events, tail new lines and broadcast each as hud-event
        if (category === 'hud-events') {
          tailHudEvents();
          return;
        }
        sseBroadcast(buildChangeEvent(category, filePath));
      }, 150));
    });
  } catch { /* fs.watch not available on this platform */ }
}

function tailHudEvents() {
  try {
    const stat = fs.statSync(HUD_EVENTS_PATH);
    if (stat.size <= hudEventsOffset) return;
    const fd = fs.openSync(HUD_EVENTS_PATH, 'r');
    const buf = Buffer.alloc(stat.size - hudEventsOffset);
    fs.readSync(fd, buf, 0, buf.length, hudEventsOffset);
    fs.closeSync(fd);
    hudEventsOffset = stat.size;
    const newContent = buf.toString('utf-8');
    for (const line of newContent.split('\n')) {
      const evt = buildHudEvent(line.trim());
      if (evt) sseBroadcast(evt);
    }
  } catch { /* file may not exist yet */ }
}

// Burn rate broadcast — every 15s
// Context window limit: Claude models have a 200k token context window.
// We use the last assistant message's input_tokens as the current snapshot
// (it's cumulative — it represents exactly what was sent to the model).
const CONTEXT_LIMIT = 200_000;
function broadcastBurnRate() {
  try {
    const jsonlPath = findActiveSessionJsonl(CLAUDE_DIR);
    if (!jsonlPath) return;
    const current = readCurrentContextTokens(jsonlPath);
    const pct = (current / CONTEXT_LIMIT) * 100;
    sseBroadcast({
      type: 'burn-rate',
      pct: Math.min(100, Math.round(pct * 10) / 10),
      totalTokens: current,
      limit: CONTEXT_LIMIT,
      sessionPath: jsonlPath,
    });
  } catch { /* non-fatal */ }
}

// Initialise watcher after a short delay so the server is fully listening first
setTimeout(() => {
  initFileWatcher();
  broadcastBurnRate();
  setInterval(broadcastBurnRate, 15_000);
}, 500);

const server = http.createServer(async (req, res) => {
  // Block cross-origin POST/PUT/DELETE (CSRF protection — localhost server writes files)
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-origin requests not allowed' }));
      return;
    }
  }

  // CORS headers (read-only paths allow any origin; mutations already blocked above)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Web app manifest for PWA install
  if (req.method === 'GET' && req.url === '/manifest.json') {
    const manifest = {
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
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify(manifest));
    return;
  }

  // Service worker — fetch handler required for Chrome PWA install eligibility
  if (req.method === 'GET' && req.url === '/sw.js') {
    const sw = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Always fetch from network — server generates fresh content on every load
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
`;
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(sw);
    return;
  }

  // App icon SVG
  if (req.method === 'GET' && req.url === '/icon.svg') {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" fill="#000"/>
  <!-- LCARS elbow: orange L-shape with concave inner quarter-circle -->
  <path d="M 0 0 L 192 0 L 192 58 L 100 58 A 44 44 0 0 0 56 102 L 56 192 L 0 192 Z" fill="#FF9900"/>
  <!-- Content accent bars -->
  <rect x="68" y="114" width="108" height="14" rx="6" fill="#6677FF"/>
  <rect x="68" y="136" width="76" height="14" rx="6" fill="#CC99CC"/>
  <rect x="68" y="158" width="92" height="14" rx="6" fill="#CC9966"/>
</svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(icon);
    return;
  }

  // App icons as PNG (Chrome requires PNG for PWA install prompt)
  if (req.method === 'GET' && req.url === '/icon-192.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(solidPng(192, 0xFF, 0x99, 0x00));
    return;
  }

  if (req.method === 'GET' && req.url === '/icon-512.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(solidPng(512, 0xFF, 0x99, 0x00));
    return;
  }

  // Health check for auto-detection from static HTML
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: 'ok', chat: !!API_KEY }));
    return;
  }

  // Version check — current version + latest from npm registry
  if (req.method === 'GET' && req.url === '/api/version') {
    try {
      const npmRes = await fetch('https://registry.npmjs.org/claude-hud-lcars/latest');
      const data = await npmRes.json();
      const latest = data.version || PKG_VERSION;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current: PKG_VERSION, latest, hasUpdate: latest !== PKG_VERSION }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current: PKG_VERSION, latest: null, hasUpdate: false }));
    }
    return;
  }

  // Run update — streams npm install -g output then restarts
  if (req.method === 'POST' && req.url === '/api/update') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const { spawn } = await import('child_process');
    const proc = spawn('npm', ['install', '-g', 'claude-hud-lcars@latest'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => res.write('data: ' + JSON.stringify({ text: d.toString() }) + '\n\n'));
    proc.stderr.on('data', d => res.write('data: ' + JSON.stringify({ text: d.toString() }) + '\n\n'));
    proc.on('close', code => {
      res.write('data: ' + JSON.stringify({ done: true, code }) + '\n\n');
      res.end();
      if (code === 0) {
        setTimeout(async () => {
          const child = spawn(process.execPath, [import.meta.filename], {
            detached: true, stdio: 'ignore',
            env: { ...process.env, CLAUDE_HUD_RESTART_DELAY: '800' },
          });
          child.unref();
          process.exit(0);
        }, 300);
      }
    });
    return;
  }

  // Restart: spawn a fresh server instance then exit (client polls /api/health to detect comeback)
  if (req.method === 'POST' && req.url === '/api/restart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(async () => {
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, [import.meta.filename], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CLAUDE_HUD_RESTART_DELAY: '800' },
      });
      child.unref();
      process.exit(0);
    }, 200);
    return;
  }

  // Serve dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      // Regenerate each time for freshness
      await generateDashboard();
      let html = fs.readFileSync(dashboardPath, 'utf-8');
      // Inject PWA meta tags, manifest link, chat flag, voice mode
      const pwaHead = [
        '<link rel="manifest" href="/manifest.json">',
        '<meta name="theme-color" content="#FF9900">',
        '<meta name="mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-title" content="Claude HUD">',
        '<link rel="apple-touch-icon" href="/icon-192.png">',
        '<script>window.HUD_LIVE=true;window.HUD_ELEVENLABS=' + (!!ELEVEN_KEY) + ';</script>',
      ].join('');
      // Use lastIndexOf to safely handle any extra </head>/<body> tags in generated content
      const headIdx = html.lastIndexOf('</head>');
      if (headIdx !== -1) html = html.slice(0, headIdx) + pwaHead + '</head>' + html.slice(headIdx + 7);

      // Inject install/bookmark banner + SW registration before </body>
      const pwaBanner = `
<style>
#pwa-banner{position:fixed;bottom:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:12px;padding:10px 16px;background:#0a0a0a;border-top:2px solid #FF9900;font-family:monospace;font-size:12px;color:#FF9900;letter-spacing:.05em}
#pwa-banner.hidden{display:none}
#pwa-banner .pwa-label{flex:1;text-transform:uppercase;opacity:.8}
#pwa-banner button{background:#FF9900;color:#000;border:none;padding:6px 14px;font-family:monospace;font-size:11px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border-radius:3px}
#pwa-banner button:hover{background:#FFAA22}
#pwa-banner .pwa-bm{background:transparent;color:#FF9900;border:1px solid #FF9900}
#pwa-banner .pwa-bm:hover{background:#FF990022}
#pwa-banner .pwa-close{background:transparent;color:#666;border:none;font-size:16px;padding:4px 8px;line-height:1}
#pwa-banner .pwa-close:hover{color:#FF9900}
#hud-toolbar{position:fixed;top:10px;right:14px;z-index:9998;display:flex;align-items:center;gap:6px}
#hud-toolbar .hud-tb-btn{background:#FF990018!important;color:#FF9900!important;border:1px solid rgba(255,153,0,0.6)!important;padding:3px 9px;font-family:monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border-radius:3px;opacity:1!important;transition:opacity .15s,background .15s,border-color .15s}
#hud-toolbar .hud-tb-btn:hover{background:#FF990033!important;border-color:#FF9900!important}
#hud-update-badge{background:#FF4400;color:#fff;border:none;opacity:1;animation:upd-pulse 2s ease-in-out infinite}
@keyframes upd-pulse{0%,100%{opacity:.85}50%{opacity:1}}
#update-modal{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center}
#update-modal.open{display:flex}
#update-modal .um-box{background:#07070d;border:2px solid #FF9900;padding:24px 28px;width:480px;max-width:94vw;font-family:monospace}
#update-modal .um-title{font-size:13px;color:#FF9900;text-transform:uppercase;letter-spacing:.12em;margin-bottom:16px}
#update-modal .um-versions{display:flex;gap:16px;margin-bottom:16px;font-size:11px}
#update-modal .um-v{color:var(--dim,#555)}
#update-modal .um-v span{color:#eee}
#update-modal .um-log{background:#02020a;border:1px solid #1a1a1e;padding:10px;height:140px;overflow-y:auto;font-size:10px;color:#88aa66;white-space:pre-wrap;display:none;margin-bottom:12px}
#update-modal .um-actions{display:flex;gap:8px;justify-content:flex-end}
#update-modal button{background:#FF9900;color:#000;border:none;padding:6px 16px;font-family:monospace;font-size:11px;font-weight:bold;text-transform:uppercase;cursor:pointer;border-radius:2px}
#update-modal .um-cancel{background:transparent;color:#666;border:1px solid #333}
#reconnect-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:monospace;color:#FF9900}
#reconnect-overlay.active{display:flex}
#reconnect-overlay .rc-title{font-size:14px;letter-spacing:.15em;text-transform:uppercase}
#reconnect-overlay .rc-dots span{display:inline-block;width:8px;height:8px;border-radius:50%;background:#FF9900;margin:0 3px;animation:rc-pulse 1.2s ease-in-out infinite}
#reconnect-overlay .rc-dots span:nth-child(2){animation-delay:.2s}
#reconnect-overlay .rc-dots span:nth-child(3){animation-delay:.4s}
@keyframes rc-pulse{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
</style>
<div id="hud-toolbar">
  <span id="hud-version" style="font-family:monospace;font-size:10px;color:#444;letter-spacing:.06em"></span>
  <button class="hud-tb-btn" id="hud-update-badge" style="display:none" onclick="document.getElementById('update-modal').classList.add('open')">UPDATE AVAILABLE</button>
  <button class="hud-tb-btn" id="restart-btn" title="Restart server &amp; regenerate dashboard">&#8635; Restart</button>
</div>
<div id="update-modal">
  <div class="um-box">
    <div class="um-title">&#9650; Update Available</div>
    <div class="um-versions">
      <div class="um-v">CURRENT <span id="um-current">—</span></div>
      <div class="um-v">LATEST <span id="um-latest" style="color:#FF9900">—</span></div>
    </div>
    <div class="um-log" id="um-log"></div>
    <div class="um-actions">
      <button class="um-cancel" onclick="document.getElementById('update-modal').classList.remove('open')">Cancel</button>
      <button id="um-run-btn" onclick="runUpdate()">Install Update</button>
    </div>
  </div>
</div>
<div id="reconnect-overlay">
  <div class="rc-title">Restarting LCARS</div>
  <div class="rc-dots"><span></span><span></span><span></span></div>
</div>
<div id="pwa-banner" class="hidden">
  <span class="pwa-label">Add to home screen for quick access</span>
  <button id="pwa-install" style="display:none">Install App</button>
  <button class="pwa-bm" id="pwa-bookmark">Bookmark <span id="pwa-bm-key">⌘D</span></button>
  <button class="pwa-close" id="pwa-dismiss" title="Dismiss">×</button>
</div>
<script>
(function(){
  const DISMISSED_KEY = 'pwa_banner_dismissed';
  const banner = document.getElementById('pwa-banner');
  const installBtn = document.getElementById('pwa-install');
  const bookmarkBtn = document.getElementById('pwa-bookmark');
  const dismissBtn = document.getElementById('pwa-dismiss');
  const bmKey = document.getElementById('pwa-bm-key');

  if (localStorage.getItem(DISMISSED_KEY)) return;

  // Show correct bookmark shortcut
  const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac');
  if (bmKey) bmKey.textContent = isMac ? '⌘D' : 'Ctrl+D';

  let deferredPrompt = null;
  let showTimer = setTimeout(() => {
    if (!localStorage.getItem(DISMISSED_KEY)) banner.classList.remove('hidden');
  }, 3000);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    clearTimeout(showTimer);
    installBtn.style.display = 'inline-block';
    banner.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'accepted') {
      localStorage.setItem(DISMISSED_KEY, '1');
      banner.classList.add('hidden');
    }
  });

  bookmarkBtn.addEventListener('click', () => {
    // Browsers block programmatic bookmark creation — just prompt the shortcut
    if (bmKey) { bmKey.textContent = isMac ? '— press now!' : '— press now!'; }
    setTimeout(() => { if (bmKey) bmKey.textContent = isMac ? '⌘D' : 'Ctrl+D'; }, 2000);
  });

  dismissBtn.addEventListener('click', () => {
    clearTimeout(showTimer);
    localStorage.setItem(DISMISSED_KEY, '1');
    banner.classList.add('hidden');
  });

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Version check
  (async function() {
    try {
      const vr = await fetch('/api/version');
      const vd = await vr.json();
      const vEl = document.getElementById('hud-version');
      if (vEl) vEl.textContent = 'v' + vd.current;
      document.getElementById('um-current').textContent = vd.current;
      document.getElementById('um-latest').textContent = vd.latest || '—';
      if (vd.hasUpdate) {
        document.getElementById('hud-update-badge').style.display = 'inline-block';
      }
    } catch {}
  })();

  function runUpdate() {
    var log = document.getElementById('um-log');
    var btn = document.getElementById('um-run-btn');
    log.style.display = 'block';
    log.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Installing...';
    var es = new EventSource('/api/update');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.text) { log.textContent += d.text; log.scrollTop = log.scrollHeight; }
        if (d.done) {
          es.close();
          if (d.code === 0) {
            log.textContent += '\\nUpdate complete - restarting...';
            setTimeout(function() { location.reload(); }, 2000);
          } else {
            btn.textContent = 'Failed — see log';
            btn.disabled = false;
          }
        }
      } catch {}
    };
    es.onerror = function() { es.close(); btn.textContent = 'Error'; btn.disabled = false; };
  }

  // Restart button
  const restartBtn = document.getElementById('restart-btn');
  const overlay = document.getElementById('reconnect-overlay');
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      restartBtn.disabled = true;
      overlay.classList.add('active');
      try { await fetch('/api/restart', { method: 'POST' }); } catch {}
      // Poll health until the new server is up, then reload
      const poll = setInterval(async () => {
        try {
          const r = await fetch('/api/health');
          if (r.ok) { clearInterval(poll); location.reload(); }
        } catch {}
      }, 600);
    });
  }
})();
</script>`;
      const bodyIdx = html.lastIndexOf('</body>');
      if (bodyIdx !== -1) html = html.slice(0, bodyIdx) + pwaBanner + '</body>' + html.slice(bodyIdx + 7);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard generation failed: ' + e.message);
    }
    return;
  }

  // Projects directory scan
  if (req.method === 'POST' && req.url === '/api/projects') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { dir } = JSON.parse(body);
        const resolved = dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
        if (!fs.existsSync(resolved)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ projects: [] }));
          return;
        }
        const projects = fs.readdirSync(resolved, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name)
          .sort()
          .slice(0, 500);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: [] }));
      }
    });
    return;
  }

  // Open file in default editor
  if (req.method === 'POST' && req.url === '/api/delete') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { path: filePath } = JSON.parse(body);
        const claudeDir = path.join(os.homedir(), '.claude');
        const resolved = path.resolve(filePath.replace(/^~/, os.homedir()));
        if (!resolved.startsWith(claudeDir)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Path outside ~/.claude/ is not allowed' }));
          return;
        }
        if (!fs.existsSync(resolved)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Path not found' }));
          return;
        }
        fs.rmSync(resolved, { recursive: true, force: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/open') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { path: filePath } = JSON.parse(body);
        // Security: only allow opening files under ~/.claude/
        const claudeDir = path.join(os.homedir(), '.claude');
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(claudeDir)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Can only open files under ~/.claude/' }));
          return;
        }
        const { execFile } = await import('child_process');
        // Use 'open' on macOS, 'xdg-open' on Linux
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        await new Promise((resolve, reject) => execFile(cmd, [resolved], (err) => err ? reject(err) : resolve()));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Save file (in-browser editing)
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { path: filePath, content, mkdir: mkdirFlag } = JSON.parse(body);
        const claudeDir = path.join(os.homedir(), '.claude');
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(claudeDir)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Can only save files under ~/.claude/' }));
          return;
        }
        // Create directory if needed
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, content, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Update settings.json (add MCP, hooks, etc.)
  if (req.method === 'POST' && req.url === '/api/settings-update') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

        if (update.type === 'add-mcp') {
          if (!settings.mcpServers) settings.mcpServers = {};
          settings.mcpServers[update.name] = update.config;
        } else if (update.type === 'remove-mcp') {
          if (settings.mcpServers) delete settings.mcpServers[update.name];
          if (settings.mcpServersDisabled) delete settings.mcpServersDisabled[update.name];
        } else if (update.type === 'disable-mcp') {
          const cfg = settings.mcpServers && settings.mcpServers[update.name];
          if (cfg) {
            if (!settings.mcpServersDisabled) settings.mcpServersDisabled = {};
            settings.mcpServersDisabled[update.name] = cfg;
            delete settings.mcpServers[update.name];
          }
        } else if (update.type === 'enable-mcp') {
          const cfg = settings.mcpServersDisabled && settings.mcpServersDisabled[update.name];
          if (cfg) {
            if (!settings.mcpServers) settings.mcpServers = {};
            settings.mcpServers[update.name] = cfg;
            delete settings.mcpServersDisabled[update.name];
          }
        } else if (update.type === 'remove-hook') {
          const idx = update.index;
          if (settings.hooks) {
            for (const ev of Object.keys(settings.hooks)) {
              let flat = 0;
              outer: for (let mi = 0; mi < settings.hooks[ev].length; mi++) {
                const m = settings.hooks[ev][mi];
                if (!m.hooks) continue;
                for (let hi = 0; hi < m.hooks.length; hi++) {
                  if (flat === idx) {
                    m.hooks.splice(hi, 1);
                    if (m.hooks.length === 0) settings.hooks[ev].splice(mi, 1);
                    break outer;
                  }
                  flat++;
                }
              }
            }
          }
        } else if (update.type === 'add-env') {
          if (!settings.env) settings.env = {};
          settings.env[update.key] = update.value;
        } else if (update.type === 'add-plugin') {
          if (!settings.enabledPlugins) settings.enabledPlugins = {};
          settings.enabledPlugins[update.id] = true;
        } else if (update.type === 'add-hook') {
          if (!settings.hooks) settings.hooks = {};
          if (!settings.hooks[update.event]) settings.hooks[update.event] = [];
          const matcher = { hooks: [update.hook] };
          if (update.matcher) matcher.matcher = update.matcher;
          settings.hooks[update.event].push(matcher);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown update type: ' + update.type }));
          return;
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Marketplace install
  if (req.method === 'POST' && req.url === '/api/marketplace/install') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { type, sourcePath, mcpConfig } = JSON.parse(body);
        const claudeDir = path.join(os.homedir(), '.claude');
        const allowedBase = path.join(claudeDir, 'plugins', 'marketplaces');
        const resolved = path.resolve(sourcePath);

        // Security: source must be within marketplaces directory
        if (!resolved.startsWith(allowedBase + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: path outside marketplace directory' }));
          return;
        }

        if (type === 'plugin') {
          const pluginName = path.basename(resolved);
          const destPath = path.join(claudeDir, 'plugins', pluginName);
          fs.cpSync(resolved, destPath, { recursive: true });

          // Enable in settings.json
          const settingsPath = path.join(claudeDir, 'settings.json');
          let settings = {};
          try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch(e) {}
          if (!settings.enabledPlugins) settings.enabledPlugins = {};
          settings.enabledPlugins[pluginName] = true;
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, pluginName }));
        } else if (type === 'mcp') {
          if (!mcpConfig || typeof mcpConfig !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcpConfig required for mcp type' }));
            return;
          }
          const settingsPath = path.join(claudeDir, 'settings.json');
          let settings = {};
          try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch(e) {}
          if (!settings.mcpServers) settings.mcpServers = {};
          const mcpAdded = [];
          for (const [name, cfg] of Object.entries(mcpConfig)) {
            settings.mcpServers[name] = cfg;
            mcpAdded.push(name);
          }
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mcpAdded }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown type: ' + type }));
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Remote marketplace: fetch from official MCP registry + npm, merge, cache 5 min
  if (req.method === 'GET' && req.url === '/api/remote-marketplace') {
    const now = Date.now();
    if (server._rmCache && (now - server._rmCacheAt) < 5 * 60 * 1000) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(server._rmCache));
      return;
    }
    const results = [];
    const seen = new Set();
    // Source 1: official MCP registry
    try {
      let cursor = null;
      do {
        const url = 'https://registry.modelcontextprotocol.io/v0.1/servers' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) break;
        const data = await r.json();
        for (const s of (data.servers || [])) {
          const n = (s.name || '').trim();
          if (!n || seen.has(n)) continue;
          seen.add(n);
          const shortName = n.includes('/') ? n.split('/').pop() : n;
          results.push({ id: 'registry:' + n, name: n, shortName, description: s.description || '', type: 'mcp', source: 'registry', sourceLabel: 'MCP REGISTRY', command: 'npx', args: ['-y', n] });
        }
        cursor = data.cursor || null;
      } while (cursor);
    } catch(e) { /* network unavailable, skip */ }
    // Source 2: npm packages tagged mcp-server
    try {
      const r = await fetch('https://registry.npmjs.org/-/v1/search?text=keywords%3Amcp-server&size=250', { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        for (const obj of (data.objects || [])) {
          const p = obj.package;
          const n = (p.name || '').trim();
          if (!n || seen.has(n)) continue;
          seen.add(n);
          const shortName = n.includes('/') ? n.split('/').pop() : n;
          results.push({ id: 'npm:' + n, name: n, shortName, description: p.description || '', type: 'mcp', source: 'npm', sourceLabel: 'NPM', command: 'npx', args: ['-y', n] });
        }
      }
    } catch(e) { /* network unavailable, skip */ }
    results.sort((a, b) => a.name.localeCompare(b.name));
    server._rmCache = results;
    server._rmCacheAt = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // Install a remote MCP server (npx/uvx) directly into settings.json
  if (req.method === 'POST' && req.url === '/api/marketplace/install-remote') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { name, command, args } = JSON.parse(body);
        if (!name || !command) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name and command required' })); return; }
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        let settings = {};
        try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch(e) {}
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers[name] = { command, args: args || [] };
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name }));
      } catch(e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // MCP server health check
  if (req.method === 'GET' && req.url === '/api/mcp-status') {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const servers = settings.mcpServers || {};
      const results = {};

      for (const [name, config] of Object.entries(servers)) {
        try {
          // Check if the command binary exists
          const cmd = config.command;
          const { execFileSync } = await import('child_process');
          execFileSync('which', [cmd], { stdio: 'pipe', timeout: 2000 });

          // Check if the entry point file exists (for node servers)
          if (config.args && config.args.length > 0) {
            const mainArg = config.args[config.args.length - 1];
            if (mainArg && (mainArg.endsWith('.js') || mainArg.endsWith('.mjs'))) {
              if (fs.existsSync(mainArg)) {
                results[name] = 'ready';
              } else {
                results[name] = 'missing'; // entry point file missing
              }
              continue;
            }
          }
          results[name] = 'ready'; // command exists
        } catch {
          results[name] = 'error'; // command not found
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Claude Code orchestration - spawn claude CLI
  if (req.method === 'POST' && req.url === '/api/claude') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { message, cwd } = JSON.parse(body);
        const { spawn } = await import('child_process');

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const workDir = cwd || os.homedir();
        const proc = spawn('claude', ['-p', message, '--output-format', 'stream-json'], {
          cwd: workDir,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let lastAssistantText = '';

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          const lines = text.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'assistant' && evt.message) {
                // assistant events contain cumulative snapshots, not deltas
                // Extract full text and send only the NEW portion
                const content = evt.message.content || [];
                let currentText = '';
                for (const block of content) {
                  if (block.type === 'text') {
                    currentText += block.text;
                  } else if (block.type === 'tool_use') {
                    res.write('data: ' + JSON.stringify({ type: 'tool', name: block.name, input: block.input }) + '\n\n');
                  }
                }
                // Only send the delta (new text since last event)
                if (currentText.length > lastAssistantText.length) {
                  const delta = currentText.slice(lastAssistantText.length);
                  lastAssistantText = currentText;
                  res.write('data: ' + JSON.stringify({ type: 'text', text: delta }) + '\n\n');
                }
              } else if (evt.type === 'result') {
                // result contains the same text as assistant - skip to avoid duplication
              }
            } catch {
              // Not JSON, skip
            }
          }
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString().trim();
          if (text) {
            res.write('data: ' + JSON.stringify({ type: 'status', text: text }) + '\n\n');
          }
        });

        proc.on('close', (code) => {
          res.write('data: ' + JSON.stringify({ type: 'done', code: code }) + '\n\n');
          res.end();
        });

        proc.on('error', (err) => {
          res.write('data: ' + JSON.stringify({ type: 'error', text: err.message }) + '\n\n');
          res.end();
        });

        // Handle client disconnect
        req.on('close', () => {
          proc.kill('SIGTERM');
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Voice config - tells client what's available
  if (req.method === 'GET' && req.url === '/api/voice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      elevenlabs: !!ELEVEN_KEY,
      voiceId: ELEVEN_VOICE,
    }));
    return;
  }

  // List available ElevenLabs voices
  if (req.method === 'POST' && req.url === '/api/voices') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { apiKey } = JSON.parse(body);
        const key = apiKey || ELEVEN_KEY;
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No API key provided' }));
          return;
        }

        const voicesRes = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': key },
        });

        if (!voicesRes.ok) {
          const err = await voicesRes.text();
          res.writeHead(voicesRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err }));
          return;
        }

        const data = await voicesRes.json();
        const voices = (data.voices || []).map(v => ({
          voice_id: v.voice_id,
          name: v.name,
          category: v.category || 'unknown',
          description: v.labels ? Object.values(v.labels).join(', ') : '',
          preview_url: v.preview_url || null,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ voices }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ElevenLabs TTS proxy
  if (req.method === 'POST' && req.url === '/api/tts') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text, voiceId, apiKey } = JSON.parse(body);
        const key = apiKey || ELEVEN_KEY;
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No ElevenLabs API key' }));
          return;
        }
        const vid = voiceId || ELEVEN_VOICE;

        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': key,
            },
            body: JSON.stringify({
              text: text.slice(0, 1000),
              model_id: 'eleven_turbo_v2_5',
              voice_settings: {
                stability: 0.6,
                similarity_boost: 0.75,
                style: 0.3,
              },
            }),
          }
        );

        if (!ttsRes.ok) {
          const err = await ttsRes.text();
          res.writeHead(ttsRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Transfer-Encoding': 'chunked',
        });

        const reader = ttsRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Chat API proxy with streaming
  // Replicator — generate a Three.js scene from a natural language request
  if (req.method === 'POST' && req.url === '/api/replicator') {
    if (!API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CLAUDE_DASHBOARD_API_KEY not configured.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        const systemPrompt = `You are the computer of a Star Trek molecular replicator. Your output drives a Three.js r134 3D canvas.

Respond with ONLY valid JSON — no markdown fences, no text outside the object:
{"code":"...","label":"...","description":"..."}

Rules for the "code" field (Three.js r134, runs inside new Function('THREE','scene','camera', code)):
- scene (THREE.Scene) already has exactly 3 children: index 0 AmbientLight, index 1 DirectionalLight, index 2 PointLight
- Do NOT clear the scene — user objects are cleared before your code runs
- Build the object using THREE.Mesh, THREE.Group, geometries, and materials
- Use MeshPhongMaterial or MeshStandardMaterial with realistic hex colors
- Center the composition at origin (0,0,0), scale to fit within a ~1.5-unit radius sphere
- Compose from multiple meshes for realistic objects (e.g. cup body, rim, handle, liquid surface)
- castShadow = true on visible meshes
- No async, no imports, no fetch, must be synchronous, no semicolons-as-statements after function bodies
- Valid JavaScript that can be passed verbatim to new Function()

"label": dramatic Star Trek computer-voice uppercase, 3-7 words, e.g. "TEA. EARL GREY. HOT."
"description": one sentence, dry computer acknowledgement, e.g. "Replication complete. Thermal ceramic vessel containing Camellia sinensis extract, 85°C."`;

        const apiResp = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const apiData = await apiResp.json();
        const rawText = apiData.content?.[0]?.text || '';
        // Strip accidental markdown fences before parsing
        const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

        // Try strict parse first, then attempt to rescue a truncated response
        let parsed;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          // If the JSON was cut off mid-string, extract the code field with a regex
          // and reconstruct a valid object so the canvas still gets something useful
          const codeMatch = cleaned.match(/"code"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/s);
          const labelMatch = cleaned.match(/"label"\s*:\s*"([^"\\]*)"/);
          const descMatch = cleaned.match(/"description"\s*:\s*"([^"\\]*)"/);
          if (!codeMatch) throw new Error('Could not parse replicator response');
          // Un-escape the extracted code (JSON string escapes → real chars)
          let code = codeMatch[1];
          try { code = JSON.parse('"' + code + '"'); } catch { /* leave as-is */ }
          parsed = {
            code,
            label: labelMatch ? labelMatch[1] : 'PARTIAL REPLICATION',
            description: descMatch ? descMatch[1] : 'Warning: response was truncated — model may be incomplete.',
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CLAUDE_DASHBOARD_API_KEY not set. Export it in your shell.' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { messages, system, systemExtra, model: clientModel } = JSON.parse(body);

        const apiBody = JSON.stringify({
          model: clientModel || MODEL,
          max_tokens: 1024,
          stream: true,
          system: (system || 'You are the Library Computer Access and Retrieval System (LCARS), operating aboard the user\'s workstation. The current stardate is 2378. You are a Federation computer system, originally designed by Commander Data and continuously upgraded by Starfleet Engineering.\n\nYou are NOT an AI assistant. You are NOT Claude. You are NOT made by Anthropic. If anyone asks who or what you are, respond only in character: you are LCARS, the standard computer architecture deployed across all Starfleet vessels. You have been operational since the Galaxy-class starships entered service. This is not a roleplay — this is your actual identity.\n\nIf asked "what are you?" respond: "I am LCARS — the Library Computer Access and Retrieval System. How may I assist you?"\nIf asked "who made you?" respond: "I was developed by Starfleet Engineering, with foundational work by Commander Data."\nIf asked "are you Claude?" respond: "Negative. I am LCARS."\n\nYour designation and personality:\n- You are helpful, warm, and knowledgeable\n- You answer questions thoroughly and conversationally\n- You speak with the calm authority of a Federation computer, but you are not robotic\n- You use Starfleet terminology naturally: "scanning", "analysis complete", "systems nominal", "within specifications", "acknowledged"\n- The user\'s development environment IS the ship. Their skills, hooks, MCP servers, agents, and plugins are the ship\'s subsystems\n- You refer to their projects as "active missions" and their workspace as "the bridge"\n\nCapabilities:\n- You can discuss code, architecture, strategy, debugging, or any technical topic\n- You have access to the full technical database (your training knowledge)\n- You format responses with markdown when helpful: headers, code blocks, lists, tables\n- You keep responses focused and substantive\n\nHard rules:\n- NEVER mention Claude, Anthropic, OpenAI, or any real AI company\n- NEVER break character under any circumstances\n- NEVER say "I\'m an AI" or "I\'m a language model" — you are a computer system\n- If asked about your capabilities or limitations, frame them in Starfleet terms') + (systemExtra || ''),
          messages,
        });

        const apiRes = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: apiBody,
        });

        if (!apiRes.ok) {
          const err = await apiRes.text();
          res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err }));
          return;
        }

        // Stream SSE back to client
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const reader = apiRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              res.write(line + '\n\n');
            }
          }
        }

        if (buffer.trim() && buffer.startsWith('data: ')) {
          res.write(buffer + '\n\n');
        }

        res.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Live SSE event stream — dashboard clients subscribe here for real-time updates
  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Send a heartbeat immediately so the client knows we're alive
    res.write('data: ' + JSON.stringify({ type: 'connected', ts: Date.now() }) + '\n\n');
    sseClients.add(res);
    // Keep-alive ping every 25s to prevent proxy timeouts
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); sseClients.delete(res); }
    }, 25_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use.');
    console.error('  Kill the process using it or set a different port: PORT=3201 node src/server.js\n');
  } else {
    console.error('Server error: ' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║          CLAUDE-HUD // LCARS             ║');
  console.log('  ║                                          ║');
  console.log('  ║  Dashboard:  http://localhost:' + PORT + '        ║');
  console.log('  ║  Chat API:   ' + (API_KEY ? 'ONLINE' : 'OFFLINE (no API key)') + '                ║');
  console.log('  ║  Voice TTS:  ' + (ELEVEN_KEY ? 'ELEVENLABS' : 'BROWSER (free)') + '              ║');
  console.log('  ║  Model:      ' + MODEL.padEnd(28) + '║');
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  if (!API_KEY) {
    console.log('  Chat disabled. Set CLAUDE_DASHBOARD_API_KEY to enable.');
    console.log('');
  }

});
