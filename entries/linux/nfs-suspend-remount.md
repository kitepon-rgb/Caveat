---
id: nfs-suspend-remount
title: 'systemd suspend/wake は NFS 再マウントをトリガしない、fstab _netdev は boot 時のみ有効'
visibility: public
confidence: confirmed
outcome: resolved
tags: [nfs, systemd, suspend, fstab, linux]
environment:
  os: linux (systemd)
  filesystem: nfs v4
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
NAS の NFS マウント（Nextcloud data / 共有ファイル等）に依存したサービスをホスト直下 or コンテナで動かす。systemd suspend/wake や OS 自動アップデートの reboot が定期的に起こる環境。

## Symptom
suspend → wake（あるいは reboot）後、`/var/mnt/nextcloud_data` が空になっている。Nextcloud は空の local dir を見て `.ncdata` を**ローカル FS に**作り始める。DB には 724GB 分のファイルパスが記録されているのに実体が無くなったように見えて 503。

手動 `mount -a` で復旧するが、気付くまでに数時間ロス。

## Cause
- `fstab` の `_netdev` オプションは **boot 時に network-online を待つ**指定
- systemd suspend/wake は mount unit を再評価しない
- wake 後の NetworkManager online signal は network layer の ready は示すが、Netavark の link-local や NFS サーバ到達性までは保証しない
- 結果、NFS は dangling な unmount 状態になり、アプリからは空ディレクトリに見える（エラーすら出ない）

## Resolution
**3 層防御**（これは多層防御ではなく、各層が別の failure mode をカバー）:

1. **fstab に `nofail`** → unmounted 状態で boot をブロックしない
2. **systemd oneshot service** `ensure-nfs-mounts.service`:
   ```ini
   [Unit]
   After=network-online.target
   Wants=network-online.target
   [Service]
   Type=oneshot
   ExecStartPre=/bin/sleep 5
   ExecStart=/usr/local/bin/ensure-nfs-mounts.sh
   Restart=on-failure
   RestartSec=10
   ```
   スクリプトは `mountpoint -q /var/mnt/nextcloud_data || mount /var/mnt/nextcloud_data` を 5 回リトライ
3. **監視 app**: 60s おきに mountpoint 確認 + 未 mount ならリマウント + 該当 container を `podman restart`

1 層目は「無条件 block しない」、2 層目は「boot / resume 後の自動回復」、3 層目は「どこかで落ちた場合のセーフティネット」。同じ failure を 3 度守るのではなく、各層が別の failure を守る。

## Evidence
- Nextcloud 導入 6 ヶ月で suspend/wake 後の unmount を 3 回観測、都度手動 mount
- 上記 3 層導入後は自動回復、手動介入ゼロ
