#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = parseInt(process.env.PORT || '3200');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// Import the dashboard generator
const dashboardPath = path.join(import.meta.dirname, '..', 'dashboard.html');

// Generate dashboard on startup
async function generateDashboard() {
  const { execSync } = await import('child_process');
  execSync('node ' + path.join(import.meta.dirname, 'generate.js'), { stdio: 'pipe' });
}

const server = http.createServer(async (req, res) => {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      // Regenerate each time for freshness
      await generateDashboard();
      let html = fs.readFileSync(dashboardPath, 'utf-8');
      // Inject chat capability flag and voice mode
      html = html.replace('</head>', '<script>window.HUD_LIVE=true;</script></head>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard generation failed: ' + e.message);
    }
    return;
  }

  // Open file in default editor
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
        const { execSync } = await import('child_process');
        // Use 'open' on macOS, 'xdg-open' on Linux
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(cmd + ' ' + JSON.stringify(resolved));
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
        const { path: filePath, content } = JSON.parse(body);
        const claudeDir = path.join(os.homedir(), '.claude');
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(claudeDir)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Can only save files under ~/.claude/' }));
          return;
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

  // Chat API proxy with streaming
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set. Export it in your shell.' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { messages, system } = JSON.parse(body);

        const apiBody = JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          stream: true,
          system: system || 'You are the LCARS computer interface aboard a starship. You respond concisely, factually, and with the calm authority of a Federation computer system. When addressed, you may prefix responses with a subtle acknowledgment. You have full knowledge of the user\'s Claude Code setup as displayed in the HUD.',
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

        if (buffer.trim()) {
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

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║          CLAUDE-HUD // LCARS             ║');
  console.log('  ║                                          ║');
  console.log('  ║  Dashboard:  http://localhost:' + PORT + '        ║');
  console.log('  ║  Chat API:   ' + (API_KEY ? 'ONLINE' : 'OFFLINE (no API key)') + '                ║');
  console.log('  ║  Model:      ' + MODEL.padEnd(28) + '║');
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  if (!API_KEY) {
    console.log('  Chat disabled. Set ANTHROPIC_API_KEY to enable.');
    console.log('');
  }
});
