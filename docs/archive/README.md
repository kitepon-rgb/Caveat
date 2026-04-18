# docs/archive/

設計の途中経過・没案・別 Claude との対話ログなどを置く場所。**現役の設計は [../plan.md](../plan.md) を参照**。

## 中身

### [knowledge-base-design-notes.md](knowledge-base-design-notes.md)
2026-04-18、別セッションの Claude とユーザーが練ったブレインストーム。優先度 A/B/C で項目を整理したもの。ECC 監査の結果：

- **採用**（plan.md に反映済）: A-1 confidence 値の明文化、B-2 `last_verified` フィールド、A-3 `outcome: impossible` の扱い（record 時の Context 節含む）、B-1 統計シグナル検知（v1 以降の拡張に明記）、B-3 エピソード/パターン層分離（v1 以降）、Claude Doctor との軸分け（設計思想）
- **却下**: A-2 `version` 単純化（現行 `environment` オブジェクトの方が豊か）、A-4 概要返し（既実装）、C-1 secret scrub（多層防御）、C-2 author/verified_by（既存 `source` で代替）

反映済み・却下済みなので現役資料としては参照不要。設計の経緯を追うときの史料として保存。
