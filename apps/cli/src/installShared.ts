import { accessSync, copyFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/**
 * Claude / Codex 両インストーラで共有するヘルパ。ホスト固有なのは
 * 「設定ファイルの形式」と「command の形」だけで、パスの quote・token 分解・
 * canonical asset 判定・backup 付き書き込みは同一実装を使う。
 * 片方だけ直して挙動がズレる事故(Mac を直すと Win が壊れる)をここで防ぐ。
 */

/**
 * Hook host の shell に渡す実行パスを quote する。Windows の `C:\\...` は
 * 空白がなくても Claude の POSIX shell で backslash escape と解釈されるため、
 * whitespace または backslash を含むパスは必ず quote する。
 */
export function quoteCommandPath(p: string): string {
  return /[\s\\]/.test(p) ? `"${p}"` : p;
}

/** hook command 文字列を quote 対応で token 分解する。不正な形は null。 */
export function commandTokens(command: string): string[] | null {
  const tokens: string[] = []; const pattern = /"([^"]*)"|([^\s"]+)/g; let end = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) { if (command.slice(end, match.index).trim()) return null; tokens.push(match[1] ?? match[2]!); end = pattern.lastIndex; }
  return command.slice(end).trim() ? null : tokens;
}

/** installer が所有する実在アセット(node バイナリ / CLI スクリプト)だけを認める。 */
export function isCanonicalAsset(path: unknown, expectedPath: string, mode: number): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || !isAbsolute(expectedPath)) return false;
  try { accessSync(path, mode); return statSync(path).isFile() && realpathSync(path) === realpathSync(expectedPath); } catch { return false; }
}

/** 既存ファイルを `.caveat-backup-<ts>` へ退避してからテキストを書く。backup パス('' = 新規)を返す。 */
export function writeFileWithBackup(path: string, text: string): string {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let backupPath = '';
  if (existsSync(path)) {
    backupPath = `${path}.caveat-backup-${Date.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, text, 'utf-8');
  return backupPath;
}

export function writeJsonWithBackup(path: string, value: unknown): string {
  return writeFileWithBackup(path, `${JSON.stringify(value, null, 2)}\n`);
}
