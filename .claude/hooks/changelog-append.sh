#!/usr/bin/env bash
# PostToolUse hook: append git commit entries to CHANGELOG.md
# Receives hook input JSON on stdin

set -euo pipefail

PROJECT_DIR="/Users/andrefigueira/Code/claude-ideas/claude-dashboard"
CHANGELOG="$PROJECT_DIR/CHANGELOG.md"

# Read stdin once
INPUT="$(cat)"

# Only act on successful git commit commands
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

# Check the command contains a real git commit (not git commit --amend without -m, etc.)
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Commit is already done by the time this hook fires — read message directly from git
MSG="$(cd "$PROJECT_DIR" && git log -1 --pretty=format:"%s" 2>/dev/null || true)"

if [[ -z "$MSG" ]]; then
  exit 0
fi

DATE="$(date '+%Y-%m-%d')"

# Create CHANGELOG.md if it does not exist
if [[ ! -f "$CHANGELOG" ]]; then
  cat > "$CHANGELOG" <<'HEADER'
# Changelog

All notable changes to this project are documented here.

HEADER
fi

# Append the new entry
printf "\n## %s - %s\n" "$DATE" "$MSG" >> "$CHANGELOG"

exit 0
