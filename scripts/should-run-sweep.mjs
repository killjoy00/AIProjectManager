// Decides whether this portfolio-sweep attempt should do any work.
//
// The agent runs against a Claude subscription, whose usage refreshes on a roughly five-hour
// cycle. When a window is exhausted the CLI exits with "You've hit your org's monthly spend
// limit" — a known misnomer in Claude Code 2.1.119+ for a depleted five-hour window rather than
// any billing ceiling. It clears by itself.
//
// The sweep runs once a week and is the system's most important output, so a spent window must not
// cost the whole week. The schedule therefore makes a second attempt a few hours later, in a
// different window, and this guard makes it a no-op when the first already succeeded.
//
// Why a rolling window and not "did one succeed today": the primary fires at 02:17 UTC Monday
// (21:17 CT Sunday). A fallback placed a few hours later is trivially on the same UTC day, but a
// fallback placed *before* midnight UTC would not be — and the old same-day comparison would have
// silently stopped seeing the primary's success and run the sweep twice. A window has no such
// edge.

import { OWNER, REPO, gh } from "./lib/github.mjs";
import { appendFileSync } from "node:fs";

const WORKFLOW = "portfolio-sweep.yml";

// Comfortably longer than the gap between the primary and its fallback, comfortably shorter than
// the week between scheduled sweeps.
const LOOKBACK_HOURS = Number(process.env.SWEEP_LOOKBACK_HOURS || 24);

function output(run, reason) {
  console.log(`${run ? "RUN" : "SKIP"} — ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  }
}

async function main() {
  // A human asking for a run always gets one, whatever else has happened.
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return output(true, "manually dispatched");
  }

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600000;
  const from = new Date(cutoff).toISOString().slice(0, 10);

  let runs = [];
  try {
    const res = await gh(
      `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs` +
      `?created=%3E%3D${from}&status=success&per_page=50`
    );
    runs = res?.workflow_runs || [];
  } catch (e) {
    // If the check itself fails, run. A duplicate sweep is a far smaller problem than a portfolio
    // silently getting no work for a week because a status query broke.
    return output(true, `could not check recent runs (${e.message}) — running rather than risk a silent skip`);
  }

  // The `created=` filter has day granularity, so re-filter to the actual window.
  const recent = runs.filter(
    (r) => r.conclusion === "success" && new Date(r.created_at).getTime() >= cutoff
  );

  if (recent.length) {
    const at = recent[0].created_at;
    return output(false, `a sweep already succeeded at ${at} (within ${LOOKBACK_HOURS}h)`);
  }

  return output(true, `no successful sweep in the last ${LOOKBACK_HOURS}h`);
}

main().catch((e) => {
  console.error("should-run-sweep failed:", e.message);
  // Same reasoning as above — fail open.
  output(true, "guard errored; running anyway");
});
