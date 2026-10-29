import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_TIMEOUT_MS = 30_000;

export interface GeminiUsage {
  promptTokens: number;
  candidateTokens: number;
}

export interface GeminiResult {
  text: string;
  usage: GeminiUsage;
}

export interface GeminiRetryEvent {
  attempt: number;
  status?: number;
  timedOut: boolean;
  delayMs: number;
}

export type GeminiStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'retry'; attempt: number; status?: number; timedOut: boolean; delayMs: number }
  | { type: 'done'; usage: GeminiUsage };

export interface GeminiStreamOptions {
  onRetry?: (event: GeminiRetryEvent) => void;
}

interface ErrorDetails {
  message: string;
  status?: number;
  timedOut: boolean;
}

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (client) return client;

  const apiKey = process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY on the server.');
  }

  client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: GEMINI_TIMEOUT_MS,
      retryOptions: { attempts: 1 },
    },
  });
  return client;
}

function getErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    const candidate = error as Error & { status?: unknown; statusCode?: unknown };
    const statusValue = candidate.status ?? candidate.statusCode;
    const status =
      typeof statusValue === 'number'
        ? statusValue
        : typeof statusValue === 'string' && /^\d+$/.test(statusValue)
          ? Number(statusValue)
          : undefined;
    const message = error.message || 'The Gemini request failed.';
    const timedOut =
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      /timeout|timed out|deadline exceeded/i.test(message);

    return { message, status, timedOut };
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
    const statusValue = candidate.status ?? candidate.statusCode;
    const status =
      typeof statusValue === 'number'
        ? statusValue
        : typeof statusValue === 'string' && /^\d+$/.test(statusValue)
          ? Number(statusValue)
          : undefined;
    const message =
      typeof candidate.message === 'string' ? candidate.message : 'The Gemini request failed.';

    return {
      message,
      status,
      timedOut: /timeout|timed out|deadline exceeded/i.test(message),
    };
  }

  return {
    message: typeof error === 'string' ? error : 'The Gemini request failed.',
    timedOut: false,
  };
}

function isRetryable(error: ErrorDetails): boolean {
  return (
    error.timedOut ||
    error.status === 408 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function* streamGeminiWithRetry(
  contents: Content[],
  modelName = DEFAULT_GEMINI_MODEL,
  options: GeminiStreamOptions = {},
): AsyncGenerator<GeminiStreamEvent> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let emittedText = false;
    let usage: GeminiUsage = { promptTokens: 0, candidateTokens: 0 };
    try {
      const response = await getClient().models.generateContentStream({
        model: modelName,
        contents,
      });

      for await (const chunk of response) {
        if (chunk.usageMetadata) {
          usage = {
            promptTokens: chunk.usageMetadata.promptTokenCount ?? usage.promptTokens,
            candidateTokens:
              chunk.usageMetadata.candidatesTokenCount ?? usage.candidateTokens,
          };
        }

        const text = chunk.text;
        if (text) {
          emittedText = true;
          yield { type: 'chunk', text };
        }
      }

      yield { type: 'done', usage };
      return;
    } catch (error: unknown) {
      const details = getErrorDetails(error);
      if (attempt === maxAttempts || emittedText || !isRetryable(details)) {
        throw error;
      }

      const baseDelay = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
      const retryEvent: GeminiRetryEvent = {
        attempt,
        status: details.status,
        timedOut: details.timedOut,
        delayMs: baseDelay + Math.floor(Math.random() * 250),
      };
      options.onRetry?.(retryEvent);
      yield { type: 'retry', ...retryEvent };
      await wait(retryEvent.delayMs);
    }
  }

  throw new Error('Gemini retry loop ended unexpectedly.');
}

export function getGeminiErrorStatus(error: unknown): number | undefined {
  return getErrorDetails(error).status;
}

export function isGeminiTimeout(error: unknown): boolean {
  return getErrorDetails(error).timedOut;
}
