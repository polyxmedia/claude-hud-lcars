# claude-hud-lcars

<p align="center">
  <img src="assets/starfleet.svg" alt="Starfleet" width="120">
</p>

<p align="center">
  <strong>LCARS Operations Dashboard for Claude Code</strong><br>
  <em>United Federation of Developers</em>
</p>

---

Your entire Claude Code setup, rendered as a Star Trek LCARS terminal. Skills, agents, hooks, MCP servers, plugins, memory files, environment variables, all of it visible, searchable, and actionable from one interface. Click anything to read the full content like you're pulling up a file on a PADD.

There's also a built-in AI chat that responds as the Federation LCARS computer. With voice output. And sound effects. Because if you're going to build an operations dashboard for an AI coding tool, you might as well commit to the bit.

```bash
npx claude-hud-lcars
```

That's the whole setup. Zero dependencies. Scans `~/.claude/`, generates a self-contained HTML dashboard, opens it in your browser. Done.

## What you're looking at

The dashboard reads everything Claude Code knows about your setup and presents it in an LCARS interface with the authentic TNG color palette, the signature rounded elbows connecting sections, colored navigation bars, and the Antonio typeface standing in for Swiss 911.

Ten sections, each one clickable:

- **Skills** with version, execution context (fork/inline), and the full SKILL.md rendered with syntax highlighting when you click through
- **MCP Servers** showing every configured server, its command, args, and the complete JSON config on drill-down (env vars auto-redacted, your secrets stay secret)
- **Hooks** with event type, matcher pattern, hook type, and the full hook definition viewable in the detail panel
- **Plugins** and their active/inactive status, clickable for config details
- **Agents** with their descriptions and full prompt definitions
- **Environment** variables you've set in settings.json, clickable to copy values
- **Memory** files across all your projects, each one readable in full
- **Tactical** an interactive canvas visualisation showing your entire setup as a Star Trek tactical display with force-directed graph, rotating scanner line, and clickable nodes
- **Comms** scrollable log of all chat messages
- **Config** model selector, voice engine, ElevenLabs setup, sound effects toggle

Every row is clickable. The detail panel slides open on the right, renders the markdown properly with headers, tables, code blocks, lists, the works. JSON configs get syntax highlighted automatically with color-coded keys, strings, numbers, and booleans. It genuinely looks like you're reading a classified Starfleet briefing.

## The COMPUTER bar

There's a persistent input bar at the bottom of every screen labeled COMPUTER. Type anything, hit Enter. It talks to the Claude API and streams responses in real-time through a response overlay that slides up from the bottom. The conversation also logs to the COMMS section in the sidebar so you can scroll back through it.

The system prompt makes Claude respond as LCARS, the Library Computer Access and Retrieval System. Calm, measured, structured responses using Starfleet terminology. It refers to your development environment as the ship's systems, your skills as installed modules, your MCP servers as the fleet. It's genuinely fun to use.

This requires the live server mode and an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx claude-hud-lcars --serve
```

That starts a local server at `http://localhost:3200`. The dashboard regenerates on every page load so it's always fresh, the chat proxies through to the Anthropic Messages API with streaming, and file operations work for opening and editing your Claude Code configs directly from the browser.

Without an API key, the dashboard still works perfectly for browsing your setup. The COMPUTER bar just shows an offline message.

## Actions

The detail panel includes action buttons that actually do things:

| Button | What happens |
|--------|-------------|
| **INVOKE** | Copies `/skill-name` to your clipboard, paste it straight into Claude Code |
| **OPEN FILE** | Opens the file in your default editor (live mode), or copies the path |
| **COPY PATH** | Copies the full file path |
| **COPY CONFIG** | Copies the complete JSON configuration |
| **EDIT SETTINGS** | Opens settings.json in your editor |
| **DELETE** | Copies the delete command with a confirmation dialog first |

In static mode these copy to clipboard. In live server mode, OPEN FILE actually opens the file.

## Voice and sound

Two toggle buttons in the COMPUTER bar:

**VOICE** activates voice output. Two engines available:

- **Browser (free)** uses Web Speech API. On macOS it picks Samantha by default with pitch and rate tuned for a computer-like delivery.
- **ElevenLabs (premium)** uses the ElevenLabs API for realistic AI voices. Configure your API key in the CONFIG panel and browse all your available voices with live audio previews before selecting one. No credits spent on previews.

**SFX** enables LCARS sound effects on every interaction. Navigation clicks, detail panel opens, sending messages, receiving responses, all get synthesized beeps via the Web Audio API. No sound files, no external assets, just sine wave oscillators tuned to the right frequencies.

**LOG** shows/hides the last computer response. Responses persist after the stream ends. You can minimise the response panel to a slim bar, expand it again, or dismiss it entirely.

All toggleable at any time. SFX is on by default, voice is off.

## Configuration

| Variable | Default | What it does |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (none) | Required for COMPUTER bar chat. Get one from [console.anthropic.com](https://console.anthropic.com/) |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Which model the COMPUTER bar talks to (also configurable in the CONFIG panel) |
| `PORT` | `3200` | Server port for live mode |

## How it actually works

The whole thing is a Node.js script that walks your `~/.claude/` directory tree:

```
~/.claude/skills/*/SKILL.md        → skill definitions with frontmatter
~/.claude/agents/*.md              → agent definitions
~/.claude/settings.json            → hooks, MCP servers, plugins, env vars
~/.claude/projects/*/memory/*.md   → memory files across all projects
```

It reads every file, parses the YAML frontmatter, extracts the markdown body, and generates a single self-contained HTML file with all the data embedded as a JSON blob. The LCARS interface, the CSS, the JavaScript, the syntax highlighter, the markdown renderer, the chat client, the voice synthesis, the sound effects, all inline in one HTML file. No build step, no bundler, no framework.

In live mode, the server adds API endpoints:
- `POST /api/chat` proxies to the Anthropic Messages API with SSE streaming
- `POST /api/open` opens files in your default editor
- `POST /api/save` saves edited files back to disk
- `POST /api/voices` lists available ElevenLabs voices
- `POST /api/tts` proxies text-to-speech to ElevenLabs

All file operations are sandboxed to `~/.claude/` only. The server validates every path and rejects anything outside that directory.

## Security

- MCP server environment variables (API keys, database URLs, tokens) are automatically replaced with `{redacted}` in the dashboard
- File open and save operations are restricted to `~/.claude/` with path traversal prevention
- The API key is only used server-side, never embedded in the HTML
- The static dashboard makes zero external requests (aside from Google Fonts for the LCARS typeface)

## Requirements

- Node.js 18 or later
- Claude Code installed (`~/.claude/` directory exists)
- An Anthropic API key if you want the chat to work (dashboard works without it)
- macOS or Linux

## Install globally

```bash
npm install -g claude-hud-lcars
```

Then run `claude-hud-lcars` for static mode or `claude-hud-lcars --serve` for live mode, from anywhere.

## What if I have nothing installed

It still works. Empty sections render cleanly with placeholder messages. It's actually a decent way to see what Claude Code can do, you look at the empty sections and think "I should probably set up some hooks" or "I didn't know I could have custom agents."

## The aesthetic

The LCARS design uses the authentic TNG color palette: `#FF9900` orange, `#FFCC99` peach, `#9999FF` periwinkle, `#CC99CC` lavender, `#CC9966` tan, `#FF9966` salmon, `#66CCCC` cyan. Pure black background. The signature rounded elbows connect the sidebar to the top and bottom bars. Navigation buttons have the characteristic pill shape with rounded right edges. Section headers use the Antonio typeface which is the closest web font to the actual Swiss 911 Ultra Compressed used in the show.

The detail panel, the response overlay, and the code blocks all render on the black void with the blue left-border accent. Tables get orange header styling. Inline code gets the orange highlight. It's consistent, it's readable, and it looks like something that belongs on the bridge of the Enterprise-D.

## License

MIT

## Credits

Built by [Andre Figueira](https://www.linkedin.com/in/andrefigueira/) ([@voidmode](https://x.com/voidmode)) at [polyxmedia.com](https://polyxmedia.com) with Claude Code.

LCARS design inspired by Star Trek: The Next Generation. LCARS is a trademark of CBS Studios. This project is not affiliated with or endorsed by CBS Studios or Paramount.
