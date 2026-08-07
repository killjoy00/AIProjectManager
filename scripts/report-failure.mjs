// Called from an `if: failure()` step. Files or updates a blocked:human issue so a broken run
// leaves a visible trace instead of silence.
//
// One issue per workflow, reused across failures, so a persistent break doesn't produce thirty
// identical issues in a month.

import { upsertSystemIssue, SYSTEM_MARKER } from "./lib/github.mjs";

const job = process.env.FAILED_JOB || "unknown workflow";
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
