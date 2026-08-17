# Session handoff

Hand this to a Claude Code session that needs to work on the manager itself.

It deliberately carries **no project status**. Status goes stale the day it is written, and this
system now generates it: see "Where the current state lives" below. What is here is the part that
does not change week to week.

Read `CLAUDE.md` first — it governs everything and wins any conflict.

---

## What this is

A personal project-management system for one human (killjoy00, "the owner"). GitHub is the system
of record — one issue per project. Scheduled GitHub Actions run Claude Code headlessly to assess
the portfolio and post findings. A Cloudflare Pages dashboard at https://ideas.planitnow.us is the
owner's interface.

**The manager does not build anything.** It finds problems, tracks state, and packages approved
work as a handoff packet the owner pastes into a separate Claude Code session that has credentials.
That split is the point of the system, not an incidental detail.

The constraint that explains the architecture: **the agent holds no credentials.** It writes a JSON
file; a separate deterministic script validates it against an allowlist and does all the writing. A
fully manipulated model can still only comment on the owner's own project issues.

## Where the current state lives

Do not reconstruct these — read them.

| What | Where |
|---|---|
| Every project's current state, findings, what needs the owner | The **📊 Portfolio status** issue, rewritten each Sunday |
| This week's direction and decisions | The latest issue labeled `brief` |
| Ideas nobody has acted on | The **💡 Idea bench** issue |
| What broke | Open issues labeled `blocked:human` |
| Everything above, in one place | https://ideas.planitnow.us |

## Standing decisions — do not relitigate

- **Subscription token only.** The owner has explicitly refused `ANTHROPIC_API_KEY` and asked not
  to be asked again. Both workflows accept it; do not propose it. When the weekly quota is hit,
  runs fail until reset and the alerting surfaces it — that is accepted behaviour.
- **The owner often works from a phone.** Instructions must be tappable, not "open a terminal".
  There is no local dev environment. Codespaces has worked before.
- **Everything must be doable from the dashboard.** Direct quote: *"I don't want to go to GitHub
  for anything if possible. That's the goal here."* If you write "go to GitHub and…", that's a bug
  to fix, not an instruction to give.
- **Never self-merge.** Gate 3 is human PR review, always.
- Repo is public, author-filtered so only owner-authored issues become projects.

## Infrastructure facts — don't rediscover these

- Manager repo: `killjoy00/AIProjectManager` (public)
- Dashboard: https://ideas.planitnow.us
- Cloudflare Pages project is **`ideatracker`**, NOT "ideas". `deploy.yml` resolves it by domain
  rather than name, deliberately.
- KV namespace `ideas`, id `e10db83346434aa5bd887f5077eda957`, bound as `IDEAS_KV`
- `wrangler pages deploy public` compiles `functions/` from the repo root. The dashboard's
  drag-and-drop uploader cannot do this.
- Foodfinder production: https://foodfinder.planitnow.us — Vercel, deploys from `main`.

Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GH_API_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `HEARTBEAT_SECRET`.
Repo variables: `CF_PAGES_PROJECT`, `CF_PAGES_DOMAIN`, `HEARTBEAT_URL`.
Pages env: `APP_PASSPHRASE`, `GH_API_TOKEN`, `GH_OWNER`, `GH_REPO`, `HEARTBEAT_SECRET`, plus the
`IDEAS_KV` binding.

`docs/RUNBOOK.md` has the full setup and day-two operations. `docs/FAILURE-MODES.md` has the
specific ways this portfolio has been burned — **read it before trusting any reading you take.**

## Schedule

| When | What |
|---|---|
| Sun 21:17 CT | `portfolio-sweep` — deep assessment, status board, weekly brief |
| Mon 02:33 CT | fallback attempt; no-ops if the primary succeeded |
| Wed & Fri 02:17 CT | `portfolio-checkin` — light, catches changes, posting nothing is fine |

Crons are UTC and Sunday night Central is Monday in UTC. See `docs/FAILURE-MODES.md`.

## Repos

- `killjoy00/AIProjectManager` — this system
- `killjoy00/foodfinder` — live, used by 3+ households. Next.js + Expo mobile. `main` is production.
- `killjoy00/polarized` — party game. `polarized/index.html`, `supabase/setup.sql`, privacy page,
  keepalive workflow.
- `killjoy00/BoardgameEngine` — BGG recommender. Empty except a README.

## Verification bar

The owner values honesty about what was and wasn't checked far more than confidence. Every PR body
in this repo has a "Not verified" section. Keep that.

Don't say a thing works because the code looks right. Run it. When something can't be run in the
sandbox, say so and say why — `docs/FAILURE-MODES.md` lists what genuinely cannot be tested here
and what can.
