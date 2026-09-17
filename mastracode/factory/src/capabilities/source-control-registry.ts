import type { SourceControlSession, SourceControlStorageHandle } from '../storage/domains/source-control/base.js';

/** Resolves persisted ownership; never chooses the first registered provider. */
export class SourceControlRegistry {
  readonly #handles: ReadonlyMap<string, SourceControlStorageHandle>;

  constructor(handles: SourceControlStorageHandle[]) {
    const entries = new Map<string, SourceControlStorageHandle>();
    for (const handle of handles) {
      if (entries.has(handle.integrationId))
        throw new Error(`Duplicate source-control provider: ${handle.integrationId}`);
      entries.set(handle.integrationId, handle);
    }
    this.#handles = entries;
  }

  async resolveSession(
    sessionId: string,
  ): Promise<{ storage: SourceControlStorageHandle; session: SourceControlSession } | null> {
    const matches = (
      await Promise.all(
        [...this.#handles.values()].map(async storage => {
          const session = await storage.sessions.getBySessionId(sessionId);
          return session ? { storage, session } : null;
        }),
      )
    ).filter(
      (match): match is { storage: SourceControlStorageHandle; session: SourceControlSession } => match !== null,
    );
    if (matches.length > 1) throw new Error('Factory session has ambiguous source-control ownership.');
    return matches[0] ?? null;
  }

  async forSession(sessionId: string): Promise<SourceControlStorageHandle | null> {
    return (await this.resolveSession(sessionId))?.storage ?? null;
  }

  async forProject(input: {
    orgId: string;
    factoryProjectId: string;
    repositorySlug?: string;
    integrationId?: string;
  }): Promise<SourceControlStorageHandle | null> {
    const matches: SourceControlStorageHandle[] = [];
    for (const storage of this.#handles.values()) {
      if (input.integrationId && input.integrationId !== storage.integrationId) continue;
      const connections = await storage.connections.list({
        orgId: input.orgId,
        factoryProjectId: input.factoryProjectId,
      });
      let matched = false;
      for (const connection of connections) {
        const links = await storage.projectRepositories.list({ orgId: input.orgId, connectionId: connection.id });
        for (const link of links) {
          const repository = await storage.repositories.get({ orgId: input.orgId, id: link.repositoryId });
          if (repository && (!input.repositorySlug || repository.slug === input.repositorySlug)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (matched) matches.push(storage);
    }
    if (matches.length > 1)
      throw new Error('Select a repository provider for this Factory run; multiple providers match.');
    return matches[0] ?? null;
  }

  async forRepository(orgId: string, projectRepositoryId: string): Promise<SourceControlStorageHandle | null> {
    const matches = (
      await Promise.all(
        [...this.#handles.values()].map(async storage =>
          (await storage.projectRepositories.get({ orgId, id: projectRepositoryId })) ? storage : null,
        ),
      )
    ).filter((storage): storage is SourceControlStorageHandle => storage !== null);
    if (matches.length > 1) throw new Error('Factory repository has ambiguous source-control ownership.');
    return matches[0] ?? null;
  }

  readonly sessions = {
    getBySessionId: async (sessionId: string) => (await this.resolveSession(sessionId))?.session ?? null,
    rename: async (input: { sessionId: string; title: string }) => {
      await (await this.forSession(input.sessionId))?.sessions.rename(input);
    },
    markFirstMessage: async (input: { sessionId: string }) => {
      await (await this.forSession(input.sessionId))?.sessions.markFirstMessage(input);
    },
    markFirstMeaningfulExec: async (input: { sessionId: string }) => {
      await (await this.forSession(input.sessionId))?.sessions.markFirstMeaningfulExec(input);
    },
  };
}
