#!/usr/bin/env python3
"""Conventional Commits hook (PreToolUse Bash): denies a commit made with -m whose message does not
start with `type(scope): description`. A message it cannot read with certainty (a file, an
editor, a command substitution other than the usual heredoc) is allowed: the hook never guesses.
Tests: test_conventional_commits.py
"""
import json
import sys
import re

try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
    sys.exit(1)

tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})
command = tool_input.get("command", "")

# Only a command that runs `git commit`: the words inside a script body, a grep pattern or an
# echo are text. The command is cut at `&&`, `||`, `;` and line ends, and a part must start with it.
if tool_name != "Bash" or "git commit" not in command:
    sys.exit(0)
starts = [m.end() for m in re.finditer(r'(?:^|&&|\|\||;|\n)(?=\s*git commit\b)', command)]
if not starts:
    sys.exit(0)
segment = command[starts[0]:]

# The heredoc form first: -m "$(cat <<'EOF' ... EOF)". Its opening quote would otherwise be read
# as a plain -m "..." that ends at the quote of <<'EOF'.
heredoc = re.search(r'^\s*git commit\b[^\n]*?-m\s+"?\$\(cat\s+<<-?\s*["\']?(\w+)["\']?[ \t]*\n(.+?)\n\s*\1\b', segment, re.DOTALL)
if heredoc:
    commit_msg = heredoc.group(2)
else:
    # -m "message" or -m 'message': the quote that opens the message is the one that closes it.
    plain = re.search(r'^\s*git commit\b[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|\'([^\']*)\')', segment, re.DOTALL)
    if not plain:
        sys.exit(0)  # no readable message: allow it
    commit_msg = plain.group(1) if plain.group(1) is not None else plain.group(2)
    if '$(' in commit_msg or '`' in commit_msg:
        sys.exit(0)  # built by a command: not readable here, allow it
commit_msg = commit_msg.strip()

# Check if message follows Conventional Commits format
# Format: type(scope)?: description
# Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert
conventional_pattern = r'^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+\))?:\s.+'

if not re.match(conventional_pattern, commit_msg):
    reason = f"""❌ Invalid commit message format

Your message: {commit_msg}

Commit messages must follow Conventional Commits:
  type(scope): description

Types:
  feat:     New feature
  fix:      Bug fix
  docs:     Documentation changes
  style:    Code style changes (formatting)
  refactor: Code refactoring
  perf:     Performance improvements
  test:     Adding or updating tests
  chore:    Maintenance tasks
  ci:       CI/CD changes
  build:    Build system changes
  revert:   Revert previous commit

Examples:
  ✅ feat: add user authentication
  ✅ feat(auth): implement JWT tokens
  ✅ fix: resolve memory leak in parser
  ✅ fix(api): handle null responses
  ✅ docs: update API documentation

Invalid:
  ❌ Added new feature (no type)
  ❌ feat:add feature (missing space after colon)
  ❌ feature: add login (wrong type, use 'feat')

💡 Tip: Start your message with one of the types above followed by a colon and space."""

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    }
    print(json.dumps(output))
    sys.exit(0)

# Allow the command
sys.exit(0)
