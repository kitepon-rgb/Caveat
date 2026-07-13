const [moduleUrl, home, sessionId, key, barrier] = process.argv.slice(2);
const { publishPendingReminder } = await import(moduleUrl);
while (true) {
  try {
    await import('node:fs').then(({ statSync }) => statSync(barrier));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
publishPendingReminder(home, sessionId, key, 'only once');
