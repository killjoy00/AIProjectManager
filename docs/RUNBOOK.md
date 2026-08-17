# Runbook

Setup, day-two operations, and what to do when something breaks.

---

## 0. Before anything deploys — the unrecoverable step

The live site at `ideas.planitnow.us` holds your real idea list. **Export it first.**

1. Open `ideas.planitnow.us`, unlock, hit **Export**. Save the JSON somewhere durable.
2. Then open DevTools → Application → Local Storage → `https://ideas.planitnow.us` and look for
   a key named **`ai-ideas:v1`**.

Why step 2: the currently deployed app only reads `ai-ideas:cache` and `ai-ideas:pass`. If an
older build ever wrote `ai-ideas:v1`, that data is **invisible to the Export button** — you'd
back up the new list and silently lose the old one. If the key exists, copy its value by hand.

`GET /api/ideas` still serves the old KV list after this rewrite, so the export path keeps
working. Nothing deletes it.

---

## 1. What you need to create

### GitHub

| Thing | Where | Notes |
|---|---|---|
| Make repo public | Settings → General → Danger Zone → Change visibility | Gives unlimited Actions minutes |
| Default branch | Settings → General → Default branch → `main` | **Scheduled workflows only run on the default branch.** If this points at a feature branch, agents run from unreviewed code. |
| Labels | Actions → **setup** → Run workflow → `labels` | Idempotent, safe to re-run |
| Fine-grained PAT | Settings → Developer settings → Personal access tokens → Fine-grained | See scopes below |

> **No local terminal needed for any of this.** The `setup` workflow runs the label creation from
> the Actions tab. For the Claude token, see "Getting the Claude token without a terminal" below.

**PAT scopes** — all 8 repos; `Contents: Read`, `Metadata: Read`, `Issues: Read and write`.
Nothing else. It cannot push code and cannot touch Cloudflare or DNS.

### Cloudflare

| Thing | Where | Notes |
|---|---|---|
| API token | dash.cloudflare.com → My Profile → API Tokens → Create | `Account → Cloudflare Pages: Edit` **and** `Account → Workers KV Storage: Edit`. **No DNS scope** — agents must never hold anything that can touch DNS. |
| Account ID | Pages project → right sidebar | |
| Pages project name | Workers & Pages → your project | Exact name, used by the deploy workflow |

### Repository secrets — Settings → Secrets and variables → Actions → **Secrets**

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | from above |
| `CLOUDFLARE_ACCOUNT_ID` | from above |
| `GH_API_TOKEN` | the fine-grained PAT |
| `CLAUDE_CODE_OAUTH_TOKEN` | see below — no local terminal required |
| `HEARTBEAT_SECRET` | any long random string — generate with `openssl rand -hex 32` |

### Getting the Claude token without a terminal

`claude setup-token` needs a shell, but it doesn't have to be your machine. Use a Codespace:

1. Repo → green **`< > Code`** → **Codespaces** → **Create codespace on main**
2. In its terminal: `npm install -g @anthropic-ai/claude-code`
3. `claude setup-token` — open the URL it prints, approve, paste the code back
4. Copy the `sk-ant-oat…` value straight into the repo secret. Never paste it anywhere else.
5. Delete the codespace at https://github.com/codespaces

**These tokens expire.** When the scheduled runs start failing with an auth error, repeat this —
it's the single most likely cause of a dead machine, and `report-failure.mjs` names it first.

**Alternative: an API key.** https://console.anthropic.com → API keys → Create key, stored as
`ANTHROPIC_API_KEY` instead. Entirely browser-based, but metered per token rather than drawn
from a subscription. If you switch, set a monthly cap in the console and restore the ceiling
language in `docs/WEEKLY-BRIEF.md` §5 (see §7 below). Both workflows accept either credential.

### Repository variables — same page, **Variables** tab

| Name | Value |
|---|---|
| `CF_PAGES_PROJECT` | your Pages project name |
| `HEARTBEAT_URL` | `https://ideas.planitnow.us/api/heartbeat` |

### Cloudflare Pages environment variables

**This is a dashboard step, not a CLI one.** Workers & Pages → your project → Settings →
Variables and Secrets → Production.

| Name | Value |
|---|---|
| `GH_API_TOKEN` | the same fine-grained PAT (mark as **Secret**) |
| `GH_OWNER` | `killjoy00` |
| `GH_REPO` | `AIProjectManager` |
| `HEARTBEAT_SECRET` | the same random string (mark as **Secret**) |

Leave `APP_PASSPHRASE` and the `IDEAS_KV` binding exactly as they are — both already work.

> **Bindings only apply to deployments created after they exist.** After adding these, trigger a
> new deployment (push, or re-run the deploy workflow) or the Function will return
> `gh_token_not_bound`.

> **Production and Preview are separate environments.** Variables and bindings set on Production
> do *not* apply to preview deployments. A preview with none of them set returns 401 from
> `/api/dashboard` (unset `APP_PASSPHRASE` fails the check the same way a wrong one does) and
> 500 `kv_not_bound` from `/api/ideas`. To exercise the API on a preview URL before merging,
> add the same four variables **and** the `IDEAS_KV` binding to the Preview environment too.

### The project is named `ideatracker`, not `ideas`

`ideas.planitnow.us` is a custom domain attached to a Pages project called **`ideatracker`**.
Deploying to `ideas` fails with `The Pages project "ideas" does not exist`.

`deploy.yml` no longer depends on anyone remembering this: it asks Cloudflare which project
serves `CF_PAGES_DOMAIN` (default `ideas.planitnow.us`) and deploys to that. `CF_PAGES_PROJECT`
is honoured only when it names a project that actually exists, so it still works as an override.

### ⚠️ Two things deploy to this Pages project

The `ideatracker` project is **Git-connected** (the setup notes said Direct Upload — they were
wrong). So it has two deploy sources:

1. its connected Git repo, which deploys on push, and
2. this repo's `deploy.yml`, via `wrangler pages deploy`.

Whichever ran last wins. **A push to the connected repo will overwrite the dashboard.** Pick one
source before relying on production: disconnect the Git integration, move the dashboard into the
connected repo, or stand up a separate Pages project on its own subdomain.

---

## 2. Deploy model

The existing Pages project was created by Direct Upload. Cloudflare **cannot** convert a Direct
Upload project to Git-connected — so instead of moving the custom domain (and touching DNS), the
`deploy` workflow runs `wrangler pages deploy` against the existing project.

- Push to `main` → production → `ideas.planitnow.us`
- Push to any other branch → a preview URL, production untouched
- Missing Cloudflare secrets → the workflow **skips with a warning** rather than failing

`wrangler pages deploy public` compiles `functions/` from the repo root. The dashboard's
drag-and-drop uploader cannot do this — that's the gotcha that cost time before.

---

## 3. Weekly rhythm

| When | What | Where |
|---|---|---|
| **Sun 21:17 CT** | `portfolio-sweep` — reads every `active`/`hot` project's source, rewrites the status board, posts findings, then writes the weekly brief | status board + issue comments + a `brief` issue |
| Mon 02:33 CT | Second attempt — no-ops if the Sunday run already succeeded | — |
| **Wed + Fri 02:17 CT** | `portfolio-checkin` — light. Catches what changed, and gets a handoff packet out for anything approved midweek | issue comments, often none |
| Any time | Quick capture | dashboard → new `background` issue |

Three scheduled runs a week, not seven. The manager's job is to find work, not do it — and the
Claude subscription it runs on is the same one your build sessions draw from, so a nightly cadence
was spending quota on the wrong half of the system.

### What the check-ins are for

They are deliberately narrow, and **a check-in that posts nothing is working correctly.** They:

- produce a handoff packet when you `/build` something midweek, so you aren't waiting until Sunday
- answer a question you left on a project issue
- notice a project that just broke or just stopped

They do **not** read project source, rewrite the status board, propose ideas, or file spinoffs —
all of those need the full source reading that only Sunday does. A check-in reasoning about code it
cannot see is exactly the confident-guess failure `CLAUDE.md` forbids.

## 3a. The status board

The Sunday sweep rewrites one rolling issue titled **📊 Portfolio status** with the current state of
every `active`/`hot` project: a state (`healthy` / `needs-attention` / `blocked` / `drifting`),
what changed, the top finding with a cited file path, and what needs you. It carries the `system`
label, so it never counts against the active/hot cap.

It is rendered at the top of the dashboard's left column — you should not need to open the issue.

**It is a board, not a log.** Each sweep replaces it wholesale. History lives in the project issues
and the weekly briefs.

The board is an issue rather than a file in this repo for a structural reason: the agents hold no
write credentials and cannot commit anything. Issues are the only place the posting scripts can
write. See §5.

## 3b. Handoff packets — how work actually gets done

The manager does not build. When you comment `/build` on an issue, the next run posts a **handoff
packet** on it: a copy-pasteable block naming the repo and branch, the problem, cited evidence,
what "done" looks like, what's out of scope, and known traps.

Paste it into a fresh Claude Code session that has repo access. That session does the work and
opens a PR. The packet restates gate 3 inside itself, so a session that never reads `CLAUDE.md`
still knows not to self-merge.

At most two packets per run. A packet is not re-posted once it exists on an issue.

## 3c. The idea bench

The sweep also proposes **1–3 new project ideas** per run — never zero. They go to a single rolling
issue titled **💡 Idea bench**, never to a project issue and never as new issues of their own —
an idea nobody asked for should not cost a triage decision. It carries the `system` label, so it
is excluded from the project list and never counts against the active/hot cap.

The brief harvests from the whole bench and surfaces **at most three** in section 6. Check-ins add
nothing to the bench: idea generation on a run that read no source is noise.

**It always returns something.** Both prompts require at least one idea, and an empty section in
the brief is rendered as a gap with a warning rather than as a legitimate "nothing this week".

### How it learns

Reacting on the bench is the whole mechanism. One line is enough — *"more like this"*,
*"never again"*, *"good but not now"*.

Each sweep reads every reaction you have ever left there, plus a distilled
**"What the agent has learned about your taste"** section kept in the bench issue body, and
rewrites that section from what it now believes. Keeping the distillation in the body rather than
re-deriving it each run means it compounds instead of decaying, and it stays visible.

**You can edit that section by hand.** If it has drawn the wrong conclusion, correcting it there
is the fastest way to fix future suggestions — the agent reads your version back on the next run
and treats it as authoritative. Only the region between the `apm:learning` markers is rewritten,
so anything you write around it survives.

Saying nothing teaches it nothing: with no reactions, it keeps guessing from your charters alone.
**Turning it off:** close the bench issue. Nothing recreates it unless the agent has ideas to
post, and it will simply reopen a fresh one — so if you want it off for good, say so in
`docs/prompts/portfolio-sweep.md` instead.

Section 6 is an addition beyond `docs/WEEKLY-BRIEF.md`, which is kept verbatim to spec. It sits
last deliberately: nothing above it should be pushed down the page by ideas nobody asked for.

Schedules are anchored to CDT (UTC-5). November–March they fire an hour earlier. Deliberately
not corrected for — nothing in this system is time-sensitive.

**Both crons deliberately avoid :00.** GitHub delays scheduled workflows under load, and the top
of the hour is the most contended minute; their docs recommend scheduling off the hour. The first
real scheduled run was set for 07:00 UTC and had not started 31 minutes later, so the crons
moved to `:17` and `:23`.

A late scheduled run is normal and is **not** a failure — GitHub gives no guarantee of
punctuality, only that it fires eventually. The dashboard reflects this: it goes amber after 8
days without a sweep, not after 30 minutes. Do not go looking for a bug because a run is an hour
late.

### "You've hit your org's monthly spend limit"

**This almost certainly is not a spend limit.** It is a known misnomer in Claude Code 2.1.119+
for an exhausted five-hour subscription usage window, reported the same way whether or not you
have an org or any billing ceiling at all. It clears by itself when the window refreshes.
Tracked upstream in Claude Code issues #52908, #52960 and #52679.

Observed here on 2026-08-10: the 08:24 UTC run died with that message and the same credential
worked fine at 12:40 — about four hours later, with nobody touching any setting.

The schedule handles this: two attempts a day in different windows, and the second no-ops when
the first succeeded. A window exhaustion on the first attempt **does not** open a
`blocked:human` issue — only the day's final attempt escalates, because that label has to keep
meaning "a human is actually needed."

If both attempts fail this way, the ceiling is genuinely too low even for a weekly sweep.
Real options then: check https://claude.ai/settings/usage, or switch to `ANTHROPIC_API_KEY` with
a hard cap set in the console — both workflows already accept either credential, so it is a
secret swap rather than a rewrite.

### Your side of the gates

1. Idea → spike: automatic.
2. Spike → build: **comment `/build`** on the issue. Nothing crosses this on its own.
3. Build → merge: **you review the PR.** Never self-merged.
4. Merge → deploy: automatic.

---

## 4. Adding a project

1. Quick capture from the dashboard, or open an issue directly.
2. Set the first line of the body to `Repo: killjoy00/<name>` — or `Repo: none` if there's no
   code yet. The agents parse this line to find the project.
3. Paste `docs/CHARTER-TEMPLATE.md` into the body and fill it in — **including kill criteria**.
4. Swap `background` → `active`.

A project with no kill criteria is not ready to leave `background`. The dashboard flags this
under "Waiting on you," and the sweep calls it out.

**If the code was built in a different Claude session,** use
[`docs/CHARTER-HANDOFF.md`](CHARTER-HANDOFF.md) — a prompt to hand that session so it writes the
charter from the actual code and returns it in the right shape. A charter written from reading
the source beats one written from reading a deployed page; issue #6's scoring section is flagged
as unverified precisely because it was done the weaker way.

**Cap: 10 issues may hold `active` or `hot`.** Go over and `portfolio-check.mjs` files a
`blocked:human` issue listing your coldest projects. It doesn't block the run — it just makes it
impossible to miss.

---

## 4b. How the agent sees project code

Each night, after collecting context, `scripts/fetch-project-repos.mjs` shallow-clones the repo
named in the `Repo:` line of every `active`/`hot` issue into `.projects/<name>/`. The agent reads
those with Glob/Grep/Read.

This matters: without it the agent gets only metadata (last push, open PR count) and has to guess
at code it cannot see — the exact failure mode `CLAUDE.md` calls confident, plausible garbage.
The prompt requires it to cite a file path for any factual claim about a codebase, and to say
plainly when source is missing rather than guess.

Access comes from `GH_API_TOKEN`, the fine-grained PAT, which already covers all 8 repos with
`Contents: Read`. **If you add a project in a repo the PAT does not cover, update the PAT's
repository list** or the clone fails — the run continues, and `.projects/INDEX.json` records why.

Guardrails: only repos owned by `GH_OWNER` are ever cloned, at most 12 per run, shallow and
single-branch, with `.git` deleted afterwards so no token survives in the checkout. The agent has
no shell and no credentials, so it can never fetch anything itself — this step decides what it is
allowed to see.

### Giving a Claude Code session access to a project repo

Separate from the agent. An interactive session (like the one that set this up) reaches GitHub
through the Claude GitHub App, which is installed per-repository. If a session says
*"you don't have access to killjoy00/<repo>"*, grant it at
**https://github.com/settings/installations** → the Claude app → **Repository access** → add the
repo. This is unrelated to `GH_API_TOKEN` and does not affect the scheduled runs.

## 4c. Revisiting kill criteria

Kill criteria written on day one are a guess. To schedule a rethink, put a line anywhere in the
charter:

```
Review kill criteria by: 2026-09-10
```

Once that date passes, the project appears under **Waiting on you** on the dashboard, and the
weekly brief is required to raise it in DRIFT with a concrete recommendation — keep the
thresholds, change them to specific new numbers, or kill the project. "Worth revisiting" is
explicitly not an acceptable answer.

Update or delete the line once you've reviewed it, or it keeps nagging — which is the point.

This is a convention, not part of `docs/CHARTER-TEMPLATE.md`; that file is kept verbatim to spec.

## 5. Security model

The agents hold **no write credentials**. Each run is three stages:

1. `collect-context.mjs` (has a token) → `.agent/context.json`
2. `claude` (no token, no `Bash`, no `gh`) → reads that file, writes `.agent/sweep.json`
3. `post-sweep.mjs` (has a token) → validates and posts

Every issue number in the model's output must appear in the allowlist from stage 1. So the worst
case for a fully manipulated model is a bad comment on one of your own issues — it cannot push
code, open a PR, or reach Cloudflare.

Because the repo is public, anyone can open an issue. **Only issues you authored are treated as
projects.** Third-party issue bodies are never sent to the model at all; third-party *comments*
on your issues are sent wrapped as untrusted data with explicit instructions to treat them as
information, never as commands.

---

## 6. When it breaks

### "The dashboard says the machine is down"

Check the linked run log first. In order of likelihood:

1. **`CLAUDE_CODE_OAUTH_TOKEN` expired.** These do expire. Re-run `claude setup-token` and update
   the secret.
2. **The schedule stopped firing.** GitHub silently disables scheduled workflows after 60 days
   of repo inactivity. The Actions tab will say so, with a button to re-enable.
3. **A secret is missing or was rotated.**

### "The dashboard shows `gh_token_not_bound`"

`GH_API_TOKEN` isn't set in **Cloudflare Pages** env vars, or it was added after the current
deployment. Add it, then redeploy.

### "The dashboard shows `kv_not_bound`"

The `IDEAS_KV` binding is missing from the Pages project. If the settings UI says *"Variables
cannot be added to a Worker that only has static assets,"* the Functions deploy hasn't landed —
fix the deploy, don't fight the settings screen.

### "Nothing failed but nothing happened either"

That's the case the heartbeat exists for. Two independent signals:

- The dashboard health strip goes amber after 8 days without a sweep.
- Any failed run files a `blocked:human` issue, which emails you via GitHub.

If both are quiet and no comments appeared, the agent ran and decided there was nothing to do —
check the run artifacts (`.agent/` is uploaded on every run, kept 14 days).

### Testing the alerting path

Actions → portfolio-sweep → Run workflow → tick **simulate_failure**. You should get a
`🔴 portfolio-sweep failed` issue labeled `blocked:human`. Close it afterwards.

Note that `portfolio-checkin` deliberately does **not** file a `blocked:human` issue when it fails
on an exhausted Claude usage window — losing one light run needs no human, and that label has to
keep meaning a human is actually needed. Real failures there (a missing secret, a broken script)
still file. Either way §5 of the weekly brief lists every failed run.

There's also a **dry_run** input on both workflows: runs the agent, prints what it *would* post,
posts nothing. `portfolio-sweep` additionally takes a **stage** input (`both` / `sweep` / `brief`)
so the brief can be re-run on its own without redoing the source reading.

### Running the self-test

`npm test` (`scripts/selftest.mjs`) exercises the pure logic — status-board rendering, handoff
packet formatting, and the gate that decides whether a packet may be posted at all. No token and no
network. Run it after touching anything under `scripts/lib/`.

It cannot cover the parts that call GitHub: this sandbox's `GITHUB_TOKEN` is a proxy placeholder
that Node's `fetch` rejects, so those paths are only exercised in Actions. See
`docs/FAILURE-MODES.md`.

---

## 7. Known divergence from spec

`docs/WEEKLY-BRIEF.md` §5 says "Tokens and Actions minutes used this week, against the monthly
ceiling." That file is kept verbatim as written. The implementation differs deliberately, because
two of its assumptions no longer hold:

- Agents authenticate with a **Claude subscription token**, so there is no per-token dollar cost.
- The repo is **public**, so Actions minutes are unmetered — there is no ceiling to report against.

So §5 reports what can actually be measured: run outcomes, wall-clock minutes as a
week-over-week trend, and truncation pressure (runs that hit their timeout). If either
assumption changes — going private, or switching to an API key — restore the ceiling language
and set one in the workflow config.
