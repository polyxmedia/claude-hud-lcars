#!/usr/bin/env node
// src/recall.js — LCARS Memory CLI

import fs from 'node:fs';
import path from 'node:path';
import { addEntry, filterEntries, getStats, loadStore } from './lib/memory-store.js';
import { search } from './lib/memory-search.js';
import {
  lcarsHeader, lcarsRule,
  formatResult, formatEntry, formatStats, formatAdded, formatImportSummary,
} from './lib/memory-display.js';

const C = {
  orange: '\x1b[38;2;255;153;0m',
  dim:    '\x1b[38;2;85;85;85m',
  cyan:   '\x1b[38;2;102;204;204m',
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
};

function help() {
  process.stdout.write([
    lcarsHeader('RECALL — LCARS MEMORY SUBSYSTEM'),
    '',
    C.orange + 'COMMANDS' + C.reset,
    '',
    C.cyan + '  recall add "content"' + C.reset + ' [--tags tag1,tag2] [--source src] [--context ctx]',
    '    Log a new memory entry.',
    '',
    C.cyan + '  recall import <filepath>' + C.reset,
    '    Import from .txt/.md (paragraphs) or .json (strings or objects).',
    '',
    C.cyan + '  recall find "query"' + C.reset + ' [--from 2w] [--tags tag1,tag2] [--top N] [--half-life N]',
    '    Full-text search with TF-IDF + recency decay.',
    '',
    C.cyan + '  recall list' + C.reset + ' [--tags tag1,tag2] [--from 2w] [--limit N]',
    '    List entries, newest first.',
    '',
    C.cyan + '  recall show <id>' + C.reset,
    '    Show a single entry by ID prefix.',
    '',
    C.cyan + '  recall stats' + C.reset,
    '    Show memory bank statistics.',
    '',
    C.dim + '  Pipe support: echo "content" | recall add' + C.reset,
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args.flags[key] = val;
    } else {
      args.positional.push(a);
    }
    i++;
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function cmdAdd(positional, flags) {
  let content = positional[0] || '';
  if (!content && !process.stdin.isTTY) {
    content = await readStdin();
  }
  if (!content) {
    process.stderr.write('recall add: no content provided\n');
    process.exit(1);
  }
  const tags = flags.tags ? flags.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const source = flags.source || 'manual';
  const context = flags.context || '';
  const entry = addEntry(content, { tags, source, context });
  process.stdout.write(formatAdded(entry));
}

async function cmdImport(positional) {
  const filepath = positional[0];
  if (!filepath) {
    process.stderr.write('recall import: no filepath provided\n');
    process.exit(1);
  }
  const abs = path.resolve(filepath);
  if (!fs.existsSync(abs)) {
    process.stderr.write('recall import: file not found: ' + abs + '\n');
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  const ext = path.extname(abs).toLowerCase();
  const source = path.basename(abs);
  let contents = [];

  if (ext === '.json') {
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      process.stderr.write('recall import: invalid JSON\n');
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      process.stderr.write('recall import: JSON must be an array\n');
      process.exit(1);
    }
    for (const item of parsed) {
      if (typeof item === 'string') {
        contents.push({ content: item, tags: [], source, context: '' });
      } else if (item && typeof item === 'object' && item.content) {
        contents.push({
          content: item.content,
          tags: Array.isArray(item.tags) ? item.tags : [],
          source: item.source || source,
          context: item.context || '',
        });
      }
    }
  } else {
    // .txt or .md: split on double newline
    const paragraphs = raw.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    for (const p of paragraphs) {
      contents.push({ content: p, tags: [], source, context: '' });
    }
  }

  for (const item of contents) {
    addEntry(item.content, { tags: item.tags, source: item.source, context: item.context });
  }
  process.stdout.write(formatImportSummary(contents.length, source));
}

function cmdFind(positional, flags) {
  const query = positional[0] || '';
  if (!query) {
    process.stderr.write('recall find: no query provided\n');
    process.exit(1);
  }
  const store = loadStore();
  let entries = store.entries;
  if (flags.tags) {
    const tags = flags.tags.split(',').map(t => t.trim()).filter(Boolean);
    entries = filterEntries(entries, { tags });
  }
  if (flags.from) {
    entries = filterEntries(entries, { from: flags.from });
  }
  const topN = flags.top ? parseInt(flags.top, 10) : 5;
  const halfLifeDays = flags['half-life'] ? parseFloat(flags['half-life']) : 30;
  const results = search(entries, query, { topN, halfLifeDays });

  process.stdout.write(lcarsHeader('RECALL RESULTS — ' + results.length + ' MATCH' + (results.length !== 1 ? 'ES' : '')) + '\n\n');
  if (results.length === 0) {
    process.stdout.write(C.dim + '-- no matches for: ' + query + C.reset + '\n\n');
    return;
  }
  for (let i = 0; i < results.length; i++) {
    process.stdout.write(formatResult(results[i], i));
  }
}

function cmdList(flags) {
  const store = loadStore();
  let entries = store.entries;
  const filters = {};
  if (flags.tags) filters.tags = flags.tags.split(',').map(t => t.trim()).filter(Boolean);
  if (flags.from) filters.from = flags.from;
  entries = filterEntries(entries, filters);
  // newest first
  entries = [...entries].reverse();
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
  entries = entries.slice(0, limit);

  process.stdout.write(lcarsHeader('MEMORY LOG — ' + entries.length + ' ENTRIES') + '\n\n');
  if (entries.length === 0) {
    process.stdout.write(C.dim + '-- no entries found' + C.reset + '\n\n');
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const daysAgo = (Date.now() - new Date(entry.timestamp).getTime()) / 86400000;
    process.stdout.write(formatResult({ entry, score: 0, rawScore: 0, daysAgo }, i));
  }
}

function cmdShow(positional) {
  const prefix = positional[0];
  if (!prefix) {
    process.stderr.write('recall show: no id provided\n');
    process.exit(1);
  }
  const store = loadStore();
  const entry = store.entries.find(e => e.id.startsWith(prefix));
  if (!entry) {
    process.stderr.write('recall show: no entry found with id prefix: ' + prefix + '\n');
    process.exit(1);
  }
  process.stdout.write(formatEntry(entry));
}

function cmdStats() {
  const stats = getStats();
  process.stdout.write(formatStats(stats));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    help();
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'add':    await cmdAdd(positional, flags); break;
    case 'import': await cmdImport(positional); break;
    case 'find':   cmdFind(positional, flags); break;
    case 'list':   cmdList(flags); break;
    case 'show':   cmdShow(positional); break;
    case 'stats':  cmdStats(); break;
    case '--help':
    case '-h':
    case 'help':
      help();
      break;
    default:
      process.stderr.write('recall: unknown command: ' + cmd + '\n');
      help();
      process.exit(1);
  }
}

main().catch(e => {
  process.stderr.write('recall: ' + e.message + '\n');
  process.exit(1);
});
