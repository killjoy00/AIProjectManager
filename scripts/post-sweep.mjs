// Reads .agent/sweep.json (written by the model) and posts it.
//
// This is the only stage that holds a token. The model's output is treated as untrusted input:
// every issue number must appear in the allowlist that collect-context.mjs produced, so even a
// fully manipulated model can do nothing but comment on the owner's own project issues.
//
// Two run modes, set by RUN_MODE:
//   sweep   — the Sunday deep run. Posts findings, rewrites the status board, files spinoffs and
//             ideas, and may emit handoff packets.
//   checkin — the light midweek run. Comments only where something changed, and may emit handoff
//             packets for approvals that landed since Sunday. Nothing else.
//
// A check-in that posts nothing is a success. That is the difference from the old nightly design,
// which treated an empty run as a failure to follow instructions.

import { readFile } from "node:fs/promises";
import { addComment, TRIAGE_MARKER, stripAgentStamps } from "./lib/github.mjs";
import { postIdeas, updateLearning } from "./lib/bench.mjs";
import { createSpinoffs } from "./lib/spinoff.mjs";
import { postHandoffs } from "./lib/handoff.mjs";
import { updateStatus } from "./lib/status.mjs";

const MAX_COMMENT = 60000;      // GitHub's hard limit is 65536
const MAX_COMMENTS_PER_RUN = 15;

const MODE = process.env.RUN_MODE === "checkin" ? "checkin" : "sweep";
const IS_SWEEP = MODE === "sweep";
const HEADER = IS_SWEEP ? "Portfolio sweep" : "Mid-week check-in";

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new Error(`could not read ${path}: ${e.message}`);
  }
}

async function main() {
  const context = await readJson(".agent/context.json");
  const allowed = new Set(context.commentableIssues || []);
  const approved = new Set(context.approvedIssues || []);

  let output;
  try {
    output = await readJson(".agent/sweep.json");
  } catch (e) {
    // The model produced nothing usable. That is a failure, not a quiet no-op.
    console.error(e.message);
    process.exit(1);
  }

  const runUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/` +
    `${process.env.GITHUB_REPOSITORY || ""}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`;

  // ── The status board ────────────────────────────────────────────────────────────────────────
  // Sweep only. A check-in has no source checkout, so letting it rewrite the board would replace
  // a reading taken from the code with one taken from metadata.
  if (IS_SWEEP) {
    try {
      const updated = await updateStatus(output.status);
      if (updated) {
        console.log(`status: rewrote the board on #${updated.number} (${updated.projects} project(s))`);
      } else {
        console.log("::warning::status: the sweep produced no status object — the board is stale");
      }
    } catch (e) {
      console.error(`status: could not update the board (${e.message}) — continuing`);
    }
  } else if (output.status) {
    console.log("status: ignored — a check-in does not rewrite the board");
  }

  // ── Ideas ──────────────────────────────────────────────────────────────────────────────────
  // Sweep only. Midweek idea generation is noise; the bench fills up weekly.
  if (IS_SWEEP) {
    try {
      const posted = await postIdeas(output.ideas);
      if (posted) {
        console.log(`bench: added ${posted.count} idea(s) to #${posted.number}`);
      } else {
        // The sweep prompt requires 1–3, so an empty batch means the agent did not follow
        // instructions rather than that it had nothing to say. Visible, but not fatal.
        console.log("::warning::bench: the agent returned no ideas — the sweep requires 1-3 every run");
      }

      // Distilled taste, rewritten from the owner's reactions. Kept in the issue body rather than
      // re-derived every run so it compounds instead of decaying.
      if (output.benchLearning) {
        const learned = await updateLearning(output.benchLearning);
        if (learned) console.log(`bench: updated learned-taste section on #${learned.number}`);
      }
    } catch (e) {
      // Ideas are a side function; never let them cost the run's actual work.
      console.error(`bench: could not post ideas (${e.message}) — continuing`);
    }
  }

  // ── Spinoffs ───────────────────────────────────────────────────────────────────────────────
  // Sweep only: a spinoff has to be justified by a source reading, and a check-in has none.
  //
  // Before comments, because a comment often references the spinoff it just asked for, and the
  // owner reading the thread should find the issue already filed rather than promised.
  if (IS_SWEEP) {
    try {
      const { created, rejected: spinRejected } = await createSpinoffs(output.spinoffs, {
        allowed,
        projects: context.projects || []
      });
      for (const s of created) console.log(`spinoff: created #${s.number} "${s.title}" from #${s.parent}`);
      for (const r of spinRejected) console.log(`::warning::spinoff rejected: ${r}`);
    } catch (e) {
      // Same reasoning as the bench: a side mechanism must never cost the run's actual work.
      console.error(`spinoff: could not create (${e.message}) — continuing`);
    }
  }

  // ── Handoff packets ────────────────────────────────────────────────────────────────────────
  // Both modes. This is how approved work leaves the system, and an approval that landed on
  // Tuesday should not wait until Sunday for its packet.
  try {
    const { posted, rejected: hoRejected } = await postHandoffs(output.handoffs, {
      allowed, approved, runUrl
    });
    for (const h of posted) console.log(`handoff: posted "${h.title}" on #${h.issue}`);
    for (const r of hoRejected) console.log(`::warning::handoff rejected: ${r}`);
  } catch (e) {
    console.error(`handoff: could not post (${e.message}) — continuing`);
  }

  // ── Comments ───────────────────────────────────────────────────────────────────────────────
  const entries = Array.isArray(output.comments) ? output.comments : [];
  if (!entries.length) {
    // On a check-in this is the expected outcome most weeks, and saying so plainly keeps it from
    // reading like a broken run in the log.
    console.log(IS_SWEEP
      ? "::warning::the sweep produced no comments — every active project should have heard something"
      : `check-in produced no comments — nothing changed since the sweep. ` +
        `Agent notes: ${output.notes || "(none)"}`);
    return;
  }

  const rejected = [];
  const accepted = [];

  for (const entry of entries) {
    const num = Number(entry?.issue);
    const body = typeof entry?.body === "string" ? entry.body.trim() : "";

    if (!Number.isInteger(num) || !allowed.has(num)) {
      rejected.push(`#${entry?.issue} — not in allowlist`);
      continue;
    }
    if (!body) {
      rejected.push(`#${num} — empty body`);
      continue;
    }
    if (accepted.some((a) => a.num === num)) {
      rejected.push(`#${num} — duplicate in this run`);
      continue;
    }
    accepted.push({ num, body: body.slice(0, MAX_COMMENT) });
  }

  if (accepted.length > MAX_COMMENTS_PER_RUN) {
    rejected.push(`${accepted.length - MAX_COMMENTS_PER_RUN} comment(s) over the per-run limit`);
    accepted.length = MAX_COMMENTS_PER_RUN;
  }

  for (const { num, body } of accepted) {
    const stamped =
      `${TRIAGE_MARKER}\n**${HEADER} — ${new Date().toISOString().slice(0, 10)}**\n\n` +
      `${stripAgentStamps(body)}\n\n` +
      `<sub>Automated. Agent is comment-only; nothing was pushed. [Run log](${runUrl})</sub>`;
    await addComment(num, stamped);
    console.log(`commented on #${num}`);
  }

  // Weekly-guarantee check. Only the sweep carries the guarantee — CLAUDE.md ties it to one
  // assessment per week, which is this run. A check-in skipping a project is correct behaviour.
  if (IS_SWEEP) {
    const worked = new Set(accepted.map((a) => a.num));
    const silent = (context.projects || [])
      .filter((p) => (p.status === "active" || p.status === "hot") && !worked.has(p.number))
      .map((p) => `#${p.number} ${p.title}`);

    if (silent.length) {
      console.log(`::warning::no comment posted for: ${silent.join(", ")} — the weekly guarantee was not met`);
    }
  }

  if (rejected.length) console.log(`rejected: ${rejected.join("; ")}`);

  console.log(`posted ${accepted.length} comment(s) [${MODE}]`);
}

main().catch((e) => {
  console.error("post-sweep failed:", e.message);
  process.exit(1);
});
