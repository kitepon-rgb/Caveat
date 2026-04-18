import { randomBytes } from 'node:crypto';

export function randomHex(hexChars: number): string {
  const bytes = Math.ceil(hexChars / 2);
  return randomBytes(bytes).toString('hex').slice(0, hexChars);
}

export function slugify(title: string, now: () => Date = () => new Date()): string {
  const lowered = title.toLowerCase();
  const sluggy = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sluggy || !/^[a-z0-9]/.test(sluggy)) {
    const d = now();
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = d.getUTCDate().toString().padStart(2, '0');
    return `entry-${yyyy}${mm}${dd}-${randomHex(6)}`;
  }
  return sluggy;
}

export function resolveCollision(baseId: string, exists: (candidate: string) => boolean): string {
  if (!exists(baseId)) return baseId;
  let n = 2;
  while (exists(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

export function generateSourceSession(now: () => Date = () => new Date()): string {
  return `${now().toISOString()}/${randomHex(12)}`;
}
