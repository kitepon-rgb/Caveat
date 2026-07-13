const [moduleUrl, home, barrier] = process.argv.slice(2);
const { cleanupStalePendingDirs } = await import(moduleUrl);
const { statSync } = await import('node:fs');
while (true) {
  try { statSync(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
}
cleanupStalePendingDirs(home, { staleDays: 7 });
