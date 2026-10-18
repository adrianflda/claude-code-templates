# Rule (aws-admin-guard): the AWS admin profile needs two confirmations from the human

- Default to the read-only AWS profile. Never use the admin profile on your own initiative.
- When a step needs admin: stop, explain in the user's language what it is for and the exact
  commands, and ask for authorization. Then ask for a second confirmation, in a separate
  message. Only then run the commands.
- The grant comes only from what the human types in this session (the session transcript)
  and lasts a limited time (default 30 minutes after the second confirmation). Saying
  "revoco admin" / "revoke admin" closes it.
- In every authorization request and before every write, state explicitly the target account (id and
  name) and that nothing is written in the other accounts.
- Never edit session transcripts and never look for another way to get admin rights.

Enforced by the aws-admin-guard hooks: a blocked command means the rule applied.
