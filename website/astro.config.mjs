import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

const repository = 'https://github.com/Mkalo/snowtyped';

export default defineConfig({
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    starlight({
      title: 'Snowtyped',
      description:
        'Schema-driven Snowflake queries, runtime validation, and parameterized raw SQL for TypeScript.',
      social: [{ icon: 'github', label: 'GitHub', href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/website/` },
      lastUpdated: false,
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      plugins: [
        starlightLinksValidator({ errorOnLocalLinks: true }),
        starlightTypeDoc({
          entryPoints: ['../src/index.ts', '../src/snowflake/index.ts'],
          tsconfig: '../tsconfig.build.json',
          output: 'api',
          sidebar: { label: 'API reference', collapsed: true, readmeLabel: 'Overview' },
          typeDoc: {
            excludePrivate: true,
            excludeProtected: true,
            excludeInternal: true,
            excludeExternals: true,
            name: 'API reference',
            readme: './src/api-readme.md',
            plugin: ['./typedoc-modules.mjs'],
            sourceLinkTemplate: `${repository}/blob/main/{path}#L{line}`,
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
            'guides/introspection',
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
