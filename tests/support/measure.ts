import { performance } from 'node:perf_hooks';

export interface Summary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Nearest-rank percentile of ascending samples. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) throw new RangeError('No samples.');
  if (p < 0 || p > 100) throw new RangeError('Percentile must be between 0 and 100.');
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: total / Math.max(1, sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] as number,
  };
}

/** Times `fn` in batches until `minMs` elapses after a warmup; each sample is ms per call. */
export async function sample(
  fn: () => unknown,
  {
    warmupMs = 200,
    minMs = 1000,
    batch = 1,
  }: { warmupMs?: number; minMs?: number; batch?: number } = {},
): Promise<Summary> {
  const run = async (budget: number, record?: number[]) => {
    const start = performance.now();
    while (performance.now() - start < budget) {
      const before = performance.now();
      for (let i = 0; i < batch; i++) await fn();
      record?.push((performance.now() - before) / batch);
    }
  };
  await run(warmupMs);
  const samples: number[] = [];
  await run(minMs, samples);
  return summarize(samples);
}

export function table(rows: readonly Record<string, string | number>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0] as object);
  const cells = rows.map((row) => headers.map((header) => String(row[header] ?? '')));
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((row) => (row[i] as string).length)),
  );
  const line = (values: readonly string[]) =>
    `| ${values.map((value, i) => (i ? value.padStart(widths[i] as number) : value.padEnd(widths[i] as number))).join(' | ')} |`;
  return [
    line(headers),
    `| ${widths.map((width, i) => (i ? `${'-'.repeat(width - 1)}:` : '-'.repeat(width))).join(' | ')} |`,
    ...cells.map(line),
  ].join('\n');
}

export const fixed = (value: number, digits = 2) =>
  value >= 100 ? value.toFixed(0) : value.toPrecision(Math.max(1, digits + 1));
