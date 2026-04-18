import type { DatabaseSync } from 'node:sqlite';
import { search } from './repository.js';
import { randomHex } from './id.js';

export interface BriefResult {
  brief_id: string;
  text: string;
}

export function generateBrief(db: DatabaseSync, topic: string, limit = 10): BriefResult {
  // search() now sanitizes FTS queries internally, so raw topic is fine.
  const related = topic.trim().length > 0 ? search(db, { query: topic, limit }) : [];
  const brief_id = `brf-${Date.now().toString(36)}-${randomHex(8)}`;

  const lines: string[] = [];
  lines.push(`# 調査依頼: ${topic}`);
  lines.push('');
  lines.push('## 依頼の背景');
  lines.push(
    `以下の話題について、一次ソース中心で調査してください: ${topic}`,
  );
  lines.push('');

  if (related.length > 0) {
    lines.push('## 既存の関連 caveat（参考）');
    for (const r of related) {
      lines.push(`- \`${r.id}\` (${r.confidence}) ${r.title}`);
    }
    lines.push('');
  }

  lines.push('## 求めたい情報');
  lines.push('1. 公式仕様 (RFC / 仕様書 / ベンダー公式ドキュメント) — バージョン明記');
  lines.push('2. 既知の落とし穴 (バージョン依存、プラットフォーム差異、既報の不具合)');
  lines.push('3. 回避策と代替手段（効果の裏取りつき）');
  lines.push('4. 一次ソース URL。二次ソース（ブログ等）は区別して記載');
  lines.push('');
  lines.push('## 出力の形');
  lines.push('Symptom / Cause / Resolution / Evidence の 4 セクションで、後続の `ingest_research` に渡せる形式で返してください。');
  lines.push('');
  lines.push('---');
  lines.push(`brief_id: ${brief_id}`);

  return { brief_id, text: lines.join('\n') };
}
