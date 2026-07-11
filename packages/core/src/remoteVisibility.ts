export type RemoteAccess =
  | { kind: 'anonymous-readable' }
  | { kind: 'denied'; status: number }
  | { kind: 'indeterminate'; reason: string };

export interface ProbeAnonymousReadOptions {
  /** Injectable only for tests; production uses the credential-free global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// Ten seconds bounds a network preflight without making a transient remote outage a hard failure.
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Converts Git's SSH spellings to an anonymous HTTPS endpoint. Host names are
 * deliberately not allowlisted: the protocol conversion is syntactic.
 */
export function deriveAnonymousProbeUrl(remoteUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(remoteUrl);
    if (!scp) return undefined;
    // Re-parse to reject malformed hosts (e.g. IPv6 scp forms) rather than
    // returning a string that throws later outside the probe's try block.
    try {
      return new URL(`https://${scp[1]}/${scp[2]}`).toString();
    } catch {
      return undefined;
    }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return undefined;
  // Rebuild over https from host/path only. This drops any embedded credentials
  // (e.g. https://x-access-token:TOKEN@host/…) so a userinfo-bearing URL still
  // gets a real public/denied verdict instead of degrading to indeterminate,
  // and correctly rewrites ssh:// (a non-special scheme whose protocol setter
  // will not flip to https in place).
  return `https://${url.host}${url.pathname}${url.search}${url.hash}`;
}

export async function probeAnonymousRead(
  probeUrl: string | undefined,
  options: ProbeAnonymousReadOptions = {},
): Promise<RemoteAccess> {
  if (!probeUrl) return { kind: 'indeterminate', reason: 'remote URL cannot be probed anonymously' };

  const endpoint = new URL('info/refs?service=git-upload-pack', ensureTrailingSlash(probeUrl));
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(endpoint, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    // 401/404 = the forge itself denies anonymous access (safe: it's private).
    // 403 is NOT included: a WAF/bot-block/rate-limit in front of a *public*
    // repo also returns 403, so treating it as denied would let a public remote
    // pass. Fail closed — classify 403 as indeterminate.
    if (response.status === 401 || response.status === 404) {
      return { kind: 'denied', status: response.status };
    }
    if (!response.ok) return { kind: 'indeterminate', reason: `unexpected HTTP status ${response.status}` };
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/x-git-upload-pack-advertisement') {
      return { kind: 'indeterminate', reason: 'missing Git smart-HTTP advertisement content type' };
    }
    return { kind: 'anonymous-readable' };
  } catch {
    return { kind: 'indeterminate', reason: 'anonymous read probe request failed' };
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
