import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's standard class-merging helper — every generated component uses it. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
