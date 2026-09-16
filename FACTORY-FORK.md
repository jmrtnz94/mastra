# Factory integration fork

This fork carries shared Mastra Factory backend/UI extension points for external
providers. GitLab and future Jira adapters live in the deployment repository as
independent packages. Keep provider-specific API calls and credentials there.

`main` tracks `mastra-ai/mastra`. `factory/integrations` is our development branch,
initially based on `871bdaa5957c2b680cd043a728b1b7fec4101512`
(`@mastra/factory@0.15.0`, `mastra@1.30.0`). Use update branches to merge released
upstream versions and run compatibility checks before adopting them.

The **Factory custom build** workflow checks the backend and UI and produces a
paired Factory/CLI artifact with distinct versions and SHA-256 hashes. It never
publishes to npm or deploys the application. Artifacts are candidate builds;
adapter compatibility tests and live provider checks are required before release.

Run locally with the repository's pinned pnpm:

```sh
pnpm install --frozen-lockfile
node --test scripts/factory-release.test.mjs
node scripts/factory-release.mjs prepare
pnpm turbo build --filter ./mastracode/factory --filter ./packages/cli
pnpm --filter ./mastracode/factory check
pnpm --filter ./mastracode/factory test
pnpm --filter ./mastracode/factory-ui typecheck
pnpm --filter ./mastracode/factory-ui test:unit
pnpm --filter ./mastracode/factory-ui test:msw
node scripts/factory-release.mjs pack
node scripts/factory-release.mjs restore
```

Use a clean disposable checkout for release builds: `prepare` temporarily stamps
package versions with the source commit; `restore` restores those two manifests
after packaging. No force push or reset is required. Do not commit stamped
manifests. Build outputs are in `factory-artifacts/`; the release JSON identifies
the exact source and both package files.

Submit shared extension improvements upstream where possible. Remove corresponding
fork changes once an official release includes them. No upstream acceptance is
required for local development to continue.
