# I Built a Star Trek LCARS Terminal to Manage My Claude Code Setup

I've been using Claude Code heavily for months now. Skills, agents, hooks, MCP servers, plugins, memory files, environment variables, the whole stack. And at some point I realized I had no idea what I'd actually built. Everything lives in `~/.claude/` spread across dozens of files and JSON configs and I was just... hoping it all worked together.

So I built a dashboard. And because I'm the kind of person who watched every episode of TNG twice and still thinks the LCARS interface is the best UI ever designed for a computer, I made it look like a Starfleet terminal.

## What It Actually Is

One command. Zero dependencies. You run `npx claude-hud-lcars` and it scans your entire `~/.claude/` directory, reads every skill definition, every agent prompt, every MCP server config, every hook, every memory file, and generates a single self-contained HTML dashboard that renders the whole thing in an authentic LCARS interface.

The real TNG color palette. The signature rounded elbows. The Antonio typeface standing in for Swiss 911. Pill-shaped navigation buttons. The black void background. If you grew up watching Picard walk onto the bridge and glance at a wall panel, you know exactly what this looks like.

But it's not just eye candy. Every single item is clickable. You click a skill and the detail panel slides open showing the full SKILL.md with syntax-highlighted code blocks, proper markdown rendering, headers, tables, the works. You click an MCP server and you see its complete JSON config with your API keys automatically redacted. You click a hook and you see the full event definition. It genuinely looks like pulling up a classified Starfleet briefing on a PADD.

## The Computer Talks Back

There's a persistent input bar at the bottom of every screen labeled COMPUTER. You type anything, hit Enter, and it streams a response from Claude in real time through a response overlay that slides up from the bottom. The system prompt makes it respond as LCARS, the Library Computer Access and Retrieval System. Calm, measured, structured. It refers to your skills as installed modules, your MCP servers as the fleet, your projects as active missions.

You can also connect ElevenLabs for premium voice output. The config panel lets you browse all your available voices with live audio previews before selecting one. The whole thing supports voice input too, you talk to the computer and it talks back. There's echo detection so it doesn't hear itself, there's interrupt handling, the mic stops during speech and restarts after a 2 second cooldown. It actually works as a voice conversation loop.

And yes, there are sound effects. Synthesized LCARS beeps via the Web Audio API. No audio files, no external assets, just sine wave oscillators tuned to frequencies that sound right. Navigation clicks, panel opens, message sends, all with that subtle satisfying chirp. Toggleable obviously.

## The Tactical Display

This is the one that makes people stop scrolling. The TACTICAL tab renders your entire Claude Code setup as an interactive force-directed graph that looks like a Star Trek sensor display. Your LCARS core sits at the center with category hubs orbiting around it, skills in periwinkle, MCP servers in orange, hooks in tan, agents in peach, all connected by pulsing edges. A rotating scanner line sweeps around like a tactical readout. You can click any node and it navigates you to that item's detail view.

There's also an ENTERPRISE tab that loads a real 3D model of the USS Enterprise NCC-1701-D via Sketchfab. Full interactive, you can rotate it, zoom in, see the hull detail. Because if you're going to build a Star Trek dashboard, you don't do it halfway.

## Q Shows Up Uninvited

I couldn't resist. There's a Q tab where you can talk to Q, the omnipotent being from the Continuum. He's in full character, condescending, theatrical, calling you "mon capitaine" and snapping his fingers. There's a JUDGE ME button where Q examines your entire setup by name and delivers a devastating roast with one grudging compliment buried in mockery.

And every couple of minutes there's a small chance Q just appears on screen with a random quip. A red popup, a snap sound, something like "I've seen civilizations rise and fall in the time it takes you to write a commit message." Then he vanishes. You can't stop it. He's Q.

## Boot Sequence and Red Alert

When you load the dashboard, you get a 3 second boot animation. The Starfleet Command logo fades in, your ship name appears (you can name your workstation in the config, mine is USS Defiant), then seven subsystems come online one by one with ascending beeps. Progress bar fills, "ALL SYSTEMS NOMINAL" pulses, overlay fades to reveal the dashboard.

Five seconds after boot, the system runs a health check. If your MCP servers are offline you get RED ALERT with a flashing red border and a klaxon alarm sound. Missing configs trigger YELLOW ALERT. Everything clean shows CONDITION GREEN briefly then dismisses. Star Trek fans will lose their minds over this.

## Ship Themes

Four color palettes you can switch from the CONFIG panel. Enterprise-D is the classic TNG orange and blue. Defiant is darker, more aggressive, red and grey. Voyager is blue-shifted, cool and distant. Discovery is silver and blue, modern Starfleet. CSS variable swap, instant application, persisted in localStorage.

## Why This Actually Matters

Look, the Star Trek stuff is fun and it's what makes people share it. But underneath the aesthetics there's a real problem being solved.

Claude Code is powerful. The skill system, the hook architecture, MCP server integration, custom agents, memory files, it's a genuinely sophisticated development environment. But the setup is invisible. Everything lives in flat files and JSON configs scattered across your home directory. You build this complex system and then you can't see it. You can't browse it. You definitely can't show it to someone else and say "this is what I've built."

This dashboard makes the invisible visible. You open it and you immediately understand your setup. Oh I have 36 skills, 12 MCP servers, 8 hooks, 4 agents. That memory file from three weeks ago is still there. That hook I thought I deleted is still active. That MCP server config has a typo in the args.

And then you can actually do something about it. Create new skills, agents, hooks, MCP servers, environment variables, and plugins directly from the dashboard. Edit files in the browser. Open them in your editor. The detail panel has action buttons that copy commands, open files, invoke skills.

It turns Claude Code from a tool you configure and hope works into a system you can actually observe and manage. That's the real value underneath the LCARS paint.

## Zero Dependencies, Single HTML

The whole thing generates one self-contained HTML file. No build step, no bundler, no framework, no node_modules. Just Node.js built-ins. The CSS, JavaScript, markdown renderer, syntax highlighter, chat client, voice synthesis, sound effects, force-directed graph, all inline in one file. You can email the dashboard to someone and they can open it in their browser.

In live server mode it adds API endpoints for chat streaming, file operations, voice synthesis, and MCP health checks. But the core dashboard works perfectly in static mode. Zero external requests aside from Google Fonts for the LCARS typeface.

## Where This Goes

I'm actively improving this. The codebase is open source under MIT. I've done a deep dive into the Claude Code source and I have a ton of ideas for where to take it. CLAUDE.md editor built into the dashboard. Skill templates gallery. Setup scoring. Config diffing. The roadmap is long and I'm building fast.

If you're using Claude Code and you want to actually see what you've built, give it a try. One command, takes about 3 seconds.

```bash
npx claude-hud-lcars
```

For the full experience with chat and voice:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx claude-hud-lcars --serve
```

The repo is at [github.com/polyxmedia/claude-hud-lcars](https://github.com/polyxmedia/claude-hud-lcars). Star it if you think it's cool, fork it if you want to make it weird, and if Q roasts your setup particularly hard, I want to hear about it.

Live long and prosper.
