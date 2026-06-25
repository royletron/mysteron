---
title: Toast!
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T16:22:52.670Z'
updated: '2026-06-25T16:45:29.811Z'
---

Could we stick a toast in when a new guest connects/disconnects? Could we also make the overlay not opaque? Very hard to read :P

---

**Done** (commit `ac03600`):

- 🍞 **Toasts on guest connect/disconnect** — new `Toast.tsx` module bus + `<Toaster/>` mounted in the app shell. `GuestIndicator` diffs the worker roster on each `workers-changed` event and pops a bottom-right toast (🤝 connected / 👋 disconnected). First load just seeds the baseline so existing guests don't spam toasts on page open.
- 👓 **Readable overlays** — the floating overlays (guest popover + `Modal`) used the translucent `.card` background (`bg-zinc-900/60`), letting the red background gradient bleed through. Made them solid (`bg-zinc-900`).

Verified: `pnpm run typecheck` clean, `pnpm test` 45/45 pass, `pnpm run build:web` succeeds. No automated frontend/UI tests exist, so the toast/overlay rendering was verified via typecheck + build only, not a browser run.
