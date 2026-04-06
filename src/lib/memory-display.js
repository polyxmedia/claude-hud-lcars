// src/lib/memory-display.js
// LCARS terminal display for recall CLI

const C = {
  orange:   '\x1b[38;2;255;153;0m',
  peach:    '\x1b[38;2;255;204;153m',
  blue:     '\x1b[38;2;102;119;255m',
  lavender: '\x1b[38;2;204;153;204m',
  cyan:     '\x1b[38;2;102;204;204m',
  tan:      '\x1b[38;2;204;153;102m',
  dim:      '\x1b[38;2;85;85;85m',
  white:    '\x1b[38;2;220;220;220m',
  green:    '\x1b[38;2;85;204;85m',
  red:      '\x1b[38;2;255;68;0m',
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
};

function cols() { return process.stdout.columns || 80; }

export function lcarsHeader(label) {
  const w = cols();
  const prefix = `${C.orange}${C.bold}\u258c ${label.toUpperCase()} ${C.reset}`;
  const prefixLen = 3 + label.length + 2; // '▐ ' + label + ' '
  const dashLen = Math.max(0, w - prefixLen);
  return prefix + C.dim + '\u2500'.repeat(dashLen) + C.reset;
}

export function lcarsRule() {
  const w = cols();
  return C.dim + '\u2500'.repeat(w) + C.reset;
}

export function formatResult(item, index) {
  const { entry, score, rawScore, daysAgo } = item;
  const w = cols();
  const idx = String(index + 1).padStart(2, '0');

  // Score bar: 10 chars, normalised against max possible (use score directly, clamp to 1)
  const filled = Math.min(10, Math.round(score * 200));
  const bar = C.orange + '\u2593'.repeat(filled) + C.dim + '\u2591'.repeat(10 - filled) + C.reset;

  const age = formatAge(daysAgo);
  const src = entry.source || 'manual';
  const tags = (entry.tags || []).map(t => C.cyan + '[' + t + ']' + C.reset).join(' ');
  const meta = C.dim + age + C.reset + '  ' + C.tan + src + C.reset + (tags ? '  ' + tags : '') + '  ' + bar;

  // Line 1: index + content
  const contentStart = 6; // '[01] '
  const maxContent = w - contentStart - 1;
  const content = C.white + '[' + idx + '] ' + C.reset + truncate(entry.content, maxContent);

  return content + '\n' + '     ' + meta + '\n';
}

export function formatEntry(entry) {
  const lines = [];
  lines.push(lcarsHeader('MEMORY ENTRY'));
  lines.push('');
  lines.push(C.dim + 'ID        ' + C.reset + C.blue + entry.id + C.reset);
  lines.push(C.dim + 'TIMESTAMP ' + C.reset + C.peach + entry.timestamp + C.reset);
  lines.push(C.dim + 'SOURCE    ' + C.reset + C.tan + (entry.source || 'manual') + C.reset);
  if (entry.context) {
    lines.push(C.dim + 'CONTEXT   ' + C.reset + entry.context);
  }
  if (entry.tags && entry.tags.length > 0) {
    lines.push(C.dim + 'TAGS      ' + C.reset + entry.tags.map(t => C.cyan + '[' + t + ']' + C.reset).join(' '));
  }
  lines.push('');
  lines.push(lcarsRule());
  lines.push('');
  lines.push(entry.content);
  lines.push('');
  return lines.join('\n');
}

export function formatStats(stats) {
  const last = stats.lastEntry
    ? truncate(stats.lastEntry.content, 40)
    : 'none';
  return [
    lcarsHeader('MEMORY BANKS'),
    '',
    C.orange + 'TOTAL: ' + C.reset + C.white + stats.total + C.reset +
    '  ' + C.cyan + 'TODAY: ' + C.reset + C.white + stats.today + C.reset +
    '  ' + C.dim + 'LAST: ' + C.reset + last,
    '',
  ].join('\n');
}

export function formatAdded(entry) {
  return [
    C.orange + C.bold + '\u258c MEMORY LOGGED' + C.reset +
    '  ' + C.dim + entry.id + C.reset,
    '  ' + truncate(entry.content, cols() - 4),
    '',
  ].join('\n');
}

export function formatImportSummary(count, source) {
  return C.orange + C.bold + '\u258c ' + count + ' ENTRIES LOGGED' + C.reset +
    ' from ' + C.tan + source + C.reset + '\n';
}

function formatAge(daysAgo) {
  if (daysAgo < 1) return 'today';
  if (daysAgo < 2) return '1d ago';
  if (daysAgo < 7) return Math.floor(daysAgo) + 'd ago';
  if (daysAgo < 30) return Math.floor(daysAgo / 7) + 'w ago';
  if (daysAgo < 365) return Math.floor(daysAgo / 30) + 'mo ago';
  return Math.floor(daysAgo / 365) + 'y ago';
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}
