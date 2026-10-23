import assert from 'node:assert/strict';
import semver from 'semver';

export const repository = 'Mkalo/snowtyped';
export const registry = 'https://registry.npmjs.org';

export interface ReleaseManifest {
  name: string;
  private: boolean;
  license: string;
  version: string;
  repository: { url: string };
  publishConfig: { access: string; registry: string; provenance: boolean };
}
export interface ReleaseInfo {
  version: string;
  prerelease: boolean;
  tag: 'alpha' | 'beta' | 'latest';
}
export interface CiRun {
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
}
export interface CiJob {
  name: string;
  status: string;
  conclusion: string | null | undefined;
}
export interface PublishedMetadata {
  name: string;
  version: string;
  license: string;
  deprecated?: string;
  dist: { integrity: string; attestations?: { url?: string; provenance?: unknown } };
}
export interface ProvenanceDocument {
  attestations?: { predicateType: string; bundle?: { dsseEnvelope?: { payload?: string } } }[];
}
export interface ProvenanceStatement {
  subject: { name: string; digest: { sha512: string } }[];
  predicate: {
    buildDefinition: {
      externalParameters: { workflow: { ref: string; repository: string; path: string } };
      resolvedDependencies: { uri: string; digest: { gitCommit: string } }[];
    };
    runDetails: { builder: { id: string } };
  };
}

export function releaseInfo(manifest: ReleaseManifest, allowStable = false): ReleaseInfo {
  assert.equal(manifest.name, 'snowtyped');
  assert.equal(manifest.private, false);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository.url, `git+https://github.com/${repository}.git`);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.publishConfig.registry, registry);
  assert.equal(manifest.publishConfig.provenance, true);
  const { version } = manifest;
  assert(semver.valid(version), 'Version must be valid SemVer.');
  assert(
    /^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/.test(version),
    'Use alpha.N, beta.N, or stable.',
  );
  const parsed = semver.parse(version);
  assert(parsed);
  const prerelease = parsed.prerelease.length > 0;
  assert(
    prerelease || allowStable,
    'Stable publication requires NPM_STABLE_RELEASES_ENABLED=true.',
  );
  const tag = prerelease ? parsed.prerelease[0] : 'latest';
  assert(tag === 'alpha' || tag === 'beta' || tag === 'latest');
  return { version, prerelease, tag };
}

export function requireCi(run: CiRun | undefined, jobs: CiJob[], sha: string) {
  assert(run, 'No CI push run exists for this exact commit.');
  assert.equal(run.head_sha, sha);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.event, 'push');
  assert.equal(run.status, 'completed', 'Wait for the latest CI push run to finish.');
  assert.equal(run.conclusion, 'success', 'The latest CI push run must pass.');
  const required = [
    'Changesets',
    'Check (ubuntu-latest, Node 22)',
    'Check (ubuntu-latest, Node 24)',
    'Check (windows-latest, Node 22)',
    'Check (windows-latest, Node 24)',
    'CI required',
  ];
  for (const name of required) {
    const matching = jobs.filter((job) => job.name === name);
    assert.equal(matching.length, 1, `Expected one ${name} job.`);
    assert(matching[0]);
    assert.equal(matching[0].status, 'completed', `${name} must finish.`);
    assert.equal(matching[0].conclusion, 'success', `${name} must pass.`);
  }
}

export function publishedState(
  metadata: PublishedMetadata | undefined,
  integrity: string,
  info: ReleaseInfo,
  tags: Record<string, string>,
) {
  if (!metadata) return 'missing';
  assert.equal(metadata.name, 'snowtyped');
  assert.equal(metadata.version, info.version);
  assert.equal(metadata.license, 'MIT');
  assert.equal(
    metadata.dist.integrity,
    integrity,
    'Published bytes differ; never overwrite/reuse this version.',
  );
  assert(!metadata.deprecated, 'This version is deprecated; review recovery manually.');
  const current = tags[info.tag];
  assert(current && semver.valid(current), `Registry is missing a valid ${info.tag} dist-tag.`);
  const currentChannel = semver.prerelease(current)?.[0] || 'latest';
  assert.equal(currentChannel, info.tag, 'Dist-tag points to a different release channel.');
  assert(
    current === info.version || semver.gt(current, info.version),
    'Dist-tag is behind this version; correct it deliberately with npm 2FA.',
  );
  return 'published';
}

export function changelogNotes(changelog: string, version: string) {
  const lines = changelog.split('\n');
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## ${version} — `),
  );
  assert(start >= 0, 'The candidate version must have a changelog entry.');
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const notes = lines
    .slice(start + 1, next < 0 ? undefined : next)
    .join('\n')
    .trim();
  assert(notes, 'Release notes must not be empty.');
  return `${notes}\n`;
}

export function requireProvenance(metadata: {
  dist: { attestations?: { url?: string; provenance?: unknown } };
}) {
  assert(metadata.dist.attestations?.url, 'The public version must have provenance attestations.');
  assert(
    metadata.dist.attestations.provenance,
    'The public version must have a provenance statement.',
  );
}

export function requireProvenanceIdentity(
  document: ProvenanceDocument | undefined,
  version: string,
  sha: string,
  integrity: string,
) {
  const attestation = document?.attestations?.find(
    (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
  );
  assert(attestation?.bundle?.dsseEnvelope?.payload, 'Missing signed SLSA v1 provenance payload.');
  const statement: ProvenanceStatement = JSON.parse(
    Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
  );
  const subject = statement.subject.find((entry) => entry.name === `pkg:npm/snowtyped@${version}`);
  assert.equal(
    subject?.digest.sha512,
    Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex'),
    'Provenance must identify the candidate bytes.',
  );
  const definition = statement.predicate.buildDefinition;
  assert.deepEqual(
    definition.externalParameters.workflow,
    {
      ref: 'refs/heads/main',
      repository: `https://github.com/${repository}`,
      path: '.github/workflows/release.yml',
    },
    'Provenance must identify this repository and staging workflow on main.',
  );
  assert(
    definition.resolvedDependencies.some(
      (entry) =>
        entry.digest.gitCommit === sha &&
        entry.uri === `git+https://github.com/${repository}@refs/heads/main`,
    ),
    'Provenance must identify the exact release commit.',
  );
  assert.equal(
    statement.predicate.runDetails.builder.id,
    'https://github.com/actions/runner/github-hosted',
  );
}
