// Enforces the hard cap from CLAUDE.md: at most 10 issues labeled `active` or `hot`.
// Per the rule, going over does not silently proceed — it files a blocked:human issue and
// asks the owner to cut. Exits non-zero only with STRICT=true, so a normal scheduled run still
// does its work while making the overage impossible to miss.

import { readFile } from "node:fs/promises";
import { OWNER, REPO, CAP, upsertSystemIssue, SYSTEM_MARKER } from "./lib/github.mjs";

const TITLE = "⚠️ Portfolio over the active/hot cap";

async function main() {
  const context = JSON.parse(await readFile(".agent/context.json", "utf8"));
  const { active, hot, total, overCap } = context.portfolio;

  console.log(`portfolio: ${active} active + ${hot} hot = ${total} / cap ${CAP}`);

  if (!overCap) return;

  const live = context.projects
    .filter((p) => p.status === "active" || p.status === "hot")
    .sort((a, b) => (b.daysSinceAnyUpdate ?? 0) - (a.daysSinceAnyUpdate ?? 0));

  const body = [
    SYSTEM_MARKER,
    `**${total} projects are \`active\` or \`hot\`. The cap is ${CAP}.**`,
    "",
    "Per `CLAUDE.md` I'm not proceeding as if this were fine. Something needs to move to",
    "`background` or `done`. Coldest first — these have gone longest without any update:",
    "",
    ...live.map((p) =>
      `- [ ] **${p.title}** (#${p.number}) — \`${p.status}\`, ` +
      `${p.daysSinceAnyUpdate ?? "?"}d since last update` +
      `${p.killCriteriaPresent ? "" : " — ⚠️ no kill criteria in charter"}`
    ),
    "",
    "Close this issue once you're back at or under the cap.",
    "",
    `<sub>Filed by \`scripts/portfolio-check.mjs\` on ${new Date().toISOString().slice(0, 10)}. ` +
    `Repo: ${OWNER}/${REPO}</sub>`
  ].join("\n");

  const { number, created } = await upsertSystemIssue({
    title: TITLE,
    body,
    labels: ["blocked:human", "system"]
  });
  console.log(`${created ? "opened" : "updated"} cap issue #${number}`);

  if (process.env.STRICT === "true") process.exit(1);
}

main().catch((e) => {
  console.error("portfolio-check failed:", e.message);
  process.exit(1);
});
