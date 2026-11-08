import { defineConfig } from 'vitest/config';

// Plain Node tests: the Worker logic is a pure router plus a handler that takes
// an injected fetcher, so the Workers runtime pool is not needed.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
