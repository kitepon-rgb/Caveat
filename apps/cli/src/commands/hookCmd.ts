import {
  detectCaveatTrigger,
  stopReminderText,
  userPromptSubmitReminderText,
} from '@caveat/core';

export type HookName = 'user-prompt-submit' | 'stop';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] json parse error: ${msg}\n`);
    return {};
  }
}

export async function runHook(name: HookName): Promise<void> {
  let raw = '';
  try {
    raw = await readStdin();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] stdin read error: ${msg}\n`);
    process.exit(0);
  }
  const payload = parsePayload(raw);

  if (name === 'user-prompt-submit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (detectCaveatTrigger(prompt)) {
      process.stdout.write(
        `<system-reminder>${userPromptSubmitReminderText()}</system-reminder>\n`,
      );
    }
    process.exit(0);
  }

  if (name === 'stop') {
    if (payload.stop_hook_active === true) {
      process.exit(0);
    }
    process.stdout.write(`<system-reminder>${stopReminderText()}</system-reminder>\n`);
    process.exit(0);
  }

  process.stderr.write(`[caveat:hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
