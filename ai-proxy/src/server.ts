import express from 'express';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { createAIClient, MODEL, MAX_TOKENS, BASE_URL } from './ai-client.js';
import type { Request, Response, NextFunction } from 'express';

config({ path: ['.env.local', '.env'] });

// Validate required environment variables
function validateEnv(): void {
  if (!process.env.MEGALLM_API_KEY) {
    console.error('MEGALLM_API_KEY is required in .env');
    process.exit(1);
  }
  
  const required = ['MEGALLM_BASE_URL', 'JWT_SECRET'];
  const missing: string[] = [];

  for (const key of required) {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error(`Error: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

validateEnv();

export const PROXY_CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET!,
  megallmApiKey: process.env.MEGALLM_API_KEY!,
  megallmBaseUrl: process.env.MEGALLM_BASE_URL || BASE_URL,
  megallmModel: process.env.MEGALLM_MODEL || MODEL,
  maxTokens: parseInt(process.env.MEGALLM_MAX_TOKENS || String(MAX_TOKENS), 10),
  temperature: parseFloat(process.env.MEGALLM_TEMPERATURE || '0.7'),
  rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '60', 10),
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow large requests for code contexts

// Rate limiting storage
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userId = req.headers['x-user-id'] as string || req.ip || 'anonymous';
  const now = Date.now();
  const windowMs = 60 * 1000;

  let userLimit = rateLimitMap.get(userId);

  if (!userLimit || now > userLimit.resetTime) {
    userLimit = { count: 0, resetTime: now + windowMs };
    rateLimitMap.set(userId, userLimit);
  }

  userLimit.count++;

  if (userLimit.count > PROXY_CONFIG.rateLimitRpm) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Maximum ${PROXY_CONFIG.rateLimitRpm} requests per minute`,
      retryAfter: Math.ceil((userLimit.resetTime - now) / 1000),
    });
    return;
  }
  next();
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, PROXY_CONFIG.jwtSecret);
    (req as any).user = decoded;
    next();
  } catch (error) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    model: PROXY_CONFIG.megallmModel,
    rateLimit: PROXY_CONFIG.rateLimitRpm,
    service: 'project-health-ai-proxy'
  });
});

app.post('/v1/chat/completions', authMiddleware, rateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    let { messages, model, temperature, max_tokens, stream } = req.body;

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'messages is required and must be an array' });
      return;
    }

    // Token Guard mechanism
    const MAX_CHARS = 60 * 1000 * 4; 
    let totalChars = 0;
    
    messages = messages.map((msg: any) => {
      if (typeof msg.content === 'string') {
        const msgChars = msg.content.length;
        if (totalChars + msgChars > MAX_CHARS) {
           const remainingChars = MAX_CHARS - totalChars;
           if (remainingChars > 100) {
             return { ...msg, content: msg.content.slice(0, remainingChars) + '\\n...[truncated]...' };
           }
        }
        totalChars += msgChars;
      }
      return msg;
    });

    const modelToUse = model || PROXY_CONFIG.megallmModel;
    const aiClient = createAIClient(PROXY_CONFIG.megallmApiKey);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const chatStream = await aiClient.chat.completions.create({
        model: modelToUse,
        messages,
        temperature: temperature ?? PROXY_CONFIG.temperature,
        max_tokens: max_tokens ?? PROXY_CONFIG.maxTokens,
        stream: true,
      });

      for await (const chunk of chatStream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const completion = await aiClient.chat.completions.create({
        model: modelToUse,
        messages,
        temperature: temperature ?? PROXY_CONFIG.temperature,
        max_tokens: max_tokens ?? PROXY_CONFIG.maxTokens,
        stream: false,
      });
      res.json(completion);
    }
  } catch (error) {
    console.error('AI request error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export function startServer(): void {
  app.listen(PROXY_CONFIG.port, () => {
    console.log(`🚀 Project Health AI Proxy started on port ${PROXY_CONFIG.port}`);
    console.log(`🔌 MegaLLM endpoint: ${PROXY_CONFIG.megallmBaseUrl}`);
    console.log(`🧠 Default model: ${PROXY_CONFIG.megallmModel}`);
    console.log(`🚦 Rate limit: ${PROXY_CONFIG.rateLimitRpm} requests/minute`);
  });
}

startServer();

export default app;
