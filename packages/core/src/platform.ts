import type { Stats } from 'node:fs';

/**
 * OS 依存の判定はこのモジュールに集約する。他のファイルで
 * `process.platform` / `win32` を直接分岐しない(データとして記録する
 * fingerprint 等は除く)。全関数は platform を引数で受けてテスト可能にする。
 */

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * owner-only 所有チェック。Node の POSIX mode/uid フィールドは Windows では
 * ACL のビューにならないため、Windows は構造チェック(呼び出し側のマーカー・
 * スキーマ検証や親ディレクトリの ACL)に委ねて素通しする。
 */
export function isPrivateOwnerStat(
  stat: Stats,
  uid: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isWindows(platform)
    || ((stat.mode & 0o077) === 0 && (uid === undefined || stat.uid === uid));
}

/**
 * Windows native Codex hook command は quoted Node パスを PowerShell で
 * 実行するため call operator `&` が必要(v0.17.1)。POSIX は不要。
 */
export function powershellCallPrefix(platform: NodeJS.Platform = process.platform): string {
  return isWindows(platform) ? '& ' : '';
}

/** PATH 走査で node 実行ファイルとして探す名前の候補。 */
export function nodeExecutableNames(platform: NodeJS.Platform = process.platform): string[] {
  return isWindows(platform)
    ? ['node.exe', 'node.cmd', 'node.bat', 'node']
    : ['node'];
}

/**
 * ファイルシステムが case-insensitive な Windows ではパス比較用に小文字化する。
 * 呼び出し側で区切り文字の正規化(\\ → /)を済ませてから渡す。
 */
export function normalizePathCase(
  normalizedPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return isWindows(platform) ? normalizedPath.toLowerCase() : normalizedPath;
}
