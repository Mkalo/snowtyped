import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { ProvenanceStatement } from '../../scripts/release-policy.js';
import {
  changelogNotes,
  publishedState,
  registryState,
  releaseInfo,
  requireCi,
  requireProvenance,
  requireProvenanceIdentity,
  requireRegistryPackage,
} from '../../scripts/release-policy.js';

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const info = (version: string, allowStable = false) =>
  releaseInfo({ ...manifest, version }, allowStable);
const sha = 'a'.repeat(40);
const run = {
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};
const jobs = [
  'Changesets',
  'Check (ubuntu-latest, Node 22)',
  'Check (ubuntu-latest, Node 24)',
  'Check (windows-latest, Node 22)',
  'Check (windows-latest, Node 24)',
  'CI required',
].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const integrity = 'sha512-reviewed-candidate-bytes';
const alpha = info('0.1.0-alpha.1');
const metadata = {
  name: 'snowtyped',
  version: alpha.version,
  license: 'MIT',
  dist: {
    integrity,
    attestations: { url: 'https://registry.npmjs.org/attestations', provenance: {} },
  },
};

test('npm tombstones block the entire 24-hour cooldown, including the final millisecond', () => {
  const removed = Date.parse('2026-10-23T01:44:09.691Z');
  const tombstone = { time: { unpublished: { time: new Date(removed).toISOString() } } };
  const deadline = removed + 86_400_000;
  for (const now of [removed, removed + 1, deadline - 1]) {
    assert.throws(() => registryState(tombstone, now), /2026-10-24T01:44:09.691Z/);
  }
  assert.equal(registryState(tombstone, deadline), 'missing');
  assert.equal(registryState(tombstone, deadline + 1), 'missing');
  assert.throws(() => registryState({ time: { unpublished: { time: 'invalid' } } }), /timestamp/);
});

test('an HTTP-200 empty or unpublished record does not establish a usable npm package', () => {
  for (const value of [
    undefined,
    {},
    { versions: {} },
    { time: { unpublished: { time: '2000-01-01T00:00:00.000Z' } } },
  ]) {
    assert.equal(registryState(value), 'missing');
    assert.throws(() => requireRegistryPackage(value), /holding stage pending/);
  }
  const placeholder = { versions: { '0.0.0-stage': {} } };
  assert.equal(registryState(placeholder), 'ready');
  requireRegistryPackage(placeholder);
});

test('alpha/beta versions select their own tags; stable needs an explicit switch', () => {
  assert.deepEqual(alpha, { version: '0.1.0-alpha.1', tag: 'alpha', prerelease: true });
  assert.equal(info('1.0.0-beta.4').tag, 'beta');
  assert.throws(() => info('1.0.0'), /NPM_STABLE_RELEASES_ENABLED/);
  assert.deepEqual(info('1.0.0', true), { version: '1.0.0', tag: 'latest', prerelease: false });
  for (const version of [
    '1.0.0-rc.1',
    '1.0.0-alpha',
    '1.0.0-alpha.01',
    '1.0.0+local',
    'v1.0.0',
    '../main',
  ]) {
    assert.throws(() => info(version), version);
  }
});

test('publication rejects private, unlicensed, renamed, or redirected package manifests', () => {
  for (const change of [
    { private: true },
    { license: 'UNLICENSED' },
    { name: 'another-package' },
    { repository: { url: 'https://github.com/other/repo' } },
    { publishConfig: { ...manifest.publishConfig, access: 'restricted' } },
    { publishConfig: { ...manifest.publishConfig, registry: 'https://other.registry' } },
    { publishConfig: { ...manifest.publishConfig, provenance: false } },
  ])
    assert.throws(() => releaseInfo({ ...manifest, ...change }));
});

test('exact main push commit needs every real matrix job, Changesets, and the fixed gate', () => {
  requireCi(run, jobs, sha);
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { status: 'queued' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ])
    assert.throws(() => requireCi({ ...run, ...change }, jobs, sha));
  assert.throws(() => requireCi(undefined, jobs, sha));
  for (const job of jobs) {
    assert.throws(() =>
      requireCi(
        run,
        jobs.filter((candidate) => candidate !== job),
        sha,
      ),
    );
    for (const conclusion of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.throws(() =>
        requireCi(
          run,
          jobs.map((candidate) => (candidate === job ? { ...job, conclusion } : candidate)),
          sha,
        ),
      );
    }
  }
  const firstJob = jobs[0];
  assert(firstJob);
  assert.throws(() => requireCi(run, [...jobs, firstJob], sha), /Expected one/);
});

test('identical published bytes are safe to resume; changed bytes cannot reuse a version', () => {
  const tags = { alpha: alpha.version, latest: '0.0.0-stage' };
  assert.equal(publishedState(undefined, integrity, alpha, tags), 'missing');
  assert.equal(publishedState(metadata, integrity, alpha, tags), 'published');
  assert.throws(
    () => publishedState(metadata, 'sha512-other-bytes', alpha, tags),
    /Published bytes differ/,
  );
  assert.throws(
    () => publishedState({ ...metadata, deprecated: 'Unsafe' }, integrity, alpha, tags),
    /deprecated/,
  );
  assert.throws(() =>
    publishedState({ ...metadata, version: '0.1.0-alpha.2' }, integrity, alpha, tags),
  );
  assert.deepEqual(tags, { alpha: alpha.version, latest: '0.0.0-stage' });
});

test('recovery never moves an advanced tag backward or silently repairs a missing/wrong tag', () => {
  assert.equal(publishedState(metadata, integrity, alpha, { alpha: '0.2.0-alpha.1' }), 'published');
  for (const tags of [
    {},
    { alpha: 'garbage' },
    { alpha: '0.1.0-alpha.0' },
    { alpha: '1.0.0' },
    { alpha: '1.0.0-beta.0' },
  ]) {
    assert.throws(() => publishedState(metadata, integrity, alpha, tags));
  }
});

test('unapproved/missing provenance fails before creating release tags', () => {
  requireProvenance(metadata);
  assert.throws(() => requireProvenance({ dist: {} }), /provenance attestations/);
  assert.throws(
    () => requireProvenance({ dist: { attestations: { url: 'url' } } }),
    /provenance statement/,
  );
});

test('release notes use only the exact candidate changelog section', () => {
  const changelog =
    '# Changelog\n\n## 0.1.0-alpha.2\n\nNewer.\n\n## 0.1.0-alpha.1\n\n### Patch Changes\n\nReviewed fix.\n\n## 0.1.0-alpha.0 — 2026-10-22\n\nOriginal.\n';
  assert.equal(changelogNotes(changelog, alpha.version), '### Patch Changes\n\nReviewed fix.\n');
  assert.equal(changelogNotes(changelog, '0.1.0-alpha.0'), 'Original.\n');
  assert.throws(() => changelogNotes(changelog, '1.0.0'), /changelog entry/);
  assert.throws(() => changelogNotes('## 1.0.0\n\n', '1.0.0'), /empty/);
});

test('provenance binds the artifact, source commit, main branch, workflow, and hosted runner', () => {
  const hash = 'a'.repeat(128);
  const expectedIntegrity = `sha512-${Buffer.from(hash, 'hex').toString('base64')}`;
  const statement = {
    subject: [{ name: `pkg:npm/snowtyped@${alpha.version}`, digest: { sha512: hash } }],
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
  const document = (payload: ProvenanceStatement) => ({
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString('base64') },
        },
      },
    ],
  });
  requireProvenanceIdentity(document(statement), alpha.version, sha, expectedIntegrity);
  for (const mutate of [
    (value: ProvenanceStatement) => {
      assert(value.subject[0]);
      value.subject[0].name = 'pkg:npm/another-package@1.0.0';
    },
    (value: ProvenanceStatement) => {
      assert(value.subject[0]);
      value.subject[0].digest.sha512 = 'b'.repeat(128);
    },
    (value: ProvenanceStatement) => {
      assert(value.predicate.buildDefinition.resolvedDependencies[0]);
      value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40);
    },
    (value: ProvenanceStatement) => {
      value.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/feature';
    },
    (value: ProvenanceStatement) => {
      value.predicate.buildDefinition.externalParameters.workflow.repository =
        'https://github.com/other/repo';
    },
    (value: ProvenanceStatement) => {
      value.predicate.buildDefinition.externalParameters.workflow.path =
        '.github/workflows/another.yml';
    },
    (value: ProvenanceStatement) => {
      value.predicate.runDetails.builder.id = 'self-hosted';
    },
  ]) {
    const changed = structuredClone(statement);
    mutate(changed);
    assert.throws(() =>
      requireProvenanceIdentity(document(changed), alpha.version, sha, expectedIntegrity),
    );
  }
  assert.throws(() => requireProvenanceIdentity({}, alpha.version, sha, expectedIntegrity));
});
