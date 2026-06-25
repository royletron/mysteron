---
title: Harden settings.json file permissions (0600)
state: backlog
priority: low
labels:
  - security
  - tech-debt
created: '2026-06-25T19:06:21.474Z'
updated: '2026-06-25T19:06:21.474Z'
---

**Low-severity hardening.** `~/.mysteron/settings.json` holds the password hash/salt and guest-token material and is written with default perms (`src/core/settings.ts`). The crypto is fine (timing-safe compares, salted hash — security audit found no high/med issues), but the file should be `chmod 0600` on write so other local users can't read the token/hash.

**Fix.** Set mode `0o600` when writing the settings file (and ideally the registry).

**Acceptance.** Settings file is created with `0600`.
