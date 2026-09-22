export default {
  cacheDir: "/tmp/graph-csharp-vite",
  test: {
    include: ["tests/context-csharp.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
};
