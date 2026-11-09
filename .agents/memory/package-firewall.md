---
name: Package firewall blocks
description: Some npm package versions are blocked by Replit's package firewall (403)
---
`vitest@3` failed to install because its `tinypool@1.1.1` tarball returned 403 from the package firewall. `vitest@4` installs fine.

**Why:** the firewall blocks specific tarballs, not whole packages.

**How to apply:** on an ERR_PNPM_FETCH_403, try a different major version before anything else.
