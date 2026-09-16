---
'@mastra/cloudflare-sandbox': minor
---

Add opt-in automatic `/workspace` persistence so files survive Cloudflare container idle-sleep. Supply a `persistence` store (`load`/`save`, optional `excludes`) and the sandbox restores the workspace when a fresh container boots and archives it after commands and on `stop()`. Also expose R2 bucket `mountBucket`/`unmountBucket` directly on `CloudflareSandbox`, and correct the default `getInstructions()` to state that `/workspace` is ephemeral scratch space unless persistence is configured.

```typescript
const workspace = new CloudflareSandbox({
  baseUrl: process.env.CF_SANDBOX_URL!,
  persistence: {
    excludes: ['node_modules'],
    load: async () => (await myStorage.get('workspace-backup')) ?? undefined,
    save: async archive => {
      await myStorage.put('workspace-backup', archive);
    },
  },
});

await workspace.sandbox?.mountBucket?.({ bucket: 'my-r2-bucket', mountPath: '/mnt/data', options: { readOnly: true } });
```
