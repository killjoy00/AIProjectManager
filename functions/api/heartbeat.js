// POST /api/heartbeat — called by the scheduled Actions after a successful run.
// Stamps KV so the dashboard can distinguish "ran fine" from "hasn't run in days".
//
// Authenticated with HEARTBEAT_SECRET, not the app passphrase: the workflows should not hold a
// credential that also unlocks the dashboard.

import { json, heartbeatAuthed, HEARTBEAT_KEY, readJsonKey } from "./_shared.js";

const MAX_HISTORY = 30;

export async function onRequestPost({ request, env }) {
  if (!env.IDEAS_KV) return json({ error: "kv_not_bound" }, 500);
  if (!heartbeatAuthed(request, env)) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_json" }, 400); }

  const job = String(body.job || "unknown").slice(0, 64);
  const status = String(body.status || "success").slice(0, 32);

  const store = await readJsonKey(env, HEARTBEAT_KEY, { jobs: {}, history: [] });
  store.jobs = store.jobs || {};
  store.history = Array.isArray(store.history) ? store.history : [];

  const entry = {
    job,
    status,
    at: body.at || new Date().toISOString(),
    run: body.run || null,
    runUrl: body.runUrl || null
  };

  store.jobs[job] = entry;
  store.history.unshift(entry);
  store.history = store.history.slice(0, MAX_HISTORY);

  await env.IDEAS_KV.put(HEARTBEAT_KEY, JSON.stringify(store));
  return json({ ok: true, job, at: entry.at });
}

// GET is deliberately unimplemented — heartbeat state is exposed through /api/dashboard,
// which is passphrase-gated. No need for a second read path.
export async function onRequestGet() {
  return json({ error: "method_not_allowed" }, 405);
}
