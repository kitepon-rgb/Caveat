import { posix } from 'node:path';

export function documentTargets(source) {
  const targets = [];
  const prose = source
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');

  for (let index = 0; index < prose.length; index += 1) {
    const image = prose[index] === '!' && prose[index + 1] === '['
      && !escaped(prose, index) && !escaped(prose, index + 1);
    const imageMarker = prose[index - 1] === '!' && !escaped(prose, index - 1);
    const link = prose[index] === '[' && !imageMarker && !escaped(prose, index);
    if (!image && !link) continue;

    const open = image ? index + 1 : index;
    const close = matchingBracket(prose, open);
    if (close === -1 || prose[close + 1] !== '(') continue;
    const destination = inlineDestination(prose, close + 1);
    if (destination !== null) targets.push(unescapeMarkdown(destination));
  }

  for (const match of prose.matchAll(/^[ \t]{0,3}\[(?:\\.|[^\]])+\]:[ \t]*(.*)$/gm)) {
    let rest = match[1];
    if (!rest) {
      const following = prose.slice(match.index + match[0].length);
      rest = following.match(/^\r?\n[ \t]*([^\r\n]*)/)?.[1] ?? '';
    }
    const destination = referenceDestination(rest);
    if (destination !== null) targets.push(unescapeMarkdown(destination));
  }

  for (const match of prose.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    targets.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of prose.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    targets.push(...srcsetTargets(match[1] ?? match[2] ?? match[3]));
  }
  return targets;
}

export function assertPackedMarkdownClosed(files, markdownPath, source) {
  for (const raw of documentTargets(source)) {
    const target = packedTarget(markdownPath, raw);
    if (target === null) continue;
    if (target === '.') continue;
    if (!files.has(target) && ![...files].some((file) => file.startsWith(`${target}/`))) {
      throw new Error(`同梱されないtargetを参照しています: ${raw}`);
    }
  }
}

function packedTarget(markdownPath, raw) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) return null;
  const pathname = raw.split('#', 1)[0].split('?', 1)[0];
  if (!pathname) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new Error(`不正なlink URIがあります: ${raw}`); }
  const normalized = posix.normalize(decoded.startsWith('/')
    ? decoded.slice(1)
    : posix.join(posix.dirname(markdownPath), decoded));
  const target = normalized === '.' ? normalized : normalized.replace(/\/+$/, '');
  if (target === '..' || target.startsWith('../')) {
    throw new Error(`package外を参照しています: ${raw}`);
  }
  return target;
}

function matchingBracket(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (escaped(source, index)) continue;
    if (source[index] === '[') depth += 1;
    if (source[index] !== ']') continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function inlineDestination(source, open) {
  let index = open + 1;
  while (index < source.length && /[ \t\n]/.test(source[index])) index += 1;
  if (source[index] === '>') return null;
  if (source[index] === '<') {
    const start = index + 1;
    for (index = start; index < source.length && source[index] !== '\n'; index += 1) {
      if (source[index] === '>' && !escaped(source, index)) return source.slice(start, index);
    }
    return null;
  }

  const start = index;
  let depth = 0;
  for (; index < source.length; index += 1) {
    if (escaped(source, index)) {
      index += 1;
      continue;
    }
    if (source[index] === '(') {
      depth += 1;
      continue;
    }
    if (source[index] === ')') {
      if (depth === 0) return source.slice(start, index);
      depth -= 1;
      continue;
    }
    if (/\s/.test(source[index]) && depth === 0) return source.slice(start, index);
  }
  return null;
}

function referenceDestination(rest) {
  let index = 0;
  while (index < rest.length && /[ \t]/.test(rest[index])) index += 1;
  if (rest[index] === '<') {
    const end = rest.indexOf('>', index + 1);
    return end === -1 ? null : rest.slice(index + 1, end);
  }
  const start = index;
  let depth = 0;
  for (; index < rest.length; index += 1) {
    if (escaped(rest, index)) {
      index += 1;
      continue;
    }
    if (rest[index] === '(') depth += 1;
    else if (rest[index] === ')' && depth > 0) depth -= 1;
    else if (/\s/.test(rest[index]) && depth === 0) break;
  }
  return index === start ? null : rest.slice(start, index);
}

function srcsetTargets(value) {
  const targets = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    const token = value.slice(start, index);
    const candidate = token.replace(/,+$/, '');
    if (candidate) targets.push(candidate);
    if (/,+$/.test(token)) continue;
    while (index < value.length && value[index] !== ',') index += 1;
    if (value[index] === ',') index += 1;
  }
  return targets;
}

function escaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function unescapeMarkdown(value) {
  return value.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
}
