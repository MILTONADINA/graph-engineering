import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../../../lib/auth/AuthContext';
import * as apiClient from '../../../../lib/apiClient';

function Probe() {
  const { user, isLoading } = useAuth();
  return <div data-testid="probe">{isLoading ? 'loading' : user ? user.email : 'anonymous'}</div>;
}

describe('frontend.authentication AuthContext', () => {
  it('resolves to anonymous when GET /api/auth/me returns 401', async () => {
    vi.spyOn(apiClient, 'apiFetch').mockRejectedValue(new apiClient.ApiError('Authentication required', 401));
    const { getByTestId } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(getByTestId('probe').textContent).toBe('anonymous'));
  });

  it('useAuth throws outside an AuthProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useAuth must be used within an AuthProvider');
    consoleError.mockRestore();
  });
});
