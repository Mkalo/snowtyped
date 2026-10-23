import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReleasePlan } from '@changesets/get-release-plan';

import { test } from 'vitest';

test('Changesets versions, prereleases, and contribution policy', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pnpm = process.env.npm_execpath;
  assert(pnpm, 'Run through pnpm test:versioning.');
  const temporaryRoot = resolve(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, 'snowtyped-versioning-'));
  const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const checkScript = join(root, 'scripts/check-changesets.mjs');
  let fixtureNumber = 0;

  function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
  }
  const git = (cwd: string, ...args: string[]) => run('git', args, cwd).trim();
  const pm = (cwd: string, ...args: string[]) => run(process.execPath, [pnpm, ...args], cwd);
  const json = async (cwd: string, path: string) =>
    JSON.parse(await readFile(join(cwd, path), 'utf8'));
  const commit = (cwd: string) => {
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'Disposable versioning fixture');
  };

  async function fixture(version: string, prerelease = false) {
    const cwd = join(temporary, String(fixtureNumber++));
    await mkdir(join(cwd, '.changeset'), { recursive: true });
    await mkdir(join(cwd, 'src'));
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'biome.json']) {
      await cp(join(root, file), join(cwd, file));
    }
    await cp(join(root, '.changeset/config.json'), join(cwd, '.changeset/config.json'));
    await writeFile(
      join(cwd, 'package.json'),
      `${JSON.stringify({ ...original, version }, null, 2)}\n`,
    );
    await writeFile(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n## ${version}\n\nOriginal entry.\n`);
    await writeFile(join(cwd, 'src/index.ts'), 'export const example = 1;\n');
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
    await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), 'junction');
    git(cwd, 'init', '--initial-branch=main');
    git(cwd, 'config', 'user.name', 'Versioning validation');
    git(cwd, 'config', 'user.email', 'versioning@example.invalid');
    // Avoid a developer's global signing/hook settings in disposable repositories.
    git(cwd, 'config', 'commit.gpgsign', 'false');
    git(cwd, 'config', 'core.hooksPath', join(cwd, 'no-hooks'));
    if (prerelease) pm(cwd, 'changeset', 'pre', 'enter', 'alpha');
    commit(cwd);
    git(cwd, 'switch', '-c', 'feature');
    return cwd;
  }

  async function changeset(
    cwd: string,
    name: string,
    type: 'patch' | 'minor' | 'major' | undefined,
    summary = `Fixture ${type} change.`,
  ) {
    await writeFile(
      join(cwd, `.changeset/${name}.md`),
      `---\n${type ? `"snowtyped": ${type}\n` : ''}---\n\n${summary}\n`,
    );
  }

  function check(cwd: string, expected = 0, env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, [checkScript, 'main'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHANGESETS_BASE: '',
        CHANGESETS_HEAD: '',
        CHANGESETS_HEAD_REPOSITORY: '',
        ...env,
      },
    });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  }

  async function version(cwd: string, expected: string, summary: string) {
    const plan = await getReleasePlan(cwd);
    assert.equal(
      plan.releases.find((release) => release.name === 'snowtyped')?.newVersion,
      expected,
    );
    pm(cwd, 'version:packages');
    const manifest = await json(cwd, 'package.json');
    assert.equal(manifest.version, expected);
    assert.equal(manifest.private, original.private);
    assert.equal(manifest.license, 'MIT');
    const changelog = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
    assert(changelog.includes(`## ${expected}\n`));
    assert(changelog.includes(summary));
    pm(cwd, 'lint');
    // This catches an out-of-sync manifest/lockfile with CI's real install mode.
    pm(cwd, 'install', '--lockfile-only', '--frozen-lockfile', '--ignore-scripts', '--offline');
  }

  try {
    for (const [type, expected] of [
      ['patch', '1.2.4'],
      ['minor', '1.3.0'],
      ['major', '2.0.0'],
    ] as const) {
      const cwd = await fixture('1.2.3');
      await changeset(cwd, 'change', type);
      commit(cwd);
      check(cwd);
      await version(cwd, expected, `Fixture ${type} change.`);
      assert.deepEqual(await readdir(join(cwd, '.changeset')), ['config.json']);
      console.log(`${type}: 1.2.3 -> ${expected}; changelog + frozen lockfile passed.`);
    }

    const pre = await fixture('0.1.0-alpha.0', true);
    await changeset(pre, 'fix', 'patch', 'Fix alpha behavior.');
    commit(pre);
    await version(pre, '0.1.0-alpha.1', 'Fix alpha behavior.');
    assert((await readdir(join(pre, '.changeset/pre'))).includes('fix.md'));
    commit(pre);
    // No new changeset must not manufacture a new prerelease on a second version command.
    const repeat = spawnSync(process.execPath, [pnpm, 'version:packages'], { cwd: pre });
    assert.equal(repeat.status, 0);
    assert.equal((await json(pre, 'package.json')).version, '0.1.0-alpha.1');
    assert.equal(git(pre, 'status', '--porcelain'), '');
    assert.equal((await getReleasePlan(pre)).releases.length, 0);
    await changeset(pre, 'feature', 'minor', 'Add alpha capability.\n\nDescribe it further.');
    commit(pre);
    await version(pre, '0.1.0-alpha.2', 'Add alpha capability.');
    commit(pre);
    // Change channels without running version between exit and enter: no stable intermediate.
    pm(pre, 'changeset', 'pre', 'exit');
    pm(pre, 'changeset', 'pre', 'enter', 'beta');
    await changeset(pre, 'beta', 'patch', 'Validate beta behavior.');
    commit(pre);
    await version(pre, '0.1.0-beta.3', 'Validate beta behavior.');
    commit(pre);
    pm(pre, 'changeset', 'pre', 'exit');
    await version(pre, '0.1.0', 'Add alpha capability.');
    assert(!(await readdir(join(pre, '.changeset'))).includes('pre.json'));
    assert.deepEqual(await readdir(join(pre, '.changeset/pre')), []);
    console.log('Alpha -> beta -> stable; retained summaries, MIT metadata, and lockfile passed.');

    const breaking = await fixture('0.1.0-alpha.0', true);
    await changeset(breaking, 'breaking', 'major', 'Remove an incompatible API.');
    commit(breaking);
    await version(breaking, '1.0.0-alpha.1', 'Remove an incompatible API.');
    console.log('Breaking alpha: 0.1.0-alpha.0 -> 1.0.0-alpha.1 passed.');

    const policy = await fixture('1.2.3');
    await writeFile(join(policy, 'README.md'), 'Docs-only fixture.\n');
    commit(policy);
    check(policy);
    await writeFile(join(policy, 'src/index.ts'), 'export const example = 2;\n');
    commit(policy);
    assert.match(check(policy, 1), /no changesets were found/);
    await changeset(policy, 'real-change', 'patch');
    commit(policy);
    check(policy);
    await version(policy, '1.2.4', 'Fixture patch change.');
    commit(policy);
    const botEnv = {
      CHANGESETS_HEAD: 'changeset-release/main',
      CHANGESETS_HEAD_REPOSITORY: 'fixture/snowtyped',
      GITHUB_REPOSITORY: 'fixture/snowtyped',
    };
    // Release PRs must be based on a commit that already contains the feature change.
    git(policy, 'branch', '-f', 'main', 'HEAD~1');
    check(policy, 0, botEnv);
    check(policy, 1, { ...botEnv, CHANGESETS_HEAD_REPOSITORY: 'fork/snowtyped' });
    await writeFile(join(policy, 'src/index.ts'), 'export const example = 3;\n');
    commit(policy);
    assert.match(check(policy, 1, botEnv), /Unexpected version PR change/);

    const tooling = await fixture('1.2.3');
    const toolingManifest = await json(tooling, 'package.json');
    toolingManifest.scripts['ci:fixture'] = 'node --version';
    await writeFile(join(tooling, 'package.json'), JSON.stringify(toolingManifest));
    commit(tooling);
    check(tooling, 1);
    await changeset(tooling, 'no-release', undefined, 'CI-only exemption.');
    commit(tooling);
    check(tooling);
    assert.equal((await getReleasePlan(tooling)).releases.length, 0);
    await writeFile(join(tooling, '.changeset/invalid.md'), 'Invalid frontmatter.\n');
    assert.match(check(tooling, 1, { CHANGESETS_BASE: 'HEAD' }), /missing or invalid frontmatter/);
    console.log(
      'Missing changeset fails; docs/CI exemptions and restricted version PR checks passed.',
    );
  } finally {
    assert(resolve(temporary).startsWith(`${temporaryRoot}${sep}snowtyped-versioning-`));
    await rm(temporary, { recursive: true, force: true });
  }
});
