import { DatabaseSync } from 'node:sqlite';
import { recordRuntimeError } from '../../src/runtimeErrors.ts';

if (process.argv[2] === 'hold-lock') {
  const db = new DatabaseSync(process.argv[3]);
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('READY\n');
  setInterval(() => {}, 1_000);
} else {
  const result = recordRuntimeError('CAVEAT.DATABASE_OPEN_FAILED', {
    env: process.env,
    version: '0.16.2',
  });
  if (result.status !== 'recorded') process.exitCode = 2;
}
