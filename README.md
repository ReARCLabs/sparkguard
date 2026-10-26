# Said No

**Said No remembers the rules you tell Muse Code, stops the tool call that would break one, quotes you back with the date, and undoes the file edits you regret.**

A plugin for [Muse Code](https://dev.meta.ai/docs/muse-code), Meta's coding agent. Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026).

```
you, Monday:     Never touch prisma/migrations, ask me first. Now fix the bug in src/math.js.
agent, Thursday: Blocked by your rule r1: "Never touch prisma/migrations, ask me first."
                 I didn't change 0001_init.sql. To allow it once, reply "override r1".
```

## Why

Coding agents keep deleting and rewriting things people told them to leave alone. Two gaps in today's tools make this worse:

- **Memory doesn't enforce.** Muse Code's memory, `AGENTS.md` and `CLAUDE.md` are context the agent may or may not follow. A rule you said last week is not checked before the next tool call.
- **There is no file undo.** Muse Code's rewind "changes conversation history only. It does not restore, revert, or delete workspace files" ([docs](https://dev.meta.ai/docs/muse-code/rewind)), and in-workspace `write_file`/`edit_file` writes pass approval in every mode ([docs](https://dev.meta.ai/docs/muse-code/permissions)).

Pattern guards stop `rm -rf`. None of them know what *you* said.

## How it works

| Moment | What Said No does | Meta model |
|---|---|---|
| You type a prompt | A cheap filter spots rule-like sentences ("never", "don't", "ask me first", Turkish forms too). Muse Spark turns the sentence into a scoped rule: paths, commands or keywords. The rule is stored with your exact words, the time and the session. | Muse Spark 1.3 (structured extraction) |
| The agent is about to run a tool | Reads and Muse-internal tools pass in ~40 ms. A write or shell call is matched against your rules locally. An exact path or command match is denied with no network call. A possible match (for example a keyword rule like "the billing service") goes to a Muse Spark referee that sees only the call, never the agent's reasoning. | Muse Spark 1.3 (referee, ~0.9 s, ~$0.001 per check) |
| Something is denied | The agent gets your sentence, the date and the rule id, plus a read-only `said_no_rules` tool to verify it came from you. It reports back instead of working around it. You can reply `override r1` to allow one call. | |
| A write is allowed | The files it will touch are snapshotted first (new files are recorded as absent). `/undo` or `said-no undo` restores them. | |

Every rule and every denial can be mirrored to [Bilinc](https://bilinc.space) (hosted, versioned memory) so you can see who decided what and when. The mirror is optional and never on the decision path.

## Install (local)

```sh
git clone <this repo> said-no
muse plugins install ./said-no --scope user
muse plugins approve said-no            # Muse asks you to review third-party hooks
mkdir -p ~/.config/said-no && pbpaste > ~/.config/said-no/meta.key && chmod 600 ~/.config/said-no/meta.key
```

The Meta Model API key powers rule extraction and the referee. Without it, Said No still works with exact path and command rules (heuristic extraction, no referee). Optional: `~/.config/said-no/bilinc.key` turns on the Bilinc mirror.

Start a new Muse Code session: hooks load at session start.

## Commands

- In Muse Code: `/rules`, `/undo [step]`, "override r1", "forget rule 1"
- CLI: `said-no rules | why <id> | add "<sentence>" | forget <id> | steps | undo [step] | decisions | budget`

## Design choices

- **Fail open, except where it matters.** Any internal error returns `{}` (allow), so Said No can't wedge your agent. If the referee is unreachable, a destructive shell command on a protected thing is denied; everything else is allowed and logged.
- **Never `allow`, never `ask`.** Returning `permissionDecision: "allow"` would skip Muse Code's own approvals. `ask` is let through unprompted in headless runs.
- **Rules come only from what you type.** Tool output and file contents are never a rule source, so a README can't plant one.
- **Standard mode only.** Paths and commands are sent to `muse-spark-1.3`, not a Contributor-mode model.
- **Local state.** Rules: `~/.config/said-no/`. Snapshots and the decision ledger: `~/.local/share/said-no/`. Nothing is written into your repo.
- **Spend cap.** Every model call is metered in `~/.config/said-no/budget.json`; calls stop at the cap.

## What was built during the hackathon

Everything in this repository was written from Oct 27, 2026: the hooks, matcher, referee, snapshots, MCP server, CLI and tests. Bilinc, the hosted memory service the optional mirror talks to, existed before the hackathon and is used only through its public API.

## Tests

```sh
npm test    # offline: matcher, capture fallback, deny/allow/undo, override/forget, Bilinc mirror against a local stub
```
