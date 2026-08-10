// Called from an `if: failure()` step. Files or updates a blocked:human issue so a broken run
// leaves a visible trace instead of silence.
//
// One issue per workflow, reused across failures, so a persistent break doesn't produce thirty
// identical issues in a month.

import { readFileSync } from "node:fs";
import { upsertSystemIssue, SYSTEM_MARKER } from "./lib/github.mjs";

const job = process.env.FAILED_JOB || "unknown workflow";

// A depleted Claude usage window is not something a human can act on — it refreshes on its own,
// roughly every five hours, and the schedule already makes a second attempt in a later window.
// Filing a blocked:human issue for it would train the owner to ignore that label, which is the
// one thing it cannot afford. Only escalate if this was the last attempt of the day.
//
// The CLI reports this as "You've hit your org's monthly spend limit" — a known misnomer in
// Claude Code 2.1.119+ for an exhausted five-hour window rather than any billing ceiling.
const QUOTA_PATTERNS = [
  /monthly spend limit/i,
  /usage limit/i,
  /rate.?limit/i,
  /429/
];

function looksLikeQuota() {
  try {
    const log = readFileSync(".agent/agent.log", "utf8");
    return QUOTA_PATTERNS.some((p) => p.test(log));
  } catch {
    return false;
  }
}

const isLastAttempt = process.env.IS_LAST_ATTEMPT === "true";

if (looksLikeQuota() && !isLastAttempt) {
  console.log(
    "Failure looks like an exhausted Claude usage window, and a later attempt is still " +
    "scheduled today. Not filing a blocked:human issue — that label must mean a human is " +
    "actually needed."
  );
  process.exit(0);
}
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "(no run URL)";

const title = `🔴 ${job} failed`;

const body = [
  SYSTEM_MARKER,
  `**\`${job}\` failed at ${new Date().toISOString()}.**`,
  "",
  `[Run log](${runUrl})`,
  "",
  "Nothing was posted to project issues by this run — treat any project that expected work",
  "this cycle as having received none.",
  "",
  "**What to check, in order:**",
  "1. The run log above — most failures are a missing or expired secret.",
  "2. `CLAUDE_CODE_OAUTH_TOKEN` — these expire. Re-run `claude setup-token` and update the secret.",
  "3. Whether the schedule is still firing at all. GitHub silently disables scheduled workflows",
  "   after 60 days without repo activity; the Actions tab will say so.",
  "",
  "Close this issue once the next run succeeds.",
  "",
  "<sub>Filed automatically by `scripts/report-failure.mjs`. Repeat failures comment here rather",
  "than opening new issues.</sub>"
].join("\n");

try {
  const { number, created } = await upsertSystemIssue({
    title,
    body,
    labels: ["blocked:human", "system"]
  });
  console.log(`${created ? "opened" : "updated"} failure issue #${number}`);
} catch (e) {
  // Last resort: if we cannot even file the issue, make sure the log screams.
  console.error("!!! COULD NOT FILE FAILURE ISSUE !!!");
  console.error(e.message);
  process.exit(1);
}
