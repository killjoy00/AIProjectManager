// Creates (or updates) the label set the whole system depends on. Idempotent — safe to re-run.
// Run once at setup: `GITHUB_TOKEN=… npm run labels`

import { OWNER, REPO, gh } from "./lib/github.mjs";

const LABELS = [
  { name: "background",   color: "9AA0A8", description: "Captured. No charter yet, or parked. Agents don't work it." },
  { name: "active",       color: "2B7FFF", description: "Charter written. Worked weekly. Counts against the cap of 10." },
  { name: "hot",          color: "EE5A36", description: "Active and prioritized. Counts against the cap of 10." },
  { name: "done",         color: "1FA971", description: "Shipped or closed out." },
  { name: "spike:needed", color: "C2703A", description: "Ready for an agent to investigate." },
  { name: "spike:done",   color: "E8912D", description: "Spike finished — awaiting the owner's /build comment." },
  { name: "blocked:human",color: "C0392B", description: "Agent stopped. Needs a judgment only the owner can make." },
  { name: "brief",        color: "2B4BF2", description: "A weekly brief issue." },
  { name: "system",       color: "6E7681", description: "Machine-generated housekeeping." }
];

async function upsert(label) {
  const existing = await gh(`/repos/${OWNER}/${REPO}/labels/${encodeURIComponent(label.name)}`, {
    allow404: true
  });
  if (existing) {
    await gh(`/repos/${OWNER}/${REPO}/labels/${encodeURIComponent(label.name)}`, {
      method: "PATCH",
      body: JSON.stringify({ new_name: label.name, color: label.color, description: label.description })
    });
    return "updated";
  }
  await gh(`/repos/${OWNER}/${REPO}/labels`, { method: "POST", body: JSON.stringify(label) });
  return "created";
}

const results = [];
for (const label of LABELS) {
  results.push(`${label.name}: ${await upsert(label)}`);
}
console.log(results.join("\n"));
