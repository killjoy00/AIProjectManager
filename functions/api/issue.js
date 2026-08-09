// /api/issue — the in-app issue view, so reading an agent comment doesn't mean leaving the site.
//
// GET  ?number=N   → issue body, labels, and comments
// GET  ?template=1 → docs/CHARTER-TEMPLATE.md, fetched from the repo so there is one source of
//                    truth for the template rather than a copy drifting in the client
// POST             → { number, action: "status" | "build" | "body", ... }
//
// Every write is passphrase-gated, same as quick capture. The actions are deliberately narrow:
// set a status label, post `/build`, or replace the body. Nothing here can close an issue,
// delete anything, or touch another repo.

import {
  json, authed, gh, ghOwner, ghRepo, labelsOf, statusOf, projectRepoOf, daysSince
} from "./_shared.js";

const STATUS = ["background", "active", "hot", "done"];
const TEMPLATE_PATH = "docs/CHARTER-TEMPLATE.md";
const TRIAGE_MARKER = "<!-- apm:triage -->";
const BRIEF_MARKER = "<!-- apm:brief -->";
const MAX_BODY = 60000;

const bustCache = (env) =>
  env.IDEAS_KV ? env.IDEAS_KV.delete("dashboard:cache").catch(() => {}) : Promise.resolve();

async function getTemplate(env) {
  const owner = ghOwner(env), repo = ghRepo(env);
  const res = await gh(env, `/repos/${owner}/${repo}/contents/${TEMPLATE_PATH}`);
  // Contents API returns base64. atob gives latin1, so decode as UTF-8 properly —
  // the template contains em dashes and curly quotes.
  const bytes = Uint8Array.from(atob(res.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function getIssue(env, number) {
  const owner = ghOwner(env), repo = ghRepo(env);
  const [issue, comments] = await Promise.all([
    gh(env, `/repos/${owner}/${repo}/issues/${number}`),
    gh(env, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`).catch(() => [])
  ]);

  const body = issue.body || "";
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    body,
    labels: labelsOf(issue),
    status: statusOf(issue),
    projectRepo: projectRepoOf(body),
    charterPresent: /##\s*What it is/i.test(body),
    killCriteriaPresent: /##\s*Kill criteria/i.test(body),
    buildApproved: (comments || []).some(
      (c) => c.user?.login?.toLowerCase() === ghOwner(env).toLowerCase() &&
             /(^|\s)\/build(\s|$)/m.test(c.body || "")
    ),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    daysSinceUpdate: daysSince(issue.updated_at),
    comments: (comments || []).map((c) => ({
      id: c.id,
      author: c.user?.login || "unknown",
      at: c.created_at,
      url: c.html_url,
      isAgent: (c.body || "").includes(TRIAGE_MARKER) || (c.body || "").includes(BRIEF_MARKER),
      body: (c.body || "").replace(TRIAGE_MARKER, "").replace(BRIEF_MARKER, "").trim()
    }))
  };
}

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.GH_API_TOKEN) return json({ error: "gh_token_not_bound" }, 500);

  const url = new URL(request.url);

  try {
    if (url.searchParams.get("template")) {
      return json({ template: await getTemplate(env) });
    }
    const number = Number(url.searchParams.get("number"));
    if (!Number.isInteger(number) || number < 1) return json({ error: "bad_number" }, 400);
    return json(await getIssue(env, number));
  } catch (e) {
    return json({ error: "github_error", detail: e.message, status: e.status || null }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.GH_API_TOKEN) return json({ error: "gh_token_not_bound" }, 500);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "bad_json" }, 400); }

  const number = Number(payload.number);
  if (!Number.isInteger(number) || number < 1) return json({ error: "bad_number" }, 400);

  const owner = ghOwner(env), repo = ghRepo(env);
  const base = `/repos/${owner}/${repo}/issues/${number}`;

  try {
    if (payload.action === "status") {
      const next = String(payload.status || "");
      if (!STATUS.includes(next)) return json({ error: "bad_status" }, 400);

      const issue = await gh(env, base);
      // Keep every non-status label (spike:*, blocked:human, …) and swap only the status one.
      const kept = labelsOf(issue).filter((l) => !STATUS.includes(l));
      await gh(env, `${base}/labels`, {
        method: "PUT",
        body: JSON.stringify({ labels: [...kept, next] })
      });
      await bustCache(env);
      return json({ ok: true, status: next });
    }

    if (payload.action === "build") {
      // The spike → build gate from CLAUDE.md. Posting `/build` is the whole approval.
      await gh(env, `${base}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "/build\n\n<sub>Approved from the dashboard.</sub>" })
      });
      await bustCache(env);
      return json({ ok: true, action: "build" });
    }

    if (payload.action === "body") {
      const body = String(payload.body ?? "");
      if (body.length > MAX_BODY) return json({ error: "body_too_long" }, 400);
      await gh(env, base, { method: "PATCH", body: JSON.stringify({ body }) });
      await bustCache(env);
      return json({ ok: true, action: "body" });
    }

    return json({ error: "bad_action" }, 400);
  } catch (e) {
    return json({ error: "github_error", detail: e.message, status: e.status || null }, 502);
  }
}
