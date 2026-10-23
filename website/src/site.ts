import type { AstroIntegration } from 'astro';

export const productionUrl = 'https://mkalo.github.io/snowtyped/';

export interface SiteLocation {
  readonly site: string;
  readonly base: string;
}

export function siteLocation(url: string = productionUrl): SiteLocation {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || parsed.username) {
    throw new Error(`Docs URL must be a plain https URL, received ${url}.`);
  }
  const base = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return { site: parsed.origin, base };
}

export function withBase(base: string, href: string): string {
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith(base)) return href;
  return `${base.replace(/\/$/, '')}${href}`;
}

interface Anchor {
  readonly properties: { readonly href?: unknown };
}

interface Context {
  readonly data: { astro?: { frontmatter?: Frontmatter } };
  setProperty(node: Anchor, key: string, value: unknown): void;
}

export interface Frontmatter {
  hero?: { actions?: { link: string }[] } | undefined;
}

export function prefixHeroLinks(base: string, frontmatter: Frontmatter | undefined): void {
  for (const action of frontmatter?.hero?.actions ?? []) action.link = withBase(base, action.link);
}

export function baseLinks(base: string) {
  return {
    name: 'snowtyped-base-links',
    before(_root: unknown, ctx: Context) {
      prefixHeroLinks(base, ctx.data.astro?.frontmatter);
    },
    element: {
      filter: ['a'],
      visit(node: Anchor, ctx: Context) {
        const href = node.properties.href;
        if (typeof href === 'string') ctx.setProperty(node, 'href', withBase(base, href));
      },
    },
  };
}

export function baseLinksIntegration(base: string): AstroIntegration {
  return {
    name: 'snowtyped-base-links',
    hooks: {
      'astro:config:setup': ({ config }) => {
        const { processor } = config.markdown as {
          processor: { options: { hastPlugins: unknown[] } };
        };
        processor.options.hastPlugins.push(baseLinks(base));
      },
    },
  };
}
