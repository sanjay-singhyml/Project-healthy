import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import {
  createAIClient,
  MODEL,
  MAX_TOKENS,
  TEMPERATURE,
} from "../ai-client.js";

export interface ChatRequest {
  messages: ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/**
 * Enforce the 60k token guard.
 * Truncates message content from the front if total exceeds limit.
 */
export function enforceTokenGuard(
  messages: ChatCompletionMessageParam[],
  maxChars: number = 60_000 * 4,
): { messages: ChatCompletionMessageParam[]; truncated: boolean } {
  let totalChars = 0;
  let truncated = false;

  const guarded = messages.map((msg) => {
    if (typeof msg.content === "string") {
      if (totalChars + msg.content.length > maxChars) {
        const remaining = maxChars - totalChars;
        truncated = true;
        if (remaining > 100) {
          totalChars = maxChars;
          return {
            ...msg,
            content:
              msg.content.slice(0, remaining) +
              "\n...[truncated for token limit]...",
          };
        }
        totalChars = maxChars;
        return { ...msg, content: "[truncated]" };
      }
      totalChars += msg.content.length;
    }
    return msg;
  });

  return { messages: guarded, truncated };
}

/**
 * Execute a chat completion (streaming or non-streaming).
 */
export async function executeChat(
  req: ChatRequest,
  apiKey: string,
): Promise<{
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
}> {
  const client = createAIClient(apiKey);
  const { messages } = enforceTokenGuard(req.messages);
  const model = req.model || MODEL;

  return { client, model, messages };
}

export function buildChatParams(
  model: string,
  messages: ChatCompletionMessageParam[],
  overrides?: { temperature?: number; max_tokens?: number },
): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model,
    messages,
    temperature: overrides?.temperature ?? TEMPERATURE,
    max_tokens: overrides?.max_tokens ?? MAX_TOKENS,
  };
}
