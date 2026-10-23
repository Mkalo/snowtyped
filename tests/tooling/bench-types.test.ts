import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/bench-types.mjs', import.meta.url));

// Instantiation counts are deterministic for a pinned TypeScript; the budget catches inference blowups.
test('keeps generated schema inference within its instantiation budget', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [script, '--tables', '10', '--columns', '20', '--joins', '4', '--json'],
      { encoding: 'utf8' },
    ),
  );
  expect(result).toMatchObject({ tables: 10, columns: 20, joins: 4, completionEntries: 13 });
  expect(result.instantiations).toBeLessThan(320_000);
  expect(result.types).toBeLessThan(110_000);
});
