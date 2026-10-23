import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { siteLocation } from '../src/site.ts';

export const previewBranch = (pr: number) => `pr-${pr}`;

export async function stage(dist: string, out: string, base: string): Promise<void> {
  const root = join(out, ...base.split('/').filter(Boolean));
  await mkdir(root, { recursive: true });
  await cp(dist, root, { recursive: true });
  await writeFile(join(out, '_headers'), '/*\n  X-Robots-Tag: noindex\n');
  if (base === '/') return;
  await cp(join(dist, '404.html'), join(out, '404.html'));
  await writeFile(join(out, '_redirects'), `/ ${base} 302\n`);
}

export interface Deployment {
  readonly id: string;
  readonly deployment_trigger?: { readonly metadata?: { readonly branch?: string } };
}

export function staleDeployments(
  deployments: readonly Deployment[],
  openPullRequests: readonly number[],
): Deployment[] {
  const open = new Set(openPullRequests.map(previewBranch));
  return deployments.filter((deployment) => {
    const branch = deployment.deployment_trigger?.metadata?.branch ?? '';
    return /^pr-\d+$/.test(branch) && !open.has(branch);
  });
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CleanupOptions {
  readonly accountId: string;
  readonly project: string;
  readonly cloudflareToken: string;
  readonly repository: string;
  readonly githubToken: string;
  readonly fetch?: Fetch;
}

export async function cleanup(options: CleanupOptions): Promise<string[]> {
  const request = options.fetch ?? fetch;
  const call = async <T>(url: string, token: string, method = 'GET'): Promise<T> => {
    const response = await request(url, { method, headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${method} ${url} failed with ${response.status}.`);
    return (await response.json()) as T;
  };

  const open: number[] = [];
  for (let page = 1; ; page++) {
    const pulls = await call<{ number: number }[]>(
      `https://api.github.com/repos/${options.repository}/pulls?state=open&per_page=100&page=${page}`,
      options.githubToken,
    );
    open.push(...pulls.map(({ number }) => number));
    if (pulls.length < 100) break;
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/pages/projects/${options.project}/deployments`;
  const deployments: Deployment[] = [];
  for (let page = 1; ; page++) {
    const { result, result_info } = await call<{
      result: Deployment[];
      result_info: { total_count: number };
    }>(`${api}?env=preview&per_page=25&page=${page}`, options.cloudflareToken);
    deployments.push(...result);
    if (result.length === 0 || deployments.length >= result_info.total_count) break;
  }

  const stale = staleDeployments(deployments, open);
  for (const { id } of stale)
    await call(`${api}/${id}?force=true`, options.cloudflareToken, 'DELETE');
  return stale.map(({ id }) => id);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stage' && args.length === 2) {
    const [dist = '', out = ''] = args;
    await stage(dist, out, siteLocation(process.env['DOCS_URL'] || undefined).base);
  } else if (command === 'cleanup') {
    const removed = await cleanup({
      accountId: required('CLOUDFLARE_ACCOUNT_ID'),
      project: required('CLOUDFLARE_PAGES_PROJECT'),
      cloudflareToken: required('CLOUDFLARE_API_TOKEN'),
      repository: required('GITHUB_REPOSITORY'),
      githubToken: required('GH_TOKEN'),
    });
    console.log(`Removed ${removed.length} preview deployment(s) of closed pull requests.`);
  } else {
    throw new Error('Usage: node scripts/preview.ts stage <dist> <out> | cleanup');
  }
}
