import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'vitest/config';

if (existsSync('.env.integration')) loadEnvFile('.env.integration');

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
