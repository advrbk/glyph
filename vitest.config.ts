import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    // The tree-walking interpreter recurses on the JS stack. Child processes get a
    // 4 MB stack so it can always reach the language's 1000-call limit, like the VM.
    // (Node's main thread on Windows, macOS and Linux reserves 8 MB.)
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2, minForks: 1, execArgv: ['--stack-size=4000'] } },
  },
});
