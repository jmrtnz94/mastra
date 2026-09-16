import { createSandboxLifecycleTests } from '@internal/workspace-test-utils';
import { SandboxUnsupportedFeatureError } from '@mastra/core/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CloudflareSandbox } from './sandbox';
import { createFakeBridge, type FakeBridge } from './testing/fake-bridge';

const BASE_URL = 'https://bridge.example.com';

function createSandbox(bridge: FakeBridge, options: Partial<ConstructorParameters<typeof CloudflareSandbox>[0]> = {}) {
  return new CloudflareSandbox({ baseUrl: BASE_URL, apiToken: 'secret', fetch: bridge.fetch, ...options });
}

describe('CloudflareSandbox', () => {
  it('creates a remote sandbox on start and deletes it on destroy', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { id: 'logical-1' });

    await sandbox._start();

    expect(bridge.sandboxes.has('sbx-1')).toBe(true);
    expect(sandbox.getInfo().id).toBe('logical-1');
    expect(sandbox.getInfo().metadata?.sandboxId).toBe('sbx-1');

    await sandbox._destroy();

    expect(bridge.sandboxes.size).toBe(0);
  });

  it('reconnects to an existing sandbox instead of creating one', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    bridge.sandboxes.add('existing-1');
    const sandbox = createSandbox(bridge, { sandboxId: 'existing-1' });

    await sandbox._start();

    expect(bridge.requests.map(request => request.url)).toEqual([`${BASE_URL}/v1/sandbox/existing-1/running`]);
    expect(sandbox.getInfo().metadata?.sandboxId).toBe('existing-1');
  });

  it('passes command, args, env and cwd through as argv', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { env: { BASE: '1' }, workingDirectory: '/workspace/app' });
    await sandbox._start();

    await sandbox.executeCommand('echo', ["it's fine"], { env: { EXTRA: 'a b' } });

    expect(bridge.execs[0]).toEqual({
      argv: ['env', 'BASE=1', 'EXTRA=a b', 'echo', "it's fine"],
      timeout_ms: 300_000,
      cwd: '/workspace/app',
    });
  });

  it('runs a bare command string through a shell so pipes and chaining work', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await sandbox.executeCommand("printf '%s' native-tool-ok");

    expect(bridge.execs[0]!.argv).toEqual(['/bin/bash', '-c', "printf '%s' native-tool-ok"]);
  });

  it('keeps the env prefix before the shell when running a bare command string', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { env: { BASE: '1' } });
    await sandbox._start();

    await sandbox.executeCommand('echo hi');

    expect(bridge.execs[0]!.argv).toEqual(['env', 'BASE=1', '/bin/bash', '-c', 'echo hi']);
  });

  it('treats an empty args array as a bare shell command string', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await sandbox.executeCommand('echo hello && echo world', []);

    expect(bridge.execs[0]!.argv).toEqual(['/bin/bash', '-c', 'echo hello && echo world']);
  });

  it('keeps explicit argument arrays literal', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await sandbox.executeCommand('printf', ['%s', 'direct-control-ok']);

    expect(bridge.execs[0]!.argv).toEqual(['printf', '%s', 'direct-control-ok']);
  });

  it('per-command cwd overrides the configured workingDirectory', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { workingDirectory: '/workspace/app' });
    await sandbox._start();

    await sandbox.executeCommand('pwd', undefined, { cwd: '/workspace/other' });

    expect(bridge.execs[0]!.cwd).toBe('/workspace/other');
    expect(sandbox.workingDirectory).toBe('/workspace/app');
  });

  it('omits cwd when no workingDirectory is configured', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await sandbox.executeCommand('pwd');

    expect(bridge.execs[0]!.cwd).toBeUndefined();
    expect(sandbox.workingDirectory).toBeUndefined();
  });

  it('setEnv after construction reaches subsequent commands', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    sandbox.setEnv(env => ({ ...env, GH_TOKEN: 'tok_1' }));
    await sandbox.executeCommand('echo', ['hi']);

    expect(bridge.execs[0]!.argv).toEqual(['env', 'GH_TOKEN=tok_1', 'echo', 'hi']);
  });

  it('decodes streamed output and reports the exit code', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    bridge.onExec = () => ({ stdout: 'hello wörld\n', stderr: 'oops\n', exitCode: 2, stdoutChunks: 5 });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await sandbox.executeCommand('echo', ['hello'], {
      onStdout: chunk => stdoutChunks.push(chunk),
      onStderr: chunk => stderrChunks.push(chunk),
    });

    expect(result.stdout).toBe('hello wörld\n');
    expect(result.stderr).toBe('oops\n');
    expect(result.exitCode).toBe(2);
    expect(result.success).toBe(false);
    expect(stdoutChunks.join('')).toBe('hello wörld\n');
    expect(stderrChunks.join('')).toBe('oops\n');
  });

  it('records bridge error events as stderr', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    bridge.onExec = () => ({ error: { error: 'container is gone', code: 'NOT_RUNNING' } });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    const result = await sandbox.executeCommand('echo', ['hi']);

    expect(result.stderr).toContain('container is gone');
    expect(result.success).toBe(false);
  });

  it('writes each file with its own request under /workspace', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await sandbox.writeFiles([
      { path: 'src/index.ts', content: 'export const a = 1;' },
      { path: '/workspace/bin/data', content: Buffer.from('hi') },
    ]);

    expect(bridge.files.get('/workspace/src/index.ts')).toBe('export const a = 1;');
    expect(bridge.files.get('/workspace/bin/data')).toBe('hi');
  });

  it('rejects writes that escape /workspace', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await expect(sandbox.writeFiles([{ path: '/etc/passwd', content: 'x' }])).rejects.toThrow(/under \/workspace/);
    await expect(sandbox.writeFiles([{ path: '../../etc/passwd', content: 'x' }])).rejects.toThrow(/under \/workspace/);
    expect(bridge.files.size).toBe(0);
  });

  it('requires start before remote operations', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { id: 'not-started' });

    await expect(sandbox.executeCommand('echo', ['hi'])).rejects.toThrow(/has not been started/);
    await expect(sandbox.writeFiles([{ path: 'a.txt', content: 'x' }])).rejects.toThrow(/has not been started/);
  });

  it('rejects an explicit per-file mode without writing', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await expect(sandbox.writeFiles([{ path: 'a.txt', content: 'x', mode: 0o600 }])).rejects.toThrow(
      SandboxUnsupportedFeatureError,
    );
    expect(bridge.files.size).toBe(0);
  });

  it('reads a file back under /workspace', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();
    await sandbox.writeFiles([{ path: 'src/index.ts', content: 'export const a = 1;' }]);

    const bytes = await sandbox.readFile('src/index.ts');

    expect(Buffer.from(bytes).toString('utf8')).toBe('export const a = 1;');
  });

  it('rejects reads that escape /workspace', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await expect(sandbox.readFile('../../etc/passwd')).rejects.toThrow(/under \/workspace/);
  });

  it('persists and hydrates /workspace through the bridge', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    const archive = await sandbox.persistWorkspace({ excludes: ['node_modules'] });
    expect(Buffer.from(archive).toString('utf8')).toBe('fake-tar-archive');
    expect(bridge.persists.at(-1)).toBe('node_modules');

    await sandbox.hydrateWorkspace(new Uint8Array([9, 8, 7]));
    expect(Array.from(bridge.hydrations.at(-1)!)).toEqual([9, 8, 7]);
  });

  it('mounts and unmounts a bucket through the bridge', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge);
    await sandbox._start();

    await sandbox.mountBucket({ bucket: 'my-bucket', mountPath: '/mnt/data', options: { readOnly: true } });
    expect(bridge.mounts.at(-1)).toEqual({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: { readOnly: true },
    });

    await sandbox.unmountBucket('/mnt/data');
    expect(bridge.unmounts.at(-1)).toEqual({ mountPath: '/mnt/data' });
  });

  it('requires start before mountBucket and unmountBucket', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { id: 'not-started-mount' });

    await expect(sandbox.mountBucket({ bucket: 'b', mountPath: '/mnt/data' })).rejects.toThrow(/has not been started/);
    await expect(sandbox.unmountBucket('/mnt/data')).rejects.toThrow(/has not been started/);
  });

  it('requires start before readFile, persistWorkspace and hydrateWorkspace', async () => {
    const bridge = createFakeBridge({ apiToken: 'secret' });
    const sandbox = createSandbox(bridge, { id: 'not-started-2' });

    await expect(sandbox.readFile('a.txt')).rejects.toThrow(/has not been started/);
    await expect(sandbox.persistWorkspace()).rejects.toThrow(/has not been started/);
    await expect(sandbox.hydrateWorkspace(new Uint8Array([1]))).rejects.toThrow(/has not been started/);
  });

  describe('instructions', () => {
    it('warns that /workspace is ephemeral when no persistence is configured', () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const sandbox = createSandbox(bridge);

      const instructions = sandbox.getInstructions();
      expect(instructions).not.toContain('persistent');
      expect(instructions).toMatch(/do NOT survive/);
    });

    it('describes restore-on-wake when persistence is configured', () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const sandbox = createSandbox(bridge, {
        persistence: { load: async () => undefined, save: async () => {} },
      });

      expect(sandbox.getInstructions()).toMatch(/restored when the container wakes/);
    });

    it('lets a custom instructions override win', () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const sandbox = createSandbox(bridge, { instructions: 'custom text' });

      expect(sandbox.getInstructions()).toBe('custom text');
    });
  });

  describe('automatic persistence', () => {
    it('persists /workspace after a successful command', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const store = { archive: undefined as Uint8Array | undefined, saves: 0 };
      const persistence = {
        excludes: ['node_modules'],
        load: async () => store.archive,
        save: async (bytes: Uint8Array) => {
          store.archive = bytes;
          store.saves++;
        },
      };
      const sandbox = createSandbox(bridge, { persistence });
      await sandbox._start();

      await sandbox.executeCommand('echo', ['hi']);

      expect(store.saves).toBe(1);
      expect(Buffer.from(store.archive!).toString('utf8')).toBe('fake-tar-archive');
      expect(bridge.persists.at(-1)).toBe('node_modules');
    });

    it('restores /workspace when a slept container wakes for the next command', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const store = { archive: undefined as Uint8Array | undefined };
      const persistence = {
        load: async () => store.archive,
        save: async (bytes: Uint8Array) => {
          store.archive = bytes;
        },
      };
      const sandbox = createSandbox(bridge, { persistence });
      await sandbox._start();

      // First command runs against the live container and saves a snapshot.
      await sandbox.executeCommand('echo', ['hi']);
      expect(store.archive).toBeDefined();

      // Simulate the idle container sleeping between turns.
      const sandboxId = sandbox.getInfo().metadata?.sandboxId as string;
      bridge.sandboxes.delete(sandboxId);
      bridge.hydrations.length = 0;

      await sandbox.executeCommand('echo', ['again']);

      expect(bridge.hydrations).toHaveLength(1);
      expect(Buffer.from(bridge.hydrations[0]!).toString('utf8')).toBe('fake-tar-archive');
    });

    it('does not touch the store or check running state without persistence', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const sandbox = createSandbox(bridge);
      await sandbox._start();

      await sandbox.executeCommand('echo', ['hi']);

      expect(bridge.requests.some(request => request.url.endsWith('/running'))).toBe(false);
      expect(bridge.persists).toHaveLength(0);
      expect(bridge.hydrations).toHaveLength(0);
    });

    it('fails the command when restoring on wake fails', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      let loadCalls = 0;
      const persistence = {
        load: async () => {
          loadCalls++;
          if (loadCalls === 1) return undefined; // start(): nothing saved yet
          throw new Error('store offline');
        },
        save: async () => {},
      };
      const sandbox = createSandbox(bridge, { persistence });
      await sandbox._start();

      const sandboxId = sandbox.getInfo().metadata?.sandboxId as string;
      bridge.sandboxes.delete(sandboxId);

      await expect(sandbox.executeCommand('echo', ['hi'])).rejects.toThrow(/store offline/);
    });

    it('hydrates /workspace from the store on a cold-boot start', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const persistence = {
        load: async () => new Uint8Array([1, 2, 3]),
        save: async () => {},
      };
      const sandbox = createSandbox(bridge, { persistence });

      await sandbox._start();

      expect(bridge.hydrations).toHaveLength(1);
      expect(Array.from(bridge.hydrations[0]!)).toEqual([1, 2, 3]);
    });

    it('does not hydrate on start when reconnecting to a running container', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const first = createSandbox(bridge, { persistence: { load: async () => undefined, save: async () => {} } });
      await first._start();
      const sandboxId = first.getInfo().metadata?.sandboxId as string;

      let loads = 0;
      const reconnected = createSandbox(bridge, {
        sandboxId,
        persistence: {
          load: async () => {
            loads++;
            return new Uint8Array([9]);
          },
          save: async () => {},
        },
      });

      await reconnected._start();

      expect(loads).toBe(0);
      expect(bridge.hydrations).toHaveLength(0);
    });

    it('persists a final snapshot on stop', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const store = { archive: undefined as Uint8Array | undefined, saves: 0 };
      const persistence = {
        load: async () => store.archive,
        save: async (bytes: Uint8Array) => {
          store.archive = bytes;
          store.saves++;
        },
      };
      const sandbox = createSandbox(bridge, { persistence });
      await sandbox._start();

      await sandbox._stop();

      expect(store.saves).toBe(1);
      expect(Buffer.from(store.archive!).toString('utf8')).toBe('fake-tar-archive');
    });

    it('does not fail the command when persisting fails', async () => {
      const bridge = createFakeBridge({ apiToken: 'secret' });
      const persistence = {
        load: async () => undefined,
        save: async () => {
          throw new Error('store full');
        },
      };
      const sandbox = createSandbox(bridge, { persistence });
      await sandbox._start();

      const result = await sandbox.executeCommand('echo', ['hi']);
      expect(result.success).toBe(true);
    });
  });
});

describe('CloudflareSandbox conformance', () => {
  const bridge = createFakeBridge({ apiToken: 'secret' });
  let sandbox: CloudflareSandbox;

  beforeAll(async () => {
    sandbox = createSandbox(bridge, { id: `conformance-${Date.now()}` });
    await sandbox._start();
  });

  afterAll(async () => {
    await sandbox._destroy();
  });

  createSandboxLifecycleTests(() => ({
    sandbox,
    capabilities: {
      supportsMounting: false,
      supportsReconnection: true,
      supportsConcurrency: true,
      supportsEnvVars: true,
      supportsWorkingDirectory: true,
      supportsTimeout: true,
      defaultCommandTimeout: 5000,
      supportsStreaming: true,
      supportsStdin: false,
    },
    testTimeout: 5000,
    fastOnly: false,
    createSandbox: () => createSandbox(bridge),
  }));
});
