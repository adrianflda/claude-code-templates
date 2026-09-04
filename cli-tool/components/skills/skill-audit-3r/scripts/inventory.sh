#!/usr/bin/env bash
# Inventory of Claude config artifacts with word counts (biggest first).
# Deterministic + cheap: gives the auditor a prioritized work-list without reading every file.
#
# Usage:
#   bash inventory.sh [project_dir]
#     no arg      -> ~/.claude global config only
#     project_dir -> also scans <project_dir>/.claude and CLAUDE.md files
#
# Output columns: WORDS  ~TOKENS  KIND  PATH   (tokens ~= words * 1.3)

set -euo pipefail
shopt -s nullglob  # unmatched globs expand to nothing (empty dirs -> no spurious rows)

CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PROJECT_DIR="${1:-}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

emit() {
  # $1 = kind label, remaining = files
  local kind="$1"; shift
  local f w
  for f in "$@"; do
    [ -f "$f" ] || continue
    w=$(wc -w < "$f" | tr -d ' ')
    printf '%s\t%s\t%s\n' "$w" "$kind" "$f" >> "$tmp"
  done
}

# --- global config ---
emit "CLAUDE.md"  "$CLAUDE_HOME"/CLAUDE.md
[ -d "$CLAUDE_HOME/skills" ]   && emit "skill"   "$CLAUDE_HOME"/skills/*/SKILL.md
[ -d "$CLAUDE_HOME/agents" ]   && emit "agent"   "$CLAUDE_HOME"/agents/*.md
[ -d "$CLAUDE_HOME/commands" ] && emit "command" "$CLAUDE_HOME"/commands/*.md
if [ -d "$CLAUDE_HOME/hooks" ]; then
  while IFS= read -r f; do emit "hook" "$f"; done < <(find "$CLAUDE_HOME/hooks" -type f 2>/dev/null)
fi

# --- project config (optional) ---
if [ -n "$PROJECT_DIR" ] && [ ! -d "$PROJECT_DIR" ]; then
  echo "Warning: project_dir '$PROJECT_DIR' not found, skipping project scan." >&2
elif [ -n "$PROJECT_DIR" ]; then
  while IFS= read -r f; do emit "proj:CLAUDE.md" "$f"; done \
    < <(find "$PROJECT_DIR" -maxdepth 3 -name CLAUDE.md -type f 2>/dev/null)
  [ -d "$PROJECT_DIR/.claude/skills" ]   && emit "proj:skill"   "$PROJECT_DIR"/.claude/skills/*/SKILL.md
  [ -d "$PROJECT_DIR/.claude/agents" ]   && emit "proj:agent"   "$PROJECT_DIR"/.claude/agents/*.md
  [ -d "$PROJECT_DIR/.claude/commands" ] && emit "proj:command" "$PROJECT_DIR"/.claude/commands/*.md
  if [ -d "$PROJECT_DIR/.claude/hooks" ]; then
    while IFS= read -r f; do emit "proj:hook" "$f"; done < <(find "$PROJECT_DIR/.claude/hooks" -type f 2>/dev/null)
  fi
fi

if [ ! -s "$tmp" ]; then
  echo "No config artifacts found under $CLAUDE_HOME${PROJECT_DIR:+ or $PROJECT_DIR}."
  exit 0
fi

count=$(wc -l < "$tmp" | tr -d ' ')
total=$(awk -F'\t' '{s+=$1} END{print s}' "$tmp")
approx_tokens=$(awk -F'\t' '{s+=$1} END{printf "%d", s*1.3}' "$tmp")

printf 'Claude config inventory  (%s artifacts, %s words, ~%s tokens)\n' "$count" "$total" "$approx_tokens"
printf '%-7s %-9s %-16s %s\n' "WORDS" "~TOKENS" "KIND" "PATH"
sort -t$'\t' -k1,1 -nr "$tmp" | while IFS=$'\t' read -r w kind path; do
  printf '%-7s %-9s %-16s %s\n' "$w" "$(( w * 13 / 10 ))" "$kind" "$path"
done

cat <<'EOF'

Next: classify each with the 3R rule (Repeatable / Requirement / Repartible).
Start from the top (largest = most potential noise). Read a file only when judging it.
EOF
