// SPDX-License-Identifier: MPL-2.0
export interface LuaExtraction {
  functions: string[];
  returnKeys: string[];
  strings: string[];
  dependencies: string[];
  searchableText: string;
}

type LuaTokenType = 'identifier' | 'number' | 'string' | 'symbol';

interface LuaToken {
  type: LuaTokenType;
  value: string;
}

interface TokenPath {
  name: string;
  next: number;
}

export function extractLua(source: string): LuaExtraction {
  const tokens = tokenizeLua(source);
  const functions = new Set<string>();
  const returnKeys = new Set<string>();
  const strings = new Set<string>();
  const dependencies = new Set<string>();

  for (const token of tokens) {
    if (token.type === 'string' && token.value.trim()) strings.add(token.value.trim());
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === 'function') {
      const path = readMemberPath(tokens, index + 1);
      if (path && tokens[path.next]?.value === '(') functions.add(path.name);
    }

    const assignment = readMemberPath(tokens, index);
    if (
      assignment &&
      tokens[assignment.next]?.value === '=' &&
      tokens[assignment.next + 1]?.value === 'function'
    ) {
      functions.add(assignment.name);
    }

    const dependencyCall = readMemberPath(tokens, index);
    if (
      dependencyCall &&
      ['require', 'mw.loadData', 'mw.loadJsonData'].includes(dependencyCall.name)
    ) {
      let argumentIndex = dependencyCall.next;
      if (tokens[argumentIndex]?.value === '(') argumentIndex += 1;
      const argument = tokens[argumentIndex];
      if (argument?.type === 'string' && argument.value.trim()) {
        dependencies.add(argument.value.trim());
      }
    }

    if (token.value === 'return' && tokens[index + 1]?.value === '{') {
      collectTableKeys(tokens, index + 1, returnKeys);
    }
  }

  const returnedRoot = finalReturnedRoot(tokens);
  if (returnedRoot) {
    for (const name of functions) {
      const key = memberKey(name, returnedRoot);
      if (key) returnKeys.add(key);
    }
    collectReturnedRootKeys(tokens, returnedRoot, returnKeys);
  }

  const result = {
    functions: [...functions],
    returnKeys: [...returnKeys],
    strings: [...strings],
    dependencies: [...dependencies],
  };
  return {
    ...result,
    searchableText: [
      ...new Set([
        ...result.functions,
        ...result.returnKeys,
        ...result.strings,
        ...result.dependencies,
      ]),
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

function tokenizeLua(source: string): LuaToken[] {
  const tokens: LuaToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === '-' && source[index + 1] === '-') {
      const longComment = readLongBracket(source, index + 2);
      if (longComment) {
        index = longComment.next;
      } else {
        const newline = source.indexOf('\n', index + 2);
        index = newline < 0 ? source.length : newline + 1;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      const quoted = readQuotedString(source, index, character);
      tokens.push({ type: 'string', value: quoted.value });
      index = quoted.next;
      continue;
    }

    if (character === '[') {
      const longString = readLongBracket(source, index);
      if (longString) {
        tokens.push({ type: 'string', value: longString.value });
        index = longString.next;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
      tokens.push({ type: 'identifier', value: source.slice(index, end) });
      index = end;
      continue;
    }

    if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9.xXpP+-]/.test(source[end]!)) end += 1;
      tokens.push({ type: 'number', value: source.slice(index, end) });
      index = end;
      continue;
    }

    tokens.push({ type: 'symbol', value: character });
    index += 1;
  }
  return tokens;
}

function readQuotedString(
  source: string,
  start: number,
  quote: string,
): { value: string; next: number } {
  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === quote) return { value, next: index + 1 };
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) return { value, next: source.length };
    if (escaped === 'z') {
      index += 2;
      while (index < source.length && /\s/.test(source[index]!)) index += 1;
      continue;
    }
    value += ['n', 'r', 't', 'v', 'f'].includes(escaped) ? ' ' : escaped;
    index += 2;
  }
  return { value, next: source.length };
}

function readLongBracket(
  source: string,
  start: number,
): { value: string; next: number } | undefined {
  if (source[start] !== '[') return undefined;
  let openingEnd = start + 1;
  while (source[openingEnd] === '=') openingEnd += 1;
  if (source[openingEnd] !== '[') return undefined;
  const equals = openingEnd - start - 1;
  const contentStart = openingEnd + 1;
  const closing = `]${'='.repeat(equals)}]`;
  const closingStart = source.indexOf(closing, contentStart);
  if (closingStart < 0) {
    return { value: source.slice(contentStart), next: source.length };
  }
  return {
    value: source.slice(contentStart, closingStart),
    next: closingStart + closing.length,
  };
}

function readMemberPath(tokens: LuaToken[], start: number): TokenPath | undefined {
  if (tokens[start]?.type !== 'identifier') return undefined;
  let name = tokens[start]!.value;
  let index = start + 1;
  while (index < tokens.length) {
    const separator = tokens[index]?.value;
    const member = tokens[index + 1];
    if ((separator === '.' || separator === ':') && member?.type === 'identifier') {
      name += `${separator}${member.value}`;
      index += 2;
      continue;
    }
    if (
      separator === '[' &&
      (member?.type === 'string' || member?.type === 'number') &&
      tokens[index + 2]?.value === ']'
    ) {
      name += `.${member.value}`;
      index += 3;
      continue;
    }
    break;
  }
  return { name, next: index };
}

function collectTableKeys(tokens: LuaToken[], openIndex: number, keys: Set<string>): void {
  let curlyDepth = 1;
  let parenthesisDepth = 0;
  let squareDepth = 0;
  let fieldStart = true;
  for (let index = openIndex + 1; index < tokens.length && curlyDepth > 0; index += 1) {
    const token = tokens[index]!;
    if (curlyDepth === 1 && parenthesisDepth === 0 && squareDepth === 0 && fieldStart) {
      if (token.type === 'identifier' && tokens[index + 1]?.value === '=') {
        keys.add(token.value);
      } else if (
        token.value === '[' &&
        (tokens[index + 1]?.type === 'string' || tokens[index + 1]?.type === 'number') &&
        tokens[index + 2]?.value === ']' &&
        tokens[index + 3]?.value === '='
      ) {
        keys.add(tokens[index + 1]!.value);
      }
      fieldStart = false;
    }

    if (token.value === '{') curlyDepth += 1;
    else if (token.value === '}') curlyDepth -= 1;
    else if (token.value === '(') parenthesisDepth += 1;
    else if (token.value === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    else if (token.value === '[') squareDepth += 1;
    else if (token.value === ']') squareDepth = Math.max(0, squareDepth - 1);
    else if (
      (token.value === ',' || token.value === ';') &&
      curlyDepth === 1 &&
      parenthesisDepth === 0 &&
      squareDepth === 0
    ) {
      fieldStart = true;
    }
  }
}

function finalReturnedRoot(tokens: LuaToken[]): string | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.value !== 'return') continue;
    const path = readMemberPath(tokens, index + 1);
    if (!path) continue;
    if (tokens.slice(path.next).every((token) => token.value === ';')) return path.name;
  }
  return undefined;
}

function collectReturnedRootKeys(
  tokens: LuaToken[],
  returnedRoot: string,
  keys: Set<string>,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const path = readMemberPath(tokens, index);
    if (!path || tokens[path.next]?.value !== '=') continue;
    const key = memberKey(path.name, returnedRoot);
    if (key) keys.add(key);
    if (path.name === returnedRoot && tokens[path.next + 1]?.value === '{') {
      collectTableKeys(tokens, path.next + 1, keys);
    }
  }
}

function memberKey(name: string, root: string): string | undefined {
  if (name === root) return undefined;
  if (!name.startsWith(`${root}.`) && !name.startsWith(`${root}:`)) return undefined;
  return name.slice(root.length + 1).split(/[.:]/)[0] || undefined;
}
