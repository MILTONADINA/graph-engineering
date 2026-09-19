# Modify: project.node-express

This node has no first-class `modify` action of its own (its files are meant to be extended by *other* nodes' `files.modify` operations, not re-templated). If asked to change `projectName`, `port`, or `corsOrigin` after generation:

1. Read the current `package.json`/`src/utils/helpers.ts` rather than re-rendering from `files/` — other nodes may have already appended to `SECRETS`/`EnvironmentVariables`.
2. Apply only the minimal targeted edit (e.g. `package.json`'s `name` field, or the `PORT`/`CORS_ORIGIN` default literals in `helpers.ts`).
3. Update `.graph/manifest.json`'s `generatedAt` for this node but leave its `version` unless the *template* itself changed.
4. Re-run `npm run build` to confirm nothing broke.
