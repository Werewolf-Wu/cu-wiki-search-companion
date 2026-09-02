// SPDX-License-Identifier: MPL-2.0
import { build } from 'vite';
import nightlyWorkflow from '../.github/workflows/nightly.yml?raw';
import packageManifestSource from '../package.json?raw';

describe('userscript activation metadata', () => {
  it('builds edit/submit-only match patterns into both metadata headers', async () => {
    const result = await build({ build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) =>
      'output' in entry ? entry.output : [],
    );
    const userScript = outputs.find(
      (entry) => entry.type === 'chunk' && entry.fileName === 'cu-wiki-local-search.user.js',
    );
    const metaFile = outputs.find(
      (entry) => entry.type === 'asset' && entry.fileName === 'cu-wiki-local-search.meta.js',
    );
    if (userScript?.type !== 'chunk' || metaFile?.type !== 'asset') {
      throw new Error('Vite build did not return both userscript metadata artifacts');
    }
    const metaSource =
      typeof metaFile.source === 'string'
        ? metaFile.source
        : new TextDecoder().decode(metaFile.source);
    const userMatches = metadataMatches(userScript.code);
    const metaMatches = metadataMatches(metaSource);
    const packageVersion = (JSON.parse(packageManifestSource) as { version?: string }).version;

    expect(packageVersion).toBe('0.3.2');
    expect(metadataValue(userScript.code, 'version')).toBe(packageVersion);
    expect(metadataValue(metaSource, 'version')).toBe(packageVersion);
    expect(metaMatches).toEqual(userMatches);
    expect(userMatches).not.toContain('https://casualtiesunknown.huijiwiki.com/*');
    for (const url of [
      'https://casualtiesunknown.huijiwiki.com/wiki/首页',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?oldid=10',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=view',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&diff=10',
    ]) {
      expect(matchesAnyPattern(url, userMatches), url).toBe(false);
    }
    for (const url of [
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=edit',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=edit&section=1',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=edit',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=edit&section=1',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=submit',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=submit&section=1',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=submit',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=submit&section=1',
    ]) {
      expect(matchesAnyPattern(url, userMatches), url).toBe(true);
    }
  });

  it('queues same-ref nightly runs without cancelling an in-progress release update', () => {
    const concurrencyBlock = /concurrency:\s*\n([\s\S]*?)\n\npermissions:/.exec(
      nightlyWorkflow,
    )?.[1];

    expect(concurrencyBlock).toContain(
      'group: nightly-${{ github.workflow }}-${{ github.ref }}',
    );
    expect(concurrencyBlock).toContain('cancel-in-progress: false');
  });

  it('advances the rolling nightly tag only after the existing release edit succeeds', async () => {
    const { chmod, execFile, join, mkdir, mkdtemp, readFile, rm, tmpdir, writeFile } =
      await loadNodeTestTools();
    const temporary = await mkdtemp(join(tmpdir(), 'cu-wiki-nightly-'));
    const repository = join(temporary, 'repository');
    const fakeBin = join(temporary, 'bin');
    const tagState = join(temporary, 'tag-state');
    const ghLog = join(temporary, 'gh.log');
    try {
      await mkdir(repository);
      await mkdir(fakeBin);
      await mkdir(join(repository, 'nightly'));
      await writeFile(join(repository, 'nightly', 'asset.txt'), 'verified asset\n');
      await execFile('git', ['init', '--initial-branch=main'], { cwd: repository });
      await execFile('git', ['config', 'user.email', 'nightly-test@example.invalid'], {
        cwd: repository,
      });
      await execFile('git', ['config', 'user.name', 'Nightly Test'], {
        cwd: repository,
      });
      await writeFile(join(repository, 'history.txt'), 'first\n');
      await execFile('git', ['add', 'history.txt'], { cwd: repository });
      await execFile('git', ['commit', '-m', 'first nightly'], { cwd: repository });
      const previousSha = (
        await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository })
      ).stdout.trim();
      await writeFile(join(repository, 'history.txt'), 'second\n');
      await execFile('git', ['commit', '-am', 'second nightly'], { cwd: repository });
      const currentSha = (
        await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository })
      ).stdout.trim();
      await writeFile(tagState, `${previousSha}\n`);
      await writeFile(ghLog, '');
      const ghPath = join(fakeBin, 'gh');
      await writeFile(
        ghPath,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$GH_LOG"
if [[ "$1" == "api" && "$2" == repos/*/git/ref/tags/* ]]; then
  cat "$TAG_STATE"
elif [[ "$1" == "release" && "$2" == "view" ]]; then
  exit 0
elif [[ "$1" == "release" && "$2" == "edit" && "$FAIL_EDIT" == "1" ]]; then
  exit 42
elif [[ "$1" == "api" && "$*" == *"--method PATCH"* ]]; then
  printf '%s\\n' "$GITHUB_SHA" >"$TAG_STATE"
fi
`,
      );
      await chmod(ghPath, 0o755);
      const releaseScript = workflowRunScript(
        nightlyWorkflow,
        'Create or update the single nightly prerelease',
      );
      const processEnvironment = (
        globalThis as { process?: { env?: Record<string, string | undefined> } }
      ).process?.env;
      const environment = {
        ...processEnvironment,
        PATH: `${fakeBin}:${processEnvironment?.PATH ?? ''}`,
        RUNNER_TEMP: temporary,
        GITHUB_REPOSITORY: 'example/project',
        GITHUB_SHA: currentSha,
        RELEASE_TAG: 'nightly',
        GH_TOKEN: 'test-token',
        GH_REPO: 'example/project',
        GH_LOG: ghLog,
        TAG_STATE: tagState,
      };

      await expect(
        execFile('bash', ['-c', releaseScript], {
          cwd: repository,
          env: { ...environment, FAIL_EDIT: '1' },
        }),
      ).rejects.toBeDefined();

      expect((await readFile(tagState, 'utf8')).trim()).toBe(previousSha);
      expect(await readFile(ghLog, 'utf8')).not.toContain('--method PATCH');

      await writeFile(ghLog, '');
      await execFile('bash', ['-c', releaseScript], {
        cwd: repository,
        env: { ...environment, FAIL_EDIT: '0' },
      });

      const notes = await readFile(
        join(temporary, 'nightly-release-notes.md'),
        'utf8',
      );
      expect(notes).toContain(`/compare/${previousSha}...${currentSha}`);
      expect((await readFile(tagState, 'utf8')).trim()).toBe(currentSha);
      const calls = (await readFile(ghLog, 'utf8')).trim().split('\n');
      const upload = calls.findIndex((call) => call.startsWith('release upload '));
      const edit = calls.findIndex((call) => call.startsWith('release edit '));
      const patch = calls.findIndex(
        (call) => call.startsWith('api --method PATCH '),
      );
      expect(upload).toBeGreaterThanOrEqual(0);
      expect(edit).toBeGreaterThan(upload);
      expect(patch).toBeGreaterThan(edit);
      expect(patch).toBe(calls.length - 1);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

function workflowRunScript(workflow: string, stepName: string): string {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  if (stepStart < 0) throw new Error(`Workflow step not found: ${stepName}`);
  const runMarker = '        run: |\n';
  const scriptStart = workflow.indexOf(runMarker, stepStart);
  if (scriptStart < 0) throw new Error(`Workflow run block not found: ${stepName}`);
  const lines: string[] = [];
  for (const line of workflow.slice(scriptStart + runMarker.length).split('\n')) {
    if (line && !line.startsWith('          ')) break;
    lines.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return lines.join('\n');
}

interface NodeTestTools {
  chmod(path: string, mode: number): Promise<void>;
  execFile(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: Record<string, string | undefined>;
    },
  ): Promise<{ stdout: string; stderr: string }>;
  join(...parts: string[]): string;
  mkdir(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  tmpdir(): string;
  writeFile(path: string, data: string): Promise<void>;
}

async function loadNodeTestTools(): Promise<NodeTestTools> {
  const childProcessSpecifier = 'node:child_process';
  const fileSystemSpecifier = 'node:fs/promises';
  const osSpecifier = 'node:os';
  const pathSpecifier = 'node:path';
  const [childProcess, fileSystem, operatingSystem, paths] = await Promise.all([
    import(/* @vite-ignore */ childProcessSpecifier),
    import(/* @vite-ignore */ fileSystemSpecifier),
    import(/* @vite-ignore */ osSpecifier),
    import(/* @vite-ignore */ pathSpecifier),
  ]);
  const run = childProcess.execFile as (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: Record<string, string | undefined>;
      encoding: 'utf8';
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  return {
    ...(fileSystem as Omit<NodeTestTools, 'execFile' | 'join' | 'tmpdir'>),
    join: paths.join as NodeTestTools['join'],
    tmpdir: operatingSystem.tmpdir as NodeTestTools['tmpdir'],
    execFile: (command, args, options) =>
      new Promise((resolve, reject) => {
        run(command, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  };
}

function metadataMatches(source: string): string[] {
  return source
    .split('\n')
    .flatMap((line) => /^\/\/ @match\s+(\S+)\s*$/.exec(line)?.[1] ?? []);
}

function metadataValue(source: string, key: string): string | undefined {
  return source
    .split('\n')
    .map((line) => new RegExp(`^// @${key}\\s+(.+?)\\s*$`).exec(line)?.[1])
    .find((value) => value !== undefined);
}

function matchesAnyPattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(url, pattern));
}

function matchesPattern(url: string, pattern: string): boolean {
  const target = new URL(url);
  const separator = pattern.indexOf('/', 'https://'.length);
  const patternOrigin = pattern.slice(0, separator);
  if (target.origin !== patternOrigin) return false;
  const pathPattern = pattern.slice(separator);
  const expression = pathPattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(`${target.pathname}${target.search}`);
}
