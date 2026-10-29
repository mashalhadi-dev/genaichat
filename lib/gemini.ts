import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const FALLBACK_GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'] as const;
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
  | {
      type: 'fallback';
      requestedModel: string;
      fallbackModel: string;
      status?: number;
      timedOut: boolean;
    }
  | { type: 'done'; usage: GeminiUsage };

export interface GeminiStreamOptions {
  onRetry?: (event: GeminiRetryEvent) => void;
  maxAttempts?: number;
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

function logGeminiError(error: unknown, model: string, attempt: number): ErrorDetails {
  const details = getErrorDetails(error);
  console.error('[Gemini] Model request failed', {
    model,
    attempt,
    status: details.status,
    message: details.message,
    error,
  });
  return details;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function* streamGeminiWithRetry(
  contents: Content[],
  modelName = DEFAULT_GEMINI_MODEL,
  options: GeminiStreamOptions = {},
): AsyncGenerator<GeminiStreamEvent> {
  const maxAttempts = options.maxAttempts ?? 2;

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
      const details = logGeminiError(error, modelName, attempt);
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

export async function* streamGeminiWithFallback(
  contents: Content[],
  modelName = DEFAULT_GEMINI_MODEL,
  options: GeminiStreamOptions = {},
): AsyncGenerator<GeminiStreamEvent> {
  const requestedModel = modelName.trim() || DEFAULT_GEMINI_MODEL;
  const models = [...new Set([requestedModel, DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS])];

  for (const [index, model] of models.entries()) {
    let emittedText = false;
    try {
      for await (const event of streamGeminiWithRetry(contents, model, {
        ...options,
        maxAttempts: index === 0 ? options.maxAttempts : 1,
      })) {
        if (event.type === 'chunk') emittedText = true;
        yield event;
      }
      return;
    } catch (error: unknown) {
      const details = getErrorDetails(error);
      const hasFallback = index < models.length - 1;
      const canFallback =
        details.status === 404 ||
        details.status === 503 ||
        details.timedOut;
      if (!hasFallback || emittedText || !canFallback) throw error;

      const fallbackModel = models[index + 1];
      console.warn(
        `[Gemini] Model "${model}" failed (HTTP ${details.status ?? 'timeout'}); falling back to "${fallbackModel}".`,
      );
      yield {
        type: 'fallback',
        requestedModel: model,
        fallbackModel,
        status: details.status,
        timedOut: details.timedOut,
      };
    }
  }
}

export function getGeminiErrorStatus(error: unknown): number | undefined {
  return getErrorDetails(error).status;
}

export function isGeminiTimeout(error: unknown): boolean {
  return getErrorDetails(error).timedOut;
}
