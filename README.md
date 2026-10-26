# Sparkguard

**Sparkguard remembers the rules you tell Muse Code, stops the tool call that would break one, quotes you back with the date, and undoes the file edits you regret.**

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

| Moment | What Sparkguard does | Meta model |
|---|---|---|
| You type a prompt | A cheap filter spots rule-like sentences ("never", "don't", "ask me first", Turkish forms too). Muse Spark turns the sentence into a scoped rule: paths, commands or keywords. The rule is stored with your exact words, the time and the session. | Muse Spark 1.3 (structured extraction) |
| The agent is about to run a tool | Reads and Muse-internal tools pass in ~40 ms. A write or shell call is matched against your rules locally. An exact path or command match is denied with no network call. A possible match (for example a keyword rule like "the billing service") goes to a Muse Spark referee that sees only the call, never the agent's reasoning. | Muse Spark 1.3 (referee, ~0.9 s, ~$0.001 per check) |
| Something is denied | The agent gets your sentence, the date and the rule id, plus a read-only `sparkguard_rules` tool to verify it came from you. It reports back instead of working around it. If you still want it, just say so ("go ahead this once"). | |
| A write is allowed | The files it will touch are snapshotted first (new files are recorded as absent). `/undo` or `sparkguard undo` restores them. | |

Every rule and every denial can be mirrored to [Bilinc](https://bilinc.space) (hosted, versioned memory) so you can see who decided what and when. With a Bilinc key, each session also pulls the repo's rules at start (~0.5 s), so a rule said on one machine applies on a teammate's machine and in CI. Rules are keyed by the repo's root commit, not its path; Muse Code's own memory is keyed by absolute path, so a fresh clone starts without it. The mirror is optional and never on the decision path.

## Install (local)

```sh
git clone <this repo> sparkguard
muse plugins install ./sparkguard --scope user
muse plugins approve sparkguard            # Muse asks you to review third-party hooks
mkdir -p ~/.config/sparkguard && pbpaste > ~/.config/sparkguard/meta.key && chmod 600 ~/.config/sparkguard/meta.key
```

The Meta Model API key powers rule extraction and the referee. Without it, Sparkguard still works with exact path and command rules (heuristic extraction, no referee). Optional: `~/.config/sparkguard/bilinc.key` turns on the Bilinc mirror.

Start a new Muse Code session: hooks load at session start.

## Just talk to it

There are no commands to learn. Say what you mean, in your own words, in the same chat where you talk to Muse Code:

| You say | Sparkguard does |
|---|---|
| "Never delete these, they are our client archive." (right after the agent listed `data/exports`) | Records a rule protecting `data/exports`. "These" is resolved from what you and the agent were just looking at. |
| "Absolutely never push to main without asking me first." | Records a rule on `git push … main`. |
| "Don't worry about the lint warnings for now." | Nothing. Relaxations, preferences and one-off instructions are not rules. |
| (after a block) "fine, you can delete them this one time" | Allows exactly one call that breaks that rule. The rule stays. |
| "We're done with the archive rule, you can delete exports from now on." | Removes the rule. |
| "Undo your last change." / "Which rules do I have?" | The agent calls the `sparkguard_undo` / `sparkguard_rules` tools. |

Plain-language routing uses Muse Spark. It runs only on messages that look like a rule, a consent or a withdrawal, or a short reply right after a block. Without a Meta key, Sparkguard falls back to explicit paths and commands, "override r1" and "forget rule 1".

For scripts there is also a CLI: `sparkguard rules | why <id> | add "<sentence>" | forget <id> | steps | undo [step] | decisions | budget`.

## Design choices

- **Fail open, except where it matters.** Any internal error returns `{}` (allow), so Sparkguard can't wedge your agent. If the referee is unreachable, a destructive shell command on a protected thing is denied; everything else is allowed and logged.
- **Never `allow`, never `ask`.** Returning `permissionDecision: "allow"` would skip Muse Code's own approvals. `ask` is let through unprompted in headless runs.
- **Rules come only from what you type.** Tool output and file contents are never a rule source, so a README can't plant one.
- **Standard mode only.** Paths and commands are sent to `muse-spark-1.3`, not a Contributor-mode model.
- **Local state.** Rules: `~/.config/sparkguard/`. Snapshots and the decision ledger: `~/.local/share/sparkguard/`. Nothing is written into your repo.
- **Spend cap.** Every model call is metered in `~/.config/sparkguard/budget.json`; calls stop at the cap.

## What was built during the hackathon

Everything in this repository was written from Oct 27, 2026: the hooks, matcher, referee, snapshots, MCP server, CLI and tests. Bilinc, the hosted memory service the optional mirror talks to, existed before the hackathon and is used only through its public API.

## Tests

```sh
npm test    # offline: matcher, capture fallback, deny/allow/undo, override/forget, Bilinc mirror against a local stub
```
