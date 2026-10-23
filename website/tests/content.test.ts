import { readdirSync, readFileSync } from 'node:fs';
import * as library from 'snowtyped';
import * as ddl from 'snowtyped/ddl';
import * as snowflake from 'snowtyped/snowflake';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const pages = readdirSync(new URL('src/content/docs/', root), { recursive: true, encoding: 'utf8' })
  .filter((path) => /\.mdx?$/.test(path) && !path.startsWith('api'))
  .map((path) => ({ path, source: read(`src/content/docs/${path}`) }));
const snippets = readdirSync(new URL('src/snippets/', root)).filter(
  (name) => !['fixtures.ts'].includes(name),
);

describe('documentation content', () => {
  it('renders every snippet on at least one page', () => {
    const imported = new Set(
      pages.flatMap(({ source }) =>
        [...source.matchAll(/snippets\/([\w.-]+)\?raw/g)].map((match) => match[1]),
      ),
    );
    expect(snippets.filter((name) => !imported.has(name))).toEqual([]);
  });

  it('mentions every runtime export in a guide or snippet', () => {
    const code = [
      ...pages.flatMap(({ source }) => source.match(/`[^`\n]+`/g) ?? []),
      ...snippets.map((name) => read(`src/snippets/${name}`)),
    ].join('\n');
    const exports = [...Object.keys(library), ...Object.keys(snowflake), ...Object.keys(ddl)];
    expect(exports.filter((name) => !new RegExp(`(?<![.\\w])${name}\\b`).test(code))).toEqual([]);
  });

  it('keeps package examples in type-checked snippets', () => {
    const inline = pages.filter(({ source }) =>
      [...source.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)].some((match) =>
        /from ['"]snowtyped/.test(match[1] ?? ''),
      ),
    );
    expect(inline.map(({ path }) => path)).toEqual([]);
  });

  it('keeps docs dependencies out of the published package', () => {
    const library = JSON.parse(read('../package.json'));
    const site = JSON.parse(read('package.json'));
    expect(site.private).toBe(true);
    const shipped = { ...library.dependencies, ...library.peerDependencies };
    for (const name of Object.keys({ ...site.dependencies, ...site.devDependencies })) {
      if (!['@types/node', 'typescript', 'vitest'].includes(name))
        expect(shipped).not.toHaveProperty(name);
    }
    expect(library.files).not.toContain('website');
  });
});
