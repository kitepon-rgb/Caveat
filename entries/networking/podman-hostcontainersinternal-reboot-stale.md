---
id: podman-hostcontainersinternal-reboot-stale
title: 'Podman rootless の host.containers.internal は reboot 直後に link-local が失効することがある'
visibility: public
confidence: reproduced
outcome: resolved
tags: [podman, networking, caddy, link-local]
environment:
  container: podman-rootless
  os: fedora / bazzite (rpm-ostree)
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Caddy を rootless Podman で動かし、reverse proxy で host 上の node / python サービスに転送。Caddyfile で upstream を `host.containers.internal` として書く。

## Symptom
- `rpm-ostree` 等の auto-update で reboot 後、Caddy が全 upstream に 502 を返す
- 症状は reboot 直後**ではなく**、network restart のタイミングで発生
- `curl host.containers.internal` が container 内から通らない
- `169.254.1.2` の link-local へのルートが container の route table にない

## Cause
Podman netavark は起動時に link-local `169.254.1.2` を interface に割り当てる。しかし reboot 後の systemd 起動順で network-online.target は「network layer ready」を示すだけで、**netavark の link-local が定着した状態までは保証しない**。Caddy container が先に起動すると、その時点の route table には link-local が無く、`host.containers.internal` が解決できない。

## Resolution
**Caddyfile で `host.containers.internal` を使わず、host の実 IP に書き換える**:
```
reverse_proxy 192.168.1.2:3000   # host LAN IP 直書き
```

- reboot 影響を受けない
- container からの参照も明確
- `host.containers.internal` の抽象化メリット（host IP が変わっても OK）は家庭 LAN では不要

**Caddyfile 書き換え時の注意**:
- bind mount した Caddyfile を `sed -i` で編集すると inode が変わる
- container は古い inode を見続けるので、`podman restart caddy` が必須
- `sed -i` の前に `cp Caddyfile Caddyfile.bak` で bk 取ってから編集

## Evidence
- ConnectC2X で rpm-ostree reboot 後に 3 回再現、すべて同じ failure mode
- 実 IP 直書きに変えてから 0 件
