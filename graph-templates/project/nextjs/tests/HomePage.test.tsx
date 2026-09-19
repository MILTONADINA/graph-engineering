import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from '../../../app/page';

describe('project.nextjs: home page', () => {
  it('renders without crashing', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading')).toBeInTheDocument();
  });
});
