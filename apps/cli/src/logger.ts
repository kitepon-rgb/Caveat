import type { Logger } from '@caveat/core';

export const stdoutLogger: Logger = {
  info: (m) => process.stdout.write(`[caveat] ${m}\n`),
  warn: (m) => process.stderr.write(`[caveat:warn] ${m}\n`),
  error: (m) => process.stderr.write(`[caveat:error] ${m}\n`),
};
