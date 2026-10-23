import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'vitest/config';
import { integrationWorkers } from './tests/support/integration-workers.js';

if (existsSync('.env.integration')) loadEnvFile('.env.integration');

const workers = integrationWorkers();

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: workers > 1,
    maxWorkers: workers,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
