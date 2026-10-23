#!/usr/bin/env node
// Measures type-checking and editor latency for a generated large schema and deep queries.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(import.meta.dirname, '..');

const builders = [
  (i) => `text('C${i}')`,
  (i) => `integer('C${i}').notNull()`,
  (i) => `decimal('C${i}')`,
  (i) => `float('C${i}').notNull()`,
  (i) => `boolean('C${i}')`,
  (i) => `date('C${i}').notNull()`,
  (i) => `timestamp('C${i}', 'tz')`,
  (i) => `variant('C${i}', z.object({ id: z.number(), tags: z.array(z.string()) }))`,
];
const requiredValues = { 1: '1n', 3: '1', 5: "'2024-01-01'" };

export function generate({ tables, columns, joins }, source) {
  const lines = [
    `import * as z from 'zod';`,
    `import { and, asc, boolean, count, date, decimal, eq, float, gt, insert, integer, isNotNull, select, snowflakeTable, sum, text, timestamp, update, variant } from '${source}/index.js';`,
    `import type { SnowflakeClient } from '${source}/snowflake/index.js';`,
  ];
  for (let t = 0; t < tables; t++) {
    const cols = Array.from({ length: columns }, (_, i) => `    c${i}: ${builders[i % 8](i)},`);
    const required = Array.from({ length: columns }, (_, i) => i)
      .filter((i) => i % 8 in requiredValues)
      .map((i) => `c${i}: ${requiredValues[i % 8]}`);
    lines.push(
      `export const t${t} = snowflakeTable('T${t}', {`,
      `    id: integer('ID').notNull(),`,
      `    parentId: integer('PARENT_ID').notNull(),`,
      ...cols,
      `}, { database: 'BENCH', schema: 'PUBLIC' });`,
      `export const q${t} = select(t${t}).where(and(gt(t${t}.columns.id, 0n), isNotNull(t${t}.columns.c0))).orderBy(asc(t${t}.columns.id)).limit(10);`,
      `export const g${t} = select(t${t}, { key: t${t}.columns.c1, n: count(), total: sum(t${t}.columns.c2) }).groupBy(t${t}.columns.c1);`,
      `export const i${t} = insert(t${t}, { id: 1n, parentId: 0n, ${required.join(', ')} });`,
      `export const u${t} = update(t${t}, { c0: 'x' }).where(eq(t${t}.columns.id, 1n));`,
    );
  }
  const depth = Math.max(1, Math.min(joins, tables - 1));
  let deep = 'select(t0)';
  const projection = ['id: t0.columns.id'];
  for (let j = 1; j <= depth; j++) {
    deep += `.${j % 2 ? 'leftJoin' : 'innerJoin'}(t${j}, eq(t${j - 1}.columns.id, t${j}.columns.parentId))`;
    projection.push(
      `j${j}a: t${j}.columns.c0`,
      `j${j}b: t${j}.columns.c1`,
      `j${j}c: t${j}.columns.c7`,
    );
  }
  lines.push(
    `export const deep = ${deep}.select({ ${projection.join(', ')} }).where(gt(t0.columns.id, 0n)).orderBy(asc(t0.columns.id)).limit(100);`,
    `export const derived = deep.as('d');`,
    `export const outer = select(derived, { id: derived.columns.id, last: derived.columns.j${depth}b });`,
    `export async function read(db: SnowflakeClient) {`,
    `  const { rows } = await db.execute(deep);`,
    `  const [first] = (await db.execute(outer)).rows;`,
    `  return [rows[0]?./*COMPLETE*/id, first?.last];`,
    `}`,
  );
  return `${lines.join('\n')}\n`;
}

function diagnostics(output) {
  const metric = (name) => {
    const match = output.match(new RegExp(`^${name}:\\s+([\\d.]+)`, 'm'));
    if (!match) throw new Error(`tsc did not report ${name}.\n${output}`);
    return Number(match[1]);
  };
  return {
    types: metric('Types'),
    instantiations: metric('Instantiations'),
    memoryKB: metric('Memory used'),
    checkSeconds: metric('Check time'),
    totalSeconds: metric('Total time'),
  };
}

function editor(file, text, compilerOptions) {
  const files = new Map([[file, { text, version: 0 }]]);
  const host = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => [file],
    getScriptVersion: (name) => String(files.get(name)?.version ?? 0),
    getScriptSnapshot: (name) => {
      const content = files.get(name)?.text ?? ts.sys.readFile(name);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
    readFile: (name) => files.get(name)?.text ?? ts.sys.readFile(name),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const time = (action) => {
    const started = performance.now();
    const result = action();
    return { ms: Math.round(performance.now() - started), result };
  };
  const hover = text.indexOf('rows }') + 1;
  const complete = text.indexOf('/*COMPLETE*/');
  const program = time(() => service.getProgram());
  const quickInfo = time(() => service.getQuickInfoAtPosition(file, hover));
  const completions = time(() => service.getCompletionsAtPosition(file, complete, {}));
  const errors = service.getSemanticDiagnostics(file);
  if (errors.length)
    throw new Error(
      ts.formatDiagnostics(errors, {
        ...ts.sys,
        getCanonicalFileName: (f) => f,
        getNewLine: () => '\n',
      }),
    );
  // An edit invalidates the checker, as typing in the file would.
  files.set(file, { text: text.replace('limit(100)', 'limit(101)'), version: 1 });
  const edited = time(() => service.getQuickInfoAtPosition(file, hover));
  const entries = completions.result?.entries.length ?? 0;
  if (!quickInfo.result || entries < 1) throw new Error('Editor queries returned no result.');
  return {
    programMs: program.ms,
    quickInfoMs: quickInfo.ms,
    completionMs: completions.ms,
    editedQuickInfoMs: edited.ms,
    completionEntries: entries,
  };
}

export function run(size) {
  if (size.tables < 2) throw new Error('The benchmark needs at least two tables.');
  // Inside the repository so the generated file resolves the project's dependencies.
  const cache = join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, 'snowtyped-bench-'));
  try {
    const file = join(directory, 'bench.ts');
    const source = relative(directory, join(root, 'src')).replaceAll('\\', '/');
    const text = generate(size, source);
    writeFileSync(file, text);
    const config = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
        typeRoots: [join(root, 'node_modules/@types')],
      },
      files: ['bench.ts'],
    };
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(config));
    const compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, directory).options;
    const tsc = require.resolve('typescript/bin/tsc');
    const output = execFileSync(process.execPath, [tsc, '-p', directory, '--extendedDiagnostics'], {
      encoding: 'utf8',
    });
    return { ...size, ...diagnostics(output), ...editor(file, text, compilerOptions) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({
    options: {
      tables: { type: 'string', default: '50' },
      columns: { type: 'string', default: '40' },
      joins: { type: 'string', default: '12' },
      json: { type: 'boolean', default: false },
    },
  });
  const result = run({
    tables: Number(values.tables),
    columns: Number(values.columns),
    joins: Number(values.joins),
  });
  if (values.json) console.log(JSON.stringify(result));
  else console.table(result);
}
