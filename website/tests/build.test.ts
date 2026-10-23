import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteLocation } from '../src/site';

const dist = new URL('../dist/', import.meta.url);
const exists = (path: string) => existsSync(new URL(path, dist));

describe('production build', () => {
  const html = () =>
    readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter((path) =>
      path.endsWith('.html'),
    );

  it('exists', () => {
    expect(exists('index.html'), 'Run pnpm build before these tests.').toBe(true);
  });

  it('renders every guide and project page', () => {
    const content = new URL('../src/content/docs/', import.meta.url);
    const sources = readdirSync(content, { recursive: true, encoding: 'utf8' }).filter(
      (path) => path.endsWith('.mdx') && path !== 'index.mdx',
    );
    expect(sources.length).toBeGreaterThan(10);
    for (const source of sources)
      expect(exists(`${source.replace(/\.mdx$/, '')}/index.html`)).toBe(true);
  });

  it('resolves every root-relative link and asset under the base path', () => {
    const { base } = siteLocation(process.env.DOCS_URL || undefined);
    const broken = new Set<string>();
    for (const page of [...html(), 'pagefind/pagefind.js']) {
      const source = readFileSync(new URL(page, dist), 'utf8');
      for (const [, url = ''] of source.matchAll(/(?:href|src)="(\/(?!\/)[^"#?]*)/g)) {
        const path = url.slice(base.length);
        const found =
          url.startsWith(base) &&
          (path === '' || path.endsWith('/') ? exists(`${path}index.html`) : exists(path));
        if (!found) broken.add(`${page}: ${url}`);
      }
    }
    expect([...broken]).toEqual([]);
  });

  it('serves a not-found page', () => {
    expect(exists('404.html')).toBe(true);
  });

  it('builds the search index', () => {
    expect(exists('pagefind/pagefind.js')).toBe(true);
  });

  it('documents both package entry points', () => {
    expect(exists('api/snowtyped/functions/select/index.html')).toBe(true);
    expect(exists('api/snowtyped/snowflake/functions/createclient/index.html')).toBe(true);
  });

  it('omits module internals that the entry points do not export', () => {
    const internals = [
      'assertScope',
      'bindTable',
      'isExpression',
      'isRawQuery',
      'normalizeWireRow',
      'requestSignal',
      'resultSchema',
      'scalarParameter',
      'streamRequest',
    ];
    const api = html().filter((path) => path.startsWith('api'));
    for (const name of internals) {
      expect(api.some((path) => path.toLowerCase().includes(name.toLowerCase()))).toBe(false);
      expect(api.some((path) => readFileSync(new URL(path, dist), 'utf8').includes(name))).toBe(
        false,
      );
    }
  });
});
