// Stamps a successful run into KV via the Pages Function, so the dashboard can tell the
// difference between "ran fine" and "hasn't run in four days."
//
// Half of the heartbeat guarantee. The other half is the failure step in each workflow, which
// files a blocked:human issue. Between them, silence is never ambiguous: either the dashboard
// goes stale, or an issue appears.

const url = process.env.HEARTBEAT_URL;
const secret = process.env.HEARTBEAT_SECRET;
const job = process.env.HEARTBEAT_JOB || "unknown";
const status = process.env.HEARTBEAT_STATUS || "success";

if (!url || !secret) {
  // Not fatal: the workflow still succeeded, we just can't stamp it. Say so loudly rather than
  // exiting non-zero and turning a good run red.
  console.log("heartbeat skipped — HEARTBEAT_URL or HEARTBEAT_SECRET not set");
  process.exit(0);
}

const payload = {
  job,
  status,
  at: new Date().toISOString(),
  run: process.env.GITHUB_RUN_ID || null,
  runUrl: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null
};

const attempt = async (n) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-heartbeat": secret },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    console.log(`heartbeat stamped: ${job} ${status}`);
    return true;
  }
  console.log(`heartbeat attempt ${n} failed: HTTP ${res.status}`);
  return false;
};

let ok = false;
for (let i = 1; i <= 3 && !ok; i++) {
  try {
    ok = await attempt(i);
  } catch (e) {
    console.log(`heartbeat attempt ${i} errored: ${e.message}`);
  }
  if (!ok && i < 3) await new Promise((r) => setTimeout(r, i * 2000));
}

if (!ok) console.log("heartbeat could not be stamped — dashboard will show this run as stale");
