// Reads .agent/triage.json (written by the model) and posts it.
//
// This is the only stage that holds a token. The model's output is treated as untrusted input:
// every issue number must appear in the allowlist that collect-context.mjs produced, so even a
// fully manipulated model can do nothing but comment on the owner's own project issues.

import { readFile } from "node:fs/promises";
import { addComment, TRIAGE_MARKER } from "./lib/github.mjs";
import { postIdeas, updateLearning } from "./lib/bench.mjs";

const MAX_COMMENT = 60000;      // GitHub's hard limit is 65536
const MAX_COMMENTS_PER_RUN = 15;

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

  let output;
  try {
    output = await readJson(".agent/triage.json");
  } catch (e) {
    // The model produced nothing usable. That is a failure, not a quiet no-op.
    console.error(e.message);
    process.exit(1);
  }

  // Ideas go to the rolling bench, not to project issues. Done before the comment work so a
  // night that produced only ideas still records them.
  try {
    const posted = await postIdeas(output.ideas);
    if (posted) {
      console.log(`bench: added ${posted.count} idea(s) to #${posted.number}`);
    } else {
      // The prompt requires 1–3 every run, so an empty batch means the agent did not follow
      // instructions rather than that it had nothing to say. Visible, but not fatal.
      console.log("::warning::bench: the agent returned no ideas — the prompt requires 1-3 every run");
    }

    // Distilled taste, rewritten from the owner's reactions. Kept in the issue body rather than
    // re-derived nightly so it compounds instead of decaying.
    if (output.benchLearning) {
      const learned = await updateLearning(output.benchLearning);
      if (learned) console.log(`bench: updated learned-taste section on #${learned.number}`);
    }
  } catch (e) {
    // Ideas are a side function; never let them cost the night's actual triage work.
    console.error(`bench: could not post ideas (${e.message}) — continuing`);
  }

  const entries = Array.isArray(output.comments) ? output.comments : [];
  if (!entries.length) {
    console.log("triage produced no comments");
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

  const runUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/` +
    `${process.env.GITHUB_REPOSITORY || ""}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`;

  for (const { num, body } of accepted) {
    const stamped =
      `${TRIAGE_MARKER}\n**Nightly triage — ${new Date().toISOString().slice(0, 10)}**\n\n` +
      `${body}\n\n` +
      `<sub>Automated. Agent is comment-only; nothing was pushed. [Run log](${runUrl})</sub>`;
    await addComment(num, stamped);
    console.log(`commented on #${num}`);
  }

  // Weekly-guarantee check: every worked project should have heard something.
  const worked = new Set(accepted.map((a) => a.num));
  const silent = (context.projects || [])
    .filter((p) => (p.status === "active" || p.status === "hot") && !worked.has(p.number))
    .map((p) => `#${p.number} ${p.title}`);

  if (silent.length) console.log(`no comment posted for: ${silent.join(", ")}`);
  if (rejected.length) console.log(`rejected: ${rejected.join("; ")}`);

  console.log(`posted ${accepted.length} comment(s)`);
}

main().catch((e) => {
  console.error("post-triage failed:", e.message);
  process.exit(1);
});
