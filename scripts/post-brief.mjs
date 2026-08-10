// Renders and posts the Monday brief from .agent/brief.json.
//
// The renderer — not the model — owns the structure. That is deliberate:
//   * `drive` is a single object, so "exactly one project, never a ranked list of three" is
//     structurally impossible to violate rather than merely discouraged in a prompt.
//   * §5 SPEND is injected from measured metrics, so spend figures cannot be invented.
//   * Caps from docs/WEEKLY-BRIEF.md (5 queue items, 4 notable) are enforced here and the
//     overflow is reported rather than silently dropped.

import { readFile, writeFile } from "node:fs/promises";
import { createIssue, BRIEF_MARKER } from "./lib/github.mjs";

const MAX_QUEUE = 5;
const MAX_NOTABLE = 4;
const MAX_IDEAS = 3;

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { if (fallback !== undefined) return fallback; throw new Error(`could not read ${p}`); }
};

const issueRef = (n) => (Number.isInteger(Number(n)) ? ` (#${n})` : "");

const benchLink = (context) =>
  context?.ideaBench?.number ? `#${context.ideaBench.number}` : "the idea bench issue";

function renderDrive(drive, warnings) {
  if (!drive || typeof drive !== "object" || Array.isArray(drive)) {
    warnings.push("brief.json had no usable `drive` object");
    return "_No DRIVE was produced. This is a failure of the brief, not a rest week._";
  }
  const lines = [];
  lines.push(`**${drive.project || "Rest week — nothing needs you"}**${issueRef(drive.issue)}`);
  lines.push("");
  // Blank lines between these, not just newlines — adjacent lines would otherwise be joined
  // into a single paragraph by the markdown renderer.
  if (drive.work) lines.push(`**The work:** ${drive.work}`, "");
  if (drive.why) lines.push(`**Why this week:** ${drive.why}`, "");
  if (drive.unblocks) lines.push(`**Unblocks:** ${drive.unblocks}`, "");
  if (drive.uncertain || drive.runnerUp) {
    const bits = [];
    if (drive.uncertain) bits.push(drive.uncertain);
    if (drive.runnerUp) bits.push(`Runner-up: ${drive.runnerUp}.`);
    lines.push("");
    lines.push(`> ${bits.join(" ")}`);
  }
  return lines.join("\n");
}

function renderQueue(queue, warnings) {
  if (!Array.isArray(queue) || !queue.length) {
    return "_Empty. Nothing needs a decision from you this week._";
  }
  if (queue.length > MAX_QUEUE) {
    warnings.push(`decision queue had ${queue.length} items; kept the first ${MAX_QUEUE}`);
  }
  return queue.slice(0, MAX_QUEUE).map((it, i) => {
    const mins = Number(it?.minutes);
    const est = Number.isFinite(mins) ? ` — **${mins} min**` : " — _no estimate given_";
    return `${i + 1}. ${it?.item || "(blank)"}${issueRef(it?.issue)}${est}`;
  }).join("\n");
}

function renderMovement(m, warnings) {
  m = m && typeof m === "object" ? m : {};
  const out = [];

  const notable = Array.isArray(m.notable) ? m.notable : [];
  if (notable.length > MAX_NOTABLE) {
    warnings.push(`notable movement had ${notable.length} items; kept the first ${MAX_NOTABLE}`);
  }
  out.push("**Notable movement**");
  out.push(notable.length
    ? notable.slice(0, MAX_NOTABLE).map((n) =>
        typeof n === "string" ? `- ${n}` : `- ${n?.project ? `**${n.project}** — ` : ""}${n?.what || ""}`).join("\n")
    : "_None._");

  out.push("");
  out.push("**Ticking along**");
  out.push(m.tickingAlong ? String(m.tickingAlong) : "_Nothing else in flight._");

  out.push("");
  out.push("**No movement**");
  const none = Array.isArray(m.noMovement) ? m.noMovement : [];
  out.push(none.length
    ? none.map((n) => `- **${n?.project || "?"}** — ${n?.reason || "_no reason given — treat this as a gap in the brief_"}`).join("\n")
    : "_Everything moved._");

  return out.join("\n");
}

function renderDrift(drift, warnings) {
  if (!Array.isArray(drift) || !drift.length) return "_Nothing drifting._";
  return drift.map((d) => {
    const rec = String(d?.recommendation || "").toLowerCase();
    if (!["re-engage", "reengage", "kill"].includes(rec)) {
      warnings.push(`drift item "${d?.project}" had no clear re-engage/kill recommendation`);
    }
    const verdict = rec === "kill" ? "**KILL**" : rec.startsWith("re") ? "**RE-ENGAGE**" : "**NO RECOMMENDATION**";
    return `- ${verdict} — **${d?.project || "?"}**${issueRef(d?.issue)}: ${d?.why || ""}`;
  }).join("\n");
}

// Section 6 is an addition beyond docs/WEEKLY-BRIEF.md, added at the owner's request. It sits
// after SPEND deliberately: it is the only optional part of the brief, and nothing above it
// should ever be pushed down the page by ideas nobody asked for.
function renderIdeas(ideas, warnings) {
  if (!Array.isArray(ideas) || !ideas.length) {
    return "_Nothing worth surfacing this week._";
  }
  if (ideas.length > MAX_IDEAS) {
    warnings.push(`idea bench offered ${ideas.length}; kept the first ${MAX_IDEAS}`);
  }
  return ideas.slice(0, MAX_IDEAS).map((i) =>
    `**${i?.title || "(untitled)"}**\n\n${i?.why || ""}` +
    (i?.fit ? `\n\n*Why it fits you:* ${i.fit}` : "")
  ).join("\n\n---\n\n");
}

function renderSpend(metrics) {
  if (!metrics) return "_Metrics unavailable this week — treat that as a gap, not as zero usage._";
  const w = metrics.week || {};
  const p = metrics.priorWeek || {};
  const delta = metrics.minutesDelta;
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";

  const lines = [
    `**Runs:** ${w.total || 0} total — ${w.success || 0} succeeded, ${w.failure || 0} failed, ` +
      `${w.cancelled || 0} cancelled, ${w.timed_out || 0} timed out.`,
    `**Agent minutes:** ${w.minutes || 0} this week vs ${p.minutes || 0} prior ` +
      `(${arrow} ${Math.abs(delta || 0)} min).`,
    `**Pressure:** ${metrics.pressure?.note || "unknown"}`,
    "",
    `<sub>${metrics.ceilingNote || ""}</sub>`
  ];

  if (metrics.failures?.length) {
    lines.push("");
    lines.push("**Failed runs:**");
    lines.push(metrics.failures.map((f) => `- ${f.name} — ${f.conclusion} — [log](${f.url})`).join("\n"));
  }
  return lines.join("\n");
}

function renderHealth(metrics, health) {
  const last = metrics?.lastRunByWorkflow || {};
  const nightly = Object.entries(last).find(([n]) => /triage/i.test(n))?.[1];

  if (!nightly) {
    return "🔴 **Machine health:** no nightly triage run found in the metrics window. " +
      "The system may not be running at all — check the Actions tab.";
  }
  // Clamp: clock skew between the runner and this process can otherwise print "-1d ago".
  const days = Math.max(0, Math.floor((Date.now() - new Date(nightly.at).getTime()) / 86400000));
  if (nightly.conclusion !== "success") {
    return `🔴 **Machine health:** last nightly run ${nightly.conclusion} (${days}d ago). [Log](${nightly.url})`;
  }
  if (days > 2) {
    return `🟠 **Machine health:** last successful nightly run was ${days} days ago — it should run daily.`;
  }
  const base = `🟢 **Machine health:** nightly triage ran successfully ${days === 0 ? "today" : `${days}d ago`}.`;
  return health ? `${base} ${String(health)}` : base;
}

async function main() {
  const brief = await readJson(".agent/brief.json");
  const metrics = await readJson(".agent/metrics.json", null);
  const context = await readJson(".agent/context.json", null);
  const warnings = [];

  const date = new Date().toISOString().slice(0, 10);

  // Blank lines here are load-bearing: without one, a `##` heading following a blockquote is
  // parsed as a lazy continuation of that quote rather than as a heading. Do not filter them out.
  const sections = [
    BRIEF_MARKER,
    renderHealth(metrics, brief.health),
    "",
    "## 1. THE DRIVE",
    "",
    renderDrive(brief.drive, warnings),
    "",
    "## 2. DECISION QUEUE",
    "",
    renderQueue(brief.decisionQueue, warnings),
    "",
    "## 3. MOVEMENT",
    "",
    renderMovement(brief.movement, warnings),
    "",
    "## 4. DRIFT",
    "",
    renderDrift(brief.drift, warnings),
    "",
    "## 5. SPEND",
    "",
    renderSpend(metrics),
    "",
    "## 6. FROM THE IDEA BENCH",
    "",
    renderIdeas(brief.ideas, warnings),
    "",
    `<sub>Nightly picks; this is the week's best of them. Not tasks — ignore freely. ` +
      `Full bench: ${benchLink(context)}</sub>`,
    ""
  ];

  if (warnings.length) {
    sections.push("---", "", `<sub>⚠️ Brief-quality warnings: ${warnings.join("; ")}.</sub>`, "");
  }
  sections.push(
    `<sub>Generated by the Monday brief workflow. Structure enforced by \`scripts/post-brief.mjs\` ` +
      `against \`docs/WEEKLY-BRIEF.md\`.</sub>`
  );

  const body = sections.join("\n");

  if (process.env.DRY_RUN === "true") {
    await writeFile(".agent/brief.md", body);
    console.log(body);
    console.log("\n[dry run — not posted]");
    return;
  }

  const issue = await createIssue({
    title: `Weekly brief — ${date}`,
    body,
    labels: ["brief"]
  });
  console.log(`posted brief: ${issue.html_url}`);
  if (warnings.length) console.log(`warnings: ${warnings.join("; ")}`);
}

main().catch((e) => {
  console.error("post-brief failed:", e.message);
  process.exit(1);
});
