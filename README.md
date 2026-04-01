# claude-hud

LCARS-inspired operations dashboard for [Claude Code](https://claude.ai/code). See everything you've built at a glance, drill into any skill, hook, agent, or MCP server, and read the full content like pulling up a file on a PADD.

> Zero config. Zero dependencies. Just run it.

## Quick Start

```bash
npx claude-hud-lcars
```

That's it. Scans your `~/.claude/` directory and opens a dashboard in your browser.

## What It Shows

| Section | What You See |
|---------|-------------|
| **Skills** | Every custom skill with version, execution context, and full SKILL.md content on click |
| **MCP Servers** | All configured servers with commands, args, and full config on click |
| **Hooks** | Every hook intercept with event, matcher, type, and the complete hook definition on click |
| **Plugins** | Installed plugins and their active/inactive status |
| **Agents** | Custom agent definitions with full prompt and configuration on click |
| **Environment** | All env var overrides from settings.json |
| **Memory** | Every memory file across all projects with full content on click |

## The Interface

Built with an LCARS (Star Trek TNG) aesthetic because if you're going to stare at your Claude Code configuration, it should look like you're operating a starship.

- **Left sidebar** - navigate between sections
- **Click any row** - opens the detail panel with full rendered content
- **ESC** - close the detail panel
- **Code blocks** - syntax highlighted with JSON detection
- **Markdown** - fully rendered with headers, tables, lists, code blocks

## How It Works

The dashboard is a single static HTML file generated from your `~/.claude/` directory. No server, no build step, no dependencies.

It reads:
- `~/.claude/skills/*/SKILL.md` - skill definitions
- `~/.claude/agents/*.md` - agent definitions
- `~/.claude/settings.json` - settings, hooks, MCP servers, plugins, env vars
- `~/.claude/projects/*/memory/*.md` - memory files across all projects

Secrets in MCP server env vars are automatically redacted.

## Install Globally (Optional)

```bash
npm install -g claude-hud-lcars
```

Then just run `claude-hud-lcars` anywhere.

## Requirements

- Node.js 18+
- Claude Code installed (`~/.claude/` directory exists)

## FAQ

**Does it modify anything?**
No. Read-only. It only reads files from `~/.claude/` and generates an HTML file.

**Does it send data anywhere?**
No. Everything stays local. The generated HTML is a self-contained file with no external requests (except Google Fonts).

**What if I have no customizations?**
It still works. Empty sections show cleanly. It's a good way to see what's possible.

**Can I customize the output location?**
The HTML is generated in the same directory as the script. Run from wherever you want it.

## License

MIT

## Credits

Built by [Andre Figueira](https://github.com/andrefigueira) using Claude Code.

LCARS design inspired by Star Trek: The Next Generation. LCARS is a trademark of CBS Studios.
