import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitPluginError } from 'simple-git';
import { createGit } from '../src/gitRuntime.js';

const GIT_RUNTIME_TEST_TIMEOUT_MS = 15_000;

let tmpDir: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmpDir = undefined;
  }
});

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'caveat-git-runtime-'));
  return tmpDir;
}

async function startLocalServer(
  handler: (res: ServerResponse) => void,
): Promise<{ url: string; activeSocketCount: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => handler(res));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', onListening);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/x.git`,
    activeSocketCount: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('createGit runtime policy', { timeout: GIT_RUNTIME_TEST_TIMEOUT_MS }, () => {
  it('reports a silent git child and bounds its HTTP helper despite conflicting inherited low-speed env', async () => {
    const root = makeTmpDir();
    vi.stubEnv('GIT_HTTP_LOW_SPEED_LIMIT', '0');
    vi.stubEnv('GIT_HTTP_LOW_SPEED_TIME', '999');
    const server = await startLocalServer(() => {
      // Accept the connection but never write response data. simple-git's
      // timeout rejects the task, while Caveat's Git env must override the
      // inherited disabling values and terminate git-remote-http as well.
    });

    try {
      const git = createGit(root, { timeoutMs: 500 });
      await git.init();
      const error = await git.clone(server.url, join(root, 'clone'))
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(GitPluginError);
      expect(error).toMatchObject({
        plugin: 'timeout',
        message: expect.stringContaining('block timeout reached'),
      });
      await waitForNoSockets(server.activeSocketCount, 3_000);
      expect(server.activeSocketCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('disables interactive terminal prompts for git http authentication', async () => {
    const root = makeTmpDir();
    const server = await startLocalServer((res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
      res.end();
    });

    try {
      await expect(
        createGit(root).clone(server.url, join(root, 'clone')),
      ).rejects.toThrow(/terminal prompts disabled/i);
    } finally {
      await server.close();
    }
  });

  it('passes the inactivity bound to the git HTTP helper', async () => {
    const git = createGit(makeTmpDir(), { timeoutMs: 1_500 });

    await expect(git.raw(['config', '--get', 'http.lowSpeedLimit'])).resolves.toBe('1\n');
    await expect(git.raw(['config', '--get', 'http.lowSpeedTime'])).resolves.toBe('2\n');
  });

  it('allows inherited pager environment variables even when their value is empty', async () => {
    vi.stubEnv('PAGER', '');

    await expect(createGit(makeTmpDir()).init()).resolves.toBeDefined();
  });

  it('allows inherited ssh command environment variables', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh');

    await expect(createGit(makeTmpDir()).init()).resolves.toBeDefined();
  });
});

async function waitForNoSockets(activeSocketCount: () => number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeSocketCount() > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
