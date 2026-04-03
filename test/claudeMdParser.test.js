// BDD: CLAUDE.md Structured Editor
// Given a CLAUDE.md file, the editor should parse it into sections,
// let the user edit each section, and serialize back without data loss.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeMdSections, serializeClaudeMdSections } from '../src/lib/claudeMdParser.js';

// ─── parseClaudeMdSections ─────────────────────────────────────────────────
describe('parseClaudeMdSections', () => {
  it('given an empty string, it returns one section with null heading and empty body', () => {
    const sections = parseClaudeMdSections('');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, null);
    assert.equal(sections[0].body, '');
  });

  it('given content with no headings, it returns a single preamble section', () => {
    const sections = parseClaudeMdSections('Just some text here.\nAnother line.');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, null);
    assert.ok(sections[0].body.includes('Just some text here.'));
  });

  it('given a single h1 heading, it returns preamble (if any) plus the section', () => {
    const sections = parseClaudeMdSections('# Rules\n\nAlways be concise.');
    const rules = sections.find(s => s.heading === 'Rules');
    assert.ok(rules, 'expected a Rules section');
    assert.ok(rules.body.includes('Always be concise.'));
  });

  it('given multiple h1 headings, it returns one section per heading', () => {
    const content = '# Persona\n\nYou are an engineer.\n\n# Rules\n\nBe concise.\n\n# Tone\n\nFriendly.';
    const sections = parseClaudeMdSections(content);
    const headings = sections.map(s => s.heading).filter(Boolean);
    assert.deepEqual(headings, ['Persona', 'Rules', 'Tone']);
  });

  it('given content before the first heading, it becomes a preamble section with null heading', () => {
    const content = 'Preamble line.\n\n# Rules\n\nBe good.';
    const sections = parseClaudeMdSections(content);
    const preamble = sections.find(s => s.heading === null);
    assert.ok(preamble, 'expected a preamble section');
    assert.ok(preamble.body.includes('Preamble line.'));
  });

  it('gives h1 headings a level of 1', () => {
    const sections = parseClaudeMdSections('# Persona\n\nYou are.');
    const s = sections.find(s => s.heading === 'Persona');
    assert.equal(s.level, 1);
  });

  it('gives h2 headings a level of 2', () => {
    const sections = parseClaudeMdSections('## Sub-section\n\nContent.');
    const s = sections.find(s => s.heading === 'Sub-section');
    assert.equal(s.level, 2);
  });

  it('gives h3 headings a level of 3', () => {
    const sections = parseClaudeMdSections('### Deep\n\nContent.');
    const s = sections.find(s => s.heading === 'Deep');
    assert.equal(s.level, 3);
  });

  it('trims trailing whitespace from section bodies', () => {
    const sections = parseClaudeMdSections('# Rules\n\nBe good.   \n   ');
    const s = sections.find(s => s.heading === 'Rules');
    assert.ok(!s.body.endsWith('   '), 'trailing whitespace should be trimmed');
  });

  it('given a heading with no following content, the body is an empty string', () => {
    const sections = parseClaudeMdSections('# Empty\n');
    const s = sections.find(s => s.heading === 'Empty');
    assert.ok(s, 'expected Empty section');
    assert.equal(s.body, '');
  });

  it('does not split on # inside a fenced code block', () => {
    const content = '# Rules\n\n```bash\n# this is a comment\necho hello\n```\n\nEnd.';
    const sections = parseClaudeMdSections(content);
    const rules = sections.find(s => s.heading === 'Rules');
    assert.ok(rules.body.includes('# this is a comment'), 'code block content should be in body');
    assert.equal(sections.filter(s => s.heading !== null).length, 1, 'should not split on # in code');
  });

  it('does not split on # that appears mid-line (not at line start)', () => {
    const content = '# Rules\n\nUse #hashtags freely.';
    const sections = parseClaudeMdSections(content);
    assert.equal(sections.filter(s => s.heading !== null).length, 1);
    const rules = sections.find(s => s.heading === 'Rules');
    assert.ok(rules.body.includes('#hashtags'), 'mid-line # should stay in body');
  });

  it('normalises Windows CRLF line endings without corruption', () => {
    const content = '# Rules\r\n\r\nBe good.\r\n';
    const sections = parseClaudeMdSections(content);
    const rules = sections.find(s => s.heading === 'Rules');
    assert.ok(rules, 'expected Rules section');
    assert.ok(!rules.body.includes('\r'), 'CRLF should be normalised to LF');
  });
});

// ─── serializeClaudeMdSections ─────────────────────────────────────────────
describe('serializeClaudeMdSections', () => {
  it('given an empty array, it returns an empty string', () => {
    assert.equal(serializeClaudeMdSections([]), '');
  });

  it('given a preamble-only section (heading=null), it emits just the body without a header line', () => {
    const sections = [{ heading: null, level: null, body: 'Intro text.' }];
    const out = serializeClaudeMdSections(sections);
    assert.ok(out.includes('Intro text.'));
    assert.ok(!out.startsWith('#'), 'preamble should not start with #');
  });

  it('given a single h1 section, it emits "# Heading" followed by the body', () => {
    const sections = [{ heading: 'Rules', level: 1, body: 'Be good.' }];
    const out = serializeClaudeMdSections(sections);
    assert.ok(out.includes('# Rules'), `got: ${out}`);
    assert.ok(out.includes('Be good.'));
  });

  it('given a level-2 section, it uses ## prefix', () => {
    const sections = [{ heading: 'Sub', level: 2, body: 'Content.' }];
    const out = serializeClaudeMdSections(sections);
    assert.ok(out.includes('## Sub'), `got: ${out}`);
  });

  it('given multiple sections, they are separated by double newlines', () => {
    const sections = [
      { heading: 'A', level: 1, body: 'Body A.' },
      { heading: 'B', level: 1, body: 'Body B.' },
    ];
    const out = serializeClaudeMdSections(sections);
    assert.ok(out.includes('\n\n'), 'sections should be double-newline separated');
  });

  it('given a section with an empty body, it serializes without crashing', () => {
    const sections = [{ heading: 'Empty', level: 1, body: '' }];
    assert.doesNotThrow(() => serializeClaudeMdSections(sections));
  });

  it('round-trips: parse then serialize preserves all section content', () => {
    const original = '# Persona\n\nYou are an engineer.\n\n# Rules\n\nBe concise.\nNever lie.\n\n# Tone\n\nFriendly but direct.';
    const sections = parseClaudeMdSections(original);
    const serialized = serializeClaudeMdSections(sections);
    // All headings must survive
    assert.ok(serialized.includes('# Persona'));
    assert.ok(serialized.includes('# Rules'));
    assert.ok(serialized.includes('# Tone'));
    // All body content must survive
    assert.ok(serialized.includes('You are an engineer.'));
    assert.ok(serialized.includes('Be concise.'));
    assert.ok(serialized.includes('Friendly but direct.'));
  });

  it('round-trips: a file with preamble + sections preserves the preamble', () => {
    const original = 'Global note.\n\n# Rules\n\nBe good.';
    const sections = parseClaudeMdSections(original);
    const serialized = serializeClaudeMdSections(sections);
    assert.ok(serialized.includes('Global note.'));
    assert.ok(serialized.includes('# Rules'));
    assert.ok(serialized.includes('Be good.'));
  });
});
