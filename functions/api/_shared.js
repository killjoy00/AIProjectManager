// Shared helpers for the Pages Functions.
// Files prefixed with `_` are not routed by Pages, so this is import-only.

export function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// length-safe comparison so a wrong guess doesn't leak timing info
// (carried over unchanged from the original ideas.js — it was already correct)
export function authed(request, env) {
  const given = request.headers.get("x-auth") || "";
  const expected = env.APP_PASSPHRASE || "";
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Same comparison, for the Actions-only heartbeat secret.
export function heartbeatAuthed(request, env) {
  const given = request.headers.get("x-heartbeat") || "";
  const expected = env.HEARTBEAT_SECRET || "";
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const HEARTBEAT_KEY = "system:heartbeat";
export const CACHE_KEY = "dashboard:cache";
export const CACHE_TTL = 300; // seconds

export const ghOwner = (env) => env.GH_OWNER || "killjoy00";
export const ghRepo = (env) => env.GH_REPO || "AIProjectManager";

// Browser JS can't hold a GitHub token and unauthenticated calls are capped at 60/hr per IP,
// so every GitHub read goes through here, server-side, with the token from Pages env.
export async function gh(env, path, init = {}) {
  if (!env.GH_API_TOKEN) throw new Error("gh_token_not_bound");
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GH_API_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-project-manager-dashboard",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`github_${res.status}`);
    err.status = res.status;
    err.detail = text.slice(0, 300);
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export const labelsOf = (issue) => (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

const STATUS_LABELS = ["background", "active", "hot", "done"];
export const statusOf = (issue) => labelsOf(issue).find((l) => STATUS_LABELS.includes(l)) || "background";

export const has = (issue, label) => labelsOf(issue).includes(label);

// Optional `Review kill criteria by: YYYY-MM-DD` line in a charter. Kill criteria written on
// day one are a guess; this makes revisiting them something the system raises rather than
// something the owner has to remember.
export function reviewDateOf(body) {
  const m = /^\s*Review kill criteria by:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(body || "");
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : m[1];
}

export const reviewOverdue = (iso) =>
  iso ? new Date(iso + "T00:00:00Z").getTime() <= Date.now() : false;

export function projectRepoOf(body) {
  const m = /^\s*Repo:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|none)\s*$/im.exec(body || "");
  if (!m) return null;
  return m[1].toLowerCase() === "none" ? null : m[1];
}

// Clamped at 0 — clock skew between GitHub and the edge would otherwise surface as "-1d".
export const daysSince = (iso) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null;

export async function readJsonKey(env, key, fallback) {
  if (!env.IDEAS_KV) return fallback;
  try {
    const raw = await env.IDEAS_KV.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
