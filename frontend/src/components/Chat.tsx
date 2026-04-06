import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, Bot, User, Loader2, Sparkles, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { sendMessage, getChatSession, listChatSessions } from '../api/client';

// ── LocalStorage — only persists the sessionId (a lightweight UUID string).
// Full message history is stored in DynamoDB and fetched on mount.
const LS_SESSION_ID = 'kostops_chat_session_id';

function loadSessionId(): string | null {
  try { return localStorage.getItem(LS_SESSION_ID); } catch { return null; }
}

function saveSessionId(sessionId: string) {
  try { localStorage.setItem(LS_SESSION_ID, sessionId); } catch { /* ignore */ }
}

function clearSessionId() {
  try { localStorage.removeItem(LS_SESSION_ID); } catch { /* ignore */ }
}

interface Message {
  id:        string;
  role:      'user' | 'assistant';
  content:   string;
  timestamp: Date;
}

const SUGGESTED_PROMPTS = [
  'What are my top savings opportunities this week?',
  'Why did costs spike last month?',
  'Show me unattached EBS volumes',
  'Which services cost the most this month?',
];

export default function Chat() {
  const [messages,      setMessages]      = useState<Message[]>([]);
  const [input,         setInput]         = useState('');
  const [loading,       setLoading]       = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);  // true on first mount
  const [sessionId,     setSessionId]     = useState<string | null>(null);
  const [error,         setError]         = useState<string | null>(null);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);

  // ── Load history from DynamoDB on mount ────────────────────────────────────
  // Strategy:
  //   1. Try the sessionId stored in localStorage (happy path — fast)
  //   2. If that 404s (old/pre-persistence session), fall back to the most
  //      recent session from the list API so the user never sees an empty chat
  //      even after the first deploy of this feature
  //   3. If no sessions at all, show the empty state
  useEffect(() => {
    const storedId = loadSessionId();

    const loadSession = (sessionId: string) =>
      getChatSession(sessionId).then(session => {
        const rehydrated: Message[] = session.messages.map(m => ({
          id:        crypto.randomUUID(),
          role:      m.role,
          content:   m.content,
          timestamp: new Date(m.timestamp),
        }));
        setMessages(rehydrated);
        setSessionId(sessionId);
        saveSessionId(sessionId);
      });

    const tryStoredThenFallback = async () => {
      // Try stored sessionId first
      if (storedId) {
        try {
          await loadSession(storedId);
          return;
        } catch {
          // stored session gone — fall through to list lookup
          clearSessionId();
        }
      }

      // Fall back: load the most recent session from DynamoDB
      try {
        const { sessions } = await listChatSessions();
        if (sessions.length > 0) {
          await loadSession(sessions[0].sessionId);
        }
      } catch (err) {
        console.warn('Could not load chat history:', err);
      }
    };

    tryStoredThenFallback().finally(() => setHistoryLoading(false));
  }, []);  // runs once on mount

  // Persist sessionId to localStorage whenever it changes after a new message
  useEffect(() => {
    if (sessionId) saveSessionId(sessionId);
  }, [sessionId]);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  function handleNewChat() {
    clearSessionId();
    setMessages([]);
    setSessionId(null);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function handleSend(text?: string) {
    const messageText = (text ?? input).trim();
    if (!messageText || loading) return;

    setInput('');
    setError(null);

    const userMsg: Message = {
      id:        crypto.randomUUID(),
      role:      'user',
      content:   messageText,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const response = await sendMessage(messageText, sessionId);
      setSessionId(response.sessionId);

      const assistantMsg: Message = {
        id:        crypto.randomUUID(),
        role:      'assistant',
        content:   response.reply,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Auto-resize textarea
  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  }

  return (
    <div className="flex flex-col h-full bg-white">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 px-6 py-4 border-b border-gray-100 bg-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-brand-500" />
            <h1 className="text-base font-semibold text-gray-900">Cost Intelligence</h1>
          </div>
          {messages.length > 0 && (
            <button
              onClick={handleNewChat}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-700
                         transition-colors px-2 py-1 rounded-md hover:bg-gray-100"
              title="Start a new conversation"
            >
              <RotateCcw size={13} />
              New chat
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          Ask about your AWS spend, savings opportunities, or anomalies
        </p>
      </header>

      {/* ── Messages ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4 space-y-6">

        {/* History loading skeleton */}
        {historyLoading && (
          <div className="flex flex-col gap-4 pt-4 animate-pulse">
            {[1, 2, 3].map(i => (
              <div key={i} className={`flex items-start gap-3 ${i % 2 === 0 ? 'flex-row-reverse' : ''}`}>
                <div className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />
                <div className={`h-10 rounded-2xl bg-gray-200 ${i % 2 === 0 ? 'w-48' : 'w-64'}`} />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!historyLoading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-2xl bg-brand-50 flex items-center justify-center mb-4">
              <Bot size={24} className="text-brand-600" />
            </div>
            <h2 className="text-gray-900 font-semibold text-lg mb-1">KostOps Agent</h2>
            <p className="text-gray-400 text-sm max-w-sm mb-8">
              I can analyse your AWS costs, find savings opportunities,
              and answer questions about your cloud spending.
            </p>
            <div className="grid grid-cols-2 gap-2 w-full max-w-lg">
              {SUGGESTED_PROMPTS.map(prompt => (
                <button
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  className="text-left px-4 py-3 rounded-xl border border-gray-200 text-sm text-gray-600
                             hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700
                             transition-colors duration-150"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Typing indicator */}
        {loading && (
          <div className="flex items-start gap-3">
            <Avatar role="assistant" />
            <div className="flex items-center gap-1.5 bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ──────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 py-4 border-t border-gray-100 bg-white">
        <div className="flex items-end gap-3 bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3
                        focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100
                        transition-all duration-150">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your AWS costs…"
            disabled={loading}
            className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400
                       resize-none outline-none leading-relaxed disabled:opacity-50"
            style={{ minHeight: '24px', maxHeight: '160px' }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className={clsx(
              'flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-colors duration-150',
              input.trim() && !loading
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed',
            )}
          >
            {loading
              ? <Loader2 size={15} className="animate-spin" />
              : <Send size={15} />
            }
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2 text-center">
          Press <kbd className="font-mono bg-gray-100 px-1 rounded">Enter</kbd> to send,{' '}
          <kbd className="font-mono bg-gray-100 px-1 rounded">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  );
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div
      className={clsx(
        'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white',
        role === 'assistant' ? 'bg-brand-600' : 'bg-gray-700',
      )}
    >
      {role === 'assistant' ? <Bot size={15} /> : <User size={15} />}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const time   = message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={clsx('flex items-start gap-3', isUser && 'flex-row-reverse')}>
      <Avatar role={message.role} />
      <div className={clsx('flex flex-col max-w-2xl', isUser && 'items-end')}>
        <div
          className={clsx(
            'px-4 py-3 rounded-2xl text-sm leading-relaxed',
            isUser
              ? 'bg-brand-600 text-white rounded-tr-sm'
              : 'bg-gray-100 text-gray-800 rounded-tl-sm',
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <ReactMarkdown
              components={{
                p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                ul:     ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
                ol:     ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
                li:     ({ children }) => <li>{children}</li>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                code:   ({ children }) => (
                  <code className="bg-gray-200 text-gray-800 px-1.5 py-0.5 rounded text-xs font-mono">
                    {children}
                  </code>
                ),
                pre:    ({ children }) => (
                  <pre className="bg-gray-200 rounded-lg p-3 overflow-x-auto text-xs font-mono my-2">
                    {children}
                  </pre>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
        </div>
        <span className="text-xs text-gray-400 mt-1 px-1">{time}</span>
      </div>
    </div>
  );
}
