---
'@mastra/temporal': patch
---

Fixed Temporal worker generation so Node-only application initialization does not leak into deterministic workflow bundles. Workflows that directly require unavailable Node modules now fail prebuild with guidance to move the code into an activity or workflow input.
