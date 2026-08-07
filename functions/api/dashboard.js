// GET /api/dashboard — everything the dashboard renders, composed server-side.
//
// Why this exists: browser JS cannot hold a GitHub token, and unauthenticated GitHub calls are
// capped at 60/hour per IP. So the Function proxies GitHub with a token and caches the composed
// response in KV. A cache miss costs ~4 calls plus one per active project repo; with a 5-minute
// TTL that stays far under the authenticated 5,000/hour limit.

import {
  json, authed, gh, ghOwner, ghRepo, labelsOf, statusOf, has, projectRepoOf,
  daysSince, readJsonKey, HEARTBEAT_KEY, CACHE_KEY, CACHE_TTL
} from "./_shared.js";

const CAP = 10;
const STALE_DAYS = 7;
const TRIAGE_MARKER = "<!-- apm:triage -->";
const BRIEF_MARKER = "<!-- apm:brief -->";

// A nightly run that hasn't landed in this many hours means something is wrong.
const NIGHTLY_STALE_HOURS = 30;

const isBrief = (i) => has(i, "brief");
const isSystem = (i) => has(i, "system");
const isProject = (i) => !i.pull_request && !isBrief(i) && !isSystem(i);

function machineHealth(heartbeat, runs) {
  const nightly = heartbeat?.jobs?.["nightly-triage"] || null;
  const brief = heartbeat?.jobs?.["monday-brief"] || null;

  const lastRun = runs.find((r) => /triage/i.test(r.name || ""));
  const stampAt = nightly?.at || lastRun?.created_at || null;
  const hours = stampAt ? Math.max(0, (Date.now() - new Date(stampAt).getTime()) / 3600000) : null;

  let state = "ok";
  let message;

  if (!stampAt) {
    state = "down";
    message = "No nightly run has ever been recorded. The system may not be running at all.";
  } else if (lastRun && ["failure", "timed_out"].includes(lastRun.conclusion)) {
    state = "down";
    message = `Last nightly run ${lastRun.conclusion}.`;
  } else if (hours > NIGHTLY_STALE_HOURS) {
    state = "stale";
    message = `No nightly run in ${Math.floor(hours)}h — it should run daily. ` +
      "GitHub disables scheduled workflows after 60 days of repo inactivity.";
  } else {
    message = `Nightly triage ran ${Math.floor(hours)}h ago.`;
  }

  return {
    state,
    message,
    nightly,
    brief,
    lastNightlyRun: lastRun
      ? { conclusion: lastRun.conclusion, at: lastRun.created_at, url: lastRun.html_url }
      : null,
    history: (heartbeat?.history || []).slice(0, 10)
  };
}

async function repoActivity(env, fullName) {
  try {
    const [repo, pulls] = await Promise.all([
      gh(env, `/repos/${fullName}`),
      gh(env, `/repos/${fullName}/pulls?state=open&per_page=20`)
    ]);
    return {
      fullName,
      lastPush: repo.pushed_at,
      daysSincePush: daysSince(repo.pushed_at),
      openPRs: (pulls || []).map((p) => ({
        number: p.number, title: p.title, draft: p.draft, url: p.html_url, updatedAt: p.updated_at
      }))
    };
  } catch (e) {
    return { fullName, error: e.message };
  }
}

async function build(env) {
  const owner = ghOwner(env);
  const repo = ghRepo(env);

  const [issues, runsRes, comments] = await Promise.all([
    gh(env, `/repos/${owner}/${repo}/issues?state=open&per_page=100`),
    gh(env, `/repos/${owner}/${repo}/actions/runs?per_page=30`).catch(() => ({ workflow_runs: [] })),
    gh(env, `/repos/${owner}/${repo}/issues/comments?sort=created&direction=desc&per_page=30`)
      .catch(() => [])
  ]);

  const runs = runsRes?.workflow_runs || [];
  const heartbeat = await readJsonKey(env, HEARTBEAT_KEY, null);

  const projects = (issues || []).filter(isProject).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    status: statusOf(i),
    labels: labelsOf(i),
    projectRepo: projectRepoOf(i.body),
    charterPresent: /##\s*What it is/i.test(i.body || ""),
    killCriteriaPresent: /##\s*Kill criteria/i.test(i.body || ""),
    updatedAt: i.updated_at,
    daysSinceUpdate: daysSince(i.updated_at),
    commentCount: i.comments,
    author: i.user?.login
  }));

  const live = projects.filter((p) => p.status === "active" || p.status === "hot");

  // Pull PR/push activity for the repos behind live projects only — bounded by the cap.
  const repoNames = [...new Set(live.map((p) => p.projectRepo).filter(Boolean))].slice(0, CAP);
  const settled = await Promise.allSettled(repoNames.map((n) => repoActivity(env, n)));
  const repos = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);

  const openPRs = repos.flatMap((r) =>
    (r.openPRs || []).map((p) => ({ ...p, repo: r.fullName }))
  );

  const waitingOnYou = [
    ...projects.filter((p) => p.labels.includes("blocked:human")).map((p) => ({
      kind: "blocked", label: "Blocked on your decision",
      title: p.title, url: p.url, number: p.number, days: p.daysSinceUpdate
    })),
    ...projects.filter((p) => p.labels.includes("spike:done")).map((p) => ({
      kind: "gate", label: "Spike done — comment /build to proceed",
      title: p.title, url: p.url, number: p.number, days: p.daysSinceUpdate
    })),
    ...openPRs.filter((p) => !p.draft).map((p) => ({
      kind: "pr", label: "PR waiting on your review",
      title: `${p.repo}#${p.number} ${p.title}`, url: p.url, days: daysSince(p.updatedAt)
    })),
    ...live.filter((p) => !p.killCriteriaPresent).map((p) => ({
      kind: "charter", label: "Active without kill criteria",
      title: p.title, url: p.url, number: p.number, days: p.daysSinceUpdate
    }))
  ];

  const agentComments = (comments || [])
    .filter((c) => (c.body || "").includes(TRIAGE_MARKER) || (c.body || "").includes(BRIEF_MARKER))
    .slice(0, 8)
    .map((c) => ({
      url: c.html_url,
      at: c.created_at,
      issue: Number((c.issue_url || "").split("/").pop()) || null,
      excerpt: (c.body || "")
        .replace(TRIAGE_MARKER, "").replace(BRIEF_MARKER, "")
        .replace(/<sub>[\s\S]*?<\/sub>/g, "")
        .trim().slice(0, 240)
    }));

  const weekAgo = Date.now() - 7 * 86400000;
  const recent = runs.filter((r) => new Date(r.created_at).getTime() >= weekAgo);
  const minutes = recent.reduce((sum, r) => {
    const ms = new Date(r.updated_at) - new Date(r.run_started_at || r.created_at);
    return sum + (Number.isFinite(ms) && ms > 0 ? ms / 60000 : 0);
  }, 0);

  const latestBrief = (issues || []).filter(isBrief)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;

  return {
    generated: new Date().toISOString(),
    repo: `${owner}/${repo}`,
    health: machineHealth(heartbeat, runs),
    portfolio: {
      cap: CAP,
      active: projects.filter((p) => p.status === "active").length,
      hot: projects.filter((p) => p.status === "hot").length,
      background: projects.filter((p) => p.status === "background").length,
      total: live.length,
      overCap: live.length > CAP
    },
    waitingOnYou,
    stalled: live
      .filter((p) => (p.daysSinceUpdate ?? 0) >= STALE_DAYS)
      .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate)
      .map((p) => ({
        title: p.title, url: p.url, number: p.number,
        days: p.daysSinceUpdate, status: p.status, repo: p.projectRepo
      })),
    staleAfterDays: STALE_DAYS,
    agentActivity: agentComments,
    spend: {
      windowDays: 7,
      runs: recent.length,
      success: recent.filter((r) => r.conclusion === "success").length,
      failure: recent.filter((r) => r.conclusion === "failure").length,
      timedOut: recent.filter((r) => r.conclusion === "timed_out").length,
      minutes: Math.round(minutes * 10) / 10,
      metered: false,
      note: "Repo is public — Actions minutes are unmetered. Shown as a trend."
    },
    latestBrief: latestBrief
      ? { number: latestBrief.number, title: latestBrief.title, url: latestBrief.html_url, at: latestBrief.created_at }
      : null,
    projects: projects.sort((a, b) => {
      const rank = { hot: 0, active: 1, background: 2, done: 3 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.daysSinceUpdate - b.daysSinceUpdate;
    })
  };
}

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.GH_API_TOKEN) return json({ error: "gh_token_not_bound" }, 500);

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";

  if (!fresh && env.IDEAS_KV) {
    const cached = await readJsonKey(env, CACHE_KEY, null);
    if (cached && Date.now() - new Date(cached.generated).getTime() < CACHE_TTL * 1000) {
      return json({ ...cached, cached: true });
    }
  }

  try {
    const data = await build(env);
    if (env.IDEAS_KV) {
      await env.IDEAS_KV.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: CACHE_TTL * 4 });
    }
    return json({ ...data, cached: false });
  } catch (e) {
    // Serve stale rather than nothing — a slightly old dashboard beats a broken one.
    const cached = env.IDEAS_KV ? await readJsonKey(env, CACHE_KEY, null) : null;
    if (cached) return json({ ...cached, cached: true, stale: true, error: e.message });
    return json({ error: "github_error", detail: e.message, status: e.status || null }, 502);
  }
}
