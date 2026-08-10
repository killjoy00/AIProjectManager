// Minimal GitHub REST helper. Used only by deterministic scripts — never exposed to the model.

const API = "https://api.github.com";

export const OWNER = process.env.GH_OWNER || "killjoy00";
export const REPO = process.env.GH_REPO || "AIProjectManager";
export const CAP = Number(process.env.PORTFOLIO_CAP || 10);

// Markers let us tell our own machine-written comments apart from human ones.
export const TRIAGE_MARKER = "<!-- apm:triage -->";
export const BRIEF_MARKER = "<!-- apm:brief -->";
export const SYSTEM_MARKER = "<!-- apm:system -->";

export const STATUS_LABELS = ["background", "active", "hot", "done"];

function token() {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN is not set");
  return t;
}

export async function gh(path, options = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token()}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-project-manager",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });

  if (res.status === 404 && options.allow404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${options.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Follows Link headers so we never silently truncate at 30 items.
export async function ghPaged(path, { max = 500 } = {}) {
  const out = [];
  let url = path.startsWith("http") ? path : `${API}${path}`;
  url += (url.includes("?") ? "&" : "?") + "per_page=100";

  while (url && out.length < max) {
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token()}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "ai-project-manager"
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub GET ${url} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    const page = await res.json();
    // Some GitHub list endpoints (actions/runs, actions/artifacts, search) wrap results in an
    // object instead of returning a bare array. This used to `break`, which silently produced an
    // empty result — that is how the first weekly brief reported "0 runs" for a busy week. Fail
    // loudly instead; a caller for one of those endpoints needs to page it itself.
    if (!Array.isArray(page)) {
      const keys = Object.keys(page || {}).slice(0, 5).join(", ");
      throw new Error(
        `ghPaged: ${url} returned an object, not an array (keys: ${keys}). ` +
        `This endpoint wraps its results — page it directly rather than with ghPaged.`
      );
    }
    out.push(...page);

    const link = res.headers.get("link") || "";
    const next = link.split(",").find((p) => p.includes('rel="next"'));
    url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
  }
  return out.slice(0, max);
}

export const labelsOf = (issue) => (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

export const statusOf = (issue) => labelsOf(issue).find((l) => STATUS_LABELS.includes(l)) || "background";

// `Repo: owner/name` header line at the top of a project issue body. `none` is legitimate —
// a background idea may not have code yet.
export function projectRepoOf(body) {
  const m = /^\s*Repo:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|none)\s*$/im.exec(body || "");
  if (!m) return null;
  return m[1].toLowerCase() === "none" ? null : m[1];
}

// Optional `Review kill criteria by: YYYY-MM-DD` line in a charter. Kill criteria written on
// day one are a guess; this makes revisiting them a thing the system surfaces rather than a
// thing the owner has to remember.
export function reviewDateOf(body) {
  const m = /^\s*Review kill criteria by:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(body || "");
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : m[1];
}

export const reviewOverdue = (iso) =>
  iso ? new Date(iso + "T00:00:00Z").getTime() <= Date.now() : false;

export const isBriefIssue = (issue) => labelsOf(issue).includes("brief");
export const isSystemIssue = (issue) => labelsOf(issue).includes("system");

// A project issue is a real portfolio entry: not a brief, not machine housekeeping.
export const isProjectIssue = (issue) =>
  !issue.pull_request && !isBriefIssue(issue) && !isSystemIssue(issue);

export async function listOpenIssues() {
  const issues = await ghPaged(`/repos/${OWNER}/${REPO}/issues?state=open`);
  return issues.filter((i) => !i.pull_request);
}

export async function listComments(number) {
  return ghPaged(`/repos/${OWNER}/${REPO}/issues/${number}/comments`);
}

export async function addComment(number, body) {
  return gh(`/repos/${OWNER}/${REPO}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

export async function createIssue({ title, body, labels = [] }) {
  return gh(`/repos/${OWNER}/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels })
  });
}

// Find an existing open issue by exact title — used so repeated failures update one issue
// instead of spamming a new one every night.
export async function findOpenIssueByTitle(title) {
  const issues = await listOpenIssues();
  return issues.find((i) => i.title === title) || null;
}

export async function upsertSystemIssue({ title, body, labels }) {
  const existing = await findOpenIssueByTitle(title);
  if (existing) {
    await addComment(existing.number, body);
    return { number: existing.number, created: false };
  }
  const issue = await createIssue({ title, body, labels });
  return { number: issue.number, created: true };
}

// Clamped at 0 — clock skew would otherwise surface as a negative age.
export const daysSince = (iso) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null;
