'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type ChatAttachment,
  type ChatMessage,
  type ChatSession,
  type ChatState,
  createEmptyChatState,
  DEFAULT_GEMINI_MODEL,
  loadChatState,
  saveChatState,
} from '@/lib/chat-state';
import type { MonitoringSnapshot } from '@/lib/monitoring';

const ACCEPTED_FILES =
  'image/png,image/jpeg,application/pdf,text/plain,text/markdown,text/csv,application/json,.md,.markdown,.csv,.json,.txt,.pdf,.png,.jpg,.jpeg';

type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'retry';
      attempt: number;
      status?: number;
      timedOut: boolean;
      delayMs: number;
    }
  | {
      type: 'fallback';
      requestedModel: string;
      fallbackModel: string;
      status?: number;
      timedOut: boolean;
    }
  | { type: 'done'; usage: { promptTokens: number; candidateTokens: number } }
  | { type: 'error'; error: string; status: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStreamEvent(value: unknown): ChatStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Gemini returned an invalid streaming response.');
  }

  if (value.type === 'chunk' && typeof value.text === 'string') {
    return { type: 'chunk', text: value.text };
  }
  if (
    value.type === 'retry' &&
    typeof value.attempt === 'number' &&
    typeof value.timedOut === 'boolean' &&
    typeof value.delayMs === 'number' &&
    (value.status === undefined || typeof value.status === 'number')
  ) {
    return {
      type: 'retry',
      attempt: value.attempt,
      timedOut: value.timedOut,
      delayMs: value.delayMs,
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
    };
  }
  if (
    value.type === 'fallback' &&
    typeof value.requestedModel === 'string' &&
    typeof value.fallbackModel === 'string' &&
    typeof value.timedOut === 'boolean' &&
    (value.status === undefined || typeof value.status === 'number')
  ) {
    return {
      type: 'fallback',
      requestedModel: value.requestedModel,
      fallbackModel: value.fallbackModel,
      timedOut: value.timedOut,
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
    };
  }
  if (
    value.type === 'done' &&
    isRecord(value.usage) &&
    typeof value.usage.promptTokens === 'number' &&
    typeof value.usage.candidateTokens === 'number'
  ) {
    return {
      type: 'done',
      usage: {
        promptTokens: value.usage.promptTokens,
        candidateTokens: value.usage.candidateTokens,
      },
    };
  }
  if (
    value.type === 'error' &&
    typeof value.error === 'string' &&
    typeof value.status === 'number'
  ) {
    return { type: 'error', error: value.error, status: value.status };
  }

  throw new Error('Gemini returned an unsupported streaming event.');
}

async function consumeNdjsonStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('The streaming response body is unavailable.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function parseLine(line: string): void {
    if (!line.trim()) return;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('Gemini returned malformed streaming data.');
    }
    onEvent(parseStreamEvent(value));
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        parseLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    parseLine(buffer);
  } catch (error: unknown) {
    await reader.cancel(error);
    throw error;
  }
}

class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatStreamError';
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ChatClient() {
  const [state, setState] = useState<ChatState>(createEmptyChatState);
  const [input, setInput] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [requestError, setRequestError] = useState('');
  const [generationStatus, setGenerationStatus] = useState('');
  const [rateLimit, setRateLimit] = useState<MonitoringSnapshot['rateLimit'] | null>(null);
  const [metricsError, setMetricsError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void Promise.resolve()
      .then(loadChatState)
      .then(setState)
      .catch((error: unknown) => {
        setStorageError(
          error instanceof Error ? error.message : 'Could not load browser chat history.',
        );
      })
      .finally(() => setStorageReady(true));
  }, []);

  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) ?? null,
    [state.activeSessionId, state.sessions],
  );
  const messages = activeSession?.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  useEffect(() => {
    let active = true;

    async function refreshRateLimit(): Promise<void> {
      try {
        const response = await fetch('/api/admin/metrics', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Rate-limit status returned ${response.status}.`);
        const snapshot = (await response.json()) as MonitoringSnapshot;
        if (active) {
          setRateLimit(snapshot.rateLimit);
          setMetricsError('');
        }
      } catch (error: unknown) {
        if (active) {
          setMetricsError(
            error instanceof Error ? error.message : 'Rate-limit status is unavailable.',
          );
        }
      }
    }

    void refreshRateLimit();
    const interval = setInterval(() => void refreshRateLimit(), 5_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  function updateState(nextState: ChatState): void {
    setState(nextState);
    if (storageError) return;

    try {
      saveChatState(nextState);
    } catch {
      setStorageError('Browser storage is full or unavailable. New chats may not be saved.');
    }
  }

  function startNewChat(): void {
    updateState({ ...state, activeSessionId: null });
    setRequestError('');
  }

  function selectSession(sessionId: string): void {
    updateState({ ...state, activeSessionId: sessionId });
    setRequestError('');
  }

  function deleteSession(sessionId: string): void {
    const sessions = state.sessions.filter((session) => session.id !== sessionId);
    updateState({
      ...state,
      sessions,
      activeSessionId:
        state.activeSessionId === sessionId ? (sessions[0]?.id ?? null) : state.activeSessionId,
    });
  }

  function setModel(model: string): void {
    updateState({ ...state, model });
  }

  const rateLimitPercent = rateLimit
    ? Math.min(100, (rateLimit.used / Math.max(rateLimit.limit, 1)) * 100)
    : 0;

  function handleFileSelection(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 5) {
      setRequestError('Please select up to five files.');
      event.target.value = '';
      return;
    }
    if (files.some((file) => file.size > 8 * 1024 * 1024)) {
      setRequestError('Each file must be 8 MB or smaller.');
      event.target.value = '';
      return;
    }
    setSelectedFiles(files);
    setRequestError('');
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading || (!input.trim() && selectedFiles.length === 0)) return;

    const prompt = input.trim();
    const files = [...selectedFiles];
    const attachments: ChatAttachment[] = files.map(({ name, type, size }) => ({
      name,
      type: type || 'application/octet-stream',
      size,
    }));
    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: prompt || 'Please review the attached file.',
      createdAt: new Date().toISOString(),
      attachments,
    };
    const existingSession = activeSession;
    const sessionId = existingSession?.id ?? createId();
    const nextSession: ChatSession = {
      id: sessionId,
      title:
        existingSession?.title ?? (prompt.slice(0, 48) || files[0]?.name || 'New chat'),
      updatedAt: new Date().toISOString(),
      messages: [...(existingSession?.messages ?? []), userMessage],
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };
    const streamingSession: ChatSession = {
      ...nextSession,
      messages: [...nextSession.messages, assistantMessage],
    };
    const nextState: ChatState = {
      ...state,
      sessions: [streamingSession, ...state.sessions.filter((session) => session.id !== sessionId)],
      activeSessionId: sessionId,
    };

    setInput('');
    setSelectedFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setRequestError('');
    updateState(nextState);
    setGenerationStatus('Connecting to Gemini…');
    setLoading(true);

    const formData = new FormData();
    formData.set('prompt', prompt || 'Please review the attached file.');
    formData.set('model', state.model || DEFAULT_GEMINI_MODEL);
    formData.set(
      'history',
      JSON.stringify(
        (existingSession?.messages ?? []).slice(-20).map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ),
    );
    for (const file of files) formData.append('files', file);

    let streamedText = '';
    let responseState = nextState;
    try {
      const response = await fetch('/api/chat', { method: 'POST', body: formData });
      if (!response.ok) {
        let errorMessage = 'The request could not be completed.';
        try {
          const body: unknown = await response.json();
          if (isRecord(body) && typeof body.error === 'string') errorMessage = body.error;
        } catch {
          errorMessage = `The request failed with status ${response.status}.`;
        }
        throw new ChatStreamError(errorMessage, response.status);
      }

      let receivedDoneEvent = false;
      await consumeNdjsonStream(response, (event) => {
        if (event.type === 'chunk') {
          streamedText += event.text;
          setGenerationStatus('Streaming response…');
          updateState({
            ...responseState,
            sessions: [
              {
                ...streamingSession,
                updatedAt: new Date().toISOString(),
                messages: streamingSession.messages.map((message) =>
                  message.id === assistantMessage.id
                    ? { ...message, content: streamedText }
                    : message,
                ),
              },
              ...responseState.sessions.filter((session) => session.id !== sessionId),
            ],
          });
        } else if (event.type === 'retry') {
          const delaySeconds = (event.delayMs / 1_000).toFixed(1);
          const reason = event.status === 429
            ? 'Gemini rate limit reached'
            : event.timedOut
              ? 'Gemini is taking too long'
              : 'Gemini is under heavy load';
          setGenerationStatus(
            `${reason}. Retrying in ${delaySeconds}s (${event.attempt}/3)…`,
          );
        } else if (event.type === 'fallback') {
          responseState = { ...responseState, model: event.fallbackModel };
          const reason =
            event.status === 404
              ? 'is unavailable'
              : event.timedOut
                ? 'timed out'
                : 'is under heavy load';
          setGenerationStatus(`${event.requestedModel} ${reason}. Trying ${event.fallbackModel}…`);
          updateState(responseState);
        } else if (event.type === 'done') {
          receivedDoneEvent = true;
          if (!streamedText) {
            streamedText = 'The model returned an empty response.';
            updateState({
              ...responseState,
              sessions: [
                {
                  ...streamingSession,
                  messages: streamingSession.messages.map((message) =>
                    message.id === assistantMessage.id
                      ? { ...message, content: streamedText }
                      : message,
                  ),
                },
                ...responseState.sessions.filter((session) => session.id !== sessionId),
              ],
            });
          }
          setGenerationStatus('');
        } else {
          throw new ChatStreamError(event.error, event.status);
        }
      });

      if (!receivedDoneEvent) {
        throw new Error('Gemini closed the stream before completing the response.');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The Gemini request failed.';
      setRequestError(
        error instanceof ChatStreamError && error.status === 429
          ? `${message} The request limit is shown above.`
          : streamedText.length > 0
            ? `${message} The partial response is preserved.`
            : message,
      );
      setGenerationStatus('');
      if (!streamedText) {
        updateState({
          ...responseState,
          sessions: [
            {
              ...nextSession,
              messages: nextSession.messages.filter(
                (message) => message.id !== assistantMessage.id,
              ),
            },
            ...responseState.sessions.filter((session) => session.id !== sessionId),
          ],
        });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="chat-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">✦</span>
          <span>Cinematic AI</span>
        </Link>
        <button
          className="new-chat-button"
          disabled={!storageReady}
          onClick={startNewChat}
          type="button"
        >
          <span aria-hidden="true">＋</span> New chat
        </button>
        <p className="sidebar-label">YOUR CHATS</p>
        <nav aria-label="Saved chats" className="session-list">
          {state.sessions.map((session) => (
            <div
              className={`session-row ${session.id === state.activeSessionId ? 'session-active' : ''}`}
              key={session.id}
            >
              <button
                className="session-select"
                onClick={() => selectSession(session.id)}
                type="button"
              >
                <span className="session-title">{session.title}</span>
                <span className="session-date">
                  {new Date(session.updatedAt).toLocaleDateString()}
                </span>
              </button>
              <button
                aria-label={`Delete ${session.title}`}
                className="session-delete"
                onClick={() => deleteSession(session.id)}
                type="button"
              >
                ×
              </button>
            </div>
          ))}
          {state.sessions.length === 0 && (
            <p className="empty-sidebar">Your saved conversations will appear here.</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <label className="setting-label" htmlFor="model-select">
            Model
          </label>
          <select
            className="model-select"
            disabled={!storageReady}
            id="model-select"
            onChange={(event) => setModel(event.target.value)}
            value={state.model}
          >
            <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
            <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
            <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite</option>
          </select>
          <Link className="admin-link" href="/app/admin">
            <span aria-hidden="true">◷</span> System monitoring
          </Link>
          <p className="privacy-note">Chats are saved in this browser only.</p>
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-topbar">
          <div className="mobile-brand">
            <span className="brand-mark">✦</span> Cinematic AI
          </div>
          <div className="mobile-controls">
            <button className="mobile-new-chat" onClick={startNewChat} type="button">
              ＋ New
            </button>
            <select
              aria-label="Saved chats"
              className="mobile-control mobile-session-select"
              disabled={!storageReady}
              onChange={(event) =>
                event.target.value ? selectSession(event.target.value) : startNewChat()
              }
              value={state.activeSessionId ?? ''}
            >
              <option value="">New chat</option>
              {state.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
            <select
              aria-label="Model"
              className="mobile-control mobile-model-select"
              disabled={!storageReady}
              onChange={(event) => setModel(event.target.value)}
              value={state.model}
            >
              <option value="gemini-3.8-flash">3.8 Flash</option>
              <option value="gemini-3.6-flash">3.6 Flash</option>
              <option value="gemini-3.5-flash-lite">3.5 Flash-Lite</option>
            </select>
            <Link className="mobile-admin-link" href="/app/admin">
              Monitor
            </Link>
          </div>
          <span className="model-chip">{state.model}</span>
        </header>

        <section aria-label="Gemini request capacity" className="rate-limit-panel">
          <div className="rate-limit-heading">
            <span className="rate-limit-label">Request capacity</span>
            {rateLimit ? (
              <span className={rateLimit.remaining === 0 ? 'rate-limit-empty' : ''}>
                {rateLimit.used} / {rateLimit.limit} used
                <span className="rate-limit-separator"> · </span>
                {rateLimit.remaining} remaining
              </span>
            ) : (
              <span>{metricsError || 'Loading limit status…'}</span>
            )}
          </div>
          <div
            aria-label={
              rateLimit
                ? `${rateLimit.used} of ${rateLimit.limit} application requests used`
                : 'Application request usage unavailable'
            }
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={rateLimitPercent}
            className={`rate-limit-track ${rateLimit && rateLimit.remaining === 0 ? 'rate-limit-track-full' : ''}`}
            role="progressbar"
          >
            <span style={{ width: `${rateLimitPercent}%` }} />
          </div>
          <p aria-live="polite" className="rate-limit-status">
            {generationStatus ||
              (rateLimit?.remaining === 0
                ? `Application request limit reached. Resets in ${Math.ceil(rateLimit.resetInMs / 60_000)} minutes.`
                : 'Application limit is process-local; Google provider quota may differ.')}
          </p>
        </section>

        <div aria-live="polite" className="messages-area">
          {messages.length === 0 ? (
            <div className="welcome-panel">
              <div className="welcome-icon">✦</div>
              <p className="eyebrow">YOUR CREATIVE ASSISTANT</p>
              <h1>What can I help you with?</h1>
              <p>Ask a question, explore an idea, or share a file to get started.</p>
              <div className="suggestion-row">
                <button
                  onClick={() => setInput('Summarize the key ideas in a document')}
                  type="button"
                >
                  Summarize a document
                </button>
                <button onClick={() => setInput('Help me brainstorm a new idea')} type="button">
                  Brainstorm ideas
                </button>
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article className={`message message-${message.role}`} key={message.id}>
                  <div className="message-avatar">
                    {message.role === 'assistant' ? '✦' : 'Y'}
                  </div>
                  <div className="message-body">
                    <p className="message-author">
                      {message.role === 'assistant' ? 'Cinematic AI' : 'You'}
                    </p>
                    <p className="message-content">{message.content}</p>
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="attachment-list">
                        {message.attachments.map((attachment) => (
                          <span className="attachment-pill" key={`${message.id}-${attachment.name}`}>
                            <span aria-hidden="true">▧</span>
                            {attachment.name}
                            <small>{formatBytes(attachment.size)}</small>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {loading && (
                <div className="message message-assistant">
                  <div className="message-avatar">✦</div>
                  <div aria-label="Gemini is responding" className="typing-indicator" role="status">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {storageError && <p className="inline-error">{storageError}</p>}
          {requestError && <p className="inline-error">{requestError}</p>}
          {selectedFiles.length > 0 && (
            <div className="pending-files">
              {selectedFiles.map((file) => (
                <span className="attachment-pill" key={`${file.name}-${file.lastModified}`}>
                  {file.name}
                  <button
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setSelectedFiles((current) => current.filter((entry) => entry !== file))
                    }
                    type="button"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="composer" onSubmit={handleSubmit}>
            <input
              accept={ACCEPTED_FILES}
              aria-label="Attach images or documents"
              className="visually-hidden"
              multiple
              onChange={handleFileSelection}
              ref={fileInputRef}
              type="file"
            />
            <button
              aria-label="Attach files"
              className="attach-button"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              ＋
            </button>
            <textarea
              aria-label="Message"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Message Cinematic AI..."
              rows={1}
              value={input}
            />
            <button
              aria-label="Send message"
              className="send-button"
              disabled={
                !storageReady || loading || (!input.trim() && selectedFiles.length === 0)
              }
              type="submit"
            >
              ↑
            </button>
          </form>
          <p className="composer-footnote">
            Supports PNG, JPEG, PDF, TXT, Markdown, CSV and JSON files · Up to 8 MB each
          </p>
        </div>
      </section>
    </main>
  );
}
