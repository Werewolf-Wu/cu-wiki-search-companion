// SPDX-License-Identifier: MPL-2.0
const BLOCK_TAGS = /<(script|style|gallery|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const REFERENCES = /<ref\b[^>]*>[\s\S]*?<\/ref\s*>|<ref\b[^>]*\/\s*>/gi;

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
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\{\{|\}\}|\{\||\|\}/g, ' ')
    .replace(/[|=]+/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/^\s*[!*#:;]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
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
