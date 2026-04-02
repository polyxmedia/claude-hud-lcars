#!/usr/bin/env bash
# PostToolUse hook: auto-create a GitHub release after git push to main
# Fires when the Bash tool runs a git push command.

set -euo pipefail

PROJECT_DIR="/Users/andrefigueira/Code/claude-ideas/claude-dashboard"

# ── Parse stdin ────────────────────────────────────────────────────────────────
INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"

# Only act on Bash tool calls that look like a git push to main/origin
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

if ! echo "$COMMAND" | grep -qE 'git\s+push'; then
  exit 0
fi

# Ignore force pushes and branch deletions
if echo "$COMMAND" | grep -qE '\-\-force|-f\b|:\w+'; then
  exit 0
fi

# ── Read version from package.json ────────────────────────────────────────────
VERSION="$(cd "$PROJECT_DIR" && node -p "require('./package.json').version" 2>/dev/null || true)"

if [[ -z "$VERSION" ]]; then
  echo "autorelease: could not read version from package.json, skipping" >&2
  exit 0
fi

TAG="v${VERSION}"

# ── Check if this tag already has a release ───────────────────────────────────
cd "$PROJECT_DIR"

if gh release view "$TAG" --repo polyxmedia/claude-hud-lcars &>/dev/null; then
  echo "autorelease: release $TAG already exists, skipping" >&2
  exit 0
fi

# ── Extract notes for this version from CHANGELOG.md ─────────────────────────
CHANGELOG="$PROJECT_DIR/CHANGELOG.md"
NOTES=""

if [[ -f "$CHANGELOG" ]]; then
  # Grab all lines between the most recent ## heading and the next one
  NOTES="$(awk '
    /^## / { if (found) exit; found=1; next }
    found { print }
  ' "$CHANGELOG" | sed '/^[[:space:]]*$/d' | head -40)"
fi

if [[ -z "$NOTES" ]]; then
  NOTES="Release $TAG"
fi

# ── Create the git tag if it does not exist ───────────────────────────────────
if ! git tag | grep -qx "$TAG"; then
  git tag "$TAG"
  git push origin "$TAG"
fi

# ── Create the GitHub release ─────────────────────────────────────────────────
gh release create "$TAG" \
  --repo polyxmedia/claude-hud-lcars \
  --title "$TAG" \
  --notes "$NOTES" \
  --latest

echo "autorelease: created GitHub release $TAG" >&2

# ── Publish to npm ────────────────────────────────────────────────────────────
NPM_PUBLISHED="$(npm view claude-hud-lcars version 2>/dev/null || true)"

if [[ "$NPM_PUBLISHED" == "$VERSION" ]]; then
  echo "autorelease: npm $VERSION already published, skipping" >&2
  exit 0
fi

cd "$PROJECT_DIR"
npm publish --access public 2>&1 | sed 's/^/autorelease [npm]: /' >&2

echo "autorelease: published claude-hud-lcars@$VERSION to npm" >&2
