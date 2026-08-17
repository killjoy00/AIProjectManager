// Handoff packets: how approved work leaves this system and reaches a session that can build it.
//
// The manager finds problems; it does not fix them. It holds no credentials and never will. So the
// deliverable for approved work is a self-contained block the owner pastes into a fresh Claude
// Code session — one that has repo access and can open a PR.
//
// This is what `/build` now means. Before, it authorised the nightly agent to write build-shaped
// work into a comment that nobody could execute. Now it authorises a packet.
//
// The packet is written for a reader with none of this context. That is the whole difficulty: a
// cold session re-derives everything unless the evidence is handed to it, and a cold session with
// a plausible wrong reading is the failure mode this portfolio has already paid for twice — see
// docs/FAILURE-MODES.md.

import { OWNER, REPO, listComments, addComment, stripAgentStamps, HANDOFF_MARKER } from "./github.mjs";

// Re-exported for convenience; the string lives in github.mjs with the rest of the markers.
export { HANDOFF_MARKER };

const MAX_PER_RUN = 2;
const MAX_TITLE = 120;
const MAX_FIELD = 2000;
const MAX_EVIDENCE = 12;

const clean = (v, max) => stripAgentStamps(String(v || "")).trim().slice(0, max);

// A fence has to be longer than the longest backtick run inside it, or the packet truncates at
// whatever code sample it happens to contain. Measure rather than hope.
function fence(content) {
  let longest = 0;
  for (const m of String(content).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The pasteable block. Plain text, no markdown — it is a prompt, not a document.
 *
 * The gate is embedded deliberately: a build session that does not know about gate 3 will happily
 * merge its own PR, and CLAUDE.md forbids that. Stating it in the packet means the rule travels
 * with the work instead of living only in a repo the session may not read.
 */
export function renderPacket(h) {
  const evidence = (Array.isArray(h.evidence) ? h.evidence : [])
    .slice(0, MAX_EVIDENCE)
    .map((e) => `- ${clean(e, 400)}`)
    .filter((e) => e !== "- ");

  return [
    `Repo: ${h.repo || "unknown — ask before touching anything"}`,
    `Branch: ${h.branch || "main"}`,
    `Task: ${h.title}`,
    `Source: ${OWNER}/${REPO} issue #${h.issue}`,
    "",
    "PROBLEM",
    h.problem || "(none given — this packet is defective; check the issue thread)",
    "",
    "EVIDENCE",
    "Found by the portfolio sweep from a shallow checkout. Re-read these files before relying on",
    "any of it — the claim may be true of a different branch than the one you are on.",
    ...(evidence.length ? evidence : ["- (none cited — treat every claim above as unverified)"]),
    "",
    "DONE WHEN",
    h.done || "(not specified — agree this with the owner before starting)",
    "",
    "OUT OF SCOPE",
    h.outOfScope || "(not specified — prefer the narrow reading)",
    ...(h.traps ? ["", "TRAPS", h.traps] : []),
    "",
    "RULES",
    "- Read CLAUDE.md in the target repo first if it has one.",
    "- Do not self-merge. Open a pull request and leave it for human review.",
    "- Verify what you can actually run, and say plainly what you did not verify.",
    "- If this packet contradicts what you find in the source, the source wins — say so."
  ].join("\n");
}

// Exported for testing: the fence length is computed from the content, and getting it wrong
// truncates the packet at whatever code sample it happens to contain.
export function handoffComment({ packet, title, date, runUrl }) {
  const f = fence(packet);
  return [
    HANDOFF_MARKER,
    `**Handoff packet — ${date}**`,
    "",
    `\`/build\` is approved on this issue, so here is **${title}** packaged for a build session.`,
    "Copy the block and paste it into a fresh Claude Code session with access to the repo.",
    "",
    f,
    packet,
    f,
    "",
    "<sub>The manager cannot build this — it holds no credentials. Nothing was pushed. " +
    `Whatever the build session opens still needs your review before it merges. ` +
    `[Run log](${runUrl})</sub>`
  ].join("\n");
}

/**
 * Validate and post the handoff packets the model proposed.
 *
 * `allowed` is the same allowlist that gates comments, and `approved` is the set of issues the
 * owner has actually `/build`-approved. Both are checked here rather than trusted from the model:
 * a packet is the one output of this system that a human is likely to run without reading closely,
 * so it must not be possible to conjure one for unapproved work.
 */
export async function postHandoffs(handoffs, { allowed, approved, runUrl = "" } = {}) {
  const posted = [];
  const rejected = [];

  if (!Array.isArray(handoffs) || !handoffs.length) return { posted, rejected };

  // Fail closed. A caller that forgets to pass the approved set would otherwise get every packet
  // posted with gate 2 silently skipped — the exact shape of hole this architecture exists to
  // prevent. Missing sets mean "approve nothing", not "approve everything".
  if (!(allowed instanceof Set) || !(approved instanceof Set)) {
    return {
      posted,
      rejected: [
        `${handoffs.length} packet(s) skipped — postHandoffs was called without an allowlist ` +
        `and an approved set. Refusing rather than posting unapproved work.`
      ]
    };
  }

  const date = new Date().toISOString().slice(0, 10);

  for (const h of handoffs) {
    if (posted.length >= MAX_PER_RUN) {
      rejected.push(`"${clean(h?.title, 60)}" — over the ${MAX_PER_RUN}-per-run limit`);
      continue;
    }

    const issue = Number(h?.issue);
    const title = clean(h?.title, MAX_TITLE);

    if (!Number.isInteger(issue) || !allowed.has(issue)) {
      rejected.push(`"${title || "(untitled)"}" — issue #${h?.issue} not in allowlist`);
      continue;
    }
    if (!approved.has(issue)) {
      // The gate, enforced deterministically. A packet for unapproved work would cross gate 2
      // on the model's word alone.
      rejected.push(`"${title}" — #${issue} has no /build approval`);
      continue;
    }
    if (!title) {
      rejected.push(`handoff on #${issue} — no title`);
      continue;
    }

    // Don't re-post the same packet every run. Keyed on the title within this issue's thread.
    let existing = [];
    try {
      existing = await listComments(issue);
    } catch (e) {
      rejected.push(`"${title}" — could not read #${issue} comments (${e.message})`);
      continue;
    }
    const already = existing.some(
      (c) => (c.body || "").includes(HANDOFF_MARKER) && (c.body || "").includes(`Task: ${title}`)
    );
    if (already) {
      rejected.push(`"${title}" — a packet with this title is already on #${issue}`);
      continue;
    }

    const packet = renderPacket({
      issue,
      title,
      repo: clean(h?.repo, 140),
      branch: clean(h?.branch, 140),
      problem: clean(h?.problem, MAX_FIELD),
      evidence: h?.evidence,
      done: clean(h?.done, MAX_FIELD),
      outOfScope: clean(h?.outOfScope, MAX_FIELD),
      traps: clean(h?.traps, MAX_FIELD)
    });

    try {
      await addComment(issue, handoffComment({ packet, title, date, runUrl }));
      posted.push({ issue, title });
    } catch (e) {
      rejected.push(`"${title}" — could not post (${e.message})`);
    }
  }

  return { posted, rejected };
}
