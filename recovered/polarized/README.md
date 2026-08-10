# Recovered source — Polarized

**This is a snapshot, not a working copy.** It exists so the nightly agent has real code to read
while the source is not yet committed to `killjoy00/polarized`.

## What happened

Polarized was deployed to Cloudflare Pages by Direct Upload and never had version control, so
the deployment was the only copy of its source. `index.html` here was recovered byte-for-byte
from https://polarized.planitnow.us on 2026-08-10.

- 30,719 bytes, 656 lines
- sha256 `0145ceba39cbda158f50cb33f9ecef1c7eef6c2b2c4234c610435bcbc0035c9c`

The recovery is faithful rather than approximate because the page is entirely self-contained:
inline CSS and JS, no build step, no local asset references. Every path other than `/` returns
`index.html` via the SPA fallback — checked, not assumed.

Scanned before committing to a public repo: the page carries `SB_URL` and an `sb_publishable_`
Supabase key, which is designed to ship to browsers. No `service_role` key, private key, or
other secret is present.

## Why it is here rather than in its own repo

`killjoy00/polarized` now exists, but this session has read access to it and not write — both
`git push` and the GitHub contents API returned 403, because the Claude GitHub App holds write
permission on `AIProjectManager` only. The owner could not upload the file by hand at the time.

Parking it here needs no new credential and no permission change. That is the whole reason —
it is not where this file belongs.

## How to retire this directory

1. Upload `index.html` to https://github.com/killjoy00/polarized
2. Delete `recovered/` from this repo
3. Drop the pointer to it from the charter in issue #6

Until step 1 happens, this snapshot can drift from what is actually deployed. Treat
https://polarized.planitnow.us as the truth if the two ever disagree.

## Known gap

The source references `polarized-setup-v2.sql`, which creates the Supabase schema. That file was
never deployed and could not be recovered — it has to be re-derived by introspecting the live
Supabase project. Tracked as Gate 0 in issue #6.
