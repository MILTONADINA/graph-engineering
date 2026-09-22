export default {
  test: {
    include: ["tests/context-java.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    cache: false,
  },
  cacheDir: "/tmp/vitest-java",
};
