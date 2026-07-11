import { describe, expect, it } from 'vitest';
import {
  deriveAnonymousProbeUrl,
  probeAnonymousRead,
} from '../src/remoteVisibility.js';
import { classifyVisibility } from '../src/visibility.js';

describe('classifyVisibility', () => {
  it('accepts only exact public and private values', () => {
    expect(classifyVisibility('public')).toBe('public');
    expect(classifyVisibility('private')).toBe('private');
  });

  it.each([' Public', 'public ', 'PUBLIC', '', undefined, null])('rejects %j without normalization', (value) => {
    expect(classifyVisibility(value)).toBe('invalid');
  });
});

describe('deriveAnonymousProbeUrl', () => {
  it('keeps HTTPS repository locations as-is', () => {
    expect(deriveAnonymousProbeUrl('https://example.test/org/repo.git')).toBe(
      'https://example.test/org/repo.git',
    );
  });

  it('converts scp-style and ssh URLs without a host allowlist', () => {
    expect(deriveAnonymousProbeUrl('git@forge.example:org/repo.git')).toBe(
      'https://forge.example/org/repo.git',
    );
    expect(deriveAnonymousProbeUrl('ssh://git@forge.example:8443/org/repo.git')).toBe(
      'https://forge.example:8443/org/repo.git',
    );
  });

  it('strips embedded credentials so a public repo is still detectable', () => {
    // A userinfo-bearing URL must not degrade the probe to indeterminate.
    expect(deriveAnonymousProbeUrl('https://x-access-token:ghp_secret@example.test/org/repo.git')).toBe(
      'https://example.test/org/repo.git',
    );
    expect(deriveAnonymousProbeUrl('ssh://git@forge.example/org/repo.git')).toBe(
      'https://forge.example/org/repo.git',
    );
  });

  it('rejects non-network Git remotes', () => {
    expect(deriveAnonymousProbeUrl('/tmp/repo.git')).toBeUndefined();
    expect(deriveAnonymousProbeUrl('file:///tmp/repo.git')).toBeUndefined();
    expect(deriveAnonymousProbeUrl('http://example.test/repo.git')).toBeUndefined();
  });

  it('rejects malformed scp forms rather than yielding a throwing URL', () => {
    // IPv6 scp form is not representable as a plain host:path — must be undefined,
    // not a string that throws when the probe later constructs a URL from it.
    expect(deriveAnonymousProbeUrl('git@[::1]:org/repo.git')).toBeUndefined();
  });
});

describe('probeAnonymousRead', () => {
  const smartAdvertisement = new Response('', {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-advertisement; charset=utf-8' },
  });

  it('recognizes a smart-HTTP advertisement as anonymous-readable without request headers', async () => {
    let requested: URL | undefined;
    let init: RequestInit | undefined;
    const result = await probeAnonymousRead('https://example.test/repo.git', {
      fetchImpl: async (input, requestInit) => {
        requested = new URL(input.toString());
        init = requestInit;
        return smartAdvertisement;
      },
    });
    expect(result).toEqual({ kind: 'anonymous-readable' });
    expect(requested?.toString()).toBe('https://example.test/repo.git/info/refs?service=git-upload-pack');
    expect(init).toMatchObject({ method: 'GET', redirect: 'follow' });
    expect(init?.headers).toBeUndefined();
  });

  it.each([401, 404])('recognizes HTTP %i as denied', async (status) => {
    expect(await probeAnonymousRead('https://example.test/repo.git', {
      fetchImpl: async () => new Response('', { status }),
    })).toEqual({ kind: 'denied', status });
  });

  it('treats 403 as indeterminate, not denied (a WAF fronting a public repo returns 403)', async () => {
    expect(await probeAnonymousRead('https://example.test/repo.git', {
      fetchImpl: async () => new Response('', { status: 403 }),
    })).toEqual({ kind: 'indeterminate', reason: 'unexpected HTTP status 403' });
  });

  it('requires a Git smart-HTTP advertisement content type', async () => {
    await expect(probeAnonymousRead('https://example.test/repo.git', {
      fetchImpl: async () => new Response('', { status: 200 }),
    })).resolves.toEqual({ kind: 'indeterminate', reason: 'missing Git smart-HTTP advertisement content type' });
  });

  it('returns a reason for unsupported URLs and transport failures', async () => {
    await expect(probeAnonymousRead(undefined)).resolves.toEqual({
      kind: 'indeterminate', reason: 'remote URL cannot be probed anonymously',
    });
    await expect(probeAnonymousRead('https://example.test/repo.git', {
      fetchImpl: async () => { throw new Error('network unavailable'); },
      timeoutMs: 1,
    })).resolves.toEqual({ kind: 'indeterminate', reason: 'anonymous read probe request failed' });
  });
});
