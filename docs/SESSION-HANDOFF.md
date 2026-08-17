# Session handoff

**Written 2026-08-15. `main` was `8699de3`.**

This is for a Claude Code session picking this project up cold. Read `CLAUDE.md` first — it
governs everything and wins any conflict. This file is context and outstanding work, not rules.

Anything below dated or version-pinned may have moved. Check before relying on it; the section
"How I got things wrong" exists because most errors in this project came from trusting a stale
reading instead of looking.

---

## What this is

A personal AI project-management system for one human (killjoy00, "the owner"). GitHub is the
system of record — one issue per project. A nightly GitHub Action runs Claude Code headlessly,
does one unit of real work per active project, and posts it as an issue comment. A Monday brief
issue summarises the week. A Cloudflare Pages dashboard at **https://ideas.planitnow.us** is the
owner's interface.

The design constraint that explains most of the architecture: **the agent holds no credentials.**
It writes a JSON file; a separate deterministic script validates that file against an allowlist
and does all the writing. A fully manipulated model can still only comment on the owner's own
project issues.

---

## Infrastructure facts

Don't rediscover these.

| Thing | Value |
|---|---|
| Manager repo | `killjoy00/AIProjectManager` (public) |
| Dashboard | https://ideas.planitnow.us |
| Cloudflare Pages project | **`ideatracker`** — not "ideas". `deploy.yml` resolves it by domain rather than name, deliberately |
| KV namespace | `ideas`, id `e10db83346434aa5bd887f5077eda957`, bound as `IDEAS_KV` |
| Pages is Direct Upload | Cannot be converted to Git-connected. `wrangler pages deploy public` works either way and compiles `functions/` |
| Foodfinder production | https://foodfinder.planitnow.us — Vercel, deploys from `main` (verified by probing a route that exists only on `main`) |

**Repo secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GH_API_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `HEARTBEAT_SECRET`.
**Repo variables:** `CF_PAGES_PROJECT`, `CF_PAGES_DOMAIN`, `HEARTBEAT_URL`.
**Cloudflare Pages env:** `APP_PASSPHRASE`, `GH_API_TOKEN`, `GH_OWNER`, `GH_REPO`,
`HEARTBEAT_SECRET`, plus the `IDEAS_KV` binding.

> Pages bindings apply only to deployments created after they exist. After adding one, redeploy or
> the Function returns `gh_token_not_bound`.

**Schedules (UTC):**
- `nightly-triage`: `17 7 * * *`, with a second attempt `33 10 * * *` that no-ops if the first
  succeeded (`scripts/should-run-triage.mjs`, which fails *open*).
- `monday-brief`: `23 12 * * 1`.

---

## Standing decisions — do not relitigate

- **Subscription token only.** The owner has explicitly refused `ANTHROPIC_API_KEY` and asked not
  to be asked again. Both workflows accept it; do not propose it. When the weekly quota is hit,
  runs fail until reset and the alerting surfaces it — that is the accepted behaviour.
- **The owner works from a phone, usually.** Instructions must be tappable, not "open a terminal".
  They have no local dev environment. Codespaces has worked in the past.
- **Everything should be doable from the dashboard.** This is a hard requirement, stated directly:
  *"I don't want to go to GitHub for anything if possible. That's the goal here."* If you catch
  yourself writing "go to GitHub and…", that is a bug to fix, not an instruction to give.
- **Repo is public**, author-filtered so only owner-authored issues become projects.
- **Never self-merge without being asked.** The owner says "merge it" and means it; wait for that.

---

## The gates (from `CLAUDE.md`)

1. Idea → spike: automatic.
2. Spike → build: needs the owner commenting `/build`. The dashboard has a button.
3. Build → merge: human PR review. Never self-merge.
4. Merge → deploy: automatic.

`/build` is **one flag per issue**. When the agent finds work an existing approval doesn't cover,
it may propose a **spinoff** — a new issue with its own gate (`scripts/lib/spinoff.mjs`). Limits:
one per run, three unapproved outstanding portfolio-wide, parent must be in the comment allowlist,
duplicate titles skipped. Spinoffs are bot-authored, so `collect-context.mjs` has an explicit
trust exception keyed on the `spinoff` **label** (labels need write access; the public can open an
issue but cannot label one).

---

## Repos

| Repo | State |
|---|---|
| `killjoy00/AIProjectManager` | This system. `main`. |
| `killjoy00/foodfinder` | Live, in use by 3+ households. Next.js + Expo mobile app. `main` is production. |
| `killjoy00/polarized` | Party game. Now has real source: `polarized/index.html`, `supabase/setup.sql`, privacy page, keepalive workflow. |
| `killjoy00/BoardgameEngine` | BGG recommender. Empty except a README. |

**A branch on foodfinder carries unshipped work.** `claude/clever-pasteur-cez5rz` has bcrypt
password hashing, rate limiting (`lib/rateLimit.ts`), and a production throw guard
(`lib/secret.ts`) that are **not on `main`**. Someone built real security improvements that never
shipped. The owner has not decided what to do with them. This is a live open question.

---

## Issues as of 2026-08-15

**Active:** #7 Foodfinder, #6 Polarized, #4 BGG Recommender (`spike:needed`).
**Background:** #5 Travel Tracker, #8 Media tracker, #9 Credit card bonus tracker, #29 EZ trivia.
**System:** #23 idea bench, #15 `🔴 nightly-triage failed` (`blocked:human`), #16 weekly brief.

Cap is 10 active+hot; currently 3.

---

## Outstanding work

Nothing is blocking. In rough order of value:

1. **Foodfinder v1 enrichment is fully spec'd and unbuilt.** `/build` was given 2026-08-11. The
   agent has spec'd **five** call sites across four nights, the fifth (catalog CSV import via
   `components/ImportClient.tsx` → `importCatalogAction` → `addCatalogEntries`) added 08-15. Nobody
   has written it. This is the largest ready-to-go piece of work in the portfolio.

2. **Two Polarized bugs, re-verified against the real source on 08-15**, neither on the charter's
   original list:
   - A moderator who abandons mid-turn stalls the game permanently.
   - Mid-game joiners can vote with zero effect — `round.order` freezes at `startGame()`, and
     `vote()` has no membership check.

3. **Polarized Gate 0's last item is open:** deploy from the repo instead of Direct Upload.

4. **Polarized keepalive risk:** its Supabase keep-alive is a scheduled GitHub Actions workflow,
   and GitHub disables scheduled workflows after 60 days of repo inactivity. Flagged 08-15.

5. **The unshipped foodfinder security branch** (see Repos above) — a decision, not a task.

6. **Foodfinder kill-criteria review is due 2026-09-10.** Three of its five criteria are marked
   *provisional* and need confirming, changing, or deleting by that date. The brief will raise it.

---

## How I got things wrong — read this before trusting a reading

Most errors in this project were the same shape: read something, state it confidently, and it was
true of the wrong branch, the wrong build, or a cached copy.

- **The wrong-branch disaster.** foodfinder's default branch was a leftover `claude/*` branch that
  had diverged from `main` by whole files. Every clone silently got it. Two nights of agent
  analysis described code that isn't deployed, and "corrected" the charter's *correct* citations
  into wrong ones. Fixed: `fetch-project-repos.mjs` now clones `--branch main` by name and reports
  drift. **A plausible wrong source is worse than no source.**
- **jsdom has no layout engine.** Three rounds of passing tests were structurally blind to a real
  mobile bug (the page scrolled sideways; a CSS grid child refused to shrink below content width).
  Chromium is available at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` — use
  `playwright-core` with an explicit `executablePath`, and serve over HTTP, because `setContent`
  leaves the URL `about:blank` and relative `fetch` calls fail.
- **A cached tab looks exactly like a failed deploy.** The dashboard now stamps the deployed
  commit in its header (`build <sha>`, sed'd in by `deploy.yml`). Check it before debugging.
- **This sandbox's `GITHUB_TOKEN` is a ~12-char proxy placeholder.** `curl` gets real credentials
  swapped in; Node's `fetch` gets `401 Bad credentials`. Scripts using `fetch` against the GitHub
  API cannot be tested here — they work in Actions. Don't conclude the code is broken.
- **"You've hit your org's monthly spend limit"** from Claude Code is a known misnomer for an
  exhausted ~5-hour usage window. **"You've hit your weekly limit"** is the real weekly cap. They
  are different failures with the same shape.

---

## Verification bar

The owner values honesty about what was and wasn't checked far more than confidence. Every PR body
in this repo has a **"Not verified"** section. Keep that.

Concretely: don't say a thing works because the code looks right. Run it. When something can't be
run here, say so and say why.
