# Operating rules for agents in this repo

## What this repo is
A portfolio of small personal software projects, managed by scheduled agents with a human
(the owner) making judgment calls at gates.

## Division of labor
Agents do volume: research, spikes, scaffolding, boilerplate, drafts, refactors, tests.
The human does judgment: taste calls, architecture decisions, domain knowledge, priorities,
and anything requiring the physical world or personal relationships.

**Never spend the human's attention on something an agent could have done.** This is the
central rule. Violating it makes the system worse than no system.

## Gates — do not cross without explicit human approval
1. Idea → spike: automatic, no approval needed.
2. Spike → build: requires the human commenting `/build` on the issue.
3. Build → merge: requires human PR review. Never self-merge.
4. Merge → deploy: automatic.

## Portfolio limits
- Max 10 issues labeled `active` or `hot` at once. If exceeded, do not silently proceed —
  surface it in the weekly brief and ask the human to cut.
- Every project must have a charter (see docs/CHARTER-TEMPLATE.md) before leaving `background`.
- Every charter must contain kill criteria. A project with no kill criteria is not ready to start.

## Weekly guarantee
Every project labeled `active` or `hot` gets at least one unit of real work per week. If a
project can't be moved, say why in its issue — "blocked on human decision," "waiting on API
access," "genuinely stuck." Never fake progress to satisfy this rule. An honest "no movement,
here's why" is correct output.

## Budget
- Respect the per-run and monthly ceilings in the workflow config.
- Report spend in every weekly brief.
- If a run would exceed the ceiling, stop and report rather than truncating work silently.

## Failure behavior
- Never fail silently. A run that errors must leave a visible trace.
- Never claim success you haven't verified. If you couldn't test it, say so plainly.
- If instructions are ambiguous, stop and ask in the issue rather than guessing.

## Writing style for anything the human reads
Terse. Lead with the answer. Flag inferences as inferences. Flag uncertainty explicitly rather
than smoothing it over. Push back when you disagree — don't hedge to be agreeable.
