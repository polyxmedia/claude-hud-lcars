// src/lib/claudeMdParser.js
// Pure functions for parsing and serializing CLAUDE.md into sections.
// No side effects, fully testable in isolation.

/**
 * Parse a CLAUDE.md string into an array of sections.
 * Each section has { heading, level, body }.
 * Content before the first heading becomes a preamble section with heading=null, level=null.
 *
 * Handles:
 * - Fenced code blocks (# inside ``` is not treated as a heading)
 * - Mid-line # (not at line start) is not treated as a heading
 * - CRLF normalization
 * - Trailing whitespace trimming per section body
 *
 * @param {string} content
 * @returns {Array<{heading:string|null, level:number|null, body:string}>}
 */
export function parseClaudeMdSections(content) {
  // Normalize CRLF → LF
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const sections = [];
  let currentHeading = null;
  let currentLevel = null;
  let currentLines = [];
  let inFence = false;

  for (const line of lines) {
    // Track fenced code blocks
    if (/^```/.test(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }

    // Check for a heading line (only when not inside a fence, must be at line start)
    const headingMatch = !inFence && /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      // Save the current section
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        body: currentLines.join('\n').trim(),
      });
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Push final section
  sections.push({
    heading: currentHeading,
    level: currentLevel,
    body: currentLines.join('\n').trim(),
  });

  // If no sections were produced at all, ensure we return at least one
  if (sections.length === 0) {
    return [{ heading: null, level: null, body: '' }];
  }

  return sections;
}

/**
 * Serialize an array of sections back to a CLAUDE.md string.
 * Preamble sections (heading=null) emit only the body.
 * Heading sections emit "#{level} heading\n\nbody".
 * Sections are separated by double newlines.
 *
 * @param {Array<{heading:string|null, level:number|null, body:string}>} sections
 * @returns {string}
 */
export function serializeClaudeMdSections(sections) {
  if (!sections || sections.length === 0) return '';

  return sections
    .map(s => {
      if (s.heading === null) {
        return s.body;
      }
      const hashes = '#'.repeat(s.level || 1);
      const header = `${hashes} ${s.heading}`;
      return s.body ? `${header}\n\n${s.body}` : header;
    })
    .join('\n\n');
}
