// Self-test for the pure logic in scripts/lib. Run with `npm test`. No token, no network.
//
// Why this exists: most of this repo cannot be tested in a sandbox, because the GitHub token here
// is a proxy placeholder that Node's fetch cannot use (docs/FAILURE-MODES.md). That makes it worth
// keeping the testable part genuinely testable — rendering, validation, and the gate that decides
// whether a handoff packet may be posted at all.
//
// The gate cases are the point. Everything else here is a convenience.

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "selftest-stub";

import { renderStatus } from "./lib/status.mjs";
import { renderPacket, handoffComment, postHandoffs } from "./lib/handoff.mjs";
import { stripAgentStamps } from "./lib/github.mjs";

let failures = 0;
let group = "";
const section = (name) => { group = name; console.log(`\n── ${name} ──`); };
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};

// ── status board ──────────────────────────────────────────────────────────────────────────────
section("status board");
{
  const board = renderStatus({
    headline: "Two projects need you.",
    projects: [
      { issue: 7, name: "Foodfinder", state: "healthy", since: "3 commits", finding: "f" },
      { issue: 9, name: "BoardgameEngine", state: "drifting", since: "No change", finding: "empty", needsOwner: "kill it" },
      { issue: 8, name: "Polarized", state: "blocked", since: "No change", finding: "g", needsOwner: "pick auth" },
      { issue: 5, name: "Multi\nline", state: "needs-attention", since: "a\nb", finding: "x | y" },
      { issue: 6, state: "bogus", finding: "" }
    ]
  });
  const heads = board.split("\n").filter((l) => /^\*\*[🟢🟡🔴⚪❔]/.test(l));

  ok(heads.length === 5, "renders one block per project");
  ok(/blocked/.test(heads[0]) && /needs attention/.test(heads[1]) &&
     /drifting/.test(heads[2]) && /healthy/.test(heads[3]),
     "sorts worst-first: blocked, needs-attention, drifting, healthy");
  ok(/❔ bogus/.test(heads[4]), "echoes an unrecognised state back rather than hiding it");
  ok(/❔ unknown/.test(renderStatus({ projects: [{ issue: 1, name: "N" }] })), "a missing state reads unknown");
  ok(!/Multi\nline/.test(board), "flattens newlines inside a field");
  ok(!/#6 \(#6\)/.test(board), "a nameless project does not print its number twice");
  ok(/none recorded/.test(board), "an empty finding says so rather than rendering blank");
  ok(/2 waiting on you/.test(board), "footer counts the projects needing the owner");
  ok(!/undefined|null/.test(board), "no undefined/null leaks into the board");
  ok(/no project states/.test(renderStatus({ projects: [] })), "no projects renders a gap notice");
  ok(/no project states/.test(renderStatus(null)), "a null status does not throw");
  // The dashboard's md() supports *asterisk* emphasis only — underscore italics render literally.
  ok(!/^_\w+:_/m.test(board), "uses no underscore italics (the dashboard renders them literally)");
  ok(Math.max(...board.split("\n").map((l) => l.length)) < 500, "no line long enough to force horizontal scroll");
}

// ── handoff packet ────────────────────────────────────────────────────────────────────────────
section("handoff packet");
{
  const packet = renderPacket({
    issue: 7, title: "Rate-limit login", repo: "killjoy00/foodfinder", branch: "main",
    problem: "No attempt counter.", evidence: ["app/api/login/route.ts:22 — none"],
    done: "6th attempt rejected.", outOfScope: "Not password hashing.", traps: "Default branch drift."
  });
  ok(/Do not self-merge/.test(packet), "gate 3 travels inside the packet");
  ok(/issue #7/.test(packet) && /Branch: main/.test(packet), "packet names its source issue and branch");

  const bare = renderPacket({ issue: 1, title: "T" });
  ok(/defective/.test(bare), "a missing problem is called defective, not left blank");
  ok(/none cited/.test(bare), "missing evidence is flagged as unverified");
  ok(!/undefined|null/.test(bare), "no undefined/null leaks into a sparse packet");

  // The packet is wrapped in a fence for copy-paste. A fence shorter than the content's own
  // backtick runs would truncate it at whatever code sample it happens to carry.
  const extract = (md) => {
    const lines = md.split("\n");
    const i = lines.findIndex((l) => /^`{3,}$/.test(l));
    const j = lines.findIndex((l, k) => k > i && l === lines[i]);
    return i === -1 || j === -1 ? null : lines.slice(i + 1, j).join("\n");
  };
  for (const [name, problem] of [
    ["no backticks", "plain"],
    ["inline code", "run `npm ci`"],
    ["a nested 3-fence", "x:\n```js\nconst a=1;\n```\ny"],
    ["a nested 4-fence", "x:\n````\n```\nz\n```\n````\ny"],
    ["a 7-backtick run", "weird ``````` seven"]
  ]) {
    const p = renderPacket({ issue: 7, title: "T", repo: "o/r", problem, done: "d", outOfScope: "o" });
    const md = handoffComment({ packet: p, title: "T", date: "2026-08-17", runUrl: "u" });
    ok(extract(md) === p, `survives the fence round-trip with ${name}`);
  }
}

// ── the gate ──────────────────────────────────────────────────────────────────────────────────
// A handoff packet is the one output a human is likely to run without reading closely. Whether it
// may be posted at all must not depend on the model's word.
section("handoff gate");
{
  let posts = [];
  let existing = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), m = opts.method || "GET";
    if (m === "POST") posts.push(u);
    const isGetComments = u.includes("/comments") && m === "GET";
    return {
      ok: true, status: 200, headers: new Map([["link", ""]]),
      json: async () => (isGetComments ? existing : {}), text: async () => ""
    };
  };

  const mk = (issue, title) => ({
    issue, title, repo: "killjoy00/foodfinder", branch: "main",
    problem: "p", evidence: ["a.ts:1"], done: "d", outOfScope: "o", traps: "t"
  });
  const allowed = new Set([7, 8, 9]);
  const approved = new Set([7]);

  posts = [];
  let r = await postHandoffs([mk(7, "Rate-limit login")], { allowed, approved, runUrl: "u" });
  ok(r.posted.length === 1 && r.rejected.length === 0, "approved and allowlisted: packet is posted");
  ok(posts.some((u) => u.includes("/issues/7/comments")), "posted to the issue it names");

  posts = [];
  r = await postHandoffs([mk(8, "Unapproved work")], { allowed, approved });
  ok(r.posted.length === 0 && /no \/build approval/.test(r.rejected[0] || ""),
     "GATE 2: an allowlisted issue with no /build gets no packet");
  ok(posts.length === 0, "and nothing at all is written for it");

  posts = [];
  r = await postHandoffs([mk(999, "Foreign")], { allowed, approved: new Set([999]) });
  ok(r.posted.length === 0 && /not in allowlist/.test(r.rejected[0] || ""),
     "an issue outside the allowlist is refused even when marked approved");
  ok(posts.length === 0, "and nothing is written for it either");

  posts = [];
  for (const opts of [{ allowed }, {}, undefined]) {
    r = await postHandoffs([mk(7, "X")], opts);
    if (r.posted.length !== 0) failures++;
  }
  ok(posts.length === 0, "FAIL CLOSED: a caller omitting the sets posts nothing");

  r = await postHandoffs([mk(7, "A"), mk(7, "B"), mk(7, "C")], { allowed, approved });
  ok(r.posted.length === 2 && /per-run limit/.test(r.rejected.join(" ")), "caps at two packets per run");

  existing = [{ body: "<!-- apm:handoff -->\n```\nTask: Rate-limit login\n```", user: { login: "bot" } }];
  r = await postHandoffs([mk(7, "Rate-limit login")], { allowed, approved });
  ok(r.posted.length === 0 && /already on #7/.test(r.rejected[0] || ""), "does not re-post an existing packet");
  r = await postHandoffs([mk(7, "Something else")], { allowed, approved });
  ok(r.posted.length === 1, "but a different task on the same issue still posts");
  existing = [];

  r = await postHandoffs([], { allowed, approved });
  ok(r.posted.length === 0 && r.rejected.length === 0, "an empty list is a clean no-op");
  ok((await postHandoffs(null, { allowed, approved })).posted.length === 0, "a null list does not throw");
}

// ── stamp stripping ───────────────────────────────────────────────────────────────────────────
// Regression guard for #27. The model copies the header format it sees in past comments, so the
// old names must stay matched for as long as old comments exist in the threads.
section("stamp stripping (regression: #27)");
{
  for (const h of ["Nightly triage", "Portfolio sweep", "Mid-week check-in", "Weekly brief", "Handoff packet"]) {
    ok(stripAgentStamps(`<!-- apm:triage -->\n**${h} — 2026-08-17**\n\nBody.`) === "Body.",
       `strips an echoed "${h}" header`);
  }
  for (const m of ["triage", "brief", "idea", "system", "spinoff", "handoff", "status:start", "learning:end"]) {
    ok(stripAgentStamps(`<!-- apm:${m} -->\nBody.`) === "Body.", `strips the apm:${m} marker`);
  }
  ok(stripAgentStamps("Body.\n\n<sub>Generated by the portfolio sweep. Ignore freely.</sub>") === "Body.",
     "strips the bench footer");
  ok(stripAgentStamps("Real content, untouched.") === "Real content, untouched.", "leaves ordinary text alone");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures ? 1 : 0);
