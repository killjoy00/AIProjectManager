// Spinoff issues: how the agent asks for a second approval on a project that already has one.
//
// `/build` is one flag per issue. When a project accumulates a second piece of work — Foodfinder
// had the enrichment feature and, separately, a fail-open cron guard — the agent has no way to
// ask for approval on the second thing. It stalls, writes "needs its own /build", and the owner
// has no button that can unstick it. That happened once and cost a night.
//
// So the agent may propose a spinoff: a new issue carrying just that piece of work, which gets
// its own gate. One issue, one approval, stays true.
//
// The agent still holds no credentials. It emits a `spinoffs` array; everything below runs in the
// posting script, which validates it the same way comments are validated. The limits are the
// point: a mechanism that lets an agent create issues is a mechanism that can bury the portfolio
// in them.

import {
  OWNER, REPO, gh, createIssue, addComment, listOpenIssues, projectRepoOf, SPINOFF_MARKER
} from "./github.mjs";

// Re-exported so existing importers keep working; the string itself lives in github.mjs with the
// rest of the markers, because the full set has to be knowable from one place.
export { SPINOFF_MARKER };

const MAX_PER_RUN = 1;          // one per run. A flood of small issues is its own failure mode.
const MAX_OUTSTANDING = 3;      // unapproved spinoffs waiting on the owner, across the portfolio
const MAX_TITLE = 120;
const MAX_FIELD = 2000;

export const SPINOFF_LABEL = "spinoff";

const clean = (v, max) => String(v || "").trim().slice(0, max);

// A spinoff inherits its parent's `Repo:` line so the same source is reachable, and carries a
// pointer back so neither issue reads as orphaned.
function spinoffBody({ parent, parentTitle, repo, why, scope, needsApprovalBecause }) {
  return [
    SPINOFF_MARKER,
    `Repo: ${repo || "none"}`,
    "",
    `**Split off from #${parent} — ${parentTitle}.**`,
    "",
    "The sweep found this while assessing that project and judged it needed its own approval",
    "rather than riding along on one already given. This issue exists so it can have one.",
    "",
    "## What it is",
    "",
    why || "_The agent gave no description, which is a defect in its output._",
    "",
    ...(scope ? ["## Scope", "", scope, ""] : []),
    ...(needsApprovalBecause
      ? ["## Why it needed a separate approval", "", needsApprovalBecause, ""]
      : []),
    "---",
    "",
    "**To get it built:** approve `/build` on this issue, and set it to `active` so it enters the",
    "weekly working set. Both controls are in the dashboard panel for this issue. The next run then",
    "posts a **handoff packet** here — a block to paste into a Claude Code session that can build it.",
    "",
    "**To decline it:** close this issue. The agent will not re-propose it.",
    "",
    `<sub>Proposed automatically by the portfolio sweep. Nothing was pushed, and nothing happens until you approve.</sub>`
  ].join("\n");
}

/**
 * Validate and create the spinoffs the model proposed.
 *
 * `allowed` is the same allowlist that gates comments — a spinoff's parent must be a project
 * issue the owner authored, so a manipulated model cannot attach one to an arbitrary issue.
 */
export async function createSpinoffs(spinoffs, { allowed, projects = [] } = {}) {
  const created = [];
  const rejected = [];

  if (!Array.isArray(spinoffs) || !spinoffs.length) return { created, rejected };

  // Existing open issues, fetched once: used both to enforce the outstanding cap and to avoid
  // re-proposing something every single night.
  let open = [];
  try {
    open = await listOpenIssues();
  } catch (e) {
    return { created, rejected: [`could not list open issues (${e.message}) — created none`] };
  }

  const outstanding = open.filter((i) =>
    (i.labels || []).some((l) => (typeof l === "string" ? l : l.name) === SPINOFF_LABEL)
  ).length;

  if (outstanding >= MAX_OUTSTANDING) {
    return {
      created,
      rejected: [
        `${spinoffs.length} spinoff(s) skipped — ${outstanding} already awaiting your approval ` +
        `(cap ${MAX_OUTSTANDING}). Approve or close one first.`
      ]
    };
  }

  const titles = new Set(open.map((i) => (i.title || "").trim().toLowerCase()));

  for (const s of spinoffs) {
    if (created.length >= MAX_PER_RUN) {
      rejected.push(`"${clean(s?.title, 60)}" — over the ${MAX_PER_RUN}-per-run limit`);
      continue;
    }

    const parent = Number(s?.parent);
    const title = clean(s?.title, MAX_TITLE);

    if (!Number.isInteger(parent) || !allowed.has(parent)) {
      rejected.push(`"${title || "(untitled)"}" — parent #${s?.parent} not in allowlist`);
      continue;
    }
    if (!title) {
      rejected.push(`spinoff on #${parent} — no title`);
      continue;
    }
    if (titles.has(title.toLowerCase())) {
      // Reruns would otherwise file the same issue every week forever.
      rejected.push(`"${title}" — an open issue with this title already exists`);
      continue;
    }

    const parentIssue = open.find((i) => i.number === parent);
    const body = spinoffBody({
      parent,
      parentTitle: parentIssue?.title || `#${parent}`,
      repo: projectRepoOf(parentIssue?.body || "") ||
            projects.find((p) => p.number === parent)?.projectRepo || null,
      why: clean(s?.why, MAX_FIELD),
      scope: clean(s?.scope, MAX_FIELD),
      needsApprovalBecause: clean(s?.needsApprovalBecause, MAX_FIELD)
    });

    try {
      // `background` keeps it off the active/hot cap until the owner decides it belongs there.
      // `spike:done` is what makes it appear in the dashboard's "waiting on you" list, since the
      // agent has already done the analysis and the only thing left is the owner's call.
      const issue = await createIssue({
        title,
        body,
        labels: ["background", SPINOFF_LABEL, "spike:done"]
      });

      // Without a pointer from the parent, the spinoff is invisible to anyone reading the project
      // it came from.
      await addComment(
        parent,
        `${SPINOFF_MARKER}\nSplit out **${title}** into #${issue.number} — it needs its own ` +
        `\`/build\`, and this issue's approval does not cover it.\n\n` +
        `<sub>Automated. Nothing was pushed.</sub>`
      ).catch(() => { /* the issue exists either way; the backlink is a courtesy */ });

      created.push({ number: issue.number, title, parent, url: issue.html_url });
      titles.add(title.toLowerCase());
    } catch (e) {
      rejected.push(`"${title}" — could not create (${e.message})`);
    }
  }

  return { created, rejected };
}
