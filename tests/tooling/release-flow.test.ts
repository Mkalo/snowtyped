import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { test } from 'vitest';
import type {
  CiJob,
  CiRun,
  ProvenanceDocument,
  PublishedMetadata,
} from '../../scripts/release-policy.js';

interface ReleaseTestState {
  packageExists: boolean;
  tags: Record<string, string>;
  npmCalls: string[][];
  writes: string[];
  run: CiRun & { id: number };
  jobs: CiJob[];
  conflict?: boolean;
  metadata?: PublishedMetadata;
  attestations?: ProvenanceDocument;
  reference?: { object: { type: string; sha: string } };
  release?: { draft: boolean; prerelease: boolean; latest: boolean; body: string };
  unpublishedAt?: string;
  registryStatus?: number;
  approvalAfterPolls?: number;
  signatureFailure?: boolean;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = resolve(tmpdir());
const pnpm = process.env.npm_execpath;
assert(pnpm, 'Run through pnpm test:release.');

test('real release CLI rehearses immutable packing, staging, and partial-failure recovery without network writes', async () => {
  const cwd = await mkdtemp(join(temporaryRoot, 'snowtyped-release-'));
  const artifacts = join(cwd, 'reports/release');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    await mkdir(join(cwd, '.changeset'));
    await mkdir(artifacts, { recursive: true });
    for (const file of ['package.json', 'LICENSE', 'CHANGELOG.md', 'pnpm-workspace.yaml']) {
      await cp(join(root, file), join(cwd, file));
    }
    await cp(join(root, '.changeset/config.json'), join(cwd, '.changeset/config.json'));
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\nreports/\n');
    await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), 'junction');
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release validation');
    git('config', 'user.email', 'release@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(cwd, 'no-hooks'));
    git('add', '.');
    git('commit', '-m', 'Disposable reviewed release candidate');
    const sha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', sha);
    execFileSync(process.execPath, [pnpm, 'pack', '--pack-destination', artifacts], {
      cwd: root,
      stdio: 'pipe',
    });
    const { version } = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const tag = String(semver.prerelease(version)?.[0] ?? 'latest');
    const stable = tag === 'latest';
    const statePath = join(cwd, 'reports/state.json');
    const preload = join(cwd, 'reports/mock-services.mjs');
    const fakeCli = join(cwd, 'reports/npm/bin/npm-cli.js');
    await mkdir(join(cwd, 'reports/npm/bin'), { recursive: true });
    await writeFile(
      join(cwd, 'reports/npm/package.json'),
      JSON.stringify({ name: 'npm', version: '12.2.1' }),
    );
    await writeFile(
      preload,
      `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const statePath = process.env.RELEASE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const realExec = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command === 'git' || command === 'tar') return realExec(command, args, options);
  if (command === process.execPath && args[0] === process.env.NPM_CLI_JS) {
    state.npmCalls.push(args.slice(1)); save();
    if (args[1] === 'stage' && args[2] === 'publish') {
      if (state.conflict) throw new Error('409: staged version already exists; review required');
      const manifest = JSON.parse(realExec('tar', ['-xOf', args[3], 'package/package.json'], { encoding: 'utf8' }));
      if (manifest.version === '0.0.0-bootstrap.0') {
        state.packageExists = true; delete state.unpublishedAt; save();
        return JSON.stringify({ snowtyped: { name: manifest.name, version: manifest.version, stageId: '11111111-1111-4111-8111-111111111111', integrity: 'sha512-' + createHash('sha512').update(fs.readFileSync(args[3])).digest('base64') } });
      }
      return '';
    }
    if (args[1] === 'access' || args[1] === 'trust' || args[1] === 'install') return '';
    if (args[1] === 'audit') { if (state.signatureFailure) throw new Error('Invalid npm signature'); return ''; }
    assert.deepEqual(args.slice(1, 3), ['stage', 'reject']);
    assert.equal(args[3], '11111111-1111-4111-8111-111111111111');
    assert(state.metadata, 'Rejecting the only stage would unpublish the placeholder.');
    return '';
  }
  assert.equal(command, 'gh', 'Block every unexpected subprocess.');
  if (args[0] === 'api') return JSON.stringify([{ jobs: state.jobs }]);
  assert.deepEqual(args.slice(0, 2), ['release', 'create']);
  state.writes.push('release');
  state.release = { draft: false, prerelease: args.includes('--prerelease'), latest: args.includes('--latest=true'), body: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') };
  save(); return 'https://github.com/Mkalo/snowtyped/releases/test';
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options = {}) => {
  let value;
  const route = String(url);
  if (route === 'https://api.github.com/repos/Mkalo/snowtyped') value = { visibility: 'public' };
  else if (route.includes('/actions/workflows/ci.yml/runs?')) value = { workflow_runs: [state.run] };
  else if (route.includes('/git/ref/tags/')) value = state.reference;
  else if (route.endsWith('/git/refs') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    state.writes.push('tag'); state.reference = { object: { type: 'commit', sha: body.sha } }; save(); value = state.reference;
  } else if (route.includes('/releases/tags/')) value = state.release;
  else if (route.includes('registry.npmjs.org/-/npm/v1/attestations/')) value = state.attestations;
  else if (route.includes('registry.npmjs.org/-/package/snowtyped/dist-tags')) value = state.tags;
  else if (route === 'https://registry.npmjs.org/snowtyped') value = state.unpublishedAt ? { time: { unpublished: { time: state.unpublishedAt } } } : state.packageExists ? { name: 'snowtyped', versions: { '0.0.0-stage': {} } } : undefined;
  else if (route.startsWith('https://registry.npmjs.org/snowtyped/')) {
    if (state.approvalAfterPolls > 0) { state.approvalAfterPolls--; save(); value = undefined; }
    else value = state.metadata;
  }
  else throw new Error('Block every unexpected HTTP request: ' + route);
  return new Response(JSON.stringify(value || {}), { status: route === 'https://registry.npmjs.org/snowtyped' && state.registryStatus ? state.registryStatus : value === undefined ? 404 : 200 });
};
`,
    );
    let state: ReleaseTestState = {
      packageExists: true,
      tags: {},
      npmCalls: [],
      writes: [],
      run: {
        id: 1,
        head_sha: sha,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      },
      jobs: [
        'Changesets',
        'CI required',
        ...['ubuntu-latest', 'windows-latest'].flatMap((os) =>
          [22, 24].map((node) => `Check (${os}, Node ${node})`),
        ),
      ].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    };
    const invoke = async (mode: string, expected = 0, env: NodeJS.ProcessEnv = {}) => {
      await writeFile(statePath, JSON.stringify(state));
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          join(root, 'scripts/release.mjs'),
          mode,
          version,
          sha,
          artifacts,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            RELEASE_TEST_STATE: statePath,
            GITHUB_OUTPUT: join(cwd, 'reports/github-output'),
            GITHUB_STEP_SUMMARY: join(cwd, 'reports/github-summary'),
            GITHUB_REPOSITORY: 'Mkalo/snowtyped',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: sha,
            GH_TOKEN: 'fake-test-token',
            NPM_CLI_JS: fakeCli,
            ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid',
            NODE_AUTH_TOKEN: '',
            NPM_TOKEN: '',
            NPM_STABLE_RELEASES_ENABLED: stable ? 'true' : '',
            ...env,
          },
        },
      );
      state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(result.status, expected, result.stdout + result.stderr);
      return result.stdout + result.stderr;
    };
    if (stable) {
      assert.match(
        await invoke('check', 1, { NPM_STABLE_RELEASES_ENABLED: '' }),
        /Stable publication requires NPM_STABLE_RELEASES_ENABLED=true/,
      );
    }
    await invoke('check');
    await invoke('inspect');
    await invoke('candidate');
    assert.match(await readFile(join(cwd, 'reports/github-output'), 'utf8'), /eligible=true/);
    const unversioned = join(cwd, '.changeset/unversioned.md');
    await writeFile(unversioned, '---\n"snowtyped": patch\n---\n\nUnversioned change.\n');
    await invoke('candidate');
    assert(
      (await readFile(join(cwd, 'reports/github-output'), 'utf8')).endsWith('eligible=false\n'),
    );
    await rm(unversioned);
    const record = JSON.parse(await readFile(join(artifacts, 'release.json'), 'utf8'));
    assert.equal(record.tag, tag);
    assert.equal(record.sha, sha);
    assert.equal((await readdir(artifacts)).filter((file) => file.endsWith('.tgz')).length, 1);
    state.run.conclusion = 'failure';
    await invoke('check', 1);
    state.run.conclusion = 'success';
    state.packageExists = false;
    await invoke('stage', 1);
    assert.equal(state.npmCalls.length, 0);
    await invoke('trust', 1);
    await invoke('cleanup-bootstrap', 1);
    assert.equal(state.npmCalls.length, 0);
    state.unpublishedAt = new Date(Date.now() - 600_000).toISOString();
    for (const operation of [
      'bootstrap-check',
      'bootstrap',
      'trust',
      'stage',
      'cleanup-bootstrap',
    ]) {
      assert.match(await invoke(operation, 1), /npm name cooldown/);
    }
    assert.equal(state.npmCalls.length, 0);
    delete state.unpublishedAt;
    state.registryStatus = 503;
    await invoke('bootstrap', 1);
    assert.equal(state.npmCalls.length, 0);
    delete state.registryStatus;
    state.unpublishedAt = new Date(Date.now() - 86_400_001).toISOString();
    await invoke('bootstrap');
    assert.equal(state.npmCalls.length, 1);
    const bootstrapArgs = state.npmCalls[0];
    assert(bootstrapArgs);
    assert.equal(bootstrapArgs[bootstrapArgs.indexOf('--tag') + 1], 'bootstrap');
    assert(
      bootstrapArgs.includes('--provenance=false') && bootstrapArgs.includes('--ignore-scripts'),
    );
    const holding = JSON.parse(await readFile(join(artifacts, 'bootstrap/receipt.json'), 'utf8'));
    assert.equal(holding.version, '0.0.0-bootstrap.0');
    assert.notEqual(holding.version, version);
    await invoke('bootstrap', 1);
    await invoke('cleanup-bootstrap', 1);
    assert.equal(state.npmCalls.length, 1);
    await invoke('trust');
    assert.equal(state.npmCalls.length, 3);
    const trust = state.npmCalls[2];
    assert(trust?.includes('--allow-stage-publish'));
    assert(!trust?.includes('--allow-publish'));
    assert(state.npmCalls[1]?.includes('mfa=publish'));
    await writeFile(
      join(cwd, 'reports/npm/package.json'),
      JSON.stringify({ name: 'npm', version: '12.0.2' }),
    );
    await invoke('trust', 1);
    assert.equal(state.npmCalls.length, 3);
    await writeFile(
      join(cwd, 'reports/npm/package.json'),
      JSON.stringify({ name: 'npm', version: '12.2.1' }),
    );
    state.packageExists = true;
    await invoke('stage', 1, { GITHUB_SHA: 'b'.repeat(40) });
    assert.equal(state.npmCalls.length, 3);
    await invoke('stage');
    const args = state.npmCalls[3];
    assert(args);
    assert.deepEqual(args.slice(0, 2), ['stage', 'publish']);
    assert.equal(args[args.indexOf('--tag') + 1], tag);
    assert(args.includes('--provenance') && args.includes('--ignore-scripts'));
    assert.deepEqual(state.writes, []);
    state.conflict = true;
    await invoke('stage', 1);
    assert.deepEqual(state.writes, []);
    await invoke('verify', 1);
    await invoke('wait', 1, { NPM_APPROVAL_TIMEOUT_MS: '0' });
    state.metadata = {
      name: 'snowtyped',
      version,
      license: 'MIT',
      dist: {
        integrity: record.integrity,
        attestations: {
          url: `https://registry.npmjs.org/-/npm/v1/attestations/snowtyped@${version}`,
          provenance: {},
        },
      },
    };
    const statement = {
      subject: [
        {
          name: `pkg:npm/snowtyped@${version}`,
          digest: { sha512: Buffer.from(record.integrity.slice(7), 'base64').toString('hex') },
        },
      ],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              ref: 'refs/heads/main',
              repository: 'https://github.com/Mkalo/snowtyped',
              path: '.github/workflows/release.yml',
            },
          },
          resolvedDependencies: [
            {
              uri: 'git+https://github.com/Mkalo/snowtyped@refs/heads/main',
              digest: { gitCommit: sha },
            },
          ],
        },
        runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
      },
    };
    state.attestations = {
      attestations: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: {
            dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
          },
        },
      ],
    };
    state.tags = { [tag]: version };
    const calls = state.npmCalls.length;
    await invoke('stage');
    assert.equal(state.npmCalls.length, calls);
    await invoke('verify');
    await invoke('candidate');
    assert(
      (await readFile(join(cwd, 'reports/github-output'), 'utf8')).endsWith('eligible=true\n'),
    );
    state.approvalAfterPolls = 1;
    await invoke('wait', 0, { NPM_APPROVAL_POLL_MS: '1' });
    assert.equal(state.npmCalls.length, calls);
    await invoke('finalize');
    assert.deepEqual(state.writes, ['tag', 'release']);
    assert.equal(state.release?.prerelease, !stable);
    assert.equal(state.release?.latest, stable);
    await invoke('candidate');
    assert(
      (await readFile(join(cwd, 'reports/github-output'), 'utf8')).endsWith('eligible=false\n'),
    );
    const rejects = () =>
      state.npmCalls.filter((call) => call[0] === 'stage' && call[1] === 'reject').length;
    assert.equal(rejects(), 0);
    await writeFile(
      join(artifacts, 'bootstrap/receipt.json'),
      JSON.stringify({ ...holding, version }),
    );
    await invoke('cleanup-bootstrap', 1);
    assert.equal(rejects(), 0);
    await writeFile(join(artifacts, 'bootstrap/receipt.json'), JSON.stringify(holding));
    state.signatureFailure = true;
    await invoke('cleanup-bootstrap', 1);
    assert.equal(rejects(), 0);
    state.signatureFailure = false;
    await invoke('cleanup-bootstrap');
    assert.equal(rejects(), 1);
    assert(state.reference);
    assert.equal(state.reference.object.sha, sha);
    await invoke('finalize');
    assert.deepEqual(state.writes, ['tag', 'release']);
    assert(state.metadata);
    state.metadata.dist.integrity = 'sha512-different';
    await invoke('finalize', 1);
    state.metadata.dist.integrity = record.integrity;
    state.reference.object.sha = 'b'.repeat(40);
    await invoke('finalize', 1);
    state.reference.object.sha = sha;
    delete state.metadata.dist.attestations;
    await invoke('finalize', 1);
    assert.deepEqual(state.writes, ['tag', 'release']);
  } finally {
    assert(resolve(cwd).startsWith(`${temporaryRoot}${sep}snowtyped-release-`));
    await rm(cwd, { recursive: true, force: true });
  }
});
