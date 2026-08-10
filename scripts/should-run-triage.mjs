// Decides whether this nightly-triage attempt should do any work.
//
// The agent runs against a Claude subscription, whose usage refreshes on a roughly five-hour
// cycle. When a window is exhausted the CLI exits with "You've hit your org's monthly spend
// limit" — a known misnomer in Claude Code 2.1.119+ for a depleted five-hour window rather than
// any billing ceiling. It clears by itself.
//
// So the schedule makes two attempts a day, in different windows. This guard makes the second
// one a no-op when the first already succeeded, so the portfolio never gets worked — and
// commented on — twice in a day.

import { OWNER, REPO, gh } from "./lib/github.mjs";
import { appendFileSync } from "node:fs";

const WORKFLOW = "nightly-triage.yml";

function output(run, reason) {
  console.log(`${run ? "RUN" : "SKIP"} — ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  }
}

async function main() {
  // A human asking for a run always gets one, whatever else has happened today.
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return output(true, "manually dispatched");
  }

  const todayUTC = new Date().toISOString().slice(0, 10);

  let runs = [];
  try {
    const res = await gh(
      `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs` +
      `?created=%3E%3D${todayUTC}&status=success&per_page=50`
    );
    runs = res?.workflow_runs || [];
  } catch (e) {
    // If the check itself fails, run. A duplicate comment is a far smaller problem than a
    // portfolio silently getting no work because a status query broke.
    return output(true, `could not check today's runs (${e.message}) — running rather than risk a silent skip`);
  }

  const succeededToday = runs.filter(
    (r) => r.conclusion === "success" && r.created_at.slice(0, 10) === todayUTC
  );

  if (succeededToday.length) {
    const at = succeededToday[0].created_at;
    return output(false, `a nightly run already succeeded today at ${at}`);
  }

  return output(true, "no successful nightly run yet today");
}

main().catch((e) => {
  console.error("should-run-triage failed:", e.message);
  // Same reasoning as above — fail open.
  output(true, "guard errored; running anyway");
});
