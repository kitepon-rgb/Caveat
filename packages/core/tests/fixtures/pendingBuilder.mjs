const [moduleUrl, home, sessionId, key, barrier, counter] = process.argv.slice(2);
const { buildAndPublishPendingReminder } = await import(moduleUrl);
const { appendFileSync, statSync } = await import('node:fs');
while (true) {
  try { statSync(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
}
buildAndPublishPendingReminder(home, sessionId, key, () => {
  appendFileSync(counter, '1\n', { encoding: 'utf8', mode: 0o600 });
  return 'built once';
});
