// SPDX-License-Identifier: MPL-2.0
const BLOCK_TAGS = /<(script|style|gallery|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const REFERENCES = /<ref\b[^>]*>[\s\S]*?<\/ref\s*>|<ref\b[^>]*\/\s*>/gi;
const HTML_ENTITIES = /&(?:nbsp|amp|lt|gt|quot|apos|#(?:\d+|x[0-9a-f]+));/gi;

export function extractWikitext(source: string): string {
  let text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_TAGS, ' ')
    .replace(REFERENCES, ' ');

  text = extractLanguageVariants(text);
  text = text
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_match, target, label) =>
      label ? `${target} ${label}` : target,
    )
    .replace(/\[(?:https?:)?\/\/\S+(?:\s+([^\]]+))?\]/g, (_match, label) => label ?? ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(HTML_ENTITIES, decodeHtmlEntity)
    .replace(/\{\{|\}\}|\{\||\|\}/g, ' ')
    .replace(/[|=]+/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/^\s*[!*#:;]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function decodeHtmlEntity(entity: string): string {
  const body = entity.slice(1, -1).toLocaleLowerCase();
  const named = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  }[body];
  if (named !== undefined) return named;

  const hexadecimal = body.startsWith('#x');
  const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

export function extractLanguageVariants(source: string): string {
  return source.replace(/-\{([\s\S]*?)\}-/g, (_match, rawBody: string) => {
    const body = rawBody.replace(/^[A-Za-z-]+\|/, '');
    return body
      .split(';')
      .map((branch) => {
        const separator = branch.indexOf(':');
        return (separator >= 0 ? branch.slice(separator + 1) : branch).trim();
      })
      .filter(Boolean)
      .join(' ');
  });
}
