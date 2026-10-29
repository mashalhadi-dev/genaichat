import type { GeminiUsage } from '@/lib/gemini';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface SystemLog {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface MonitoringSnapshot {
  updatedAt: string;
  rateLimit: {
    limit: number;
    used: number;
    remaining: number;
    windowEndsAt: string;
    resetInMs: number;
  };
  usage: {
    promptTokens: number;
    candidateTokens: number;
    successfulRequests: number;
    failedRequests: number;
    model: string;
    contextWindowTokens: number | null;
  };
  logs: SystemLog[];
}

interface MonitoringState {
  windowStartedAt: number;
  requestsInWindow: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  candidateTokens: number;
  activeModel: string;
  logs: SystemLog[];
}

const WINDOW_MS = 60 * 60 * 1_000;
const MAX_LOGS = 100;
const DEFAULT_REQUEST_LIMIT = 60;
const globalMonitoring = globalThis as typeof globalThis & {
  __cinematicAiMonitoring?: MonitoringState;
};

function getRequestLimit(): number {
  const configured = Number(process.env.RATE_LIMIT_MAX_REQUESTS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_REQUEST_LIMIT;
}

function getState(): MonitoringState {
  if (!globalMonitoring.__cinematicAiMonitoring) {
    globalMonitoring.__cinematicAiMonitoring = {
      windowStartedAt: Date.now(),
      requestsInWindow: 0,
      successfulRequests: 0,
      failedRequests: 0,
      promptTokens: 0,
      candidateTokens: 0,
      activeModel: 'gemini-3.8-flash',
      logs: [],
    };
  }
  return globalMonitoring.__cinematicAiMonitoring;
}

function refreshWindow(state: MonitoringState, now: number): void {
  if (now - state.windowStartedAt >= WINDOW_MS) {
    state.windowStartedAt = now;
    state.requestsInWindow = 0;
  }
}

function addLog(level: LogLevel, message: string): void {
  const state = getState();
  state.logs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
  });
  state.logs.length = Math.min(state.logs.length, MAX_LOGS);
}

export function consumeRequest(model: string): boolean {
  const state = getState();
  const now = Date.now();
  refreshWindow(state, now);

  if (state.requestsInWindow >= getRequestLimit()) {
    addLog('warning', 'Application rate limit reached; request was rejected.');
    return false;
  }

  state.requestsInWindow += 1;
  state.activeModel = model;
  addLog('info', `Generation request accepted for ${model}.`);
  return true;
}

export function recordRetry(status?: number, timedOut = false): void {
  const reason = timedOut
    ? 'timeout'
    : status === 429
      ? 'upstream rate limit'
      : `HTTP ${status ?? 'error'}`;
  addLog('warning', `Retrying Gemini request after ${reason}.`);
}

export function recordSuccess(model: string, usage: GeminiUsage): void {
  const state = getState();
  state.successfulRequests += 1;
  state.promptTokens += usage.promptTokens;
  state.candidateTokens += usage.candidateTokens;
  state.activeModel = model;
  addLog('success', `Gemini generation completed for ${model}.`);
}

export function recordFailure(message: string): void {
  getState().failedRequests += 1;
  addLog('error', message);
}

export function recordRateLimitWarning(): void {
  addLog('warning', 'Gemini returned HTTP 429; retrying with exponential backoff.');
}

export function recordModelFallback(model: string, status?: number, timedOut = false): void {
  getState().activeModel = model;
  const reason = timedOut ? 'after a timeout' : `after HTTP ${status ?? 'error'}`;
  addLog('warning', `Falling back to ${model} ${reason}.`);
}

function getContextWindow(model: string): number | null {
  if (/^gemini-(?:3\.[568]|2\.5)/i.test(model)) return 1_048_576;
  return null;
}

export function getMonitoringSnapshot(): MonitoringSnapshot {
  const state = getState();
  const now = Date.now();
  refreshWindow(state, now);
  const limit = getRequestLimit();
  const windowEndsAt = state.windowStartedAt + WINDOW_MS;

  return {
    updatedAt: new Date(now).toISOString(),
    rateLimit: {
      limit,
      used: state.requestsInWindow,
      remaining: Math.max(0, limit - state.requestsInWindow),
      windowEndsAt: new Date(windowEndsAt).toISOString(),
      resetInMs: Math.max(0, windowEndsAt - now),
    },
    usage: {
      promptTokens: state.promptTokens,
      candidateTokens: state.candidateTokens,
      successfulRequests: state.successfulRequests,
      failedRequests: state.failedRequests,
      model: state.activeModel,
      contextWindowTokens: getContextWindow(state.activeModel),
    },
    logs: [...state.logs],
  };
}
