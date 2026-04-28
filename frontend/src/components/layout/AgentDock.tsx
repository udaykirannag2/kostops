import { useState, useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DockState = 'minimized' | 'docked' | 'expanded';
export type DockMode  = 'push' | 'overlay';

export interface AgentContext {
  scope:       string;
  transcript?: TranscriptMessage[];
}

export interface TranscriptMessage {
  role:     'user' | 'assistant';
  text:     string;
  data?:    Record<string, string>;
  actions?: string[];
  source?:  string;
}

export interface AgentNudge {
  text: string;
  cta?: string;
}

interface PersistedDockState {
  state:     DockState;
  mode:      DockMode;
  proactive: boolean;
}

export interface UseAgentDockResult {
  reservedWidth: number;
  node:          ReactNode;
  state:         DockState;
  mode:          DockMode;
  setState:      (patch: Partial<PersistedDockState>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DOCK_W: Record<DockState, number> = {
  minimized: 56,
  docked:    420,
  expanded:  640,
};

const STORAGE_KEY = 'atlas.agentDock.v1';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadDockState(): PersistedDockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { state: 'docked', mode: 'push', proactive: true, ...JSON.parse(raw) } as PersistedDockState;
    }
  } catch (_) { /* ignore */ }
  return { state: 'docked', mode: 'push', proactive: true };
}

function saveDockState(s: PersistedDockState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// useAgentDock hook
// ─────────────────────────────────────────────────────────────────────────────

interface UseAgentDockOptions {
  context?:     AgentContext;
  suggestions?: string[];
  nudge?:       AgentNudge | null;
}

export function useAgentDock({
  context,
  suggestions = [],
  nudge = null,
}: UseAgentDockOptions): UseAgentDockResult {
  const [persisted, setPersisted] = useState<PersistedDockState>(loadDockState);
  const { state, mode: rawMode, proactive } = persisted;

  const [vpW, setVpW] = useState<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  );

  useEffect(() => {
    const onResize = () => setVpW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Auto-flip push → overlay on narrow screens
  const narrow = vpW < 1280;
  const mode: DockMode = narrow ? 'overlay' : rawMode;

  const setStateHelper = (patch: Partial<PersistedDockState>) => {
    setPersisted((p) => {
      const v = { ...p, ...patch };
      saveDockState(v);
      return v;
    });
  };

  // ⌘K / Ctrl+K toggles minimized ↔ docked; Esc minimizes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K' || e.key === '/')) {
        e.preventDefault();
        setStateHelper({ state: state === 'minimized' ? 'docked' : 'minimized' });
      } else if (e.key === 'Escape' && state !== 'minimized') {
        setStateHelper({ state: 'minimized' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  const reservedWidth = mode === 'push' ? DOCK_W[state] : 0;

  const node = (
    <AgentDock
      state={state}
      mode={mode}
      proactive={proactive}
      context={context}
      suggestions={suggestions}
      nudge={nudge}
      onSetState={(v) => setStateHelper({ state: v })}
      onSetMode={(v) => setStateHelper({ mode: v })}
      onSetProactive={(v) => setStateHelper({ proactive: v })}
    />
  );

  return { reservedWidth, node, state, mode, setState: setStateHelper };
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentDock
// ─────────────────────────────────────────────────────────────────────────────

interface AgentDockProps {
  state:          DockState;
  mode:           DockMode;
  proactive:      boolean;
  context?:       AgentContext;
  suggestions:    string[];
  nudge:          AgentNudge | null;
  onSetState:     (v: DockState) => void;
  onSetMode:      (v: DockMode) => void;
  onSetProactive: (v: boolean) => void;
}

function AgentDock({
  state,
  mode,
  proactive,
  context,
  suggestions,
  nudge,
  onSetState,
  onSetMode,
  onSetProactive,
}: AgentDockProps) {
  if (state === 'minimized') {
    return (
      <AgentDockPill
        proactive={proactive}
        nudge={nudge}
        onOpen={() => onSetState('docked')}
      />
    );
  }

  const w = DOCK_W[state];

  return (
    <div
      className="absolute bottom-0 right-0 top-0 z-50 flex flex-col bg-white"
      style={{
        width: w,
        borderLeft: '1px solid #e6e9ef',
        boxShadow: mode === 'overlay' ? '-12px 0 32px rgba(11,18,32,0.10)' : 'none',
        transition: 'all 240ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      <AgentDockHeader
        state={state}
        mode={mode}
        proactive={proactive}
        onSetState={onSetState}
        onSetMode={onSetMode}
        onSetProactive={onSetProactive}
      />
      <AgentContextChip context={context} />
      <AgentTranscript expanded={state === 'expanded'} context={context} />
      <AgentSuggestionRow suggestions={suggestions} />
      <AgentComposer />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimized pill — position: fixed, bottom-right
// ─────────────────────────────────────────────────────────────────────────────

interface AgentDockPillProps {
  proactive: boolean;
  nudge:     AgentNudge | null;
  onOpen:    () => void;
}

function AgentDockPill({ proactive, nudge, onOpen }: AgentDockPillProps) {
  const showNudge = proactive && nudge;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex items-end gap-2.5">
      {showNudge && nudge && (
        <div
          onClick={onOpen}
          className="max-w-[280px] cursor-pointer rounded-[12px_12px_4px_12px] border border-atlas-rule bg-white p-3.5 text-[12.5px] leading-relaxed text-atlas-ink shadow-lg"
        >
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-atlas-brandAtlas">
            Suggestion
          </div>
          <div>{nudge.text}</div>
          <div className="mt-1.5 text-[11px] font-medium text-atlas-brandAtlas">
            {nudge.cta ?? 'Ask Claude →'}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onOpen}
        title="Open assistant (⌘K)"
        className="relative flex h-14 w-14 items-center justify-center rounded-full border-none text-[22px] text-white shadow-lg"
        style={{ background: 'linear-gradient(135deg, #0b66e4, #6c4ad9)', cursor: 'pointer' }}
      >
        ✦
        {showNudge && (
          <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-atlas-warn" />
        )}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

interface AgentDockHeaderProps {
  state:          DockState;
  mode:           DockMode;
  proactive:      boolean;
  onSetState:     (v: DockState) => void;
  onSetMode:      (v: DockMode) => void;
  onSetProactive: (v: boolean) => void;
}

function AgentDockHeader({
  state,
  mode,
  proactive,
  onSetState,
  onSetMode,
  onSetProactive,
}: AgentDockHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-atlas-rule px-4 py-3">
      {/* Left: logo + label */}
      <div className="flex items-center gap-2">
        <span
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-[13px] text-white"
          style={{ background: 'linear-gradient(135deg,#0b66e4,#6c4ad9)' }}
        >
          ✦
        </span>
        <div>
          <div className="text-[13px] font-semibold leading-tight text-atlas-ink">Assistant</div>
          <div className="text-[10.5px] text-atlas-inkDim">Claude · Bedrock</div>
        </div>
      </div>

      {/* Right: expand/collapse, options menu, minimize */}
      <div className="relative flex items-center gap-0.5" ref={menuRef}>
        <DockIconBtn
          title={state === 'expanded' ? 'Collapse' : 'Expand'}
          onClick={() => onSetState(state === 'expanded' ? 'docked' : 'expanded')}
        >
          {state === 'expanded' ? '⇤' : '⇥'}
        </DockIconBtn>
        <DockIconBtn title="Options" onClick={() => setMenuOpen((o) => !o)}>
          ⋯
        </DockIconBtn>
        <DockIconBtn title="Minimize (Esc)" onClick={() => onSetState('minimized')}>
          −
        </DockIconBtn>

        {menuOpen && (
          <div className="absolute right-7 top-8 z-[60] min-w-[200px] rounded-lg border border-atlas-rule bg-white p-1.5 shadow-lg">
            <DockMenuLabel>Layout</DockMenuLabel>
            <DockMenuRadio
              active={mode === 'push'}
              label="Push content"
              sub="Dashboard reflows"
              onClick={() => { onSetMode('push'); setMenuOpen(false); }}
            />
            <DockMenuRadio
              active={mode === 'overlay'}
              label="Overlay"
              sub="Floats on top"
              onClick={() => { onSetMode('overlay'); setMenuOpen(false); }}
            />
            <div className="my-1 h-px bg-atlas-rule" />
            <DockMenuLabel>Behavior</DockMenuLabel>
            <DockMenuToggle
              active={proactive}
              label="Proactive nudges"
              onClick={() => onSetProactive(!proactive)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small icon button ────────────────────────────────────────────────────────

function DockIconBtn({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] border-none bg-transparent text-[14px] leading-none text-atlas-inkDim transition-colors hover:bg-atlas-bg"
    >
      {children}
    </button>
  );
}

// ── Menu sub-components ──────────────────────────────────────────────────────

function DockMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-atlas-inkDim">
      {children}
    </div>
  );
}

function DockMenuRadio({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label:  string;
  sub:    string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="flex cursor-pointer items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 transition-colors hover:bg-atlas-bg"
    >
      <span
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
        style={{
          border: `1.5px solid ${active ? '#0b66e4' : '#d3d8e0'}`,
        }}
      >
        {active && (
          <span className="h-1.5 w-1.5 rounded-full bg-atlas-brandAtlas" />
        )}
      </span>
      <div>
        <div className={clsx('text-[12.5px] text-atlas-ink', active && 'font-medium')}>
          {label}
        </div>
        <div className="text-[11px] text-atlas-inkDim">{sub}</div>
      </div>
    </div>
  );
}

function DockMenuToggle({
  active,
  label,
  onClick,
}: {
  active:  boolean;
  label:   string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="flex cursor-pointer items-center justify-between gap-2.5 rounded-[5px] px-2.5 py-1.5 transition-colors hover:bg-atlas-bg"
    >
      <span className="text-[12.5px] text-atlas-ink">{label}</span>
      <span
        className="relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150"
        style={{ background: active ? '#0b66e4' : '#d3d8e0' }}
      >
        <span
          className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all duration-150"
          style={{ left: active ? '14px' : '2px' }}
        />
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Context chip
// ─────────────────────────────────────────────────────────────────────────────

function AgentContextChip({ context }: { context?: AgentContext }) {
  if (!context) return null;
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-atlas-rule bg-atlas-brandSoft px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-atlas-brandDeep">
          SCOPE
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-atlas-ink">
          {context.scope}
        </span>
      </div>
      <span className="shrink-0 cursor-pointer text-[11px] font-medium text-atlas-brandAtlas">
        Detach
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript
// ─────────────────────────────────────────────────────────────────────────────

function AgentTranscript({
  expanded,
  context,
}: {
  expanded: boolean;
  context?: AgentContext;
}) {
  const messages = context?.transcript ?? [];

  return (
    <div
      className={clsx(
        'flex flex-1 flex-col gap-3 overflow-y-auto text-[12.5px] leading-relaxed',
        expanded ? 'px-7 py-5' : 'px-4 py-3.5',
      )}
    >
      {messages.length === 0 && (
        <div className="py-5 text-center text-atlas-inkDim">
          <div
            className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-[10px] text-[18px] text-white"
            style={{ background: 'linear-gradient(135deg,#0b66e4,#6c4ad9)' }}
          >
            ✦
          </div>
          <div className="mb-1 text-[13px] font-medium text-atlas-ink">
            How can I help?
          </div>
          <div className="text-[11.5px]">
            Ask about cost, anomalies, or run a playbook.
          </div>
        </div>
      )}
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <UserBubble key={i}>{m.text}</UserBubble>
        ) : (
          <AssistantBubble key={i} message={m} expanded={expanded} />
        ),
      )}
    </div>
  );
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="self-end max-w-[85%] rounded-[12px_12px_2px_12px] bg-atlas-brandAtlas px-3 py-2 text-white">
      {children}
    </div>
  );
}

function AssistantBubble({
  message,
  expanded,
}: {
  message:  TranscriptMessage;
  expanded: boolean;
}) {
  const hasExtra = message.data || message.actions;
  return (
    <div
      className={clsx(
        'rounded-[12px_12px_12px_2px] bg-atlas-bg px-3 py-2.5 text-atlas-ink',
        expanded ? 'max-w-[78%]' : 'max-w-[92%]',
      )}
    >
      <div className={clsx(hasExtra && 'mb-1.5')}>{message.text}</div>
      {message.data && (
        <div className="mt-1 rounded-md border border-atlas-rule bg-white px-2.5 py-2 font-mono text-[11.5px] text-atlas-inkSoft">
          {Object.entries(message.data).map(([k, v]) => (
            <div key={k}>
              {k}: <span className="text-atlas-ink">{v}</span>
            </div>
          ))}
        </div>
      )}
      {message.actions && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.actions.map((a, i) => (
            <span
              key={i}
              className="cursor-pointer rounded-xl border border-atlas-rule bg-white px-2 py-[3px] text-[11px] text-atlas-inkSoft"
            >
              {a}
            </span>
          ))}
        </div>
      )}
      {message.source && (
        <div className="mt-2 text-[11px] text-atlas-inkDim">{message.source}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion row
// ─────────────────────────────────────────────────────────────────────────────

function AgentSuggestionRow({ suggestions }: { suggestions: string[] }) {
  if (!suggestions.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap gap-1.5 px-3 pb-0 pt-2">
      {suggestions.map((s, i) => (
        <SuggestionPill key={i}>{s}</SuggestionPill>
      ))}
    </div>
  );
}

function SuggestionPill({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={clsx(
        'cursor-pointer rounded-[14px] border px-2.5 py-[5px] text-[11.5px] transition-colors',
        hovered
          ? 'border-atlas-brandAtlas text-atlas-brandAtlas'
          : 'border-atlas-rule bg-white text-atlas-inkSoft',
      )}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────────────────────

function AgentComposer() {
  const [val, setVal] = useState('');

  return (
    <div className="shrink-0 border-t border-atlas-rule p-3">
      <div className="flex items-center gap-2 rounded-lg border border-atlas-rule bg-atlas-bg px-3 py-2">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Ask about your AWS spend…"
          className="flex-1 bg-transparent text-[12.5px] text-atlas-ink placeholder:text-atlas-inkMute focus:outline-none"
        />
        <button
          type="button"
          className={clsx(
            'flex h-6 w-6 items-center justify-center rounded-md text-[12px] text-white transition-colors',
            val ? 'bg-atlas-brandAtlas' : 'bg-atlas-ruleHi',
          )}
        >
          ↵
        </button>
      </div>
      <div className="mt-1.5 flex justify-between text-[10.5px] text-atlas-inkDim">
        <span>⌘K to toggle · Esc to minimize</span>
        <span>Claude Sonnet 4</span>
      </div>
    </div>
  );
}

export default AgentDock;
