export default {
  test: {
    include: [
      "tests/context-rust.test.ts",
      "tests/context-rust-integration.test.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    cache: false,
  },
  cacheDir: "/tmp/vitest-rust",
};
