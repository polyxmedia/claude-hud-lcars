# Changelog

All notable changes to this project are documented here.

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
