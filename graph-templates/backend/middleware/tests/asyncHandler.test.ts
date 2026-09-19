import { describe, expect, it, vi } from 'vitest';
import { asyncHandler } from '../../../../src/middlewares/asyncHandler';

describe('backend.middleware asyncHandler', () => {
  it('forwards a rejected promise to next', async () => {
    const next = vi.fn();
    const err = new Error('boom');
    const wrapped = asyncHandler(async () => { throw err; });
    wrapped({} as any, {} as any, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not call next on success', async () => {
    const next = vi.fn();
    const wrapped = asyncHandler(async () => 'ok');
    wrapped({} as any, {} as any, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).not.toHaveBeenCalled();
  });
});
