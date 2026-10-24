import { describe, expect, it } from 'vitest';
import { fixed, percentile, sample, summarize, table } from '../support/measure.js';

describe('benchmark measurement helpers', () => {
  it('takes nearest-rank percentiles and rejects bad input', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile(sorted, 101)).toThrow(RangeError);
    expect(() => percentile(sorted, -1)).toThrow(RangeError);
  });

  it('summarizes unsorted samples without reordering them', () => {
    const samples = [5, 1, 4, 2, 3];
    expect(summarize(samples)).toEqual({ count: 5, mean: 3, p50: 3, p95: 5, p99: 5, max: 5 });
    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });

  it('times batches after a warmup', async () => {
    let calls = 0;
    const result = await sample(
      () => {
        calls++;
      },
      { warmupMs: 1, minMs: 5, batch: 10 },
    );
    expect(result.count).toBeGreaterThan(0);
    expect(calls).toBeGreaterThanOrEqual(result.count * 10);
    expect(result.p50).toBeGreaterThanOrEqual(0);
  });

  it('renders aligned markdown tables and compact numbers', () => {
    expect(
      table([
        { case: 'a', ms: 1.5 },
        { case: 'longer', ms: 120 },
      ]),
    ).toBe(
      ['| case   |  ms |', '| ------ | --: |', '| a      | 1.5 |', '| longer | 120 |'].join('\n'),
    );
    expect(table([])).toBe('');
    expect(fixed(1234.56)).toBe('1235');
    expect(fixed(12.345)).toBe('12.3');
    expect(fixed(0.012345)).toBe('0.0123');
  });
});
