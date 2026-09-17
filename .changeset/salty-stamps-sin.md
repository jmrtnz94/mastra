---
'@mastra/factory': minor
---

Added provider-owned repository resolution and workspace construction. Factory now resolves sessions through their stored repository provider, so multiple integrations can coexist without choosing the first registered provider.

```ts
new MastraFactory({
  ...config,
  integrations: [github, gitlab],
});
```

Custom integrations implement `versionControl.resolveRepository` and `workspaceFactory`; existing GitHub integrations retain their compatibility path.
