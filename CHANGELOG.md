# Changelog

All notable changes to this project are documented here.

## 1.7.0 - 2026-04-22

- MNEMOS panel — new sidebar section that auto-detects [Mnemos](https://github.com/polyxmedia/mnemos) (persistent memory + skills for AI coding agents) and surfaces every observation, session, auto-promoted skill, file touch, top tag, and top project from `~/.mnemos/mnemos.db`. Reads SQLite directly via the system `sqlite3` CLI — zero new npm dependencies
- Sub-tabs for OBSERVATIONS / SESSIONS / SKILLS / FILES with full-text filter that searches title, content, tags, and project across the active tab
- Type-filter chips on observations (CORRECTION, CONVENTION, DECISION, BUGFIX, PATTERN, etc.) colour-coded by obs_type
- Detail panels render the full observation body with structured `tried` / `wrong_because` / `fix` for corrections, importance, access count, supersession status, expiry, session ID, and tag chips
- Action buttons: COPY ID, COPY CONTENT, OPEN IN CLI (runs `mnemos search`), REPLAY (runs `mnemos replay <session>`), EXPORT PACK (runs `mnemos skill export <name>`)
- Universal search (Cmd+K) picks up mnemos entries with their own pink MNEMOS type badge
- Cross-platform `sqlite3` lookup — checks `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/opt/local/bin`, the standard Windows install path, then falls back to `which`/`where`
- When mnemos is not installed, the panel renders a hands-off install pitch — learning-loop benefits cards, copy-able install one-liner, and links to the GitHub repo, quick start, and MCP tools reference. Dashboard never errors regardless of mnemos state

## 1.2.0 - 2026-04-02

- Discover panel — one-click install suggestions for skills, agents, MCP servers, and hooks you haven't set up yet. Collapsed by default, expandable per section
- Skills/agents/hooks install directly into ~/.claude via the live server API. MCP servers write into settings.json via new /api/settings-update endpoint
- PWA icon generation in server.js — LCARS-styled icon served from /icon.png with no external assets
- Expanded server test suite
- escA() helper for safe HTML attribute escaping of JSON values embedded in onclick handlers

## 1.1.0 - 2026-04-02

- Expanded test suite to 87 tests covering all data-parsing functions: getSettings, getMcpServers, getSessionCount, getSessions, getHistory, getClaudeMdFiles, parseMcpEntry, getHooks, getPlugins, getEnv, esc, escJ
- Projects directory config field in CONFIG panel — set your code folder path and it injects active project context into every COMPUTER bar chat
- Fixed JS syntax error that broke the boot sequence on first load
- Autorelease hook — GitHub release created automatically on every git push when version changes
- Shell injection hardening in server.js (execFile instead of execSync for open/which commands)
- Silent error fixes — MCP parse warnings now surfaced to console, dead speak() function removed

## 2026-04-02 - chore: add PolyForm Noncommercial license

Free to use, modify, and share — commercial use not permitted.

## 2026-04-02 - fix: stop file:// tab on reload, isolate API key, harden error handling

- Pass --no-open when server calls generate.js so reloading localhost never spawns a file:// tab
- Remove auto-open browser on server start
- Support CLAUDE_DASHBOARD_API_KEY to avoid conflicts with Claude Code's own key
- Add server EADDRINUSE handler with helpful port conflict message
- Wrap all fs.readFileSync calls in generate.js with try/catch so bad files are skipped gracefully
- Add Contributing and Reporting bugs sections to README
- Delete ARTICLE.md

## 2026-04-02 - fix dashboard: zoom, Q tab visibility, search highlight, auto-detect server

## 2026-04-02 - CLI: auto-open browser, --serve flag, --help

## 2026-04-02 - $(cat <<

## 2026-04-02 - feat: delete for all items, suggest card detail panel, fix changelog hook

## 2026-04-02 - fix: strengthen LCARS identity — never breaks character, explicit responses to who/what questions

## 2026-04-02 - feat: default chat to Sonnet, Discover model config (default Opus), fix Haiku option value

## 2026-04-02 - feat: seamless install/delete (no reload), LCARS confirm modal, fixed markdown panel padding

## 2026-04-02 - test: add ESM-compatible syntax check for generated dashboard JS

## 2026-04-02 - test: add ESM-compatible syntax check for generated dashboard JS

## 2026-04-02 - chore: bump version to 1.3.0

## 2026-04-02 - feat: add Marketplace tab — browse and install from local plugin marketplaces

## 2026-04-02 - feat: add Marketplace tab — browse and install from local plugin marketplaces
