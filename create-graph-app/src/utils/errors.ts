export interface CliErrorOptions {
  reason: string;
  suggestion?: string;
}

/**
 * A user-facing error. src/cli/index.ts's top-level catch prints
 * `message` / `reason` / `suggestion` on separate lines and exits 1,
 * never a stack trace — unless --debug is passed, in which case the
 * original stack is also printed. Anything thrown that is NOT a
 * CliError is treated as a real bug: its stack always prints, debug
 * mode or not, because hiding an unexpected error is worse than an
 * ugly one (see docs/architecture.md "Error handling").
 */
export class CliError extends Error {
  reason: string;
  suggestion?: string;

  constructor(message: string, options: CliErrorOptions) {
    super(message);
    this.name = 'CliError';
    this.reason = options.reason;
    this.suggestion = options.suggestion;
  }
}

export function formatCliError(error: CliError): string {
  const lines = [error.message, '', error.reason];
  if (error.suggestion) {
    lines.push('', error.suggestion);
  }
  return lines.join('\n');
}
