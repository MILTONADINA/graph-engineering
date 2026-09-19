To batch-delete, add a new `deleteFiles(keys: string[])` method rather than changing `deleteFile`'s signature — existing callers expect the single-key form.
