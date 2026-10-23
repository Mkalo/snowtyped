import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getReleasePlan } from '@changesets/get-release-plan';
import {
  changelogNotes,
  publishedState,
  registry,
  releaseInfo,
  repository,
  requireCi,
  requireProvenance,
  requireProvenanceIdentity,
} from './release-policy.ts';

const [mode, expectedVersion, sha, directory = 'reports/release'] = process.argv.slice(2);
assert(
  ['check', 'inspect', 'stage', 'verify', 'finalize'].includes(mode),
  'Unknown release operation.',
);
assert(/^[a-f0-9]{40}$/.test(sha || ''), 'Select a full, lowercase commit SHA.');
const artifactDirectory = resolve(directory);
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);
const api = async (path, options = {}) => {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...options.headers,
    },
  });
  if (response.status === 404 && !options.method) return undefined;
  assert(response.ok, `GitHub request failed (${response.status}): ${path}`);
  return response.json();
};
const npmMetadata = async (path) => {
  const response = await fetch(`${registry}/${path}`);
  if (response.status === 404) return undefined;
  assert(
    response.ok,
    `npm request failed (${response.status}); do not treat an outage as a new version.`,
  );
  return response.json();
};

assert.equal(git('rev-parse', 'HEAD'), sha, 'Checkout must match the selected candidate.');
git('merge-base', '--is-ancestor', sha, 'origin/main');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const info = releaseInfo(manifest, process.env.NPM_STABLE_RELEASES_ENABLED === 'true');
assert.equal(info.version, expectedVersion, 'The expected version must match the exact commit.');
assert.equal(
  (await getReleasePlan(process.cwd())).releases.length,
  0,
  'Merge the Changesets version PR first.',
);
const notes = changelogNotes(await readFile('CHANGELOG.md', 'utf8'), info.version);

if (mode === 'check') {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Release workflows run only from main.');
  if (process.env.RELEASE_OPERATION === 'stage') {
    assert.equal(
      process.env.GITHUB_SHA,
      sha,
      'Stage the workflow run commit so OIDC provenance identifies the actual source.',
    );
  }
  assert.equal(
    git('status', '--porcelain', '--untracked-files=no'),
    '',
    'Start from a clean checkout.',
  );
  const repo = await api(`repos/${repository}`);
  assert.equal(repo.visibility, 'public', 'Provenance requires public source.');
  const runs = await api(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const latest = runs.workflow_runs
    .filter((candidate) => candidate.head_branch === 'main' && candidate.head_sha === sha)
    .sort((a, b) => b.id - a.id)[0];
  const pages = latest
    ? JSON.parse(
        gh(
          'api',
          `repos/${repository}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`,
          '--paginate',
          '--slurp',
        ),
      )
    : [];
  requireCi(
    latest,
    pages.flatMap((page) => page.jobs),
    sha,
  );
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(artifactDirectory, 'release-notes.md'), notes);
  console.log(`Approved candidate checks: ${info.version}, ${sha}, npm tag ${info.tag}.`);
  process.exit(0);
}

const archives = (await readdir(artifactDirectory)).filter((file) => file.endsWith('.tgz'));
assert.equal(archives.length, 1, 'Expect exactly one release tarball.');
const archive = join(artifactDirectory, archives[0]);
const bytes = await readFile(archive);
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const packed = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json']));
// Pinned pnpm removes the development packageManager field and prepack hook from tarballs.
const expectedPacked = structuredClone(manifest);
delete expectedPacked.packageManager;
delete expectedPacked.scripts.prepack;
assert.deepEqual(packed, expectedPacked, 'Tarball metadata must match the reviewed manifest.');
assert.equal(
  run('tar', ['-xOf', archive, 'package/LICENSE']),
  (await readFile('LICENSE', 'utf8')).trim(),
);
for (const file of run('tar', ['-tzf', archive]).split(/\r?\n/)) {
  assert(
    /^package\/(?:dist\/|src\/|(?:package\.json|LICENSE|README\.md|CHANGELOG\.md)$)/.test(file),
    `Unexpected tarball entry: ${file}`,
  );
}
const record = { ...info, sha, archive: archives[0], integrity };
if (mode === 'inspect') {
  await writeFile(join(artifactDirectory, 'release.json'), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(artifactDirectory, 'release-notes.md'), notes);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Release candidate\n\nVersion: \`${info.version}\`\n\nCommit: \`${sha}\`\n\nDist-tag: \`${info.tag}\`\n\nIntegrity: \`${integrity}\`\n\n${notes}`,
    );
  }
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}
assert.deepEqual(
  JSON.parse(await readFile(join(artifactDirectory, 'release.json'), 'utf8')),
  record,
);
assert.equal(await readFile(join(artifactDirectory, 'release-notes.md'), 'utf8'), notes);
const metadata = await npmMetadata(`snowtyped/${info.version}`);
const tags = (await npmMetadata('-/package/snowtyped/dist-tags')) || {};
const state = publishedState(metadata, integrity, info, tags);

if (mode === 'stage') {
  if (state === 'published') {
    console.log('Identical version is already public; no npm write or dist-tag change.');
    process.exit(0);
  }
  assert(
    await npmMetadata('snowtyped'),
    'Bootstrap the npm package before OIDC staging; see docs/versioning.md#npm-publication.',
  );
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.GITHUB_SHA, sha, 'OIDC source must equal the staged candidate.');
  assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, 'Staging requires GitHub OIDC.');
  assert(
    !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN,
    'Use OIDC rather than npm token secrets.',
  );
  assert(process.env.NPM_CLI_JS, 'The workflow must provide its pinned npm CLI path.');
  // A pending stage occupies this version. Conflicts require review; never overwrite or approve it.
  execFileSync(
    process.execPath,
    [
      process.env.NPM_CLI_JS,
      'stage',
      'publish',
      archive,
      '--registry',
      registry,
      '--access',
      'public',
      '--tag',
      info.tag,
      '--provenance',
      '--ignore-scripts',
    ],
    { stdio: 'inherit' },
  );
  console.log('Staged only. Inspect the npm stage and approve it with 2FA, then run finalize.');
  process.exit(0);
}

assert.equal(state, 'published', 'Approve this exact npm stage with 2FA before finalizing.');
requireProvenance(metadata);
const attestationUrl = new URL(metadata.dist.attestations.url);
assert.equal(
  attestationUrl.origin,
  registry,
  'Fetch provenance only from the public npm registry.',
);
const attestations = await npmMetadata(
  `${attestationUrl.pathname.slice(1)}${attestationUrl.search}`,
);
requireProvenanceIdentity(attestations, info.version, sha, integrity);
if (mode === 'verify') {
  console.log('Public registry bytes and provenance metadata match the candidate.');
  process.exit(0);
}

const tag = `v${info.version}`;
let reference = await api(`repos/${repository}/git/ref/tags/${tag}`);
if (reference) {
  let object = reference.object;
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
    object = (await api(`repos/${repository}/git/tags/${object.sha}`)).object;
  }
  assert.equal(object.type, 'commit');
  assert.equal(object.sha, sha, 'Existing Git tag targets another commit; never move it.');
} else {
  reference = await api(`repos/${repository}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
  });
  assert.equal(reference.object.sha, sha);
}
const release = await api(`repos/${repository}/releases/tags/${tag}`);
if (release) {
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, info.prerelease);
  assert.equal(
    release.body.trim(),
    notes.trim(),
    'Existing release notes differ; review manually.',
  );
  console.log(`Release ${tag} already exists and matches; no changes.`);
} else {
  console.log(
    gh(
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--title',
      `snowtyped ${tag}`,
      '--notes-file',
      join(artifactDirectory, 'release-notes.md'),
      `--latest=${!info.prerelease && tags.latest === info.version}`,
      ...(info.prerelease ? ['--prerelease'] : []),
    ),
  );
}
