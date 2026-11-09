---
name: Publish blocked by dependency scan
description: Publishing runs a dependency vulnerability scan first and refuses to build if any high-severity finding exists
---
Publishing stops before the build if any dependency has a high-severity advisory. The build logs list each package, version and fixed version.

**Why:** the first OllieOS publish was blocked this way (body-parser via Express, undici, zod). There is no patched zod 3.x, so fixing zod means moving the workspace to zod 4 (the code already imports `zod/v4`).

**How to apply:** when a publish fails, read the build logs first. If it's this scan, upgrade the packages it names, then rerun the api-server tests and check the MCP connection still works (the MCP SDK and drizzle-zod both depend on zod) before asking Ollie to publish again.
