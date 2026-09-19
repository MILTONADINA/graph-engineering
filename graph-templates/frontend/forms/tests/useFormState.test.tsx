import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFormState } from '../../../../lib/forms/useFormState';
import { ApiError } from '../../../../lib/apiClient';

describe('frontend.forms useFormState', () => {
  it('setValue updates values and clears that field error', () => {
    const { result } = renderHook(() => useFormState({ email: '' }));
    act(() => result.current.setValue('email', 'a@b.com'));
    expect(result.current.values.email).toBe('a@b.com');
  });

  it('handleSubmit surfaces an ApiError message as formError', async () => {
    const { result } = renderHook(() => useFormState({ email: '' }));
    await act(async () => {
      await result.current.handleSubmit(async () => {
        throw new ApiError('Invalid credentials', 401);
      })({ preventDefault() {} } as React.FormEvent);
    });
    expect(result.current.formError).toBe('Invalid credentials');
    expect(result.current.isSubmitting).toBe(false);
  });
});
