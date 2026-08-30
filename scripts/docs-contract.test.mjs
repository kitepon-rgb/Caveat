import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPackedMarkdownClosed, documentTargets } from './docs-contract.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('extracts effective Markdown links, references, and HTML image candidates through ASTs', () => {
  const targets = documentTargets(`
[![badge](https://img.example/badge.svg)](docs/badges.md)
[API](docs/api_(v1).md)
[escaped \\] label](docs/escaped.md)

[guide]:
  docs/guide.md

[guide]

> [quoted]: docs/quoted.md
>
> [quoted]

- [listed]: docs/listed.md
  [listed]

<a href="docs/a&amp;b.md"><img src="images/direct.png" srcset="data:image/svg+xml,%3Csvg%3E 1x, images/two.png 2x">
<template><img src="images/template.png"></template>
`);

  assert.deepEqual(targets, [
    'docs/badges.md',
    'https://img.example/badge.svg',
    'docs/api_(v1).md',
    'docs/escaped.md',
    'docs/guide.md',
    'docs/quoted.md',
    'docs/listed.md',
    'docs/a&b.md',
    'images/direct.png',
    'data:image/svg+xml,%3Csvg%3E',
    'images/two.png',
    'images/template.png',
  ]);
});

test('ignores CommonMark code, escaped definitions, malformed links, and fake HTML attributes', () => {
  const targets = documentTargets(`
    [indented code](missing-indented.md)

\`\` \`[unequal backticks](missing-inline.md)\` \`\`

\\[escaped]: missing-escaped.md

[escaped]

[unterminated title](missing-title.md "title)

[blank line](

missing-blank.md)

<div title='href="missing-html.md"' data-example="src='missing-src.md'"></div>
`);

  assert.deepEqual(targets, []);
});

test('rejects a relative target missing from the packed manifest', () => {
  const files = new Set(['README.md', 'docs/guide.md', 'images/logo.png']);
  assert.doesNotThrow(() => assertPackedMarkdownClosed(
    files,
    'README.md',
    '[Guide](docs/guide.md) ![Logo](images/logo.png)',
  ));
  assert.throws(
    () => assertPackedMarkdownClosed(files, 'README.md', '[Missing](docs/missing.md)'),
    /同梱されないtargetを参照しています: docs\/missing\.md/,
  );
  assert.throws(
    () => assertPackedMarkdownClosed(files, 'README.md', '[Missing]:\n  docs/missing.md\n\n[Missing]'),
    /同梱されないtargetを参照しています: docs\/missing\.md/,
  );
  assert.doesNotThrow(() => assertPackedMarkdownClosed(
    files,
    'README.md',
    '[Package root](.) [Packed docs](docs/)',
  ));
});

test('rejects a packed Markdown target that escapes the package', () => {
  assert.throws(
    () => assertPackedMarkdownClosed(new Set(['README.md']), 'README.md', '[Secret](../secret.md)'),
    /package外を参照しています/,
  );
});

test('parses single-character and comma-bearing srcset URLs without dropping targets', () => {
  assert.deepEqual(
    documentTargets('<img srcset="a 1x, data:image/svg+xml,%3Csvg%3E 2x, images/a,b.png 3x">'),
    ['a', 'data:image/svg+xml,%3Csvg%3E', 'images/a,b.png'],
  );
  assert.throws(
    () => assertPackedMarkdownClosed(new Set(['README.md']), 'README.md', '<img srcset="a">'),
    /同梱されないtargetを参照しています: a/,
  );
});

test('public docs expose one product-owned non-interactive setup entry', async () => {
  for (const path of ['README.md', 'README.ja.md', 'apps/cli/README.md']) {
    const content = await readFile(join(ROOT, path), 'utf8');
    assert.match(content, /caveat init --sync --yes/u, `${path}に一回setup入口がない`);
    assert.match(content, /非0終了|non-zero/u, `${path}に明示sync失敗の契約がない`);
  }
});
