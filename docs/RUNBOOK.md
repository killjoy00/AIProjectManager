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
| Labels | `GITHUB_TOKEN=<pat> npm run labels` | Idempotent, safe to re-run |
| Fine-grained PAT | Settings → Developer settings → Personal access tokens → Fine-grained | See scopes below |

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
| `CLAUDE_CODE_OAUTH_TOKEN` | run `claude setup-token` locally |
| `HEARTBEAT_SECRET` | any long random string — generate with `openssl rand -hex 32` |

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

## 3. Daily / weekly rhythm

| When | What | Where |
|---|---|---|
| 02:00 CT daily | Nightly triage — one unit of work per `active`/`hot` project | issue comments |
| Mon 07:00 CT | Weekly brief | new issue labeled `brief` |
| Any time | Quick capture | dashboard → new `background` issue |

Schedules are anchored to CDT (UTC-5). November–March they fire an hour earlier (01:00 and
06:00 CT). Deliberately not corrected for — nothing in this system is time-sensitive.

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
under "Waiting on you," and the nightly agent calls it out.

**Cap: 10 issues may hold `active` or `hot`.** Go over and `portfolio-check.mjs` files a
`blocked:human` issue listing your coldest projects. It doesn't block the run — it just makes it
impossible to miss.

---

## 5. Security model

The agents hold **no write credentials**. Each run is three stages:

1. `collect-context.mjs` (has a token) → `.agent/context.json`
2. `claude` (no token, no `Bash`, no `gh`) → reads that file, writes `.agent/triage.json`
3. `post-triage.mjs` (has a token) → validates and posts

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

- The dashboard health strip goes amber after 30h without a nightly run.
- Any failed run files a `blocked:human` issue, which emails you via GitHub.

If both are quiet and no comments appeared, the agent ran and decided there was nothing to do —
check the run artifacts (`.agent/` is uploaded on every run, kept 14 days).

### Testing the alerting path

Actions → nightly-triage → Run workflow → tick **simulate_failure**. You should get a
`🔴 nightly-triage failed` issue labeled `blocked:human`. Close it afterwards.

There's also a **dry_run** input on both workflows: runs the agent, prints what it *would* post,
posts nothing.

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
