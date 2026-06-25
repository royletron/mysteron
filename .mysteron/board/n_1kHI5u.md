---
title: Footer
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T21:53:05.086Z'
updated: '2026-06-25T16:45:25.733Z'
---

Can we add a footer after the main content? Pop the name in, along with links to the github repo issues and stars. Could you also bake in the commit sha (will need to be done on build I guess). Make sure that the footer appears after the scroll, but no higher up the page than the bottom of the visible window (use dvh)

---

## Work log — Waldorf the Compiler

All done.

**Footer.** Added a `<Footer>` after `<main>` with: the **Mysteron** name, and links (new tab) to the **GitHub repo**, **Issues**, and **★ Stars** (stargazers). Repo resolved from the git remote → `github.com/royletron/mysteron`.

**Baked-in commit sha.** `vite.config.ts` now runs `git rev-parse --short HEAD` at config load and injects it via `define: { __COMMIT_SHA__ }` (falls back to `"dev"` if git isn't available). The footer shows the sha, linked to that commit on GitHub. Verified the built bundle contains the real sha (`commit/8467efb` found in the output JS). Declared the global in `web/src/vite-env.d.ts` for the typechecker.

**Positioning (dvh).** The app root is now a `min-h-[100dvh] flex flex-col`, with `main` as `flex-1`. So on short pages the footer is pushed to the bottom of the visible window (never floating up mid-page), and on long pages it sits after the scroll — exactly the requested behaviour, using `dvh` so mobile browser chrome is handled.

Files: `vite.config.ts`, `web/src/App.tsx`, `web/src/vite-env.d.ts` (new).

Verified: `npm run typecheck` clean, `vite build` succeeds (sha confirmed in bundle), `npm test` 17/17 pass. Committed as `63406e6` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

Note: the repo URL is hardcoded to `royletron/mysteron` (matching the git remote) since package.json has no `repository` field — easy to swap to a config value later if the repo moves.
