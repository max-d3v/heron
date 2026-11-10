import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The element in the settings header where the current pane's actions go. */
export const HeaderSlot = createContext<HTMLElement | null>(null);

/** Renders a pane's actions (its add buttons) in the settings header, next to the close button. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot ? createPortal(children, slot) : null;
}
