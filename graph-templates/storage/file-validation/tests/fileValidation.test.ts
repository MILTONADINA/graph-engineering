import { describe, expect, it, vi } from 'vitest';
import { fileFilter } from '../../../../src/middlewares/fileValidation';

describe('storage.file-validation', () => {
  it('rejects a disallowed MIME type', () => {
    const cb = vi.fn();
    fileFilter({} as any, { mimetype: 'application/zip' } as any, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });

  it('accepts an allowed MIME type', () => {
    const cb = vi.fn();
    fileFilter({} as any, { mimetype: 'image/png' } as any, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });
});
