# ROADMAP // CLAUDE HUD LCARS

> From operations dashboard to AI nervous system.

---

## Current State — Honest Rating

**Version 1.3.5 — 7.5 / 10**

| Dimension | Score | Notes |
|-----------|-------|-------|
| Design & aesthetic | 9/10 | Genuinely beautiful. The LCARS execution is committed and consistent |
| Read / browse experience | 8/10 | Every section clickable, detail panel solid, search works |
| Write / action capability | 5/10 | Can edit files and install suggestions but the UX is rough |
| Observability | 4/10 | Shows your config but has no idea what Claude is actually doing |
| Intelligence | 4/10 | Chat is a wrapper, not a collaborator |
| Marketplace | 6/10 | Exists, npm works, but no install wizard, no env var setup |
| Code health | 7/10 | Zero deps, good tests, but generate.js at 5,600 lines is a liability |
| Test coverage | 8/10 | 190 tests, data layer solid, UI completely uncovered |

**The core limitation:** it's a mirror. You look at what you have. Nothing watches, learns, or acts on your behalf.

The roadmap is about turning the mirror into a brain.

---

## Phase 1.4 — The Living Dashboard

*The dashboard should know what's happening right now, not just what was true when you last reloaded.*

### Real-time awareness
- **File watcher** — `fs.watch()` on `~/.claude/` broadcasts changes via WebSocket. Dashboard updates live when you install a new skill, Claude edits a hook, or a memory file is written. No manual reload.
- **Session stream** — Live view of active Claude Code sessions. See the current working directory, last command, token usage, and whether Claude is thinking/writing/waiting. Think activity monitor, not static list.
- **MCP health monitor** — Continuous ping of MCP servers. Status badges go live/degraded/offline in real time, not just on page load.

### Config as code
- **Settings diff viewer** — Every change to `settings.json` shown as a git-style diff with timestamp. Know what changed and when.
- **One-click rollback** — Restore any previous settings snapshot from a visible history panel.
- **Schema validation** — Settings mutations validated against Claude Code's config schema before write. Catches malformed hooks, bad MCP entries, typos in model names.

### Small quality-of-life
- **Q mute toggle** — He's funny for five minutes. Add a snooze button.
- **COMPUTER bar model persists** — Write model choice to settings.json so it survives a reload.
- **Keyboard shortcuts for actions** — `E` to edit, `O` to open file, `C` to copy, without clicking the buttons.

---

## Phase 1.5 — The Active Dashboard

*The dashboard should build things, not just show them.*

### Skill & agent workshop
- **Skill builder** — Form-based UI to create skills with frontmatter fields (name, description, context, version), a full body editor with markdown preview, and a one-click save to `~/.claude/skills/`. No file editing required.
- **Agent builder** — Same for agents. Define tools list, system prompt, model preference.
- **Skill tester** — Send a test prompt directly to a skill from the detail panel. See the response without leaving the dashboard.
- **Hook lab** — Write a hook, set the event + matcher, and test it against a sample payload. Shows what the hook would do before you commit it to settings.json.

### MCP setup wizard
- **Env var collection** — When you install an MCP server, the wizard reads its README for required env vars and prompts you to fill them in. No more guessing what `GITHUB_TOKEN` is supposed to be.
- **Connection test** — After install, fires a test command and shows whether the server responds. Green light / red light before you close the wizard.
- **Dependency check** — Verifies `npx`, `uvx`, `docker` etc. are available before adding the server to settings.

### Context substrate builder
- **CLAUDE.md editor** — Visual editor for `~/.claude/CLAUDE.md` and per-project CLAUDE.md files. Structured sections (persona, rules, preferences, project context) with a live preview. This is where the AI's permanent memory lives — it deserves a real UI.
- **Memory editor** — Browse, edit, create, and delete memory files directly in the dashboard. Tag files, link them to projects, see which ones are being loaded into which contexts.

---

## Phase 2.0 — The Intelligent Dashboard

*The dashboard should understand your setup, not just display it.*

### Usage analytics
- **Skill usage tracker** — Hook into Claude Code's session history to surface: which skills you invoke most, which ones you defined but never use, which ones get modified most often. The skills that do nothing should be obvious.
- **MCP server profiling** — Track response times and error rates per server over time. Graph showing which servers are reliable and which ones are flaky. Helps you decide what to keep.
- **Session productivity** — Token counts, task completion rates, session length distributions per project. Gives you signal on where Claude is most useful in your workflow.

### Setup advisor
- **Config analyser** — Claude reads your entire setup (skills, agents, hooks, MCP servers, memory files, CLAUDE.md) and writes a structured report: what you have, what's redundant, what's missing, what conflicts. Runs on demand or weekly.
- **Suggestion engine** — Not just "here are 5 pre-built skills" but "given that you work primarily in TypeScript with GitHub, here are the specific MCP servers and hooks that would reduce your friction." Personalised, not generic.
- **Dead config detection** — Identifies skills you haven't used in 30 days, MCP servers that haven't responded in a week, hooks that never fired. Declutter button.

### Pattern learning
- **Cross-session context** — Surfaces recurring patterns from your chat history: questions you ask Claude repeatedly, errors that keep coming back, file paths you reference often. Turns patterns into suggested CLAUDE.md entries or new skills.
- **Prompt library** — Extract the prompts that worked. When a COMPUTER bar conversation produces something useful, save it as a reusable template with one click.

---

## Phase 2.5 — The Networked Dashboard

*Your setup shouldn't live in isolation.*

### Team and sharing
- **Setup export** — Bundle your entire `~/.claude/` configuration as a portable `.tar.gz` or GitHub Gist. Shareable with a link. Other people can import it and get your exact workflow.
- **Setup import** — Import someone else's setup, preview what it contains, and cherry-pick the parts you want. Skills, agents, hooks, MCP configs — selectively.
- **Team presets** — Shared config baselines for your org. "Frontend setup", "backend setup", "security auditor setup". New team members run one command.

### GitHub sync
- **Settings as code** — Two-way sync between `settings.json` and a git repository. Config changes tracked, reviewed, and rolled back via PRs. `git blame` for your Claude setup.
- **Skill versioning** — Skills stored in git with proper semantic versioning. Changelog auto-generated from diffs. Upgrade or downgrade individual skills.

### Marketplace 2.0
- **Ratings and reviews** — Community feedback on marketplace plugins. Upvotes, comments, last-updated dates. Signal over noise.
- **Verified publishers** — Checkmarks for Anthropic, major tool vendors, high-reputation contributors.
- **Fork and customize** — Take any marketplace plugin, fork it, modify it, publish your version. GitHub-style.
- **Dependency resolution** — Install a plugin that requires another MCP server? It installs both. No manual hunting.

---

## Phase 3.0 — The Autonomous Dashboard

*The dashboard should improve your setup without you asking.*

### Self-improving setup
- **Skill evolution** — Claude monitors your COMPUTER bar usage and periodically suggests updated versions of your skills. "You've asked me to do X 15 times this month. Here's a skill that automates it." One click to create, one click to reject.
- **Hook suggestions from usage** — Notices you always run `npm test` after saving TypeScript files, or always type `git status` before committing. Surfaces these as hook candidates.
- **Memory hygiene** — Scans memory files for outdated information (references to old projects, stale API endpoints, deprecated tools), flags them for review. Memory rot is real.

### Multi-agent visibility
- **Agent mesh** — If you're running multiple Claude Code sessions across projects, the dashboard shows them as a connected graph. Which agents are active, what they're working on, whether they're reading shared memory files.
- **Coordination view** — See when two sessions are working in the same files. Prevent conflicts. Visualise parallelism.
- **Shared context bus** — Experimental: a shared memory layer that lets agents in different sessions read and write to common context. Coordination without explicit API calls.

### Evaluation framework
- **Skill benchmarks** — Define a set of test cases for each skill (input + expected output). Run the benchmark suite on demand. Know if a skill regresses when you modify it.
- **Hook test runner** — Supply synthetic tool call payloads and verify your hooks behave correctly. CI for your Claude configuration.
- **A/B skill testing** — Run two versions of a skill against the same prompt, compare outputs. Iterate empirically, not by feel.

### Autonomous task scheduler
- **Cron-style agent runner** — Schedule agents to run tasks on a timer. "Every Monday at 9am, run the security-auditor agent on my current project." Results delivered to memory or CLAUDE.md.
- **Event-triggered agents** — When a file changes, a PR opens, or a build fails: trigger an agent. Hook the dashboard into your development events.
- **Long-running task monitor** — Track background agents, see their progress, interrupt or redirect them from the dashboard.

---

## Phase ∞ — The Substrate

*This is where it stops being a dashboard and starts being something else.*

The thing this is building toward is not a better dashboard. It's a persistent, intelligent layer between you and your tools. A substrate that knows your context, coordinates your agents, manages your knowledge, and continuously improves itself based on what actually works.

Some of what that looks like:

**Universal context** — Every tool you use (editor, browser, terminal, CI, chat) reads from and writes to a shared context layer. Claude isn't a separate tool you open; it's ambient. The dashboard is the control surface.

**Reasoning transparency** — Not just "Claude said X" but "Claude said X because it read these memory files, made these intermediate conclusions, and chose this action over these alternatives." Explainability as a first-class feature.

**Continuous calibration** — The system tracks what you accepted and rejected across thousands of sessions. Skill suggestions, hook recommendations, memory summaries — all calibrated to your actual preferences, not a generic baseline.

**Self-healing configs** — When an MCP server breaks, the system detects it, searches the registry for alternatives, proposes a replacement, and asks permission to swap it in. Zero downtime on your workflow.

**Emergence surface** — The dashboard becomes the place where new capabilities emerge from the combination of your skills, agents, hooks, and memory. Not features someone built — patterns the system noticed and codified from your own usage.

AGI isn't a single model getting smarter. It's an ecosystem of models, memory, tools, and coordination getting tighter. This dashboard is the interface to that ecosystem. The roadmap is about making that interface worthy of what it's connecting to.

---

## What We're Not Building

To stay grounded:

- **Not a Claude Code replacement** — The CLI stays the primary interface. This dashboard augments it, doesn't compete with it.
- **Not a team product** — Personal productivity first. Team features come after individual workflows are solid.
- **Not adding dependencies** — Every feature ships with zero new runtime dependencies or it ships as an optional enhancement.
- **Not abstracting the filesystem** — `~/.claude/` stays the source of truth. The dashboard reads and writes files. No proprietary database, no cloud sync required.

---

## Current Version Gaps to Close First

Before any of the above, these are the embarrassing things that should be fixed:

1. **generate.js needs to be split** — 5,600 lines is not sustainable. Section generators into separate logical blocks minimum.
2. **No end-to-end tests** — The data layer is tested. The actual UI interactions are not. One Playwright smoke test suite.
3. **COMPUTER bar history disappears on reload** — Should persist to localStorage at minimum.
4. **No onboarding** — First-time user with zero skills/hooks sees empty sections with no guidance. An empty state that teaches is better than an empty state that just sits there.
5. **MCP server detail shows redacted env** — Right, but there's no way to view or edit env vars in the UI. Circular. Fix it.

---

*The galaxy isn't going to explore itself.*
