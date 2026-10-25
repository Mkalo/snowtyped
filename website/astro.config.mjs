import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import { apiEntryPoints, apiTsconfig, apiTypeDocOptions } from './src/api.ts';
import { baseLinksIntegration, siteLocation } from './src/site.ts';

const repository = 'https://github.com/Mkalo/snowtyped';
const { site, base } = siteLocation(process.env.DOCS_URL || undefined);
const sourceRef = process.env.DOCS_SOURCE_REF || 'main';

export default defineConfig({
  site,
  base,
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    baseLinksIntegration(base),
    starlight({
      title: 'Snowtyped',
      logo: { src: './src/assets/logo.svg', alt: '' },
      description:
        'Schema-driven Snowflake queries, runtime validation, and parameterized raw SQL for TypeScript.',
      social: [{ icon: 'github', label: 'GitHub', href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/website/` },
      lastUpdated: false,
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      routeMiddleware: './src/route-data.ts',
      plugins: [
        starlightLinksValidator({ errorOnLocalLinks: true }),
        starlightTypeDoc({
          entryPoints: apiEntryPoints,
          tsconfig: apiTsconfig,
          output: 'api',
          sidebar: { label: 'API reference', collapsed: true, readmeLabel: 'Overview' },
          typeDoc: {
            ...apiTypeDocOptions,
            name: 'API reference',
            readme: './src/api-readme.md',
            indexFormat: 'table',
            parametersFormat: 'table',
            interfacePropertiesFormat: 'table',
            classPropertiesFormat: 'table',
            typeAliasPropertiesFormat: 'table',
            typeDeclarationFormat: 'table',
            useCodeBlocks: true,
            tableColumnSettings: { hideModifiers: true, hideSources: true },
            sourceLinkTemplate: `${repository}/blob/${sourceRef}/{path}#L{line}`,
          },
        }),
      ],
      sidebar: [
        { label: 'Start here', items: ['getting-started', 'guides/feature-status'] },
        {
          label: 'Guides',
          items: [
            'guides/schemas',
            'guides/queries',
            'guides/snowflake-syntax',
            'guides/mutations',
            'guides/raw-sql',
            'guides/validation',
            'guides/execution',
            'guides/production',
            'guides/introspection',
            'guides/migrations',
            'guides/testing',
          ],
        },
        typeDocSidebarGroup,
        {
          label: 'Project',
          items: ['project/contributing', 'project/releases', 'project/changelog'],
        },
      ],
    }),
  ],
});
