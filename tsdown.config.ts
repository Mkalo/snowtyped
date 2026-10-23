import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', snowflake: 'src/snowflake/index.ts', ddl: 'src/ddl/index.ts' },
  format: ['esm', 'cjs'],
  fixedExtension: true,
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.build.json',
});
