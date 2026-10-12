import { createContext, useContext } from "react";

export interface ShellApi {
  /** Open the new-quote dialog. */
  newQuote: () => void;
  /** Show a short confirmation, optionally with an Undo. */
  toast: (message: string, undo?: () => void) => void;
}

export const ShellContext = createContext<ShellApi>({
  newQuote: () => {},
  toast: () => {},
});

export function useShell() {
  return useContext(ShellContext);
}
