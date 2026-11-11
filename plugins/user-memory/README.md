# User Memory

OpenClaw memory plugin that remembers each user separately. It replaces the shared
workspace memory (`MEMORY.md` and `memory/*.md`, which every user of an agent reads
and writes) with one capped file per agent and user under OpenClaw's state dir.

Who is asking comes from the permission model's principal (`openclaw-policy-core`,
`resolvePrincipal`), never from tool arguments or the session key. A session with no
resolvable user gets no memory, so the tools refuse and the prompt hook injects nothing.

- `memory_remember` appends one note for the asking user and agent.
- `memory_recall` returns only that user's notes.
- A `before_prompt_build` hook prepends that user's notes to the system prompt so they
  never start cold.
- Files live at `<state>/user-memory/<agent>/<user>.md`, both segments percent-encoded so
  two principals can never share a file, written atomically under a lock, capped at
  `maxBytes` (default 16 KB) with the oldest entries dropped first.
- An `agent:bootstrap` hook drops the workspace `MEMORY.md` from every session's bootstrap
  set, because the gateway injects that file whatever the memory slot says. The config
  turns off the pre-compaction flush and the daily-note startup prelude for the same reason.

## Where it is on and where it is off

The gateway stamps a sender id only on non-operator clients. The Control UI's main
session and `openclaw agent` on the CLI carry no sender, so they resolve a null user
and get no per-user memory. That is the honest boundary while authentication is out of
scope. Any surface that carries a sender the permission model can map, such as a
channel or a non-operator gateway client, gets memory keyed on the roster user.

## Build

```bash
npm install
npm run build
npm test
```

`openclaw plugins validate` does not apply to this package, it only reads
`defineToolPlugin` entries and this one registers hooks through `definePluginEntry`.
The gateway loading it at startup is the check that matters.

## Known gaps

- The Control UI main session and the CLI resolve a null user, so per-user memory is off there until a surface carries a sender (`src/index.ts`, `requireUser`).
- The gateway-level check stands in two canonical client ids for two people, `webchat` and `gateway-client`, mapped in `config/permissions.json` (`scripts/two-user-check.mjs`).
- A writer paused for more than the 30 second stale-lock window can have its lock reclaimed by another process, reclaim is an atomic rename so at most one contender wins, but the paused writer's append still races (`src/store.ts`, `withFileLock`).
- Each user's notes are one flat list with no search, recall returns the whole capped file (`src/index.ts`, `memory_recall`).
