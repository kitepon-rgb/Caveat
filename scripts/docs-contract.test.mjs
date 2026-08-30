import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPackedMarkdownClosed, documentTargets } from './docs-contract.mjs';

test('extracts nested links, balanced destinations, escaped labels, and HTML image candidates', () => {
  const targets = documentTargets(`
[![badge](https://img.example/badge.svg)](docs/badges.md)
[API](docs/api_(v1).md)
[escaped \\] label](docs/escaped.md)
<source srcset="images/one.png 1x, images/two.png 2x">
<img srcset="images/three.png, images/four.png">
\\![literal bang link](docs/literal-bang.md)
`);

  assert.deepEqual(targets, [
    'docs/badges.md',
    'https://img.example/badge.svg',
    'docs/api_(v1).md',
    'docs/escaped.md',
    'docs/literal-bang.md',
    'images/one.png',
    'images/two.png',
    'images/three.png',
    'images/four.png',
  ]);
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
