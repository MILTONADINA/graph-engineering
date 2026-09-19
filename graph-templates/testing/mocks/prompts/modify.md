To support a query shape `createMockDatabase` doesn't cover yet (e.g. a `.orderBy()` chain used by `api.crud`), add the missing method to the `chain` object rather than creating a second mock helper.
