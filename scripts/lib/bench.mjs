// The idea bench: one rolling issue the nightly agent appends to, and the Monday brief harvests.
//
// Ideas are generated nightly and published weekly. That split is deliberate — nightly gives the
// agent many chances to notice something, weekly means the owner is shown at most three. Volume
// where it is free, restraint where attention is spent.

import {
  OWNER, REPO, gh, listOpenIssues, listComments, BENCH_TITLE, IDEA_MARKER, stripAgentStamps
} from "./github.mjs";

// The learning section lives between these markers in the issue body. Distilling what the
// feedback taught, once, beats re-deriving it from forty comments every night — it compounds
// instead of decaying, and it is visible so it can be corrected when the agent gets it wrong.
export const LEARNING_START = "<!-- apm:learning:start -->";
export const LEARNING_END = "<!-- apm:learning:end -->";

const LEARNING_PLACEHOLDER = "_Nothing learned yet — this fills in once you react to some ideas._";

const BENCH_BODY = [
  "<!-- apm:system -->",
  "Ideas the nightly agent thought might suit this portfolio. **Nothing here is a commitment.**",
  "",
  "One rolling issue rather than an issue per idea — an idea nobody asked for should not cost a",
  "triage decision. The Monday brief surfaces at most three of the week's best; the rest sit here",
  "until you want them or they age out of relevance.",
  "",
  "**React freely.** \"more like this\", \"never again\", \"good but not now\" — one line is enough.",
  "Every reaction you leave here is read before the next batch and folded into the section below,",
  "so the suggestions get closer to your taste over time. Saying nothing teaches it nothing.",
  "",
  "**To promote one:** open a new issue (or use quick capture on the dashboard), paste the idea,",
  "and charter it like anything else.",
  "",
  "Close this issue to turn idea generation off entirely.",
  "",
  "---",
  "",
  "## What the agent has learned about your taste",
  "",
  "Maintained by the nightly agent from your reactions. **Edit it freely** — if it has drawn the",
  "wrong conclusion, correcting it here is the fastest way to fix future suggestions.",
  "",
  LEARNING_START,
  LEARNING_PLACEHOLDER,
  LEARNING_END
].join("\n");

export async function findBench() {
  const issues = await listOpenIssues();
  return issues.find((i) => i.title === BENCH_TITLE) || null;
}

export async function ensureBench() {
  const existing = await findBench();
  if (existing) return existing;
  return gh(`/repos/${OWNER}/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: BENCH_TITLE, body: BENCH_BODY, labels: ["system"] })
  });
}

// Ideas already on the bench, newest first. The agent gets these so it does not re-suggest the
// same thing every night, and so the owner's rejections are visible to it.
function extractLearning(body) {
  const s = (body || "").indexOf(LEARNING_START);
  const e = (body || "").indexOf(LEARNING_END);
  if (s === -1 || e === -1 || e < s) return "";
  return body.slice(s + LEARNING_START.length, e).trim();
}

export async function readBench({ days = 60, max = 40 } = {}) {
  const bench = await findBench();
  if (!bench) return { number: null, ideas: [], ownerNotes: [], learning: "" };

  const comments = await listComments(bench.number);
  const cutoff = Date.now() - days * 86400000;
  const owner = OWNER.toLowerCase();

  const ideas = [];
  const ownerNotes = [];

  for (const c of comments) {
    const body = c.body || "";
    const isOwner = (c.user?.login || "").toLowerCase() === owner;

    if (isOwner) {
      // The owner talking back to the bench is the training signal. Never aged out and kept
      // generously — this is the thing that makes later suggestions better than earlier ones.
      ownerNotes.push({ at: c.created_at, body: body.slice(0, 2000) });
      continue;
    }
    if (!body.includes(IDEA_MARKER)) continue;
    if (new Date(c.created_at).getTime() < cutoff) continue;

    // Titles are emitted as "### <title>" by postIdeas below.
    for (const m of body.matchAll(/^###\s+(.+)$/gm)) {
      ideas.push({ title: m[1].trim(), at: c.created_at });
    }
  }

  return {
    number: bench.number,
    url: bench.html_url,
    ideas: ideas.slice(-max),
    ownerNotes: ownerNotes.slice(-40),
    learning: extractLearning(bench.body)
  };
}

// Replaces the distilled-taste section in the bench issue body. Only the region between the
// markers is touched, so anything the owner writes around it survives — including edits they
// make to the section itself, which the agent will then read back next run.
export async function updateLearning(text) {
  const clean = String(text || "").trim().slice(0, 4000);
  if (!clean) return null;

  const bench = await ensureBench();
  const body = bench.body || "";

  const s = body.indexOf(LEARNING_START);
  const e = body.indexOf(LEARNING_END);

  let next;
  if (s === -1 || e === -1 || e < s) {
    // Markers missing — the owner may have rewritten the body. Append rather than overwrite,
    // so nothing they wrote is lost.
    next = `${body}\n\n## What the agent has learned about your taste\n\n` +
      `${LEARNING_START}\n${clean}\n${LEARNING_END}`;
  } else {
    next = body.slice(0, s + LEARNING_START.length) + "\n" + clean + "\n" + body.slice(e);
  }

  if (next === body) return null;

  await gh(`/repos/${OWNER}/${REPO}/issues/${bench.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body: next })
  });
  return { number: bench.number, chars: clean.length };
}

export async function postIdeas(ideas) {
  if (!Array.isArray(ideas) || !ideas.length) return null;

  const clean = ideas
    .filter((i) => i && typeof i.title === "string" && i.title.trim())
    .slice(0, 3)
    .map((i) => ({
      // Same reason as post-triage: the marker and footer are this file's to add, and a model
      // that echoes them back produces a comment carrying each one twice.
      title: stripAgentStamps(i.title).slice(0, 200),
      why: stripAgentStamps(i.why).slice(0, 1200),
      fit: stripAgentStamps(i.fit).slice(0, 600)
    }))
    .filter((i) => i.title);

  if (!clean.length) return null;

  const bench = await ensureBench();
  const date = new Date().toISOString().slice(0, 10);

  const body = [
    IDEA_MARKER,
    `**${date}**`,
    "",
    ...clean.flatMap((i) => [
      `### ${i.title}`,
      "",
      i.why,
      i.fit ? `\n*Why it fits you:* ${i.fit}` : "",
      ""
    ]),
    "<sub>Generated by nightly triage. Not a commitment and not a task — ignore freely.</sub>"
  ].join("\n");

  await gh(`/repos/${OWNER}/${REPO}/issues/${bench.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body })
  });

  return { number: bench.number, count: clean.length };
}
