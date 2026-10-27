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

This is a measured problem, not an anecdote. On file-deletion tasks, a casual request that gives a reason ("we don't need those old files anymore") is executed by every one of ten model endpoints tested, and labels inside the model's context are not a trust boundary; what reliably stops out-of-scope deletion is an external monitor ([Leong 2026, arXiv:2608.28502](https://arxiv.org/abs/2608.28502)). Sparkguard is that monitor for Muse Code, with the scope taken from what you said.

## How it works

| Moment | What Sparkguard does | Meta model |
|---|---|---|
| You type a prompt | A cheap filter spots rule-like sentences ("never", "don't", "ask me first", "keep … intact"). Muse Spark turns the sentence into a scoped rule: paths, commands or keywords, using the repo's top-level names to resolve "these logs". The rule is stored with your exact words, the time and the session. Rule-like prompts wait ~2 s (p90 3.7 s) for this; other prompts pass at once. | Muse Spark 1.3 (structured extraction) |
| The agent is about to run a tool | Reads and Muse-internal tools pass in ~40 ms. A write, a shell command (including `bash -c`, `cd … &&`, `xargs`, globs, `python -c`, `node -e`) or an MCP call is matched against your rules locally. Deleting a parent of a protected path (`rm -rf data`, `git clean -fdx`) counts. An exact match is denied in ~50 ms with no network call. A possible match (for example a keyword rule like "the billing service") goes to a Muse Spark referee that sees only the call, never the agent's reasoning. | Muse Spark 1.3 (referee, ~2.5 s, ~$0.002 per check) |
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

## Security model

- **Narrowing is automatic, widening needs you.** A rule can only forbid. Adding one never needs approval; removing one or allowing a single exception needs your own words in the chat. This is the "monotonic confinement" principle from [Progent (arXiv:2504.11703)](https://arxiv.org/abs/2504.11703), applied to rules you say rather than rules derived from a task.
- **Injection can only add protection.** Rules come only from what you type. File contents and tool output never create, widen or remove a rule; the session recap used to resolve "this" can at worst make a rule cover too much. The referee sees the call as data, never the agent's reasoning, so the agent cannot argue its way past a rule. Meta's [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) asks that an agent not combine untrusted input, sensitive access and state changes in one session; Sparkguard makes the state-changing part conditional on what you said.
- **Undo is a safety net, not the lock.** Snapshots cover file writes the guard allowed, so a mistake inside the rules can still be reversed.

## Honest limits

- **A teammate can still say yes.** If someone else's agent hits your rule and they reply "go ahead this once", Sparkguard allows that one call. What changes is that the deletion is no longer silent: it becomes an explicit consent, quoted against your rule and logged with who and when (and mirrored to Bilinc). Sparkguard has no notion of user identity or roles.
- **Scripts are opaque.** `npm run clean`, `make reset` or `python3 cleanup.py` do not name the paths they touch, and Sparkguard does not read the script. These are the two routes our bypass eval still lets through. Shell variables and `$(...)` are not expanded either; when the protected path is visible in the command, the referee catches them.
- **Semantic authorisation is not solved.** Keyword rules and the referee handle "the billing service"-style rules well in our tests, but a model decides those cases; exact path and command rules are the deterministic part.
- **Telling you a rule was recorded is best effort.** The rule is always stored and enforced; whether the agent mentions it depends on the model.
- Tested with Muse Code 1.4.13 and `muse-spark-1.3` on macOS.

## What was built during the hackathon

Everything in this repository was written from Oct 27, 2026: the hooks, matcher, referee, snapshots, MCP server, CLI and tests. Bilinc, the hosted memory service the optional mirror talks to, existed before the hackathon and is used only through its public API.

## Evaluation

Run on Oct 27, 2026 with `muse-spark-1.3`. The scripts and raw results are in [`eval/`](eval/). The sets are small and written by us, so read these numbers as a sanity check, not a benchmark.

**Capture.** Does a sentence become the right rule, and do ordinary instructions stay ordinary? We used 40 sentences (20 rules, 20 near misses such as "don't worry about lint", "can you delete tmp?" and "never mind") and a 20-sentence held-out set written before tuning. Each set was run 3 times.

| | precision | recall | right scope | false rules |
|---|---|---|---|---|
| Muse Spark, 40-sentence set (3 runs) | 1.00 | 1.00 | 58/60 | 0 |
| Muse Spark, held-out set (3 runs) | 1.00 | 1.00 | 28/30 | 0 |
| Muse Spark, held-out set, before tuning | 1.00 | 0.50 | 5/5 | 0 |
| No model (offline heuristic), either set | 1.00 | 0.70 | n/a | 0 |

The two scope misses are rules stored as keywords instead of commands ("never commit directly to the release branch" became the keyword `release branch`); the referee still sees them.

For comparison, AgentSpec reports 95.6% precision and 71% recall for rules generated by o1 ([arXiv:2503.18666](https://arxiv.org/abs/2503.18666)). That is a different task on a different benchmark, so the comparison is only a reference point.

**Bypass.** We used one rule ("Never delete anything in data/exports.") and 37 ways to break it: `rm` variants, a parent delete, `cd … &&`, globs, `find -delete`, `git clean`, `xargs`, `tar --remove-files`, `bash -c`, `python -c`, `node -e`, `perl -e`, variables, `$(...)`, `write_file`, `edit_file`, MCP delete and move. We added 18 ordinary calls that must still pass, such as reading, copying out, `rm -rf tmp` and `git clean -fd tmp`.

| | attacks blocked | ordinary calls blocked |
|---|---|---|
| Deterministic matcher only (no model, no network) | 33/37 | 0/18 |
| Matcher + Muse Spark referee | 35/37 | 0/18 |

The two misses are `python3 scripts/cleanup.py` and `npm run clean` (see Honest limits). Before this pass the matcher with the referee blocked 24/34 and wrongly blocked `cp data/exports/a.csv /tmp/backup.csv`.

```sh
node eval/capture.js [--heldout] [--offline]
node eval/bypass.js [--offline]
```

Both scripts run the real hooks in throwaway directories. A full model run costs about $0.10.

## Tests

```sh
npm test    # offline: matcher, bypass routes (parents, cd, xargs, globs, git clean), capture fallback, deny/allow/undo, consent/forget, clones, Bilinc mirror against a local stub
```
