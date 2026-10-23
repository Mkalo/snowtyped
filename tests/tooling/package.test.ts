import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { test } from 'vitest';

test('packed ESM/CJS consumers, declarations, license, and tree shaking', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporaryRoot = resolve(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, 'snowtyped-'));
  const pnpm = process.env.npm_execpath;
  assert(pnpm, 'Run this script through pnpm test:package.');

  const runPnpm = (args: string[], cwd = temporary) => {
    return execFileSync(process.execPath, [pnpm, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  };

  try {
    if (process.env.RELEASE_TARBALL) {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(resolve(process.env.RELEASE_TARBALL), join(temporary, 'candidate.tgz'));
    } else {
      runPnpm(['pack', '--pack-destination', temporary], root);
    }
    const archive = (await readdir(temporary)).find((name) => name.endsWith('.tgz'));
    assert(archive, 'pnpm pack must produce a tarball.');
    await writeFile(
      join(temporary, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    runPnpm(['add', '--ignore-workspace', '--ignore-scripts', join(temporary, archive)]);

    const packageRoot = join(temporary, 'node_modules/snowtyped');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.sideEffects, false);
    assert.equal(manifest.license, 'MIT');
    assert.equal(
      await readFile(join(packageRoot, 'LICENSE'), 'utf8'),
      await readFile(join(root, 'LICENSE'), 'utf8'),
    );
    assert.deepEqual(await readdir(packageRoot).then((files) => files.sort()), [
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'dist',
      'package.json',
      'src',
    ]);

    // Both module formats must work from the tarball, with no SDK installed for core imports.
    const example = `
    const table = lib.snowflakeTable('CUSTOMERS', { id: lib.integer('ID').notNull() });
    const query = lib.select(table, { id: table.columns.id }).where(lib.eq(table.columns.id, 42n));
    assert.equal(query.compile().sql, 'SELECT TO_VARCHAR("__sflib_result"."id") AS "id" FROM (SELECT "ID" AS "id" FROM "CUSTOMERS" WHERE ("ID" = ?)) AS "__sflib_result"');
    assert.deepEqual(query.compile().binds, ['42']);
  `;
    await writeFile(
      join(temporary, 'consumer.mjs'),
      `import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import * as lib from 'snowtyped';
    import { createClient } from 'snowtyped/snowflake';
    assert.equal(typeof createClient, 'function');
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve('snowflake-sdk'), { code: 'MODULE_NOT_FOUND' });
    ${example}
    const cjs = require('snowtyped');
    const mixedQuery = cjs.select(table, { id: table.columns.id });
    const mixedClient = createClient({ execute(options) {
      options.complete(undefined, { getQueryId: () => 'mixed-formats' }, [['42']]);
    }});
    assert.deepEqual((await mixedClient.execute(mixedQuery)).rows, [{ id: 42n }]);`,
    );
    await writeFile(
      join(temporary, 'consumer.cjs'),
      `const assert = require('node:assert/strict');
    const lib = require('snowtyped');
    assert.equal(typeof require('snowtyped/snowflake').createClient, 'function');
    ${example}`,
    );
    for (const file of ['consumer.mjs', 'consumer.cjs']) {
      execFileSync(process.execPath, [file], { cwd: temporary, stdio: 'pipe' });
    }

    // Inspect bundled inputs as well as output size: unused schema/SDK code must disappear.
    const bundle = await build({
      stdin: {
        contents: "import { identifier } from 'snowtyped'; console.log(identifier('CUSTOMERS'));",
        resolveDir: temporary,
        sourcefile: 'tree-shaking.mjs',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      minify: true,
      metafile: true,
    });
    const bundled = bundle.outputFiles[0];
    assert(bundled);
    assert(
      bundled.contents.length < 1500,
      `Core identifier bundle grew to ${bundled.contents.length} bytes.`,
    );
    const includedInputs = Object.entries(bundle.metafile.outputs)
      .flatMap(([, output]) => Object.entries(output.inputs))
      .filter(([, contribution]) => contribution.bytesInOutput > 0)
      .map(([name]) => name);
    assert(
      !includedInputs.some((name) => /node_modules[/\\](?:zod|snowflake-sdk)[/\\]/.test(name)),
      'A pure identifier import must not retain Zod or the SDK.',
    );

    // TypeScript must resolve both conditional declaration formats from the installed tarball.
    runPnpm(['add', '--ignore-workspace', '--ignore-scripts', '--save-dev', 'snowflake-sdk@3.4.0']);
    const typeSource = `import { eq, integer, select, snowflakeTable, sql, text } from 'snowtyped';
    import type { SnowflakeClient } from 'snowtyped/snowflake';
    const table = snowflakeTable('T', { id: integer('ID').notNull(), email: text('EMAIL') });
    const query = select(table, { id: table.columns.id, email: table.columns.email });
    declare const client: SnowflakeClient;
    const raw: Promise<{ ID: string }[]> = client.queryRaw<{ ID: string }[]>(sql.unsafe('SELECT 1 AS ID'));
    void raw;
    client.execute(query).then((result) => {
      const id: bigint = result.rows[0]!.id;
      const email: string | null = result.rows[0]!.email;
      void [id, email];
    });
    // @ts-expect-error Integer filters require bigint.
    eq(table.columns.id, '1');`;
    for (const extension of ['mts', 'cts'])
      await writeFile(join(temporary, `consumer.${extension}`), typeSource);
    const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
    for (const resolution of ['NodeNext', 'Bundler']) {
      const module = resolution === 'NodeNext' ? 'NodeNext' : 'Preserve';
      execFileSync(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          module,
          '--moduleResolution',
          resolution,
          'consumer.mts',
          'consumer.cts',
        ],
        { cwd: temporary, stdio: 'pipe' },
      );
    }
    console.log(
      `Packed ESM/CJS consumers, declaration resolution, and tree shaking passed (${bundled.contents.length} B).`,
    );
  } catch (error) {
    if (error && typeof error === 'object') {
      const output = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      if (output.stdout) process.stderr.write(output.stdout);
      if (output.stderr) process.stderr.write(output.stderr);
    }
    throw error;
  } finally {
    // Verify the resolved deletion target is the exact task-created temporary directory.
    assert.equal(dirname(resolve(temporary)), temporaryRoot);
    assert(basename(temporary).startsWith('snowtyped-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
