// The portfolio status board: one rolling issue whose body is rewritten by every Sunday sweep.
//
// Why an issue and not a file: the agents hold no write credentials to the repo — by design, see
// the security model in docs/RUNBOOK.md. Nothing in this system can commit. So the generated
// status document lives where the deterministic scripts *can* write, which is issues. It carries
// the `system` label, so isProjectIssue() excludes it and it never counts against the active/hot
// cap.
//
// Rewritten wholesale rather than appended to. A status board is current state; a log of every
// state it has ever been in is the thing this replaces.

import { OWNER, REPO, gh, listOpenIssues, stripAgentStamps } from "./github.mjs";

export const STATUS_TITLE = "📊 Portfolio status";

// Only the region between these is rewritten, so anything the owner writes around it survives.
export const STATUS_START = "<!-- apm:status:start -->";
export const STATUS_END = "<!-- apm:status:end -->";

const STATUS_PLACEHOLDER = "_No sweep has run yet._";

// Sorted worst-first: the point of the board is what needs attention, not alphabetical order.
const STATE_ORDER = ["blocked", "needs-attention", "drifting", "healthy"];

const STATE_BADGE = {
  healthy: "🟢 healthy",
  "needs-attention": "🟡 needs attention",
  blocked: "🔴 blocked",
  drifting: "⚪ drifting"
};

const STATUS_BODY = [
  "<!-- apm:system -->",
  "The current state of every `active`/`hot` project, rewritten by the Sunday sweep.",
  "",
  "**This is a board, not a log.** Each sweep replaces it. History lives in the project issues",
  "and in the weekly briefs.",
  "",
  "The manager does not do the work — it finds problems and packages them. When you approve one",
  "with `/build`, the next run posts a **handoff packet** on that project issue: a self-contained",
  "block to paste into a fresh Claude Code session that has credentials and can build.",
  "",
  "---",
  "",
  STATUS_START,
  STATUS_PLACEHOLDER,
  STATUS_END
].join("\n");

export async function findStatus() {
  const issues = await listOpenIssues();
  return issues.find((i) => i.title === STATUS_TITLE) || null;
}

export async function ensureStatus() {
  const existing = await findStatus();
  if (existing) return existing;
  return gh(`/repos/${OWNER}/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: STATUS_TITLE, body: STATUS_BODY, labels: ["system"] })
  });
}

// One line per field, not a table. A five-column table is the right shape for a status board on a
// desktop and the wrong one on a phone: it forces horizontal scrolling, which is the bug this repo
// already fixed once (#27). It also renders correctly in the dashboard, whose markdown subset has
// no table support — so a table would degrade to raw pipes there.
const line = (s, max = 400) =>
  stripAgentStamps(s || "")
    .replace(/\r?\n+/g, " ")   // a newline mid-field would split it into a second visual row
    .trim()
    .slice(0, max);

export function renderStatus(status) {
  const projects = Array.isArray(status?.projects) ? status.projects : [];
  if (!projects.length) {
    return "_The sweep produced no project states. That is a gap in the run, not an empty " +
      "portfolio — check the run log._";
  }

  const sorted = [...projects].sort((a, b) => {
    const ai = STATE_ORDER.indexOf(String(a?.state || "").toLowerCase());
    const bi = STATE_ORDER.indexOf(String(b?.state || "").toLowerCase());
    // Unknown states sort last rather than first — an unrecognised state is not an emergency.
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const out = [];
  if (status.headline) out.push(`**${line(status.headline)}**`, "");

  for (const p of sorted) {
    const state = String(p?.state || "").toLowerCase();
    // An unrecognised state is echoed back rather than flattened to "unknown": the actual string
    // tells the owner the sweep invented a state, which is a defect worth seeing.
    const badge = STATE_BADGE[state] || `❔ ${line(p?.state, 40) || "unknown"}`;
    const named = line(p?.name, 80);
    const ref = p?.issue ? ` (#${p.issue})` : "";

    // Falling back to the issue number as the name and *also* appending the ref printed "#6 (#6)".
    out.push(named ? `**${badge} — ${named}**${ref}` : `**${badge} — ${ref.trim() || "unnamed"}**`);
    // Plain labels, not `_Since:_`. The dashboard's markdown subset implements only *asterisk*
    // emphasis, so underscore italics render as literal underscores there — verified by rendering
    // the page in Chromium, which is the only way to catch this class of thing.
    out.push(`Since: ${line(p?.since) || "not stated"}`);
    out.push(`Finding: ${line(p?.finding) || "none recorded"}`);
    if (p?.needsOwner) out.push(`**Needs you:** ${line(p.needsOwner)}`);
    out.push("");
  }

  const needing = sorted.filter((p) => p?.needsOwner).length;
  out.push(
    `<sub>Updated ${new Date().toISOString().slice(0, 10)} by the Sunday sweep. ` +
    `${projects.length} project(s), ${needing} waiting on you.</sub>`
  );

  return out.join("\n");
}

// Replaces the board region in the status issue body. Same marker-preserving approach as the
// bench's learning section: if the markers are gone (the owner rewrote the body), append rather
// than overwrite so nothing they wrote is lost.
export async function updateStatus(status) {
  const rendered = renderStatus(status);
  if (!rendered) return null;

  const issue = await ensureStatus();
  const body = issue.body || "";

  const s = body.indexOf(STATUS_START);
  const e = body.indexOf(STATUS_END);

  let next;
  if (s === -1 || e === -1 || e < s) {
    next = `${body}\n\n${STATUS_START}\n${rendered}\n${STATUS_END}`;
  } else {
    next = body.slice(0, s + STATUS_START.length) + "\n" + rendered + "\n" + body.slice(e);
  }

  if (next === body) return null;

  await gh(`/repos/${OWNER}/${REPO}/issues/${issue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body: next })
  });

  return { number: issue.number, projects: (status.projects || []).length };
}
