const [moduleUrl, home, sessionId, key, started, release] = process.argv.slice(2);
const { buildAndPublishPendingReminder } = await import(moduleUrl);
const { existsSync, writeFileSync } = await import('node:fs');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
buildAndPublishPendingReminder(home, sessionId, key, () => {
  writeFileSync(started, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 5);
  return 'built after sweep';
});
