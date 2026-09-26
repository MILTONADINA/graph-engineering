// Dockerfile names: Dockerfile, Dockerfile.dev, Dockerfile-dev,
// Dockerfile.prod.local, Containerfile and api.dockerfile. A name that ends
// in a source, data or template extension is not a Dockerfile.
const DOCKERFILE =
  /(^|\/)((dockerfile|containerfile)([.-][a-z0-9_-]+)*|[^/]+\.dockerfile)$/i;
const NOT_DOCKERFILE =
  /\.(dockerignore|template|tmpl|md|txt|json|ya?ml|toml|lock|sh|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|kt|swift|c|h|cpp|hpp)$/i;

export function isDockerfile(file: string): boolean {
  return DOCKERFILE.test(file) && !NOT_DOCKERFILE.test(file);
}
