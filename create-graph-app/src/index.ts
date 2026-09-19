/**
 * Public library entrypoint — see docs/architecture.md "Future AI
 * consumption". A caller that isn't the CLI (an AI agent, a test, a script)
 * imports from here (or the narrower `create-graph-app/registry` /
 * `create-graph-app/resolver` subpaths in package.json's `exports`) and gets
 * the exact same Registry/resolve/generate the CLI itself calls.
 */
export { Registry } from './registry/registry';
export { loadTemplates, DEFAULT_TEMPLATES_DIR } from './registry/loader';
export { resolve } from './resolver/dependency-resolver';
export { checkCompatibility } from './resolver/compatibility';
export { generate } from './generator/generator';
export { validateBeforeGenerate } from './validation/validate';
export { configToTemplateIds, inferProjectType } from './configuration/mapping';
export { DEFAULT_CONFIG } from './configuration/defaults';
export * from './types';
