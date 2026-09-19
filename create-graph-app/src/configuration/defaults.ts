import { ProjectConfig } from '../types';

/**
 * Smart defaults (brief §38) — pre-selected answers the INTERACTIVE WIZARD
 * shows as each prompt's `initialValue`, always changeable before the user
 * confirms. Never used to fill in a --non-interactive flag the user left
 * out — see NONE_CONFIG below for why that's a different, deliberately
 * unopinionated baseline.
 */
export const DEFAULT_CONFIG: ProjectConfig = {
  project: { name: 'my-app', type: 'fullstack' },
  frontend: { framework: 'nextjs', stateManagement: 'none', ui: 'shadcn' },
  backend: { framework: 'express' },
  database: { provider: 'neon-postgres' },
  storage: { provider: 'none' },
};

/**
 * The baseline for `--non-interactive` flag-driven generation: every
 * category defaults to "none" unless the flag explicitly names something.
 * Using DEFAULT_CONFIG's smart defaults here would mean `--backend express`
 * alone silently also generates a full Next.js frontend nobody asked for —
 * exactly what brief §37 says never to do. Smart defaults are for a wizard
 * the user can see and correct before confirming; a flag-only invocation
 * has no such confirmation step, so silence must mean "nothing," not "the
 * wizard's opinion."
 */
export const NONE_CONFIG: ProjectConfig = {
  project: { name: 'my-app', type: 'fullstack' },
  frontend: { framework: 'none', stateManagement: 'none', ui: 'none' },
  backend: { framework: 'none' },
  database: { provider: 'none' },
  storage: { provider: 'none' },
};
