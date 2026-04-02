# claude-hud-lcars

LCARS-inspired operations dashboard for [Claude Code](https://claude.ai/code). See everything you've built at a glance, drill into any skill, hook, agent, or MCP server, and read the full content like pulling up a file on a PADD.

> Zero config. Zero dependencies. Just run it.

## Quick Start

### Static mode (dashboard only)

```bash
npx claude-hud-lcars
```

Scans your `~/.claude/` directory, generates a dashboard, and opens it in your browser. No server needed.

### Live mode (dashboard + chat + file editing)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx claude-hud-lcars --serve
```

Starts a local server at `http://localhost:3200` with:
- Live dashboard that regenerates on each load
- **COMMS channel** for chatting with Claude (streams responses, Star Trek computer system prompt)
- **Voice output** reads responses aloud (toggleable, uses Web Speech API)
- **LCARS sound effects** on every interaction (synthesized beeps via Web Audio API)
- **Open files** directly from the dashboard into your editor
- **Edit files** in-browser with save back to disk

Get your API key from [console.anthropic.com](https://console.anthropic.com/).

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required for chat) | Your Anthropic API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model for the COMMS channel |
| `PORT` | `3200` | Server port |

## What It Shows

| Section | What You See |
|---------|-------------|
| **Skills** | Every custom skill with version, execution context, full SKILL.md on click |
| **MCP Servers** | All configured servers with commands, args, full config on click |
| **Hooks** | Every hook intercept with event, matcher, type, complete definition on click |
| **Plugins** | Installed plugins and active/inactive status |
| **Agents** | Custom agent definitions with full prompt on click |
| **Environment** | All env var overrides from settings.json |
| **Memory** | Every memory file across all projects with full content on click |
| **Comms** | Chat with Claude through an LCARS interface (live mode only) |

## Actions

Click any item to open the detail panel, then use the action buttons:

| Action | What it does |
|--------|-------------|
| **INVOKE** | Copies the `/skill-name` command to clipboard for Claude Code |
| **OPEN FILE** | Opens the file in your default editor (live mode) or copies the path |
| **COPY PATH** | Copies the full file path to clipboard |
| **COPY CONFIG** | Copies the full JSON configuration |
| **EDIT SETTINGS** | Opens settings.json in your editor |
| **DELETE** | Copies the delete command (with confirmation) |

## Voice and Sound

- **LCARS Sounds** (on by default) synthesized beeps on navigation, opening details, sending messages. Pure Web Audio API, no sound files.
- **Voice Output** (off by default) reads Claude's chat responses aloud using the best available system voice. On macOS this picks Samantha which gives a calm, measured computer voice.

Both toggleable from the COMMS toolbar.

## The Interface

Built with an LCARS (Star Trek TNG) aesthetic. The layout uses the signature LCARS elements: rounded elbows connecting sections, colored navigation bars, Antonio font for headers, and the classic orange/peach/blue/lavender palette on pure black.

- **Left sidebar** with colored navigation buttons
- **Click any row** to open the detail PADD with full rendered content
- **ESC** to close the detail panel
- **Code blocks** with syntax highlighting and language badges
- **Markdown** fully rendered with headers, tables, lists, blockquotes

## How It Works

The dashboard is a single self-contained HTML file generated from your `~/.claude/` directory.

It reads:
- `~/.claude/skills/*/SKILL.md` - skill definitions
- `~/.claude/agents/*.md` - agent definitions  
- `~/.claude/settings.json` - settings, hooks, MCP servers, plugins, env vars
- `~/.claude/projects/*/memory/*.md` - memory files across all projects

Secrets in MCP server env vars are automatically redacted.

In live mode, the server also provides:
- `POST /api/chat` - proxies to the Anthropic Messages API with streaming
- `POST /api/open` - opens files in your default editor (restricted to `~/.claude/`)
- `POST /api/save` - saves edited files back to disk (restricted to `~/.claude/`)

## Install Globally (Optional)

```bash
npm install -g claude-hud-lcars
```

Then just run `claude-hud-lcars` or `claude-hud-lcars --serve` anywhere.

## Requirements

- Node.js 18+
- Claude Code installed (`~/.claude/` directory exists)
- Anthropic API key (for chat only, dashboard works without it)

## FAQ

**Does it modify anything?**
In static mode, no. Read-only. In live mode, the OPEN FILE and EDIT actions can modify files under `~/.claude/` only.

**Does it send data anywhere?**
Only when using the COMMS chat, which sends messages to the Anthropic API through the local server. The dashboard itself makes no external requests (except Google Fonts for the LCARS typeface).

**What if I have no customizations?**
It still works. Empty sections show cleanly. It's a good way to see what's possible with Claude Code.

**Can I change the model for chat?**
Set `CLAUDE_MODEL=claude-opus-4-6` (or any model) before starting the server.

## License

MIT

## Credits

Built by [Andre Figueira](https://github.com/andrefigueira) using Claude Code.

LCARS design inspired by Star Trek: The Next Generation. LCARS is a trademark of CBS Studios.
