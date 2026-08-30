import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const yaml = requireFromCore('js-yaml');
const workflowPath = new URL('../.github/workflows/product-full-ci.yml', import.meta.url);
const callerPath = new URL('../.github/workflows/ci.yml', import.meta.url);

test('windows-native product CI uses PowerShell 7 only', () => {
  const source = readFileSync(workflowPath, 'utf8');
  const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  const steps = workflow?.jobs?.full?.steps;
  assert.ok(Array.isArray(steps), 'jobs.full.steps must exist');

  const windowsSteps = steps.filter((step) =>
    typeof step?.if === 'string' && step.if.includes("matrix.environment == 'windows-native'"));
  assert.deepEqual(
    windowsSteps.map((step) => step.name),
    ['logical CPU parallelism', 'dependency install', 'product full test'],
  );
  for (const step of windowsSteps) assert.equal(step.shell, 'pwsh', `${step.name} must use pwsh`);

  const cpuStep = windowsSteps[0];
  assert.match(cpuStep.run, /\$env:GITHUB_ENV/);
  assert.doesNotMatch(source, /Git\\bin\\bash|Git\/bin\/bash|shell:\s*(?:powershell|cmd)\b/i);
});

test('the local caller always supplies the product-owned documentation check', () => {
  const caller = yaml.load(readFileSync(callerPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
  const command = caller?.jobs?.full?.with?.['documentation-command'];
  assert.equal(command, 'node scripts/check-current-docs.mjs');
});
