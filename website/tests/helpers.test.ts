import { describe, expect, it } from 'vitest';
import { describeRelease } from '../src/release';
import {
  baseLinks,
  baseLinksIntegration,
  prefixHeroLinks,
  productionUrl,
  siteLocation,
  withBase,
} from '../src/site';
import { visibleSnippet } from '../src/snippet';

describe('describeRelease', () => {
  it('labels prerelease versions with their channel', () => {
    expect(describeRelease('0.1.0-alpha.1')).toEqual({
      version: '0.1.0-alpha.1',
      channel: 'alpha',
      stable: false,
    });
    expect(describeRelease('1.0.0-beta.0').channel).toBe('beta');
  });

  it('labels versions without a prerelease tag as stable', () => {
    expect(describeRelease('1.2.3')).toEqual({ version: '1.2.3', channel: 'stable', stable: true });
    expect(describeRelease('1.2.3+build.5').stable).toBe(true);
  });
});

describe('visibleSnippet', () => {
  it('hides setup above the cut marker', () => {
    expect(visibleSnippet("import { db } from './fixtures.js';\n// ---cut---\nawait db;\n")).toBe(
      'await db;',
    );
    expect(visibleSnippet('setup;\r\n// ---cut---\r\nshown;\r\n')).toBe('shown;');
  });

  it('shows the whole file without a marker', () => {
    expect(visibleSnippet('\nconst a = 1;\n')).toBe('const a = 1;');
  });
});

describe('siteLocation', () => {
  it('splits the production URL into site and base', () => {
    expect(siteLocation()).toEqual({ site: 'https://mkalo.github.io', base: '/snowtyped/' });
    expect(siteLocation(productionUrl)).toEqual(siteLocation());
  });

  it('supports a custom domain at the root or under a path', () => {
    expect(siteLocation('https://docs.example.com')).toEqual({
      site: 'https://docs.example.com',
      base: '/',
    });
    expect(siteLocation('https://example.com/docs').base).toBe('/docs/');
  });

  it('rejects URLs that cannot be a static site root', () => {
    for (const url of [
      'http://example.com/',
      'https://example.com/?a=1',
      'https://example.com/#top',
      'https://user@example.com/',
    ])
      expect(() => siteLocation(url)).toThrow('plain https URL');
    expect(() => siteLocation('docs')).toThrow();
  });
});

describe('withBase', () => {
  it('prefixes root-relative links once', () => {
    expect(withBase('/snowtyped/', '/guides/queries/#joins')).toBe(
      '/snowtyped/guides/queries/#joins',
    );
    expect(withBase('/snowtyped/', '/snowtyped/api/')).toBe('/snowtyped/api/');
    expect(withBase('/', '/guides/')).toBe('/guides/');
  });

  it('leaves relative, external, protocol-relative, and fragment links alone', () => {
    for (const href of ['../queries/', 'https://example.com/', '//cdn.example.com/a.js', '#top'])
      expect(withBase('/snowtyped/', href)).toBe(href);
  });
});

describe('base link plugin', () => {
  it('rewrites anchor hrefs and hero actions before link validation', () => {
    const frontmatter = { hero: { actions: [{ link: '/getting-started/' }] } };
    const set: unknown[] = [];
    const ctx = {
      data: { astro: { frontmatter } },
      setProperty: (...args: unknown[]) => set.push(args),
    };
    const plugin = baseLinks('/snowtyped/');
    plugin.before(null, ctx);
    expect(frontmatter.hero.actions[0]?.link).toBe('/snowtyped/getting-started/');
    const anchor = { properties: { href: '/guides/' } };
    plugin.element.visit(anchor, ctx);
    plugin.element.visit({ properties: {} }, ctx);
    expect(set).toEqual([[anchor, 'href', '/snowtyped/guides/']]);
    expect(plugin.element.filter).toEqual(['a']);
  });

  it('registers the plugin on the Markdown processor', () => {
    const hastPlugins = [{ name: 'existing' }];
    const setup = baseLinksIntegration('/snowtyped/').hooks['astro:config:setup'];
    setup?.({ config: { markdown: { processor: { options: { hastPlugins } } } } } as never);
    expect(hastPlugins.map(({ name }) => name)).toEqual(['existing', 'snowtyped-base-links']);
  });

  it('ignores pages without hero actions', () => {
    expect(() => prefixHeroLinks('/snowtyped/', undefined)).not.toThrow();
    expect(() => prefixHeroLinks('/snowtyped/', { hero: undefined })).not.toThrow();
  });
});
