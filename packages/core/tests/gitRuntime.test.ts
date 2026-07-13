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
): Promise<{ url: string; close: () => Promise<void> }> {
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
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('createGit runtime policy', { timeout: GIT_RUNTIME_TEST_TIMEOUT_MS }, () => {
  it('kills a silent git child after the configured inactivity timeout', async () => {
    const root = makeTmpDir();
    const server = await startLocalServer(() => {
      // Accept the connection but never write stdout/stderr-producing response
      // data back to git; simple-git's timeout.block should kill the child.
    });

    try {
      const error = await createGit(root, { timeoutMs: 500 })
        .clone(server.url, join(root, 'clone'))
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(GitPluginError);
      expect(error).toMatchObject({
        plugin: 'timeout',
        message: expect.stringContaining('block timeout reached'),
      });
    } finally {
      await server.close();
      // Windows can retain the terminated git process' directory handle briefly
      // after simple-git has already reported the timeout. Keep the timeout
      // assertion strict, but let the OS finish releasing that handle before
      // the shared afterEach cleanup removes the fixture.
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
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

  it('allows inherited pager environment variables even when their value is empty', async () => {
    vi.stubEnv('PAGER', '');

    await expect(createGit(makeTmpDir()).init()).resolves.toBeDefined();
  });

  it('allows inherited ssh command environment variables', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh');

    await expect(createGit(makeTmpDir()).init()).resolves.toBeDefined();
  });
});
