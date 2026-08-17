import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** Live provider tests. Run with `npm run test:live`; each suite self-skips
 *  when its credentials are absent. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration.live.test.ts'],
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
