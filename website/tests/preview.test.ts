import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, stage, staleDeployments } from '../scripts/preview';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function site() {
  const root = await mkdtemp(join(tmpdir(), 'snowtyped-preview-'));
  temporary.push(root);
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'guides'), { recursive: true });
  await writeFile(join(dist, 'index.html'), 'home');
  await writeFile(join(dist, '404.html'), 'missing');
  await writeFile(join(dist, 'guides', 'index.html'), 'guides');
  return { dist, out: join(root, 'out') };
}

const files = (path: string) => readdir(path, { recursive: true }).then((names) => names.sort());

describe('stage', () => {
  it('mirrors the production base path and keeps a root not-found page', async () => {
    const { dist, out } = await site();
    await stage(dist, out, '/snowtyped/');
    expect(await files(out)).toEqual([
      '404.html',
      '_headers',
      '_redirects',
      'snowtyped',
      'snowtyped/404.html',
      'snowtyped/guides',
      'snowtyped/guides/index.html',
      'snowtyped/index.html',
    ]);
    expect(await readFile(join(out, '_redirects'), 'utf8')).toBe('/ /snowtyped/ 302\n');
    expect(await readFile(join(out, '_headers'), 'utf8')).toContain('X-Robots-Tag: noindex');
  });

  it('serves a root base without redirects', async () => {
    const { dist, out } = await site();
    await stage(dist, out, '/');
    expect(await files(out)).toEqual([
      '404.html',
      '_headers',
      'guides',
      'guides/index.html',
      'index.html',
    ]);
  });
});

const deployment = (id: string, branch?: string) => ({
  id,
  deployment_trigger: { metadata: branch === undefined ? {} : { branch } },
});

describe('staleDeployments', () => {
  it('selects only previews of pull requests that are no longer open', () => {
    const deployments = [
      deployment('a', 'pr-1'),
      deployment('b', 'pr-2'),
      deployment('c', 'main'),
      deployment('d', 'pr-1x'),
      deployment('e'),
      { id: 'f' },
    ];
    expect(staleDeployments(deployments, [2]).map(({ id }) => id)).toEqual(['a']);
  });
});

describe('cleanup', () => {
  const options = {
    accountId: 'account',
    project: 'snowtyped-docs',
    cloudflareToken: 'cf-token',
    repository: 'Mkalo/snowtyped',
    githubToken: 'gh-token',
  };

  function server(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const key = `${method} ${url}`;
      calls.push(`${key} ${new Headers(init?.headers).get('authorization')}`);
      if (!(key in routes)) return new Response(null, { status: 404 });
      return Response.json(routes[key]);
    };
    return { calls, fetch };
  }

  const pulls = 'https://api.github.com/repos/Mkalo/snowtyped/pulls?state=open&per_page=100';
  const api =
    'https://api.cloudflare.com/client/v4/accounts/account/pages/projects/snowtyped-docs/deployments';

  it('pages through open pull requests and previews, then deletes stale previews', async () => {
    const open = Array.from({ length: 100 }, (_, index) => ({ number: index + 10 }));
    const previews = Array.from({ length: 25 }, (_, index) => deployment(`p${index}`, 'pr-50'));
    const { calls, fetch } = server({
      [`GET ${pulls}&page=1`]: open,
      [`GET ${pulls}&page=2`]: [{ number: 200 }],
      [`GET ${api}?env=preview&per_page=25&page=1`]: {
        result: previews,
        result_info: { total_count: 27 },
      },
      [`GET ${api}?env=preview&per_page=25&page=2`]: {
        result: [deployment('old', 'pr-3'), deployment('open', 'pr-200')],
        result_info: { total_count: 27 },
      },
      [`DELETE ${api}/old?force=true`]: { success: true },
    });
    expect(await cleanup({ ...options, fetch })).toEqual(['old']);
    expect(calls).toEqual([
      `GET ${pulls}&page=1 Bearer gh-token`,
      `GET ${pulls}&page=2 Bearer gh-token`,
      `GET ${api}?env=preview&per_page=25&page=1 Bearer cf-token`,
      `GET ${api}?env=preview&per_page=25&page=2 Bearer cf-token`,
      `DELETE ${api}/old?force=true Bearer cf-token`,
    ]);
  });

  it('stops on an empty page and fails on API errors', async () => {
    const empty = server({
      [`GET ${pulls}&page=1`]: [],
      [`GET ${api}?env=preview&per_page=25&page=1`]: {
        result: [],
        result_info: { total_count: 5 },
      },
    });
    expect(await cleanup({ ...options, fetch: empty.fetch })).toEqual([]);

    const failing = server({ [`GET ${pulls}&page=1`]: [] });
    await expect(cleanup({ ...options, fetch: failing.fetch })).rejects.toThrow(
      `GET ${api}?env=preview&per_page=25&page=1 failed with 404.`,
    );
  });
});
