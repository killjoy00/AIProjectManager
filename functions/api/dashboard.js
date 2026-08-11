// GET /api/dashboard — everything the dashboard renders, composed server-side.
//
// Why this exists: browser JS cannot hold a GitHub token, and unauthenticated GitHub calls are
// capped at 60/hour per IP. So the Function proxies GitHub with a token and caches the composed
// response in KV. A cache miss costs ~4 calls plus one per active project repo; with a 5-minute
// TTL that stays far under the authenticated 5,000/hour limit.

import {
  json, authed, gh, ghOwner, ghRepo, labelsOf, statusOf, has, projectRepoOf,
  daysSince, readJsonKey, reviewDateOf, reviewOverdue,
  HEARTBEAT_KEY, CACHE_KEY, CACHE_TTL
} from "./_shared.js";

const CAP = 10;
const STALE_DAYS = 7;
const TRIAGE_MARKER = "<!-- apm:triage -->";
const BRIEF_MARKER = "<!-- apm:brief -->";
const IDEA_MARKER = "<!-- apm:idea -->";
const LEARNING_START = "<!-- apm:learning:start -->";
const LEARNING_END = "<!-- apm:learning:end -->";
const BENCH_TITLE = "💡 Idea bench";

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

// The idea bench, unpacked for the dashboard.
//
// The bench only works if the owner reacts to it — the nightly agent distils those reactions into
// the learning section and picks better next time. Leaving the bench visible only on GitHub meant
// the one input the feature depends on lived somewhere the owner didn't want to go, so the whole
// loop sat open. Everything here is read-only; reactions post back through /api/issue's `comment`
// action against the bench's own issue number.
function parseIdeas(body) {
  // postIdeas() in scripts/lib/bench.mjs emits "### <title>" per idea, then prose, then an
  // optional "*Why it fits you:* …" line. Parse that shape back out rather than showing raw text.
  const out = [];
  const parts = (body || "").split(/^###[ \t]+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const title = (nl === -1 ? part : part.slice(0, nl)).trim();
    if (!title) continue;
    const rest = (nl === -1 ? "" : part.slice(nl + 1))
      .replace(/<sub>[\s\S]*?<\/sub>/g, "")
      .trim();
    const fitAt = rest.search(/^\*Why it fits you:\*/m);
    out.push({
      title,
      why: (fitAt === -1 ? rest : rest.slice(0, fitAt)).trim(),
      fit: fitAt === -1 ? "" : rest.slice(fitAt).replace(/^\*Why it fits you:\*/, "").trim()
    });
  }
  return out;
}

async function ideaBench(env, issues) {
  const bench = (issues || []).find((i) => isSystem(i) && i.title === BENCH_TITLE);
  if (!bench) return null;

  const body = bench.body || "";
  const s = body.indexOf(LEARNING_START);
  const e = body.indexOf(LEARNING_END);
  const learning = s !== -1 && e !== -1 && e > s
    ? body.slice(s + LEARNING_START.length, e).trim()
    : "";

  const owner = ghOwner(env).toLowerCase();
  let comments = [];
  try {
    comments = await gh(
      env,
      `/repos/${ghOwner(env)}/${ghRepo(env)}/issues/${bench.number}/comments?per_page=100`
    );
  } catch { /* bench still renders without its comments */ }

  const ideaComments = (comments || []).filter((c) => (c.body || "").includes(IDEA_MARKER));
  const latest = ideaComments[ideaComments.length - 1] || null;
  const ownerNotes = (comments || []).filter(
    (c) => (c.user?.login || "").toLowerCase() === owner
  );
  const lastNote = ownerNotes[ownerNotes.length - 1] || null;

  return {
    number: bench.number,
    url: bench.html_url,
    // A placeholder learning section means the agent has nothing to go on yet. Say that
    // explicitly rather than rendering the placeholder as if it were a finding.
    learning: /^_Nothing learned yet/.test(learning) ? "" : learning,
    at: latest?.created_at || null,
    ideas: latest ? parseIdeas(latest.body) : [],
    batches: ideaComments.length,
    reactions: ownerNotes.length,
    lastReactionAt: lastNote?.created_at || null
  };
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
    reviewBy: reviewDateOf(i.body),
    reviewOverdue: reviewOverdue(reviewDateOf(i.body)),
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
    })),
    ...projects.filter((p) => p.reviewOverdue).map((p) => ({
      kind: "review", label: "Kill criteria due for review (set " + p.reviewBy + ")",
      title: p.title, url: p.url, number: p.number, days: daysSince(p.reviewBy)
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

  const bench = await ideaBench(env, issues);

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
    bench,
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
