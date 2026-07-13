import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, recordRuntimeError, runtimeErrorsStatePath } from '@caveat/core';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repo, 'apps', 'cli', 'dist', 'caveat.js');

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20_000 });
}

function json(result: ReturnType<typeof run>) {
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, any>;
}

function isolated() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-factory-cli-'));
  const home = join(root, 'home'); const caveatHome = join(root, 'caveat');
  const configHome = join(root, 'xdg-config'); const stateHome = join(root, 'xdg-state');
  mkdirSync(home, { recursive: true }); mkdirSync(caveatHome, { recursive: true });
  mkdirSync(join(configHome, 'dotagents'), { recursive: true });
  const reporterConfig = join(configHome, 'dotagents', 'factory-reporter.json'); writeFileSync(reporterConfig, JSON.stringify({ schema_version: '1.0', host: { id: 'fixture', profile: 'mac' }, collection: { enabled: true }, reporting: { enabled: false } }), { mode: 0o600 }); chmodSync(reporterConfig, 0o600);
  const codexHome = join(root, 'codex');
  return { root, home, caveatHome, codexHome, env: { ...process.env, HOME: home, CAVEAT_HOME: caveatHome, CODEX_HOME: codexHome, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, PATH: process.env.PATH ?? '' } };
}

function readyFactory(fixture: ReturnType<typeof isolated>) {
  const db = openDb({ path: join(fixture.caveatHome, 'index', 'caveat.db') }); db.close();
  const own = join(fixture.caveatHome, 'own'); const remote = join(fixture.root, 'remote.git'); mkdirSync(own, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' }); execFileSync('git', ['init'], { cwd: own, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: own }); execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: own });
  writeFileSync(join(own, 'README.md'), 'fixture\n'); execFileSync('git', ['add', '.'], { cwd: own }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: own, stdio: 'pipe' }); execFileSync('git', ['branch', '-M', 'main'], { cwd: own }); execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: own }); execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: own, stdio: 'pipe' });
  writeFileSync(join(fixture.home, '.claude.json'), JSON.stringify({ mcpServers: { caveat: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cli, 'mcp-server'], env: {} } } }));
  mkdirSync(join(fixture.home, '.claude'), { recursive: true }); writeFileSync(join(fixture.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: `${process.execPath} ${cli} hook user-prompt-submit` }] }], PostToolUse: [{ hooks: [{ command: `${process.execPath} ${cli} hook post-tool-use` }] }], PostToolUseFailure: [{ hooks: [{ command: `${process.execPath} ${cli} hook post-tool-use` }] }], Stop: [{ hooks: [{ command: `${process.execPath} ${cli} hook stop` }] }] } }));
  mkdirSync(fixture.codexHome, { recursive: true }); writeFileSync(join(fixture.codexHome, 'config.toml'), '[features]\nhooks = true\n'); writeFileSync(join(fixture.codexHome, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: `${process.execPath} ${cli} codex-hook user-prompt-submit` }] }], PostToolUse: [{ hooks: [{ command: `${process.execPath} ${cli} codex-hook post-tool-use` }] }], Stop: [{ hooks: [{ command: `${process.execPath} ${cli} codex-hook stop` }] }] } }));
}

describe('built factory/runtime CLI contracts', () => {
  it('keeps a missing isolated home read-only and emits one JSON diagnostic with non-ready exit', () => {
    const fixture = isolated(); const db = join(fixture.caveatHome, 'index', 'caveat.db');
    const result = run(['factory-diagnostics', '--json'], fixture.env);
    expect(result.status).toBe(1); const output = json(result);
    expect(output).toMatchObject({ schema: 'caveat.native_factory_diagnostics.v1', overall: { status: 'not_ready' } });
    expect(existsSync(db)).toBe(false); expect(existsSync(join(fixture.caveatHome, 'own'))).toBe(false);
  });

  it('keeps prepared ready DB/config/git mtimes unchanged and exposes runtime JSON lifecycle plus negative arguments', () => {
    const fixture = isolated(); readyFactory(fixture); const dbPath = join(fixture.caveatHome, 'index', 'caveat.db');
    const own = join(fixture.caveatHome, 'own');
    const config = join(fixture.home, '.caveatrc.json'); writeFileSync(config, '{}');
    const before = [statSync(dbPath).mtimeMs, statSync(config).mtimeMs, statSync(join(own, '.git')).mtimeMs];
    const diagnostic = run(['factory-diagnostics', '--json'], fixture.env); expect(diagnostic.status).toBe(0); const factory = json(diagnostic);
    expect(factory).toMatchObject({ schema: 'caveat.native_factory_diagnostics.v1', overall: { status: 'ready' } });
    expect([statSync(dbPath).mtimeMs, statSync(config).mtimeMs, statSync(join(own, '.git')).mtimeMs]).toEqual(before);

    const recorded = recordRuntimeError('CAVEAT.DATABASE_OPEN_FAILED', { env: fixture.env, version: '0.16.3' });
    const snapshot = json(run(['runtime-errors', 'snapshot', '--json'], fixture.env));
    expect(snapshot).toMatchObject({ schema: 'caveat.runtime_errors.v1', product: 'caveat', diagnostics: { collection: 'enabled' } });
    const fingerprint = snapshot.runtime_errors[0].fingerprint as string; const cursor = snapshot.cursor.high_watermark as number;
    expect(json(run(['runtime-errors', 'ack', String(cursor), '--json'], fixture.env)).cursor.acknowledged_through).toBe(cursor);
    expect(json(run(['runtime-errors', 'resolve', fingerprint, '--json'], fixture.env)).resolutions[0].fingerprint).toBe(fingerprint);
    expect(json(run(['runtime-errors', 'reopen', fingerprint, '--json'], fixture.env)).runtime_errors[0].fingerprint).toBe(fingerprint);
    expect(json(run(['runtime-errors', 'compact', '--json'], fixture.env)).schema).toBe('caveat.runtime_errors.v1');
    expect(runtimeErrorsStatePath(fixture.env)).toContain(fixture.root); expect(recorded.status).toBe('recorded');
    expect(run(['runtime-errors', 'ack', '99', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['runtime-errors', 'ack', 'not-a-number', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['runtime-errors', 'resolve', 'nope', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['runtime-errors', 'snapshot', '--after-cursor', '99', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['factory-diagnostics'], fixture.env).status).not.toBe(0);
  });

  it('rejects lookalike DB and connector registrations instead of emitting false ready', () => {
    const fixture = isolated(); readyFactory(fixture); const dbPath = join(fixture.caveatHome, 'index', 'caveat.db');
    const db = new DatabaseSync(dbPath); db.exec("DROP TRIGGER entries_ai; DROP TRIGGER entries_ad; DROP TRIGGER entries_au; DROP TABLE entries_fts; CREATE VIRTUAL TABLE entries_fts USING fts5(garbage, content='entries', content_rowid='rowid', tokenize='trigram'); CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(garbage) VALUES ('insert'); END; CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts) VALUES('delete'); END; CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN INSERT INTO entries_fts(entries_fts) VALUES('delete'); INSERT INTO entries_fts(garbage) VALUES ('update'); END;"); db.close();
    const fakeDb = json(run(['factory-diagnostics', '--json'], fixture.env)); expect(fakeDb.database).toMatchObject({ status: 'not_ready', reason_code: 'schema_contract_mismatch' });

    const connectorFixture = isolated(); readyFactory(connectorFixture);
    writeFileSync(join(connectorFixture.home, '.claude.json'), JSON.stringify({ mcpServers: { caveat: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cli, 'not-mcp-server'], env: {} } } }));
    writeFileSync(join(connectorFixture.codexHome, 'config.toml'), '[features]\nhooks = false\n');
    const fakeConnector = json(run(['factory-diagnostics', '--json'], connectorFixture.env));
    expect(fakeConnector.connectors.claude.mcp.status).toBe('not_ready'); expect(fakeConnector.connectors.codex.status).toBe('not_ready'); expect(fakeConnector.overall.status).toBe('not_ready');

    const executorFixture = isolated(); readyFactory(executorFixture);
    const fakeNode = join(executorFixture.root, 'not-node'); const fakeCli = join(executorFixture.root, 'caveat.js');
    writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); writeFileSync(fakeCli, '/* not Caveat */\n', { mode: 0o644 });
    writeFileSync(join(executorFixture.home, '.claude.json'), JSON.stringify({ mcpServers: { caveat: { type: 'stdio', command: fakeNode, args: ['--disable-warning=ExperimentalWarning', fakeCli, 'mcp-server'], env: {} } } }));
    writeFileSync(join(executorFixture.home, '.claude', 'settings.json'), JSON.stringify({ hooks: Object.fromEntries([['UserPromptSubmit', 'user-prompt-submit'], ['PostToolUse', 'post-tool-use'], ['PostToolUseFailure', 'post-tool-use'], ['Stop', 'stop']].map(([event, subcommand]) => [event, [{ hooks: [{ command: `${fakeNode} ${fakeCli} hook ${subcommand}` }] }]])) }));
    writeFileSync(join(executorFixture.codexHome, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries([['UserPromptSubmit', 'user-prompt-submit'], ['PostToolUse', 'post-tool-use'], ['Stop', 'stop']].map(([event, subcommand]) => [event, [{ hooks: [{ command: `${fakeNode} ${fakeCli} codex-hook ${subcommand}` }] }]])) }));
    const fakeExecutor = json(run(['factory-diagnostics', '--json'], executorFixture.env));
    expect(fakeExecutor.connectors.claude.status).toBe('not_ready'); expect(fakeExecutor.connectors.codex.status).toBe('not_ready'); expect(fakeExecutor.overall.status).toBe('not_ready');
  });

  it('does not report own sync ready for dirty, remotely-behind, or unreachable worktrees', () => {
    const dirty = isolated(); readyFactory(dirty); writeFileSync(join(dirty.caveatHome, 'own', 'dirty.md'), 'uncommitted\n');
    expect(json(run(['factory-diagnostics', '--json'], dirty.env)).sync).toMatchObject({ status: 'not_ready', reason_code: 'worktree_dirty' });

    const behind = isolated(); readyFactory(behind); const remote = join(behind.root, 'remote.git'); const writer = join(behind.root, 'writer');
    execFileSync('git', ['clone', remote, writer], { stdio: 'pipe' }); execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: writer }); execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: writer });
    writeFileSync(join(writer, 'remote.md'), 'remote advance\n'); execFileSync('git', ['add', '.'], { cwd: writer }); execFileSync('git', ['commit', '-m', 'remote advance'], { cwd: writer, stdio: 'pipe' }); execFileSync('git', ['push'], { cwd: writer, stdio: 'pipe' });
    execFileSync('git', ['fetch', 'origin'], { cwd: join(behind.caveatHome, 'own'), stdio: 'pipe' });
    expect(json(run(['factory-diagnostics', '--json'], behind.env)).sync).toMatchObject({ status: 'not_ready', reason_code: 'remote_mismatch' });

    const unreachable = isolated(); readyFactory(unreachable); const own = join(unreachable.caveatHome, 'own');
    execFileSync('git', ['remote', 'set-url', 'origin', join(unreachable.root, 'missing-remote.git')], { cwd: own });
    expect(json(run(['factory-diagnostics', '--json'], unreachable.env)).sync.status).not.toBe('ready');
  });
});
