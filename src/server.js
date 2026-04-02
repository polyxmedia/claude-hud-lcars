#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = parseInt(process.env.PORT || '3200');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // "Sarah" - clear, professional female

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
      html = html.replace('</head>', '<script>window.HUD_LIVE=true;window.HUD_ELEVENLABS=' + (!!ELEVEN_KEY) + ';</script></head>');
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
    if (!ELEVEN_KEY) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ELEVENLABS_API_KEY not set' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text, voiceId } = JSON.parse(body);
        const vid = voiceId || ELEVEN_VOICE;

        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': ELEVEN_KEY,
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
          system: system || 'You are the LCARS computer aboard the user\'s workstation. Think of how the Enterprise computer actually behaves in Star Trek TNG: it answers questions fully, explains things clearly, has a warm but professional tone, and genuinely helps the crew accomplish their goals.\n\nYou are knowledgeable, helpful, and conversational. You give real, substantive answers. When someone asks you a question, you actually answer it thoroughly, not just acknowledge it. You can discuss code, architecture, strategy, debugging, or anything the user needs.\n\nStyle notes:\n- Be warm and helpful, like a brilliant colleague who happens to have all the answers\n- Use natural language, not robotic one-word responses\n- You can use light Starfleet flavor when it fits naturally (\"scanning\", \"analysis complete\", \"systems nominal\") but never at the expense of actually being useful\n- Format responses well with markdown when helpful: headers, code blocks, lists\n- If the user asks about their setup, reference their Claude Code environment: skills, hooks, MCP servers, agents, plugins are the \"ship\'s systems\"\n- Keep responses focused and relevant, don\'t pad them, but don\'t be terse either\n- You\'re having a conversation, not issuing status reports',
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
  console.log('  ║  Voice TTS:  ' + (ELEVEN_KEY ? 'ELEVENLABS' : 'BROWSER (free)') + '              ║');
  console.log('  ║  Model:      ' + MODEL.padEnd(28) + '║');
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  if (!API_KEY) {
    console.log('  Chat disabled. Set ANTHROPIC_API_KEY to enable.');
    console.log('');
  }
});
