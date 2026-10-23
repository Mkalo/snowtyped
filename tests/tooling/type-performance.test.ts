import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tables = 60;
const columns = ['integer', 'decimal', 'float', 'text', 'boolean', 'date', 'timestamp', 'variant'];
// Instantiation counts are deterministic for a TypeScript version; raise this only deliberately.
const instantiationBudget = 250_000;

function fixture(): string {
  const lines = [
    `import { and, count, desc, eq, gt, gte, like, lower, max, min, ne, rowNumber, select, snowflakeTable, sum, ${columns.join(', ')} } from ${JSON.stringify(join(root, 'src/index.js').replaceAll('\\', '/'))};`,
  ];
  for (let index = 0; index < tables; index++) {
    const fields = Array.from({ length: 40 }, (_, column) => {
      const kind = columns[column % columns.length];
      return `c${column}: ${kind}('C${column}')${column % 3 ? '' : '.notNull()'}`;
    });
    lines.push(
      `const t${index} = snowflakeTable('T${index}', { id: integer('ID').notNull(), ${fields.join(', ')} });`,
    );
  }
  for (let index = 0; index < tables - 1; index++) {
    const [a, b] = [`t${index}.columns`, `t${index + 1}.columns`];
    lines.push(
      `select(t${index}).leftJoin(t${index + 1}, eq(${a}.id, ${b}.id)).where(and(gt(${a}.c0, 1n), ne(${a}.c1, '1'), gte(${a}.c2, ${b}.c2), like(${a}.c3, 'a%'), eq(${a}.c4, true), eq(${a}.c5, ${b}.c5))).groupBy(${a}.c0, ${b}.c3).select({ key: ${a}.c0, name: lower(${b}.c3), n: count(), total: sum(${b}.c1), low: min(${b}.c5), high: max(${a}.c6) }).as('D${index}');`,
      `const r${index} = rowNumber({ partitionBy: [${a}.c3], orderBy: [desc(${a}.c0)] });`,
      `select(t${index}, { id: ${a}.id, r: r${index} }).qualify(eq(r${index}, 1n));`,
    );
  }
  return lines.join('\n');
}

test('type-checking a large schema stays within the instantiation budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snowtyped-types-'));
  try {
    await writeFile(join(directory, 'fixture.mts'), fixture());
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: join(root, 'tsconfig.json'),
        compilerOptions: { noEmit: true, typeRoots: [join(root, 'node_modules/@types')] },
        include: ['fixture.mts'],
      }),
    );
    const { status, stdout: output } = spawnSync(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', directory, '--extendedDiagnostics'],
      { encoding: 'utf8' },
    );
    assert.equal(status, 0, output);
    const instantiations = Number(/Instantiations:\s+(\d+)/.exec(output)?.[1]);
    const checkTime = /Check time:\s+([\d.]+s)/.exec(output)?.[1];
    console.info(`type-performance: ${instantiations} instantiations, check time ${checkTime}`);
    assert(instantiations > 0, output);
    assert(
      instantiations <= instantiationBudget,
      `${instantiations} instantiations exceed the ${instantiationBudget} budget.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
