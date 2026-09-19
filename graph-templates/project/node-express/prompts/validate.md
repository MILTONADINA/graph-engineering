# Validate: project.node-express

Run, in order, stopping at the first failure:

1. `file-exists package.json` — if missing, this node was never generated; nothing else in `validation.checks` is meaningful.
2. `file-exists src/app.ts`.
3. `npm run build` — must exit 0. A failure here after only this node has run indicates a broken template (see README "On failure"); a failure after downstream nodes have run usually means a downstream node's `files.modify` operation inserted invalid code at one of `app.ts`'s markers — inspect the diff at `// Import routes`, `// Routes`, `// Error handling middleware`.
4. `npm test -- health-check` — confirms `GET /` still returns `{ status: 'OK' }` (a downstream node overwriting the health-check route rather than composing around it is a bug in that node).

Report `{ valid: boolean, errors: [...] }` per `TEMPLATE-SPEC.md` §validation.
