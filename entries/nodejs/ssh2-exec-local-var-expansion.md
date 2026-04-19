---
id: ssh2-exec-local-var-expansion
title: 'ssh2.exec("cmd $VAR") の $VAR は **ローカル shell で展開**、リモートに届かない'
visibility: public
confidence: confirmed
outcome: resolved
tags: [nodejs, ssh, shell, variable-expansion]
environment:
  ssh2: ">=1"
  node: ">=18"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Node.js の `ssh2` モジュールで SSH 経由でリモートコマンド実行。Docker コンテナの環境変数（例: `MYSQL_ROOT_PASSWORD`）をリモートで使いたい。

## Symptom
```javascript
ssh.exec(`mariadb-admin ping -u root -p$MYSQL_ROOT_PASSWORD`)
// → "Access denied (using password: NO)"
```
パスワードが空で送られる。リモートには `mariadb-admin ping -u root -p` という文字列で届く（`$VAR` が消える）。

## Cause
`ssh2.exec()` は内部で command string を template リテラル / double-quote-wrapped でシェル経由に渡すため、Node プロセスの**ローカル shell が先に $VAR を展開**してしまう。ローカルにその変数がなければ空文字列、またはテンプレートリテラル評価の段階で undefined。リモート側で展開されることはない。

## Resolution
**2 ステップ実行**で値を取得してから埋め込む：
```javascript
const pwd = (await ssh.exec('printenv MYSQL_ROOT_PASSWORD')).trim();
const result = await ssh.exec(`mariadb-admin ping -u root -p${pwd}`);
```

quote/escape の地獄に入らない。`$` を backslash escape する方式もあるが shell の種類で挙動が変わるため不安定。2 ステップが最も確実。

**注**: `pwd` を後段で使うとき `${pwd}` を double-quote で囲まない（Node の template literal は dollar sign を含む値を壊す可能性）。特殊文字を含むパスワードなら `shell-escape` ライブラリを噛ます。

## Evidence
- ServerManager（監視系）で MariaDB ping が常に NO で通らなかった
- 2 ステップ化で完全解決
