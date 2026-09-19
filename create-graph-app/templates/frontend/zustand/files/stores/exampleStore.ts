import { create } from 'zustand';

interface ExampleState {
  count: number;
  increment: () => void;
  reset: () => void;
}

// Starter store — replace with your own state. One `create()` call per
// concern is the idiomatic Zustand pattern; avoid one giant store.
export const useExampleStore = create<ExampleState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  reset: () => set({ count: 0 }),
}));
