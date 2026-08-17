# AI Project Manager

Control plane for a portfolio of small personal software projects. GitHub issues are the system of
record; a scheduled agent tracks state and finds problems; a weekly brief directs the owner's
limited attention. The projects themselves live in their own repos — this one holds issues,
workflows, and the dashboard.

**This manager does not write code.** It reads every active project, says what is wrong with cited
evidence, and packages approved work as a *handoff packet* — a self-contained block the owner
pastes into a separate Claude Code session that has credentials and opens the PR. Finding the work
and doing the work are deliberately different jobs held by different sessions.

Operating rules for agents: [`CLAUDE.md`](CLAUDE.md).
Setup and day-two ops: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
How this has gone wrong before: [`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md).

## How it works

```
        ┌───────────────────────────────────────────────┐
        │  GitHub issues in this repo = system of record │
        │  one issue per project, labels carry status    │
        └───────────────┬───────────────────────────────┘
                        │
     ┌──────────────────┼────────────────────┐
     │                  │                    │
 portfolio-sweep   portfolio-checkin   dashboard (Pages)
 Sun 21:17 CT      Wed + Fri 02:17 CT  ideas.planitnow.us
     │                  │                    │
 reads every       catches what         shows the machine:
 active project's  changed; posts       status board, health,
 source; writes    nothing when         what's waiting on you,
 the status board  nothing did          portfolio load, spend
 + weekly brief         │
     │                  │
     └────────┬─────────┘
              │
      on an approved issue: a handoff packet
              │
              ▼
   you paste it into a Claude Code session
   that has credentials → it opens a PR
              │
              ▼
        you review and merge
```

## Status labels

| Label | Meaning |
|---|---|
| `background` | Captured. No charter yet, or deliberately parked. Agents do not work it. |
| `active` | Charter written. Agents work it weekly. Counts against the cap of 10. |
| `hot` | Same as active, prioritized. Counts against the cap of 10. |
| `done` | Shipped or closed out. |
| `spike:needed` | Ready for an agent to investigate. |
| `spike:done` | Spike finished, awaiting your `/build` comment to cross the gate. |
| `blocked:human` | Agent stopped; needs a judgment only you can make. Also used for system failures. |
| `brief` | A weekly brief issue. |
| `system` | Machine-generated housekeeping (status board, idea bench, failures, cap warnings). |
| `spinoff` | Work split off an approved project because the approval didn't cover it. Needs its own `/build`. |

**Hard cap: 10 issues may hold `active` or `hot` at once.** `scripts/portfolio-check.mjs`
enforces this and files a `blocked:human` issue when you go over.

## Project issue format

Every project issue starts with a machine-readable header line:

```
Repo: killjoy00/foodfinder
```

Use `Repo: none` for an idea with no code yet. Below that goes the charter — copy
[`docs/CHARTER-TEMPLATE.md`](docs/CHARTER-TEMPLATE.md). A charter with no kill criteria means the
project is not ready to leave `background`.

## Gates

1. Idea → spike — automatic.
2. Spike → build — **you comment `/build`**. That authorises a handoff packet, which the next run
   posts on the issue. Nothing is built until you hand that packet to a build session.
3. Build → merge — **you review the PR**. Never self-merged.
4. Merge → deploy — automatic.

## Security posture

The scheduled agents hold **no write credentials at all**. Each run works in three stages:

1. A deterministic script fetches issue data and writes `.agent/context.json`.
2. Claude Code runs with no `Bash` and no `gh` access, reads that file, and writes a structured
   JSON result.
3. A second deterministic script validates that JSON and posts the comments.

So "comment-only" is structural, not a promise in a prompt — the model never holds a token that
could push code, open a PR, or reach Cloudflare.

Because this repo is public, anyone can open an issue on it. **The agent only processes issues
authored by the repo owner.** Everything else — third-party issues, comments from anyone else —
is passed to the model wrapped as untrusted data: readable for information, never followed as
instructions.
