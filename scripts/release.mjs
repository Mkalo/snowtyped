import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getReleasePlan } from '@changesets/get-release-plan';
import {
  bootstrapVersion,
  changelogNotes,
  publishedState,
  registry,
  registryState,
  releaseInfo,
  repository,
  requireCi,
  requireProvenance,
  requireProvenanceIdentity,
  requireRegistryPackage,
} from './release-policy.ts';

const [mode, expectedVersion, sha, directory = 'reports/release'] = process.argv.slice(2);
assert(
  [
    'candidate',
    'check',
    'inspect',
    'bootstrap-check',
    'bootstrap',
    'trust',
    'stage',
    'wait',
    'verify',
    'finalize',
    'cleanup-bootstrap',
  ].includes(mode),
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
const npm = async (args, capture = false) => {
  const cli = process.env.NPM_CLI_JS;
  assert(cli, 'Set NPM_CLI_JS to the pinned npm 12.2.1 bin/npm-cli.js path.');
  const packageJson = JSON.parse(await readFile(join(dirname(cli), '../package.json'), 'utf8'));
  assert.equal(packageJson.name, 'npm');
  assert.equal(packageJson.version, '12.2.1');
  return execFileSync(process.execPath, [cli, ...args, '--registry', registry], {
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
};

assert.equal(git('rev-parse', 'HEAD'), sha, 'Checkout must match the selected candidate.');
git('merge-base', '--is-ancestor', sha, 'origin/main');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const info = releaseInfo(manifest, process.env.NPM_STABLE_RELEASES_ENABLED === 'true');
assert.equal(info.version, expectedVersion, 'The expected version must match the exact commit.');
const pending = (await getReleasePlan(process.cwd())).releases.length > 0;
if (mode === 'candidate') {
  const published = !pending && (await npmMetadata(`snowtyped/${info.version}`));
  const release = published && (await api(`repos/${repository}/releases/tags/v${info.version}`));
  const eligible = !pending && !(release && !release.draft);
  assert(process.env.GITHUB_OUTPUT);
  await appendFile(process.env.GITHUB_OUTPUT, `eligible=${eligible}\n`);
  console.log(eligible ? 'Version needs staging or finalization.' : 'No new version to release.');
  process.exit(0);
}
assert(!pending, 'Merge the Changesets version PR first.');
const notes = changelogNotes(await readFile('CHANGELOG.md', 'utf8'), info.version);
if (mode === 'bootstrap-check') {
  console.log(`npm name: ${registryState(await npmMetadata('snowtyped'))}.`);
  process.exit(0);
}
if (
  ['bootstrap', 'trust', 'stage', 'cleanup-bootstrap'].includes(mode) ||
  (mode === 'check' && ['stage', 'release'].includes(process.env.RELEASE_OPERATION))
) {
  const packageMetadata = await npmMetadata('snowtyped');
  if (mode === 'bootstrap') {
    assert.equal(
      registryState(packageMetadata),
      'missing',
      'The npm name already exists; retain its pending bootstrap stage.',
    );
  } else {
    requireRegistryPackage(packageMetadata);
  }
}

if (mode === 'check') {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Release workflows run only from main.');
  if (['stage', 'release'].includes(process.env.RELEASE_OPERATION)) {
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
const bootstrapDirectory = join(artifactDirectory, 'bootstrap');
if (mode === 'bootstrap') {
  assert(
    !existsSync(join(bootstrapDirectory, 'stage-result.json')),
    'A bootstrap result already exists; inspect it instead of staging again.',
  );
  const packageDirectory = join(bootstrapDirectory, 'package');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'snowtyped',
      version: bootstrapVersion,
      license: 'MIT',
      description:
        'DO NOT APPROVE: temporary bootstrap stage. Approve only the real CI release with provenance.',
    }),
  );
  await writeFile(join(packageDirectory, 'LICENSE'), await readFile('LICENSE'));
  const holdingArchive = join(bootstrapDirectory, `snowtyped-${bootstrapVersion}.tgz`);
  run('tar', ['-czf', holdingArchive, '-C', bootstrapDirectory, 'package']);
  const result = await npm(
    [
      'stage',
      'publish',
      holdingArchive,
      '--tag',
      'bootstrap',
      '--access',
      'public',
      '--ignore-scripts',
      '--provenance=false',
      '--json',
    ],
    true,
  );
  await writeFile(join(bootstrapDirectory, 'stage-result.json'), result, { flag: 'wx' });
  const staged = JSON.parse(result).snowtyped;
  assert.equal(staged.name, 'snowtyped');
  assert.equal(staged.version, bootstrapVersion);
  assert(/^[a-f0-9-]{36}$/.test(staged.stageId));
  const holdingIntegrity = `sha512-${createHash('sha512')
    .update(await readFile(holdingArchive))
    .digest('base64')}`;
  assert.equal(staged.integrity, holdingIntegrity);
  await writeFile(
    join(bootstrapDirectory, 'receipt.json'),
    JSON.stringify({
      stageId: staged.stageId,
      version: bootstrapVersion,
      integrity: holdingIntegrity,
    }),
    { flag: 'wx' },
  );
  console.log(
    'Keep the holding stage pending. Configure trust, then stage the real version from CI. Never approve the holding stage.',
  );
  process.exit(0);
}
if (mode === 'trust') {
  await npm(['access', 'set', 'mfa=publish', 'snowtyped']);
  await npm([
    'trust',
    'github',
    'snowtyped',
    '--file=release.yml',
    `--repo=${repository}`,
    '--env=npm',
    '--allow-stage-publish',
    '--yes',
  ]);
  console.log(
    'Stage-only trust configured; enable NPM_RELEASES_ENABLED after checking the configuration.',
  );
  process.exit(0);
}
let metadata = await npmMetadata(`snowtyped/${info.version}`);
if (mode === 'wait') {
  const timeout = Number(process.env.NPM_APPROVAL_TIMEOUT_MS ?? 3_600_000);
  const poll = Number(process.env.NPM_APPROVAL_POLL_MS ?? 30_000);
  assert(Number.isFinite(timeout) && timeout >= 0 && timeout <= 3_600_000);
  assert(Number.isFinite(poll) && poll >= 1 && poll <= 30_000);
  const deadline = Date.now() + timeout;
  while (!metadata) {
    assert(
      Date.now() < deadline,
      'npm approval is still pending. Approve the CI stage, then rerun this release workflow.',
    );
    console.log(`Waiting for npm 2FA approval of snowtyped@${info.version}.`);
    await setTimeout(Math.min(poll, Math.max(1, deadline - Date.now())));
    metadata = await npmMetadata(`snowtyped/${info.version}`);
  }
}
const tags = (await npmMetadata('-/package/snowtyped/dist-tags')) || {};
const state = publishedState(metadata, integrity, info, tags);

if (mode === 'stage') {
  if (state === 'published') {
    console.log('Identical version is already public; no npm write or dist-tag change.');
    process.exit(0);
  }
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.GITHUB_SHA, sha, 'OIDC source must equal the staged candidate.');
  assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, 'Staging requires GitHub OIDC.');
  assert(
    !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN,
    'Use OIDC rather than npm token secrets.',
  );
  // A pending stage occupies this version. Conflicts require review; never overwrite or approve it.
  await npm([
    'stage',
    'publish',
    archive,
    '--access',
    'public',
    '--tag',
    info.tag,
    '--provenance',
    '--ignore-scripts',
  ]);
  console.log(
    'Staged only. Approve the CI stage with npm 2FA; this workflow will finalize automatically.',
  );
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
if (mode === 'verify' || mode === 'wait') {
  console.log('Public registry bytes and provenance metadata match the candidate.');
  process.exit(0);
}
if (mode === 'cleanup-bootstrap') {
  const receipt = JSON.parse(await readFile(join(bootstrapDirectory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.version, bootstrapVersion, 'Cleanup may reject only the holding version.');
  assert(/^[a-f0-9-]{36}$/.test(receipt.stageId));
  const holdingArchive = await readFile(
    join(bootstrapDirectory, `snowtyped-${bootstrapVersion}.tgz`),
  );
  assert.equal(
    receipt.integrity,
    `sha512-${createHash('sha512').update(holdingArchive).digest('base64')}`,
  );
  const consumer = await mkdtemp(join(tmpdir(), 'snowtyped-bootstrap-'));
  try {
    await npm([
      'install',
      '--prefix',
      consumer,
      '--ignore-scripts',
      '--no-audit',
      '--omit=optional',
      `snowtyped@${info.version}`,
    ]);
    await npm(['audit', 'signatures', '--prefix', consumer]);
    requireRegistryPackage(await npmMetadata('snowtyped'));
    await npm(['stage', 'reject', receipt.stageId]);
  } finally {
    assert(resolve(consumer).startsWith(`${resolve(tmpdir())}${sep}snowtyped-bootstrap-`));
    await rm(consumer, { recursive: true, force: true });
  }
  console.log('Holding stage removed after verifying the real public release.');
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
