import OpenAI from 'openai';
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'] });

// Get model from environment
export const MODEL = process.env.MEGALLM_MODEL || 'openai-gpt-oss-20b';

// Base URL for MegaLLM
export const BASE_URL = process.env.MEGALLM_BASE_URL || 'https://ai.megallm.io/v1';

// Timeout configuration
const TIMEOUT_MS = parseInt(process.env.MEGALLM_TIMEOUT || '60000', 10);

export const MAX_TOKENS = parseInt(process.env.MEGALLM_MAX_TOKENS || '60000', 10);

// Create AI client instance specifically for the proxy utilizing a real API key
export const createAIClient = (apiKey: string): OpenAI => {
  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    timeout: TIMEOUT_MS,
    maxRetries: 2,
  });
};
