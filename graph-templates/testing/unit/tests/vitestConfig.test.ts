import { describe, expect, it } from 'vitest';

describe('testing.unit: runner sanity', () => {
  it('the test runner itself executes', () => {
    expect(1 + 1).toBe(2);
  });
});
