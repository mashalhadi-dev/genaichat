export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const CHAT_STORAGE_KEY = 'cinematic-ai-chat-state-v1';

export interface ChatAttachment {
  name: string;
  type: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  model: string;
}

export function createEmptyChatState(): ChatState {
  return {
    sessions: [],
    activeSessionId: null,
    model: DEFAULT_GEMINI_MODEL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAttachment(value: unknown): value is ChatAttachment {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.size === 'number'
  );
}

function isMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) && value.attachments.every(isAttachment)))
  );
}

function isSession(value: unknown): value is ChatSession {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage)
  );
}

function isChatState(value: unknown): value is ChatState {
  return (
    isRecord(value) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isSession) &&
    (typeof value.activeSessionId === 'string' || value.activeSessionId === null) &&
    typeof value.model === 'string'
  );
}

export function loadChatState(): ChatState {
  const saved = window.localStorage.getItem(CHAT_STORAGE_KEY);
  if (saved === null) return createEmptyChatState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    throw new Error('Saved chat data is not valid JSON.');
  }

  if (!isChatState(parsed)) {
    throw new Error('Saved chat data has an unsupported format.');
  }
  return parsed;
}

export function saveChatState(state: ChatState): void {
  window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state));
}
