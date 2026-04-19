---
id: selinux-enforcing-breaks-fscache-nfs
title: 'SELinux Enforcing は NFS fscache を container から読めなくする（Permissive 運用必須）'
visibility: public
confidence: confirmed
outcome: resolved
tags: [selinux, nfs, fscache, podman, container]
environment:
  os: fedora / bazzite
  selinux: enforcing
  nfs: v4
  container: podman-rootless
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
自宅 NAS に NFS v4 マウント、fscache（cachefilesd）でローカルキャッシュ、Nextcloud を Podman rootless で動かす構成。SELinux Enforcing で本格運用したい。

## Symptom
- Nextcloud の全ファイル read が 100% cache miss になる
- 毎回 NAS に取りに行くので体感 ~10x 遅くなる
- `/var/log/audit/audit.log` に `type=AVC ... apache2 ... read access denied` ログが大量
- 対象は `/var/cache/nfs-cache/cache/...`

Permissive に戻すと即解決。

## Cause
- fscache は NFS I/O を intercept して `/var/cache/nfs-cache/` に保存する kernel module
- このパスの SELinux context は `var_t`
- container の apache2 は `container_file_t` context
- SELinux default policy で `container_file_t` → `var_t` への read 許可は存在しない
- Permissive では AVC denial がログされるだけで許可される、Enforcing では実際にブロック

## Resolution
**v1 運用**: `setenforce 0` で Permissive 維持（`/etc/selinux/config` で `SELINUX=permissive`）。fscache パスを使う container を動かす限り、この制約は外せない。

**Enforcing に上げるための手順**（未実施）:
1. `audit2allow -a -M nfscache-policy < /var/log/audit/audit.log | grep nfs-cache`
2. 生成された `nfscache-policy.pp` を `semodule -i` でロード
3. Permissive で 48h 安定稼働確認
4. Enforcing に切り替え
5. 新しい AVC が出たら 1 に戻る

安全のため Permissive は「defense-in-depth の 1 層が弱まっている」自覚を持つ。host 側の firewalld / container isolation は別レイヤで効いているので裸ではない。

## Evidence
- Nextcloud 導入記録で `setenforce 0` 前後の cache hit rate 比較（0% → 98%）
- `ausearch -m AVC -ts recent` で fscache 関連の denial が容易に観測可能
