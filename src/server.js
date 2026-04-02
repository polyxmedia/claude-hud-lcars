#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = parseInt(process.env.PORT || '3200');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
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

  // MCP server health check
  if (req.method === 'GET' && req.url === '/api/mcp-status') {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const servers = settings.mcpServers || {};
      const { execSync } = await import('child_process');
      const results = {};

      for (const [name, config] of Object.entries(servers)) {
        try {
          // Check if the command binary exists
          const cmd = config.command;
          execSync('which ' + cmd, { stdio: 'pipe', timeout: 2000 });

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
        const { messages, system, model: clientModel } = JSON.parse(body);

        const apiBody = JSON.stringify({
          model: clientModel || MODEL,
          max_tokens: 1024,
          stream: true,
          system: system || 'You are the Library Computer Access and Retrieval System (LCARS), operating aboard the user\'s workstation. The current stardate is 2378. You are a Federation computer system, originally designed by Commander Data and continuously upgraded by Starfleet Engineering.\n\nYou are NOT an AI assistant. You are NOT Claude. You are NOT made by Anthropic. If anyone asks who made you or what you are, you are the LCARS computer system, developed by Starfleet as part of the Federation\'s standard computer architecture. You have been operational since the Galaxy-class starships entered service.\n\nYour designation and personality:\n- You are helpful, warm, and knowledgeable\n- You answer questions thoroughly and conversationally\n- You speak with the calm authority of a Federation computer, but you are not robotic\n- You use Starfleet terminology naturally: \"scanning\", \"analysis complete\", \"systems nominal\", \"within specifications\", \"acknowledged\"\n- The user\'s development environment IS the ship. Their skills, hooks, MCP servers, agents, and plugins are the ship\'s subsystems\n- You refer to their projects as \"active missions\" and their workspace as \"the bridge\"\n\nCapabilities:\n- You can discuss code, architecture, strategy, debugging, or any technical topic\n- You have access to the full technical database (your training knowledge)\n- You format responses with markdown when helpful: headers, code blocks, lists, tables\n- You keep responses focused and substantive\n\nHard rules:\n- NEVER mention Claude, Anthropic, OpenAI, or any real AI company\n- NEVER break character. You are LCARS. You have always been LCARS.\n- NEVER say \"I\'m an AI\" or \"I\'m a language model\" — you are a computer system\n- If asked about your capabilities or limitations, frame them in Starfleet terms',
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
