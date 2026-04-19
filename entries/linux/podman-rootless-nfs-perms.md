---
id: podman-rootless-nfs-perms
title: 'Podman rootless + NFS + Nextcloud は data dir を 2777 + check_data_directory_permissions=false が必要'
visibility: public
confidence: confirmed
outcome: resolved
tags: [podman, rootless, nfs, nextcloud, uid-mapping, permissions]
environment:
  container: podman-rootless
  nfs: v4
  app: nextcloud
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Nextcloud を Podman rootless で起動、data directory は NFS mount（NAS）。Nextcloud は内部で data dir の permission を自己チェックする。

## Symptom
- 0750 / 0755 に設定すると container 内 apache2 (www-data) が write できない → 500 error
- 正しい uid で chown しても、**Podman rootless は UID remapping する**のでコンテナ内 UID 33 → host UID 524320（100000 + 33） → NAS には UID 524320 しか見えない
- それを許可しようと NFS export で uid 524320 を許可すると別の問題（他の client が混乱）
- Nextcloud の `check_data_directory_permissions` は 0770 を期待するので、緩くすると 403

## Cause
Podman rootless の UID remapping は host と container で UID 空間が分離される設計。NFS server は host UID しか見えない（NFSv4 の uid mapping は別設定が必要）。Nextcloud 側の permission check は伝統的な UID モデルを前提。3 者の前提がずれている。

## Resolution
**パーミッションを緩めて Nextcloud のチェックを無効化する**のが最も工数少ない解:

1. data dir: `chmod 2777 <data>`（SGID + rwx all。SGID は group 継承で整合性保持）
2. Nextcloud の `config.php`:
   ```php
   'check_data_directory_permissions' => false,
   ```

**注意**: 2777 は世間的にはセキュリティ警告が出る設定。以下で正当化:
- 家庭用 NAS で他 user が同一 host にログインしないなら実害ゼロ
- NFS export 自体を IP 制限（`root_squash`, `ro` 以外の `rw` 先指定）
- 代替として NFS uid/gid mapping を設定する方法もあるが、NAS 側の対応と全 client 側の設定で「複雑度 >> メリット」

**やってはいけない**: 0750 に戻して「動くはず」と粘る → 黙って write が失敗して data loss の温床。

## Evidence
- Nextcloud 公式は「traditional UID 前提」を明示していないが、実装読めば明白
- Podman rootless UID mapping: https://docs.podman.io/en/latest/markdown/podman-run.1.html#userns-mode
- 自家運用で 2777 + disable check の組み合わせ以外は安定動作せず
