# Failure modes

Specific ways this portfolio has been burned. Each one cost real time, and each one looked like
correct output at the moment it happened.

Read this before trusting a reading. `CLAUDE.md` points here from its failure-behavior rules, and
the sweep prompt requires naming anything from this list that applies to a handoff packet.

**They are nearly all the same shape:** read something, state it confidently, and it was true of
the wrong branch, the wrong build, or a cached copy. The output was never obviously wrong — that
is what made it expensive.

---

## A repo's default branch is not necessarily the branch that ships

Foodfinder's default branch was once a leftover `claude/*` branch, diverged from `main` by whole
files. Every clone silently got it. Two nights of agent analysis described undeployed code, and
"corrected" the charter's correct citations into wrong ones.

**Fixed by:** `scripts/fetch-project-repos.mjs` clones `--branch main` by name and reports
default-branch drift into `.projects/INDEX.json`.

**Still your job:** when a claim could differ between branches, say which branch it is true of.
Handoff packets have an `evidence` field precisely so a build session can tell.

## jsdom has no layout engine

Three rounds of passing tests were structurally blind to a real mobile bug: the page scrolled
sideways because a CSS grid child refused to shrink below its content width — grid items default to
`min-width: auto`. Every test passed. The bug was visible to anyone who opened the page on a phone.

**A DOM without layout cannot see a layout bug.** For anything visual, render it:

- Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
- Use `playwright-core` with an explicit `executablePath`
- **Serve over HTTP.** `page.setContent()` leaves the URL at `about:blank`, so relative `fetch`
  calls fail and the page renders in a state the owner will never see.
- Check `document.documentElement.scrollWidth` against `window.innerWidth` at a phone viewport.

The same blindness applies to markdown: the dashboard implements its own small renderer (`md()` in
`public/index.html`), which supports `*asterisk*` emphasis but **not** `_underscore_` emphasis. Text
that renders correctly on GitHub can render with literal underscores on the dashboard. Anything
written for both has to be checked in both.

## A cached tab looks exactly like a failed deploy

The dashboard stamps the deployed commit in its header (`build <sha>`, sed'd in by `deploy.yml`).
**Check it before debugging anything.** More than one "the deploy is broken" investigation has
ended at a stale tab.

Corollary for the Pages Function: when renaming a field in `/api/dashboard`, keep the old name as
an alias for a release. A cached `index.html` meeting a new Function otherwise renders blanks,
which looks identical to a dead backend.

## Cloudflare Pages bindings only apply to later deployments

Adding an environment variable or a KV binding does nothing to deployments that already exist.
After adding one, redeploy — or the Function keeps returning `gh_token_not_bound`.

Production and Preview are separate environments. A preview with none of them set returns 401 from
`/api/dashboard` and 500 `kv_not_bound` from `/api/ideas`, which reads as broken code.

## This sandbox's GITHUB_TOKEN is a proxy placeholder

It is roughly 12 characters. `curl` gets real credentials swapped in by the proxy; Node's `fetch`
gets `401 Bad credentials`.

**Scripts that call the GitHub API with `fetch` cannot be tested in an interactive sandbox.** They
work in Actions. Do not conclude the code is broken, and do not "fix" it in response.

What *can* be tested here: pure rendering functions, JSON shaping, YAML validity, and anything
driven through a real browser. Prefer writing code so the untestable part is a thin edge.

## "You've hit your org's monthly spend limit" is not a spend limit

It is a known misnomer in Claude Code 2.1.119+ for an exhausted ~5-hour subscription usage window,
reported the same way whether or not you have an org or any billing ceiling. It clears by itself.
Tracked upstream in Claude Code issues #52908, #52960 and #52679.

Observed 2026-08-10: the 08:24 UTC run died with that message; the same credential worked at 12:40.

**"You've hit your weekly limit" is the real weekly cap.** Different failure, same shape.

The schedule handles the first: the Sunday sweep makes a second attempt in a later window, and
`report-failure.mjs` only escalates a quota failure to a `blocked:human` issue on the final attempt
— that label has to keep meaning a human is actually needed.

## Cron is UTC, and "Sunday night" is Monday in UTC

The sweep runs 21:17 US Central on Sunday, which is `17 2 * * 1` — day-of-week **1**, not 0. Using
0 fires it a day early, every week, silently.

Schedules are anchored to CDT (UTC-5); November–March they land an hour earlier. Deliberately not
corrected for — nothing in this system is time-sensitive.

Both crons avoid `:00`. GitHub delays scheduled workflows under load and the top of the hour is the
most contended minute; their own docs recommend scheduling off it. The first scheduled run here was
set for 07:00 UTC and had not started 31 minutes later.

**A late scheduled run is not a failure.** GitHub guarantees only that it fires eventually.

## The model echoes back the formatting it reads

Comment markers, dated headers and footers are added by the posting scripts, not the model. But the
model reads past comments from the context file and copies what it sees, producing comments with
their header printed twice. `stripAgentStamps()` in `scripts/lib/github.mjs` removes them.

**Its pattern list keeps the old header names** (`Nightly triage`) alongside the current ones. Those
headers still exist in issue threads, so the model will keep emitting them. Dropping an old name
when something is renamed silently reintroduces the duplicate-header bug.
