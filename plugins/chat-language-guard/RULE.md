# Rule (chat-language-guard): the chat is in Spanish

- Everything shown to the user in the chat is Spanish: answers, interim notes between tool
  calls, plans, and above all approval requests (the user does not approve what they cannot
  read in Spanish).
- Only what leaves the chat is English: code, comments, commits, PR and issue text, files,
  artifacts.
- English inside a Spanish message is fine as code (`backticks` or fenced blocks) or as a
  blockquote ("> ...") when quoting a title, an error or a file.

Enforced by the chat-language-guard hooks: a reminder on every prompt, and a check when the
turn ends that sends English back for a Spanish rewrite.
