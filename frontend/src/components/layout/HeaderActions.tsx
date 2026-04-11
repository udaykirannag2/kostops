/**
 * HeaderActions — page-to-header action injection
 *
 * Pages call `useSetHeaderActions(<JSX />)` to render contextual controls
 * (refresh, period picker, export, etc.) in the top-right of the PageHeader.
 *
 * Usage in a page component:
 *   useSetHeaderActions(
 *     <button onClick={refresh} className="…">Refresh</button>
 *   );
 */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react';

interface HeaderActionsContextValue {
  actions:    ReactNode;
  setActions: (node: ReactNode) => void;
}

const HeaderActionsContext = createContext<HeaderActionsContextValue>({
  actions:    null,
  setActions: () => undefined,
});

export function HeaderActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ReactNode>(null);
  return (
    <HeaderActionsContext.Provider value={{ actions, setActions }}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

/** Read the current header actions — used by PageHeader */
export function useHeaderActions(): ReactNode {
  return useContext(HeaderActionsContext).actions;
}

/**
 * Page hook: inject action nodes into the PageHeader's right slot.
 * Clears automatically on unmount.
 *
 * @param actions - React node(s) to render in the header action area.
 *   Pass `null` or `undefined` to render nothing.
 */
export function useSetHeaderActions(actions: ReactNode): void {
  const { setActions } = useContext(HeaderActionsContext);

  // Sync on every render so callers can pass in dynamic jsx (loading state, etc.)
  useEffect(() => {
    setActions(actions ?? null);
    return () => setActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);                   // intentionally runs once — caller re-renders propagate via setActions
}

/**
 * Variant: re-syncs whenever `deps` change (for dynamic labels / states).
 *
 * useSetHeaderActions(node) is fine for static buttons.
 * Use useSetHeaderActionsDynamic(node, [loading]) when button label/state changes.
 */
export function useSetHeaderActionsDynamic(actions: ReactNode, deps: unknown[]): void {
  const { setActions } = useContext(HeaderActionsContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setActions(actions ?? null); }, deps);
  useEffect(() => () => setActions(null), []);  // cleanup
}
