// /api/pr — read and act on pull requests without leaving the dashboard.
//
// Merging a PR was the single most frequent thing this system still sent the owner to GitHub for,
// so it is the thing most worth pulling in. The shape mirrors /api/issue: narrow, named actions,
// passphrase-gated, and scoped to repositories this owner owns.
//
// GET  ?repo=o/n&number=N  → one PR: body, files with patches, checks, review threads
// GET  (no number)         → every open PR across the manager repo and the project repos
// POST                     → { repo, number, action: "merge" | "close" | "reopen" | "ready" | "comment" }
//
// The guardrail that matters: `repo` is validated to be owned by GH_OWNER before any call goes
// out, so a tampered request cannot aim these writes at someone else's repository.

import {
  json, authed, gh, ghOwner, ghRepo, projectRepoOf, daysSince
} from "./_shared.js";

const MAX_FILES = 40;
const MAX_PATCH = 12000;      // per file — a giant lockfile diff shouldn't drown the panel
const MAX_TOTAL_PATCH = 90000;
const MAX_COMMENT = 60000;
const MERGE_METHODS = ["squash", "merge", "rebase"];

const bustCache = (env) =>
  env.IDEAS_KV ? env.IDEAS_KV.delete("dashboard:cache").catch(() => {}) : Promise.resolve();

// Only repositories owned by GH_OWNER. Same rule the nightly agent's clone step enforces —
// stated once here so every write below inherits it.
function resolveRepo(env, raw) {
  const fallback = `${ghOwner(env)}/${ghRepo(env)}`;
  const name = String(raw || "").trim() || fallback;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.split("/")[0].toLowerCase() !== ghOwner(env).toLowerCase()) return null;
  return name;
}

// GitHub reports mergeability asynchronously: the first read after a push can come back with
// mergeable: null while it computes. Saying "unknown" is honest; claiming "conflicts" is not.
function mergeState(pr) {
  if (pr.merged) return { state: "merged", canMerge: false, why: "Already merged." };
  if (pr.state === "closed") return { state: "closed", canMerge: false, why: "Closed without merging." };
  if (pr.draft) return { state: "draft", canMerge: false, why: "Draft — mark ready first." };
  if (pr.mergeable === null) {
    return { state: "computing", canMerge: false, why: "GitHub is still computing mergeability — refresh in a moment." };
  }
  if (pr.mergeable === false) {
    return { state: "conflict", canMerge: false, why: "Conflicts with the base branch." };
  }
  if (pr.mergeable_state === "blocked") {
    return { state: "blocked", canMerge: true, why: "A required check or review is outstanding." };
  }
  return { state: "clean", canMerge: true, why: "" };
}

async function checksFor(env, repo, sha) {
  if (!sha) return { total: 0, failing: 0, pending: 0, runs: [] };
  try {
    const res = await gh(env, `/repos/${repo}/commits/${sha}/check-runs?per_page=50`);
    const runs = (res?.check_runs || []).map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      url: c.html_url
    }));
    return {
      total: runs.length,
      failing: runs.filter((r) => ["failure", "timed_out", "cancelled"].includes(r.conclusion)).length,
      pending: runs.filter((r) => r.status !== "completed").length,
      runs
    };
  } catch {
    return { total: 0, failing: 0, pending: 0, runs: [], error: true };
  }
}

async function getPR(env, repo, number) {
  const [pr, files, comments, reviews] = await Promise.all([
    gh(env, `/repos/${repo}/pulls/${number}`),
    gh(env, `/repos/${repo}/pulls/${number}/files?per_page=${MAX_FILES}`).catch(() => []),
    gh(env, `/repos/${repo}/issues/${number}/comments?per_page=50`).catch(() => []),
    gh(env, `/repos/${repo}/pulls/${number}/reviews?per_page=50`).catch(() => [])
  ]);

  // Budget the patches so one enormous file can't push the rest off the response.
  let spent = 0;
  const shown = (files || []).map((f) => {
    let patch = f.patch || "";
    let truncated = false;
    if (patch.length > MAX_PATCH) { patch = patch.slice(0, MAX_PATCH); truncated = true; }
    if (spent + patch.length > MAX_TOTAL_PATCH) { patch = ""; truncated = true; }
    spent += patch.length;
    return {
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch,
      truncated,
      binary: !f.patch && f.status !== "removed"
    };
  });

  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    body: pr.body || "",
    author: pr.user?.login || "unknown",
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    head: pr.head?.ref,
    base: pr.base?.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    filesShown: shown.length,
    files: shown,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    daysOpen: daysSince(pr.created_at),
    merge: mergeState(pr),
    checks: await checksFor(env, repo, pr.head?.sha),
    reviews: (reviews || [])
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({ author: r.user?.login, state: r.state, at: r.submitted_at, body: (r.body || "").slice(0, 4000) })),
    comments: (comments || []).map((c) => ({
      id: c.id,
      author: c.user?.login || "unknown",
      at: c.created_at,
      body: (c.body || "").trim()
    }))
  };
}

async function listPRs(env) {
  const owner = ghOwner(env), repo = ghRepo(env);
  const manager = `${owner}/${repo}`;

  let projectRepos = [];
  try {
    const issues = await gh(env, `/repos/${manager}/issues?state=open&per_page=100`);
    projectRepos = [...new Set(
      (issues || [])
        .filter((i) => !i.pull_request)
        .map((i) => projectRepoOf(i.body))
        .filter(Boolean)
        .map((n) => resolveRepo(env, n))
        .filter(Boolean)
    )];
  } catch { /* the manager repo's own PRs still list */ }

  const targets = [...new Set([manager, ...projectRepos])].slice(0, 12);
  const settled = await Promise.allSettled(
    targets.map((t) =>
      gh(env, `/repos/${t}/pulls?state=open&per_page=20`).then((prs) =>
        (prs || []).map((p) => ({
          repo: t,
          number: p.number,
          title: p.title,
          url: p.html_url,
          author: p.user?.login,
          draft: p.draft,
          base: p.base?.ref,
          updatedAt: p.updated_at,
          days: daysSince(p.created_at)
        }))
      )
    )
  );

  return settled
    .filter((s) => s.status === "fulfilled")
    .flatMap((s) => s.value)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.GH_API_TOKEN) return json({ error: "gh_token_not_bound" }, 500);

  const url = new URL(request.url);
  const repo = resolveRepo(env, url.searchParams.get("repo"));
  if (!repo) return json({ error: "bad_repo" }, 400);

  try {
    const raw = url.searchParams.get("number");
    if (raw === null) return json({ prs: await listPRs(env) });

    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) return json({ error: "bad_number" }, 400);
    return json(await getPR(env, repo, number));
  } catch (e) {
    return json({ error: "github_error", detail: e.detail || e.message, status: e.status || null }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.GH_API_TOKEN) return json({ error: "gh_token_not_bound" }, 500);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "bad_json" }, 400); }

  const repo = resolveRepo(env, payload.repo);
  if (!repo) return json({ error: "bad_repo" }, 400);

  const number = Number(payload.number);
  if (!Number.isInteger(number) || number < 1) return json({ error: "bad_number" }, 400);

  const base = `/repos/${repo}/pulls/${number}`;

  try {
    if (payload.action === "merge") {
      const method = MERGE_METHODS.includes(payload.method) ? payload.method : "squash";
      const res = await gh(env, `${base}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: method })
      });
      await bustCache(env);
      return json({ ok: true, action: "merge", method, sha: res?.sha || null });
    }

    if (payload.action === "ready") {
      // Undrafting is GraphQL-only on the REST v3 surface, so it goes through the GraphQL API.
      const q = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`;
      const pr = await gh(env, base);
      await gh(env, "https://api.github.com/graphql", {
        method: "POST",
        body: JSON.stringify({ query: q, variables: { id: pr.node_id } })
      });
      await bustCache(env);
      return json({ ok: true, action: "ready" });
    }

    if (payload.action === "close" || payload.action === "reopen") {
      await gh(env, base, {
        method: "PATCH",
        body: JSON.stringify({ state: payload.action === "close" ? "closed" : "open" })
      });
      await bustCache(env);
      return json({ ok: true, action: payload.action });
    }

    if (payload.action === "comment") {
      const text = String(payload.body ?? "").trim();
      if (!text) return json({ error: "empty_comment" }, 400);
      if (text.length > MAX_COMMENT) return json({ error: "comment_too_long" }, 400);
      // A PR's conversation tab is the issues endpoint — same thread, different noun.
      await gh(env, `/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: text })
      });
      await bustCache(env);
      return json({ ok: true, action: "comment" });
    }

    return json({ error: "bad_action" }, 400);
  } catch (e) {
    // The dashboard's token was created for issues. Merging needs "Pull requests: Read and
    // write", and a raw 403 here reads as a bug rather than as a permission the owner never
    // granted — so name the fix instead of surfacing the status code.
    if (e.status === 403 || e.status === 404) {
      return json({
        error: "token_scope",
        detail: e.detail || e.message,
        status: e.status,
        hint: "The GitHub token needs \"Pull requests: Read and write\" for this repository. " +
          "Open github.com/settings/personal-access-tokens, tap this token, then Repository " +
          "permissions → Pull requests → Read and write → Save. Editing permissions does not " +
          "change the token's value, so nothing needs updating in Cloudflare and no redeploy " +
          "is needed — just reload this page."
      }, 403);
    }
    return json({ error: "github_error", detail: e.detail || e.message, status: e.status || null }, 502);
  }
}
