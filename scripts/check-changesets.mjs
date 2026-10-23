import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getReleasePlan } from '@changesets/get-release-plan';

const pnpm = process.env.npm_execpath;
assert(pnpm, 'Run through pnpm check:changesets.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.private, true, 'Publication remains blocked pending #20/#24.');
assert.equal(manifest.license, 'UNLICENSED', 'Licensing requires an owner decision in #24.');
// Parse and validate all pending/archived changesets, even on push and merge-group events.
await getReleasePlan(process.cwd());

// Pushes/merge queues validate current state; PRs require changesets new to that diff.
const base = process.env.CHANGESETS_BASE || process.argv[2] || 'origin/main';
const versionPr =
  process.env.CHANGESETS_HEAD ===
    `changeset-release/${process.env.CHANGESETS_BASE_BRANCH || 'main'}` &&
  process.env.CHANGESETS_HEAD_REPOSITORY === process.env.GITHUB_REPOSITORY;

if (versionPr) {
  const paths = git('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`)
    .split('\0')
    .filter(Boolean);
  assert(paths.includes('package.json'), 'A version PR must update the package version.');
  assert(paths.includes('CHANGELOG.md'), 'A version PR must update the changelog.');
  for (const path of paths) {
    assert(
      ['package.json', 'pnpm-lock.yaml', 'CHANGELOG.md', '.changeset/pre.json'].includes(path) ||
        /^\.changeset\/(?:pre\/)?[^/]+\.md$/.test(path),
      `Unexpected version PR change: ${path}. Use a feature PR with a changeset.`,
    );
  }
  const previous = JSON.parse(git('show', `${git('merge-base', base, 'HEAD')}:package.json`));
  assert.notEqual(manifest.version, previous.version, 'A version PR must change the version.');
  previous.version = manifest.version;
  assert.deepEqual(manifest, previous, 'A version PR may only change the manifest version.');
  assert(
    readFileSync('CHANGELOG.md', 'utf8').includes(`## ${manifest.version}\n`),
    'The generated version must have a changelog entry.',
  );
  console.log('Generated version PR: checked version, changelog, and allowed paths.');
}

execFileSync(
  process.execPath,
  [pnpm, 'exec', 'changeset', 'status', '--since', versionPr ? 'HEAD' : base],
  {
    stdio: 'inherit',
  },
);
