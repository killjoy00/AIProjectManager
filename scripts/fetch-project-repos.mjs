// Shallow-clones the repo behind each active project so the agent can actually read the code.
//
// Without this the agent sees only metadata — last push, open PR count — and has to reason about
// a codebase it cannot see. That produces confident guesses, which is the exact failure mode
// CLAUDE.md exists to prevent.
//
// Clones land in .projects/<name>/ and the agent reads them with Read/Glob/Grep. It has no Bash
// and no token, so it can never clone anything itself — this step decides what it may see.

import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const OUT = ".projects";
const OWNER = (process.env.GH_OWNER || "killjoy00").toLowerCase();
const MAX_REPOS = 12;

// Only statuses the agent actually works. No point cloning for a parked idea.
const WORKED = new Set(["active", "hot"]);

async function main() {
  const context = JSON.parse(await readFile(".agent/context.json", "utf8"));
  const token = process.env.GH_API_TOKEN;

  const wanted = [...new Set(
    (context.projects || [])
      .filter((p) => WORKED.has(p.status) && p.projectRepo)
      .map((p) => p.projectRepo)
  )];

  if (!wanted.length) {
    console.log("no project repos to fetch (nothing active/hot with a Repo: line)");
    await writeFile(`${OUT}/INDEX.json`, "[]").catch(() => {});
    return;
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const index = [];
  for (const full of wanted.slice(0, MAX_REPOS)) {
    const [owner, name] = full.split("/");

    // Guardrail: only ever clone repos the owner owns. The `Repo:` line comes from an
    // owner-authored issue body, but this keeps a stray or edited value from pointing the
    // clone at an arbitrary third-party repository.
    if ((owner || "").toLowerCase() !== OWNER) {
      console.log(`skip ${full} — not owned by ${OWNER}`);
      index.push({ repo: full, ok: false, reason: `not owned by ${OWNER}` });
      continue;
    }

    const dest = `${OUT}/${name}`;
    const url = token
      ? `https://x-access-token:${token}@github.com/${full}.git`
      : `https://github.com/${full}.git`;

    try {
      await run("git", ["clone", "--depth", "1", "--single-branch", "--quiet", url, dest], {
        timeout: 120000
      });
      // Drop .git — the agent only needs the working tree, and it keeps the token out of
      // the checkout's remote config.
      await rm(`${dest}/.git`, { recursive: true, force: true });

      const { stdout } = await run("bash", ["-c", `find ${dest} -type f | wc -l`]);
      const files = Number(stdout.trim()) || 0;
      console.log(`cloned ${full} -> ${dest} (${files} files)`);
      index.push({ repo: full, path: dest, files, ok: true });
    } catch (e) {
      // A missing repo must not kill the night's work — the agent can still do everything
      // that doesn't need the source, as long as it knows the source is missing.
      const msg = String(e.stderr || e.message || e).replace(token || "___", "***").slice(0, 300);
      console.log(`could not clone ${full}: ${msg}`);
      index.push({ repo: full, ok: false, reason: msg });
    }
  }

  await writeFile(`${OUT}/INDEX.json`, JSON.stringify(index, null, 2));
  const ok = index.filter((i) => i.ok).length;
  console.log(`project repos: ${ok}/${index.length} available`);
}

main().catch((e) => {
  console.error("fetch-project-repos failed:", e.message);
  process.exit(1);
});
