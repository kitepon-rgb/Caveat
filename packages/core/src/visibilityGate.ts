import { parseMarkdown } from './frontmatter.js';

export interface StagedFileInput {
  path: string;
  content: string;
}

export function findBlockedFiles(stagedContents: StagedFileInput[]): string[] {
  const blocked: string[] = [];
  for (const { path, content } of stagedContents) {
    let fm;
    try {
      fm = parseMarkdown(content).frontmatter;
    } catch {
      continue;
    }
    if (fm && (fm as { visibility?: string }).visibility === 'private') {
      blocked.push(path);
    }
  }
  return blocked;
}
