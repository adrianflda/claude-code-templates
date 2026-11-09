#!/usr/bin/env node
/**
 * SessionStart hook: puts this plugin's RULE.md into the session context, so the rule
 * travels with its enforcement hook instead of living only in a memory file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let rule = '';
try {
  rule = readFileSync(join(root, 'RULE.md'), 'utf8').trim();
} catch {
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rule },
}));
