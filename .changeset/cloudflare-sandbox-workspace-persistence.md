---
'@mastra/cloudflare-sandbox': minor
---

Add opt-in automatic `/workspace` persistence so files survive Cloudflare container idle-sleep. Supply a `persistence` store (`load`/`save`, optional `excludes`) and the sandbox restores the workspace when a fresh container boots and archives it after commands and on `stop()`. Also expose R2 bucket `mountBucket`/`unmountBucket` directly on `CloudflareSandbox`, and correct the default `getInstructions()` to state that `/workspace` is ephemeral scratch space unless persistence is configured.
