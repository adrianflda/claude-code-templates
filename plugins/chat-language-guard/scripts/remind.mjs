#!/usr/bin/env node
/**
 * chat-language-guard — Claude Code UserPromptSubmit hook: a one-line reminder of the rule
 * on every prompt, so it is fresh in context exactly when Claude starts writing.
 */
if (process.env.CHAT_LANGUAGE_GUARD_DISABLE === '1') process.exit(0);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext:
      '[chat-language-guard] Write every line you show the user in Spanish, interim notes and approval ' +
      'requests included. Only what leaves the chat (code, commits, PRs, files, artifacts) is English.',
  },
}));
