import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type {
  CommandResult,
  ExecuteCommandOptions,
  MastraSandboxOptions,
  ProviderStatus,
  SandboxFileInput,
  SandboxInfo,
} from '@mastra/core/workspace';
import { MastraSandbox, assertModesUnsupported } from '@mastra/core/workspace';
import {
  CloudflareSandboxBridgeClient,
  type CloudflareMountBucketRequest,
  type CloudflarePersistWorkspaceOptions,
  type CloudflareSandboxBridgeClientOptions,
} from './bridge-client';

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const WORKSPACE_ROOT = '/workspace';

type InstructionsOption = string | ((options: { defaultInstructions: string }) => string);
type BridgeClient = Pick<
  CloudflareSandboxBridgeClient,
  | 'createSandbox'
  | 'isRunning'
  | 'deleteSandbox'
  | 'writeFile'
  | 'readFile'
  | 'persistWorkspace'
  | 'hydrateWorkspace'
  | 'mountBucket'
  | 'unmountBucket'
  | 'exec'
>;

/**
 * Caller-supplied durable store for `/workspace` archives.
 *
 * Cloudflare stops idle containers, discarding everything under `/workspace`
 * between turns. When a store is supplied, {@link CloudflareSandbox} archives
 * the workspace after commands and restores it whenever a fresh container
 * boots, so files survive an idle sleep. The provider does not know where the
 * archive should live, so persistence is the caller's responsibility.
 */
export interface CloudflareWorkspacePersistence {
  /** Returns the most recently saved archive, or undefined if none exists yet. */
  load(): Promise<Uint8Array | undefined>;
  /** Persists the latest archive produced by the bridge. */
  save(archive: Uint8Array): Promise<void>;
  /** Relative paths (under /workspace) to exclude from the archive, e.g. `['node_modules']`. */
  excludes?: string[];
}

export interface CloudflareSandboxOptions extends Omit<MastraSandboxOptions, 'processes'> {
  /** URL of a deployed Cloudflare Sandbox Bridge Worker. */
  baseUrl: string;
  /** Bearer token matching the Worker's `SANDBOX_API_KEY` secret, when authentication is enabled. */
  apiToken?: string;
  /** Stable Mastra identifier for this sandbox instance. */
  id?: string;
  /** Existing Cloudflare sandbox ID to reconnect to instead of creating a sandbox. */
  sandboxId?: string;
  /** Human-readable name shown in Mastra sandbox metadata. */
  name?: string;
  /** Environment variables applied to every command. */
  env?: Record<string, string>;
  /** Working directory applied to every command. Must be under /workspace. */
  workingDirectory?: string;
  /** Default command timeout in milliseconds. */
  commandTimeout?: number;
  /** Custom instructions returned by getInstructions(). */
  instructions?: InstructionsOption;
  /**
   * Durable store for `/workspace`. When set, the sandbox restores files on a
   * fresh container boot and persists them after commands, so they survive an
   * idle container sleep. Omit to keep `/workspace` as ephemeral scratch space.
   */
  persistence?: CloudflareWorkspacePersistence;
  /** Custom fetch implementation, primarily for advanced networking setup and tests. */
  fetch?: CloudflareSandboxBridgeClientOptions['fetch'];
  /** Preconfigured Bridge client, primarily for tests. */
  client?: BridgeClient;
}

/**
 * Absolute path to the shell used to interpret bare command strings. Absolute so it
 * resolves even when a custom PATH excludes the standard system directories.
 */
const SHELL_PATH = '/bin/bash';

/**
 * Builds the argv array sent to the bridge. The bridge applies ANSI-C quoting to
 * every element, so no local escaping is needed. Environment variables are applied
 * with `env`, which keeps each assignment a separate argv element.
 *
 * When no separate arguments are supplied (the shape the built-in Workspace
 * `execute_command` tool uses), `command` is a shell command string — pipes,
 * chaining, quoting, redirection — so it is run through a non-login shell rather
 * than treated as a single executable name. When explicit arguments are given,
 * each element stays a literal argv token.
 */
function buildArgv(command: string, args: string[] | undefined, env: Record<string, string>): string[] {
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    return `${key}=${value}`;
  });
  const invocation = args && args.length > 0 ? [command, ...args] : [SHELL_PATH, '-c', command];
  return assignments.length ? ['env', ...assignments, ...invocation] : invocation;
}

/** Resolves a path inside /workspace, rejecting anything that escapes the workspace root. */
function resolveWorkspacePath(path: string): string {
  const resolved = posix.resolve(WORKSPACE_ROOT, path);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`Cloudflare Sandbox files must be written under ${WORKSPACE_ROOT}: ${path}`);
  }
  return resolved;
}

export class CloudflareSandbox extends MastraSandbox {
  readonly id: string;
  readonly name: string;
  readonly provider = 'cloudflare-sandbox';
  status: ProviderStatus = 'pending';

  private readonly client: BridgeClient;
  private readonly commandTimeout: number;
  private readonly instructions?: InstructionsOption;
  private readonly persistence?: CloudflareWorkspacePersistence;
  private sandboxId?: string;
  private createdAt = new Date();
  private lastUsedAt?: Date;

  constructor(options: CloudflareSandboxOptions) {
    const name = options.name ?? 'Cloudflare Sandbox';
    super({ ...options, name });
    this.id = options.id ?? `cloudflare-sandbox-${randomUUID()}`;
    this.name = name;
    this.sandboxId = options.sandboxId;
    this.commandTimeout = options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.instructions = options.instructions;
    this.persistence = options.persistence;
    this.client =
      options.client ??
      new CloudflareSandboxBridgeClient({ baseUrl: options.baseUrl, apiToken: options.apiToken, fetch: options.fetch });
  }

  async start(): Promise<void> {
    if (this.sandboxId) {
      // The bridge boots the container on demand, so a stopped container is not fatal.
      const running = await this.client.isRunning(this.sandboxId);
      if (!running) {
        this.logger?.debug(`Cloudflare sandbox ${this.sandboxId} is not running yet; it starts on first use`);
      }
      await this.hydrateFromStore();
      return;
    }
    this.sandboxId = await this.client.createSandbox();
    this.createdAt = new Date();
    await this.hydrateFromStore();
  }

  async stop(): Promise<void> {
    // The bridge exposes create/delete but no suspend operation. Stop detaches this
    // Mastra lifecycle while preserving the remote sandbox for later reconnection.
    // Persist a final snapshot so the detached container's files are not lost.
    await this.persistToStore();
  }

  async destroy(): Promise<void> {
    if (!this.sandboxId) return;
    await this.client.deleteSandbox(this.sandboxId);
    this.sandboxId = undefined;
  }

  async executeCommand(command: string, args?: string[], options?: ExecuteCommandOptions): Promise<CommandResult> {
    const sandboxId = this.requireSandboxId();

    // The container may have slept between turns, discarding /workspace. Restore
    // it before running so the command sees the persisted files, not a blank VM.
    if (this.persistence && !(await this.client.isRunning(sandboxId))) {
      await this.hydrateFromStore();
    }

    const startedAt = Date.now();
    const timeout = options?.timeout ?? this.commandTimeout;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Command timeout must be positive');

    const controller = new AbortController();
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeout);
    const signal = options?.abortSignal ? AbortSignal.any([controller.signal, options.abortSignal]) : controller.signal;

    // stdout and stderr are separate byte streams, so each needs its own streaming decoder.
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    let stdout = '';
    let stderr = '';
    let exitCode = 1;

    const env = Object.fromEntries(
      Object.entries({ ...this.getEnv(), ...options?.env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

    try {
      await this.client.exec(
        sandboxId,
        {
          argv: buildArgv(command, args, env),
          timeoutMs: timeout,
          cwd: options?.cwd ?? this.workingDirectory,
        },
        {
          signal,
          onEvent: event => {
            switch (event.type) {
              case 'stdout': {
                const chunk = stdoutDecoder.decode(event.data, { stream: true });
                if (!chunk) return;
                stdout += chunk;
                options?.onStdout?.(chunk);
                return;
              }
              case 'stderr': {
                const chunk = stderrDecoder.decode(event.data, { stream: true });
                if (!chunk) return;
                stderr += chunk;
                options?.onStderr?.(chunk);
                return;
              }
              case 'exit':
                exitCode = event.exitCode;
                return;
              case 'error':
                stderr += event.message;
                options?.onStderr?.(event.message);
                return;
            }
          },
        },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }

    // Flush each decoder so a trailing truncated multi-byte sequence isn't dropped.
    const stdoutTail = stdoutDecoder.decode();
    if (stdoutTail) {
      stdout += stdoutTail;
      options?.onStdout?.(stdoutTail);
    }
    const stderrTail = stderrDecoder.decode();
    if (stderrTail) {
      stderr += stderrTail;
      options?.onStderr?.(stderrTail);
    }

    this.lastUsedAt = new Date();
    const result: CommandResult = {
      command,
      args,
      success: exitCode === 0 && !signal.aborted,
      exitCode,
      stdout,
      stderr,
      executionTimeMs: Date.now() - startedAt,
      timedOut: didTimeout,
      killed: signal.aborted && !didTimeout,
    };

    // Snapshot /workspace after a successful command so the changes survive an
    // idle container sleep. Best-effort: a failed snapshot must not fail the command.
    if (result.success) await this.persistToStore();

    return result;
  }

  async writeFiles(files: SandboxFileInput[]): Promise<void> {
    assertModesUnsupported(files, 'Cloudflare');
    const sandboxId = this.requireSandboxId();
    // The bridge writes one file per request.
    for (const file of files) {
      await this.client.writeFile(sandboxId, resolveWorkspacePath(file.path), file.content);
    }
    this.lastUsedAt = new Date();
  }

  /** Reads a single file under /workspace, returning its raw bytes. */
  async readFile(path: string): Promise<Uint8Array> {
    const sandboxId = this.requireSandboxId();
    const bytes = await this.client.readFile(sandboxId, resolveWorkspacePath(path));
    this.lastUsedAt = new Date();
    return bytes;
  }

  /** Archives /workspace, returning raw tar bytes that can later restore it via hydrateWorkspace. */
  async persistWorkspace(options?: CloudflarePersistWorkspaceOptions): Promise<Uint8Array> {
    const sandboxId = this.requireSandboxId();
    const archive = await this.client.persistWorkspace(sandboxId, options);
    this.lastUsedAt = new Date();
    return archive;
  }

  /** Restores /workspace from a raw tar payload produced by persistWorkspace. */
  async hydrateWorkspace(tar: Uint8Array): Promise<void> {
    const sandboxId = this.requireSandboxId();
    await this.client.hydrateWorkspace(sandboxId, tar);
    this.lastUsedAt = new Date();
  }

  /** Mounts an S3-compatible bucket (e.g. R2) as a directory in the sandbox. */
  async mountBucket(request: CloudflareMountBucketRequest): Promise<void> {
    const sandboxId = this.requireSandboxId();
    await this.client.mountBucket(sandboxId, request);
    this.lastUsedAt = new Date();
  }

  /** Unmounts a bucket previously mounted with {@link mountBucket}. */
  async unmountBucket(mountPath: string): Promise<void> {
    const sandboxId = this.requireSandboxId();
    await this.client.unmountBucket(sandboxId, mountPath);
    this.lastUsedAt = new Date();
  }

  /** Restores /workspace from the configured store, if a saved archive exists. */
  private async hydrateFromStore(): Promise<void> {
    if (!this.persistence) return;
    const archive = await this.persistence.load();
    if (!archive) return;
    await this.hydrateWorkspace(archive);
  }

  /** Archives /workspace and hands it to the configured store. Best-effort. */
  private async persistToStore(): Promise<void> {
    if (!this.persistence || !this.sandboxId) return;
    try {
      const archive = await this.persistWorkspace({ excludes: this.persistence.excludes });
      await this.persistence.save(archive);
    } catch (error) {
      this.logger?.warn(`Failed to persist Cloudflare sandbox ${this.sandboxId} workspace`, error);
    }
  }

  getInfo(): SandboxInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      metadata: {
        sandboxId: this.sandboxId,
        bridgeBaseUrl: this.client instanceof CloudflareSandboxBridgeClient ? this.client.baseUrl : undefined,
      },
    };
  }

  getInstructions(): string {
    const defaultInstructions = this.persistence
      ? 'Commands execute in a remote Cloudflare Sandbox. Work with project files under /workspace; the workspace is restored when the container wakes and persisted after commands, so files survive an idle container sleep.'
      : 'Commands execute in a remote Cloudflare Sandbox. Use /workspace as scratch space only: the container sleeps when idle and files under /workspace do NOT survive between commands. Do not assume earlier files still exist.';
    return typeof this.instructions === 'function'
      ? this.instructions({ defaultInstructions })
      : (this.instructions ?? defaultInstructions);
  }

  private requireSandboxId(): string {
    if (!this.sandboxId) throw new Error(`Cloudflare Sandbox ${this.id} has not been started`);
    return this.sandboxId;
  }
}
