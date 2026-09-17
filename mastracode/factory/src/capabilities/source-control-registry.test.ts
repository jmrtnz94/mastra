import { describe, expect, it } from 'vitest';
import { SourceControlStorageInMemory } from '../storage/domains/source-control/inmemory.js';
import { SourceControlRegistry } from './source-control-registry.js';

async function seed(provider: string, factoryProjectId = 'factory', slug = 'team/repo') {
  const storage = new SourceControlStorageInMemory(provider);
  const installation = await storage.installations.upsert({
    orgId: 'org',
    connectedByUserId: 'user',
    externalId: 'account',
  });
  const repository = await storage.repositories.upsert({
    orgId: 'org',
    input: { installationId: installation.id, externalId: 'repo', slug, defaultBranch: 'main' },
  });
  const connection = await storage.connections.create({
    orgId: 'org',
    factoryProjectId,
    installationId: installation.id,
    createdByUserId: 'user',
  });
  const link = await storage.projectRepositories.link({
    orgId: 'org',
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: 'user',
    sandboxProvider: 'local',
    sandboxWorkdir: '/sandbox',
  });
  const session = await storage.sessions.create({
    sessionId: `${provider}-session`,
    projectRepositoryId: link.id,
    orgId: 'org',
    userId: 'user',
    branch: 'work',
    baseBranch: 'main',
  });
  return { storage, session, link };
}

describe('SourceControlRegistry', () => {
  it('resolves a custom provider regardless of registration order', async () => {
    const github = await seed('github', 'home');
    const forge = await seed('custom-forge', 'work');
    for (const handles of [
      [github.storage, forge.storage],
      [forge.storage, github.storage],
    ]) {
      const registry = new SourceControlRegistry(handles);
      expect(await registry.forSession(forge.session.sessionId)).toBe(forge.storage);
      expect(await registry.forProject({ orgId: 'org', factoryProjectId: 'work' })).toBe(forge.storage);
      expect(await registry.forRepository('org', forge.link.id)).toBe(forge.storage);
      expect(await registry.forRepository('another-org', forge.link.id)).toBeNull();
    }
  });

  it('does not select an arbitrary provider for ambiguous factory repositories', async () => {
    const first = await seed('first');
    const second = await seed('second');
    const registry = new SourceControlRegistry([first.storage, second.storage]);
    await expect(registry.forProject({ orgId: 'org', factoryProjectId: 'factory' })).rejects.toThrow(
      'multiple providers',
    );
    expect(await registry.forProject({ orgId: 'org', factoryProjectId: 'factory', integrationId: 'second' })).toBe(
      second.storage,
    );
    expect(await registry.forProject({ orgId: 'wrong-org', factoryProjectId: 'factory' })).toBeNull();
  });

  it('routes session writes only to the owning provider', async () => {
    const first = await seed('first');
    const second = await seed('second');
    const registry = new SourceControlRegistry([first.storage, second.storage]);
    await registry.sessions.rename({ sessionId: second.session.sessionId, title: 'Updated' });
    await registry.sessions.markFirstMessage({ sessionId: second.session.sessionId });
    expect((await second.storage.sessions.getBySessionId(second.session.sessionId))?.title).toBe('Updated');
    expect((await second.storage.sessions.getBySessionId(second.session.sessionId))?.firstMessageAt).not.toBeNull();
    expect((await first.storage.sessions.getBySessionId(first.session.sessionId))?.title).toBeNull();
    expect((await first.storage.sessions.getBySessionId(first.session.sessionId))?.firstMessageAt).toBeNull();
  });

  it('fails closed on duplicate ownership and unknown sessions', async () => {
    const first = await seed('first');
    const second = await seed('second');
    second.storage.sessionsRows[0]!.sessionId = first.session.sessionId;
    const registry = new SourceControlRegistry([first.storage, second.storage]);
    await expect(registry.forSession(first.session.sessionId)).rejects.toThrow('ambiguous');
    expect(await registry.forSession('unknown')).toBeNull();
    expect(() => new SourceControlRegistry([first.storage, first.storage])).toThrow('Duplicate');
  });
});
