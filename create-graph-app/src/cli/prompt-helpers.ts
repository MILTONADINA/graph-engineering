import * as clack from '@clack/prompts';
import { Template } from '../types';

/**
 * Every @clack/prompts call can resolve to its own cancel symbol (Ctrl+C).
 * Centralizing the isCancel check here means no question module needs to
 * repeat "if (clack.isCancel(answer)) { ... exit ... }" — brief §2's wizard
 * needs a clean cancel path at every single question, not just the final
 * summary screen.
 */
export async function promptOrExit<T>(promise: Promise<T | symbol>): Promise<T> {
  const value = await promise;
  if (clack.isCancel(value)) {
    clack.cancel('Cancelled — no files were created.');
    process.exit(0);
  }
  return value as T;
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Uniformly-typed template -> {value,label} mapping — the id's segment after the category dot becomes the value (e.g. "frontend.nextjs" -> "nextjs"). */
export function templatesToOptions(templates: Template[]): SelectOption[] {
  return templates.map((template) => ({ value: template.id.split('.')[1], label: template.name }));
}

const NONE_OPTION: SelectOption = { value: 'none', label: 'None' };

/**
 * A single-select prompt over a uniformly `SelectOption[]`-typed list — this
 * is what keeps TypeScript from narrowing each option object to its own
 * literal type when a static "None" entry is mixed with registry-derived
 * entries (clack.select's generics infer per call site; a consistent input
 * type is the fix, not forcing explicit generics against a 2-type-param
 * signature — see git history if this needs revisiting).
 */
export async function selectOption(message: string, options: SelectOption[], initialValue: string, includeNone = true): Promise<string> {
  return promptOrExit(
    clack.select({
      message,
      initialValue,
      options: includeNone ? [...options, NONE_OPTION] : options,
    }),
  );
}
