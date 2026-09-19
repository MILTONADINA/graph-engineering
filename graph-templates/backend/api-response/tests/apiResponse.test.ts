import { describe, expect, it, vi } from 'vitest';
import { sendSuccess, sendPaginated } from '../../../../src/utils/apiResponse';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('backend.api-response', () => {
  it('sendSuccess defaults to 200 and wraps data under { message, data }', () => {
    const res = mockRes();
    sendSuccess(res, { id: 1 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Success', data: { id: 1 } });
  });

  it('sendPaginated includes pagination meta', () => {
    const res = mockRes();
    sendPaginated(res, [1, 2], { page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(res.json).toHaveBeenCalledWith({
      message: 'Success',
      data: [1, 2],
      pagination: { page: 1, pageSize: 2, total: 5, totalPages: 3 },
    });
  });
});
