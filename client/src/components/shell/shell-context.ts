import { createContext, useContext } from "react";

export interface ShellApi {
  /** Open the new-quote dialog. */
  newQuote: () => void;
  /** Show a short confirmation, optionally with an Undo, for `durationMs` (default 3.2 s, 6 s with Undo). */
  toast: (message: string, undo?: () => void, options?: { durationMs?: number }) => void;
}

export const ShellContext = createContext<ShellApi>({
  newQuote: () => {},
  toast: () => {},
});

export function useShell() {
  return useContext(ShellContext);
}
