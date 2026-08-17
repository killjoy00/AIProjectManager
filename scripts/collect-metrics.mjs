// Gathers real numbers for section 5 (SPEND) of the weekly brief and for the dashboard.
//
// These are measured, never authored by the model — the brief renderer injects this object
// verbatim so spend figures cannot be hallucinated.
//
// Note: this repo is public, so GitHub Actions minutes are unmetered and the `billable` field
// comes back empty. We therefore report wall-clock minutes as a *trend*, not against a ceiling,
// plus run outcomes and any sign that an agent run was truncated or rate-limited.

import { writeFile, mkdir } from "node:fs/promises";
import { OWNER, REPO, gh } from "./lib/github.mjs";

const WINDOW_DAYS = Number(process.env.METRICS_WINDOW_DAYS || 7);

const minutesBetween = (a, b) =>
  a && b ? Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000) : 0;

function summarize(runs) {
  const out = { total: runs.length, success: 0, failure: 0, cancelled: 0, timed_out: 0, other: 0, minutes: 0 };
  for (const r of runs) {
    const c = r.conclusion || "other";
    if (c in out) out[c] += 1;
    else out.other += 1;
    out.minutes += minutesBetween(r.run_started_at, r.updated_at);
  }
  out.minutes = Math.round(out.minutes * 10) / 10;
  return out;
}

async function main() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000);
  const prevSince = new Date(Date.now() - WINDOW_DAYS * 2 * 86400000);

  // The Actions runs endpoint returns {total_count, workflow_runs:[…]}, not a bare array.
  // ghPaged stops at the first non-array page, so using it here silently produced zero runs
  // every time — which is how the first real brief came to report "0 runs, 0 minutes" in a
  // week that had plenty. Page it explicitly instead.
  const all = [];
  const from = prevSince.toISOString().slice(0, 10);
  for (let page = 1; page <= 3; page++) {
    let batch;
    try {
      batch = await gh(
        `/repos/${OWNER}/${REPO}/actions/runs?created=%3E%3D${from}&per_page=100&page=${page}`
      );
    } catch (e) {
      console.error(`metrics: page ${page} failed (${e.message}) — reporting on what we have`);
      break;
    }
    const runs = batch?.workflow_runs || [];
    all.push(...runs);
    if (runs.length < 100) break;
  }

  if (!all.length) {
    // Distinguish "genuinely no runs" from "the query broke". A brief that quietly claims zero
    // activity is worse than one that admits it could not measure.
    console.error("metrics: no workflow runs returned — verify this is real before trusting §5");
  }

  const thisWeek = all.filter((r) => new Date(r.created_at) >= since);
  const lastWeek = all.filter((r) => new Date(r.created_at) < since && new Date(r.created_at) >= prevSince);

  const byWorkflow = {};
  for (const r of thisWeek) {
    (byWorkflow[r.name] ||= []).push(r);
  }

  const week = summarize(thisWeek);
  const prior = summarize(lastWeek);

  // Truncation / rate-limit pressure: runs that timed out or were cancelled are the observable
  // signal that an agent run did not finish its work.
  const pressure = {
    timedOut: week.timed_out,
    cancelled: week.cancelled,
    failed: week.failure,
    // A run that hits the workflow timeout is the clearest sign of truncation.
    truncationSuspected: week.timed_out > 0,
    note: week.timed_out > 0
      ? "At least one run hit its timeout — agent work was cut short, not completed."
      : "No runs hit their timeout."
  };

  const failures = thisWeek
    .filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out")
    .slice(0, 10)
    .map((r) => ({ name: r.name, conclusion: r.conclusion, at: r.created_at, url: r.html_url }));

  const metrics = {
    generated: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    meteredMinutes: false,
    ceilingNote: "Repo is public — Actions minutes are unmetered. Minutes are reported as a trend.",
    week,
    priorWeek: prior,
    minutesDelta: Math.round((week.minutes - prior.minutes) * 10) / 10,
    byWorkflow: Object.fromEntries(
      Object.entries(byWorkflow).map(([name, rs]) => [name, summarize(rs)])
    ),
    pressure,
    failures,
    lastRunByWorkflow: Object.fromEntries(
      Object.entries(byWorkflow).map(([name, rs]) => {
        const latest = rs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        return [name, { at: latest.created_at, conclusion: latest.conclusion, url: latest.html_url }];
      })
    )
  };

  await mkdir(".agent", { recursive: true });
  await writeFile(".agent/metrics.json", JSON.stringify(metrics, null, 2));
  console.log(
    `metrics: ${week.total} run(s) this week — ${week.success} ok, ${week.failure} failed, ` +
    `${week.minutes} min (prior week ${prior.minutes} min)`
  );
}

main().catch((e) => {
  console.error("collect-metrics failed:", e.message);
  process.exit(1);
});
