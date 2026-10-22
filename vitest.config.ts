import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov', 'html'],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
