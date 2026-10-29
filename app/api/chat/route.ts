import type { Content } from '@google/genai';

import {
  DEFAULT_GEMINI_MODEL,
  getGeminiErrorStatus,
  isGeminiTimeout,
  streamGeminiWithFallback,
} from '@/lib/gemini';
import type { GeminiStreamEvent } from '@/lib/gemini';
import {
  consumeRequest,
  recordFailure,
  recordModelFallback,
  recordRateLimitWarning,
  recordRetry,
  recordSuccess,
} from '@/lib/monitoring';

export const runtime = 'nodejs';
export const maxDuration = 150;

const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_HISTORY_MESSAGES = 20;
const MAX_PROMPT_LENGTH = 12_000;
const MODEL_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

const MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
};

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { role?: unknown; content?: unknown };
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.length <= MAX_PROMPT_LENGTH
  );
}

function getFileMimeType(file: File): string | null {
  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (!extension) return null;

  const expectedType = MIME_TYPES[extension];
  if (!expectedType) return null;
  if (file.type && file.type !== expectedType && file.type !== 'application/octet-stream') {
    return null;
  }
  return expectedType;
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return jsonError('Request is too large. Keep the total upload under 24 MB.', 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError('Expected a multipart form request.', 400);
  }

  const prompt = formData.get('prompt');
  const requestedModel = formData.get('model');
  const model =
    typeof requestedModel === 'string' && requestedModel.length > 0
      ? requestedModel
      : DEFAULT_GEMINI_MODEL;
  if (!MODEL_PATTERN.test(model)) {
    return jsonError('The selected model name is invalid.', 400);
  }
  if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) {
    return jsonError(`Prompt must be no longer than ${MAX_PROMPT_LENGTH} characters.`, 400);
  }

  const files = formData.getAll('files');
  if (files.length > MAX_FILES || files.some((entry) => !(entry instanceof File))) {
    return jsonError(`Attach up to ${MAX_FILES} supported files.`, 400);
  }
  const uploads = files.filter((entry): entry is File => entry instanceof File);
  if (!prompt.trim() && uploads.length === 0) {
    return jsonError('Enter a message or attach a file.', 400);
  }

  let totalFileBytes = 0;
  const typedFiles: Array<{ file: File; mimeType: string }> = [];
  for (const file of uploads) {
    const mimeType = getFileMimeType(file);
    if (!mimeType) {
      return jsonError(
        'Supported formats: PNG, JPEG, PDF, TXT, Markdown, CSV, and JSON.',
        415,
      );
    }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      return jsonError('Each file must be between 1 byte and 8 MB.', 413);
    }
    totalFileBytes += file.size;
    typedFiles.push({ file, mimeType });
  }
  if (totalFileBytes > MAX_REQUEST_BYTES) {
    return jsonError('The combined upload size must be under 24 MB.', 413);
  }

  let history: unknown;
  try {
    history = JSON.parse(String(formData.get('history') ?? '[]'));
  } catch {
    return jsonError('Chat history must be valid JSON.', 400);
  }
  if (
    !Array.isArray(history) ||
    history.length > MAX_HISTORY_MESSAGES ||
    !history.every(isHistoryMessage)
  ) {
    return jsonError('Chat history is invalid or too long.', 400);
  }

  if (!consumeRequest(model)) {
    return jsonError(
      'The application request limit has been reached. Try again after it resets.',
      429,
    );
  }

  const contents: Content[] = history.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
  const parts: NonNullable<Content['parts']> = [];
  if (prompt.trim()) parts.push({ text: prompt });
  for (const { file, mimeType } of typedFiles) {
    parts.push({
      inlineData: {
        mimeType,
        data: Buffer.from(await file.arrayBuffer()).toString('base64'),
      },
    });
  }
  contents.push({ role: 'user', parts });

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let iterator: AsyncGenerator<GeminiStreamEvent> | undefined;
  let effectiveModel = model;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      function send(event: GeminiStreamEvent | { type: 'error'; error: string; status: number }): void {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }

      try {
        iterator ??= streamGeminiWithFallback(contents, model, {
          onRetry: (retryEvent) => recordRetry(retryEvent.status, retryEvent.timedOut),
          signal: abortController.signal,
        });
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }

        const event = result.value;
        if (event.type === 'retry') {
          if (event.status === 429) recordRateLimitWarning();
        } else if (event.type === 'fallback') {
          effectiveModel = event.fallbackModel;
          recordModelFallback(effectiveModel, event.status, event.timedOut);
        } else if (event.type === 'done') {
          recordSuccess(effectiveModel, event.usage);
        }
        send(event);
      } catch (error: unknown) {
        if (controller.desiredSize === null) return;

        const status = getGeminiErrorStatus(error);
        const timedOut = isGeminiTimeout(error);
        const errorMessage =
          error instanceof Error ? error.message : 'Gemini threw a non-Error value.';
        console.error('[Chat API] Gemini request failed', {
          model: effectiveModel,
          status,
          message: errorMessage,
          error,
        });
        const isConfigurationError =
          error instanceof Error && error.message.startsWith('Set GOOGLE_GENAI_API_KEY');
        const publicMessage = isConfigurationError
          ? 'Gemini is not configured. Set a server-side Gemini API key.'
          : timedOut
            ? 'The Gemini request timed out. Please try again.'
            : status === 429
              ? 'Gemini is rate limiting requests. Please try again shortly.'
              : status === 404
                ? `Gemini model "${effectiveModel}" is unavailable. Check the model ID and API access.`
                : status === 403
                  ? 'The Gemini API key does not have permission to use this model.'
              : status !== undefined && status >= 500
                ? 'The Gemini service is temporarily unavailable.'
                : 'Gemini could not complete this request.';
        recordFailure(timedOut ? 'Gemini request timed out.' : publicMessage);
        send({
          type: 'error',
          error: publicMessage,
          status: isConfigurationError ? 503 : timedOut ? 504 : (status ?? 502),
        });
        controller.close();
      }
    },
    cancel(reason) {
      abortController.abort(reason);
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}
