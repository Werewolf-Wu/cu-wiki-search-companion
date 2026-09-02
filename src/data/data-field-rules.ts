// SPDX-License-Identifier: MPL-2.0
const LEGACY_DEFAULT_DATA_CODE_RULES = `# jq 风格路径子集；所选路径的标量值会用于查找对应代码名
Block = .locales["zh-CN"].name
Entity = .locales["zh-CN"].name, .locales["zh-CN"].description
Editor = .locales["zh-CN"].name, .locales["zh-CN"].description
Item = .locales["zh-CN"].name, .locales["zh-CN"].description
Liquid = .locales["zh-CN"].name
Localization = .locales["zh-CN"].name, .locales["zh-CN"].description
Moodle = .locales["zh-CN"].name, .locales["zh-CN"].description
WorldFluid = .locales["zh-CN"].name, .locales["zh-CN"].description
* = .locales["zh-CN"].name`;

export const DEFAULT_DATA_CODE_RULES = `# jq 风格路径子集；所选路径的标量值会用于查找对应代码名
Block = .locales["zh-CN"].name, .wiki.locales["zh-CN"].name
Entity = .locales["zh-CN"].name, .locales["zh-CN"].description, .wiki.locales["zh-CN"].name
Editor = .locales["zh-CN"].name, .locales["zh-CN"].description, .wiki.locales["zh-CN"].name
Item = .locales["zh-CN"].name, .locales["zh-CN"].description, .wiki.locales["zh-CN"].name
Liquid = .locales["zh-CN"].name, .wiki.locales["zh-CN"].name
Localization = .locales["zh-CN"].name, .locales["zh-CN"].description, .wiki.locales["zh-CN"].name
Moodle = .locales["zh-CN"].name, .locales["zh-CN"].description, .wiki.locales["zh-CN"].name
WorldFluid = .locales["zh-CN"].name, .locales["zh-CN"].description, .wiki.locales["zh-CN"].name
* = .locales["zh-CN"].name, .wiki.locales["zh-CN"].name`;

export function upgradeDefaultDataCodeRules(source: string | undefined): string | undefined {
  return source === LEGACY_DEFAULT_DATA_CODE_RULES ? DEFAULT_DATA_CODE_RULES : source;
}

type PathPattern = string[];

export type DataFieldRules = Record<string, PathPattern[]>;

export function parseDataFieldRules(source: string): DataFieldRules {
  const rules: DataFieldRules = {};
  for (const [lineIndex, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Data 代码配置第 ${lineIndex + 1} 行缺少“类型 = 路径”`);
    }
    const category = line.slice(0, separator).trim();
    const selectors = line
      .slice(separator + 1)
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean)
      .map((selector) => parsePath(selector, lineIndex + 1));
    if (!selectors.length) throw new Error(`Data 代码配置第 ${lineIndex + 1} 行没有路径`);
    rules[category] = selectors;
  }
  if (!Object.keys(rules).length) throw new Error('Data 代码配置不能为空');
  return rules;
}

export function extractDataFieldValues(
  document: unknown,
  source: string,
  rules: DataFieldRules,
): string[] {
  const category = dataCategory(source);
  const patterns = rules[category] ?? rules['*'] ?? [];
  const values = new Set<string>();
  collectSelectedValues(document, [], patterns, values);
  return [...values];
}

export function dataFieldProjection(rules: DataFieldRules): Record<string, 1> | undefined {
  const projection: Record<string, 1> = {
    id: 1,
    'locales.zh-CN.name': 1,
  };
  for (const patterns of Object.values(rules)) {
    for (const pattern of patterns) {
      const wildcardIndex = pattern.findIndex((segment) => segment === '*' || segment === '**');
      if (wildcardIndex === 0) return undefined;
      const projectedPath = pattern.slice(0, wildcardIndex < 0 ? pattern.length : wildcardIndex);
      if (!projectedPath.length) return undefined;
      projection[projectedPath.join('.')] = 1;
    }
  }
  return projection;
}

function collectSelectedValues(
  value: unknown,
  path: string[],
  patterns: PathPattern[],
  values: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectSelectedValues(child, path, patterns, values);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectSelectedValues(child, [...path, key], patterns, values);
    }
    return;
  }
  if (value === null || !patterns.some((pattern) => pathMatches(pattern, path))) return;
  if (typeof value === 'string') {
    if (value.trim()) values.add(value.trim());
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    values.add(String(value));
  }
}

function dataCategory(source: string): string {
  const match = /^Data:([^/]+)/.exec(source);
  return match?.[1] ?? '*';
}

function parsePath(source: string, lineNumber: number): PathPattern {
  if (!source.startsWith('.')) {
    throw new Error(`Data 代码配置第 ${lineNumber} 行路径必须以“.”开头：${source}`);
  }
  const segments: string[] = [];
  let cursor = 1;
  while (cursor < source.length) {
    if (source[cursor] === '.') {
      cursor += 1;
      continue;
    }
    if (source.startsWith('[]', cursor)) {
      cursor += 2;
      continue;
    }
    if (source.startsWith('["', cursor)) {
      const end = source.indexOf('"]', cursor + 2);
      if (end < 0) throw new Error(`Data 代码配置第 ${lineNumber} 行括号未闭合：${source}`);
      const quoted = source.slice(cursor + 1, end + 1);
      try {
        segments.push(JSON.parse(quoted) as string);
      } catch {
        throw new Error(`Data 代码配置第 ${lineNumber} 行括号键无效：${source}`);
      }
      cursor = end + 2;
      continue;
    }
    const nextDot = source.indexOf('.', cursor);
    const nextBracket = source.indexOf('[', cursor);
    const candidates = [nextDot, nextBracket].filter((position) => position >= 0);
    const end = candidates.length ? Math.min(...candidates) : source.length;
    const segment = source.slice(cursor, end);
    if (!segment || (segment.includes('*') && segment !== '*' && segment !== '**')) {
      throw new Error(`Data 代码配置第 ${lineNumber} 行路径无效：${source}`);
    }
    segments.push(segment);
    cursor = end;
  }
  if (!segments.length) throw new Error(`Data 代码配置第 ${lineNumber} 行路径为空`);
  return segments;
}

function pathMatches(pattern: PathPattern, path: string[], patternIndex = 0, pathIndex = 0): boolean {
  const segment = pattern[patternIndex];
  if (segment === undefined) return pathIndex === path.length;
  if (segment === '**') {
    if (patternIndex === pattern.length - 1) return true;
    for (let index = pathIndex; index <= path.length; index += 1) {
      if (pathMatches(pattern, path, patternIndex + 1, index)) return true;
    }
    return false;
  }
  if (pathIndex >= path.length || (segment !== '*' && segment !== path[pathIndex])) return false;
  return pathMatches(pattern, path, patternIndex + 1, pathIndex + 1);
}
