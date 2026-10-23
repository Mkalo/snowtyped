import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^snowtyped$/, replacement: source('index.ts') },
      { find: /^snowtyped\/snowflake$/, replacement: source('snowflake/index.ts') },
    ],
  },
  test: { include: ['tests/**/*.test.ts', 'src/snippets/**/*.test.ts'] },
});
