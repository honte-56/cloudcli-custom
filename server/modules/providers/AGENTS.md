# Project authentication at runtime

The runtime dispatcher resolves GitHub authentication from the authenticated writer and project directory before each run. Never put project credentials in process.env, prompts, command arguments, or logs. Each adapter must pass the prepared environment only to its own child. Both Codex transports must allow the explicitly configured authentication variables through to shell tools. This is account selection, not isolation from an agent with local execution access.

Authentication instructions are prepended only when starting a provider session. Use the resolved provider session ID, not the preallocated app session ID, to distinguish the first turn from a resume. Credentials are still resolved and passed to the child on every run.
