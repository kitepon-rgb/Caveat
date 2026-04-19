---
id: ghcr-packages-write-permission
title: 'GitHub Actions から GHCR に push するには permissions: packages: write が明示必要'
visibility: public
confidence: confirmed
outcome: resolved
tags: [github-actions, ghcr, docker, permissions]
environment:
  github-actions: "all"
  registry: ghcr.io
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
GitHub Actions workflow で Docker image を ghcr.io に push する。`GITHUB_TOKEN` で認証する構成にした。

## Symptom
```
denied: installation not allowed to Create organization package
(or: insufficient_scope: authorization failed)
```
`docker login` は成功するが `docker push` で 403。`secrets.GITHUB_TOKEN` は有効、PAT を使う必要はないはずなのに reject される。

## Cause
`GITHUB_TOKEN` は job ごとにスコープ限定の短期トークン。デフォルトのスコープには `contents: read` や `issues: read` は入っているが、**`packages: write` は入っていない**。GHCR への push はこの scope を要求するため、明示的に付与しないと 403。

Repository の Settings > Actions > General > Workflow permissions が "Read repository contents and packages permission" になっていても、**workflow YAML 側の `permissions:` 明示は別枠**。

## Resolution
workflow YAML の job レベル（または top-level）に追加:
```yaml
permissions:
  contents: read
  packages: write          # ← これが必須
```

複数 job なら top-level に書くほうが漏れない。private repo の場合は Settings > Actions > General で "Allow GitHub Actions to create and approve pull requests" 系の項目も一緒に確認。

**PAT でやる方法もあるが推奨しない**（expiration 管理が発生、secret leak リスク）。`GITHUB_TOKEN` + `permissions` 明示が正解。

## Evidence
- LicenseServer の `.github/workflows/docker-publish.yml` で再現 → `permissions: packages: write` で解決
- GitHub 公式: https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions
