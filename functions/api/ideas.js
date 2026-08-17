// /api/ideas
//
// GET  — legacy read of the old KV idea list. Kept so the pre-existing export path keeps
//        working; the dashboard no longer uses it. Safe to delete once the owner has exported.
// POST — quick capture. The dashboard's one write: creates a real GitHub issue.
//
// Bindings required: IDEAS_KV, APP_PASSPHRASE, GH_API_TOKEN, GH_OWNER, GH_REPO

import { json, authed, gh, ghOwner, ghRepo } from "./_shared.js";

const KEY = "ideas:list";
const MAX_TITLE = 250;
const MAX_WHY = 2000;

async function readStore(env) {
  const raw = await env.IDEAS_KV.get(KEY);
  if (!raw) return { ideas: [], rev: 0 };
  try {
    const p = JSON.parse(raw);
    return { ideas: Array.isArray(p.ideas) ? p.ideas : [], rev: p.rev || 0 };
  } catch {
    return { ideas: [], rev: 0 };
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.IDEAS_KV) return json({ error: "kv_not_bound" }, 500);
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  const store = await readStore(env);
  return json({ ...store, legacy: true, note: "Superseded by GitHub issues. Export-only." });
}

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.GH_API_TOKEN) return json({ error: "gh_token_not_bound" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_json" }, 400); }

  const title = String(body.title || "").trim().slice(0, MAX_TITLE);
  const why = String(body.why || "").trim().slice(0, MAX_WHY);
  if (!title) return json({ error: "title_required" }, 400);

  // Set when an idea is promoted off the bench rather than typed into quick capture. Worth
  // recording on the issue: an idea the agent proposed and the owner promoted is the clearest
  // possible evidence of what to suggest more of, and it should be legible months later.
  const from = Number(body.fromBench);
  const provenance = Number.isInteger(from) && from > 0
    ? `Promoted from the idea bench (#${from}) — proposed by the portfolio sweep.`
    : null;

  // Every project issue carries the machine-readable repo header the agents parse.
  // `none` is correct here — a freshly captured idea has no code yet.
  const issueBody = [
    "Repo: none",
    "",
    why ? `**Why it's interesting:** ${why}` : "_Captured without a note._",
    "",
    ...(provenance ? [provenance, ""] : []),
    "---",
    "",
    "Captured from the dashboard. This is `background` until it has a charter.",
    "Before moving it to `active`, paste in [`docs/CHARTER-TEMPLATE.md`](../blob/main/docs/CHARTER-TEMPLATE.md)",
    "and fill it out — **including kill criteria**. A charter without kill criteria means the",
    "project isn't ready to start.",
    "",
    "Set `Repo:` above to `owner/name` once code exists."
  ].join("\n");

  try {
    const issue = await gh(env, `/repos/${ghOwner(env)}/${ghRepo(env)}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: issueBody, labels: ["background"] })
    });

    // Bust the dashboard cache so the new issue shows on the next load rather than up to
    // five minutes later.
    if (env.IDEAS_KV) await env.IDEAS_KV.delete("dashboard:cache").catch(() => {});

    return json({ ok: true, number: issue.number, url: issue.html_url, title: issue.title }, 201);
  } catch (e) {
    return json({ error: "github_error", detail: e.message, status: e.status || null }, 502);
  }
}
