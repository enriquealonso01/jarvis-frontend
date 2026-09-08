import { createContext } from "react";
import type { ReactNode } from "react";

export interface PageHeaderContextValue {
  setAfterTitle: (node: ReactNode) => void;
  setEnd: (node: ReactNode) => void;
  setTitle: (title: string | null) => void;
  /** Pages that render their own fixed-height surface opt out of the scrollable main. */
  setImmersive: (immersive: boolean) => void;
}

export const PageHeaderContext = createContext<PageHeaderContextValue | null>(
  null,
);
