1. Resolve `entityName`/`tableName`/`fields`; derive `tableExportName` = camelCase(entityName) + "Table" (e.g. `Product` → `productTable`).
2. Detect: if `src/repository/<Entity>.ts` exists, switch to `modify.md` instead.
3. Render `files/EntityRepository.ts.template` to `src/repository/<Entity>.ts`.
4. Append `files/schema.fragment.ts.template` (rendered) to the end of `src/config/schema.ts`, expanding the `{{#each input.fields}}` block into one column line per field.
5. Run `npm run dbGenerate` to produce the migration, then `npm run build`.
6. Report `files`, `exports`, `tableExportName`.
