// Main entry point for project-health CLI
// Exports types and utilities for external use

// Re-export types
export * from './types/index.js';

// Re-export utilities
export * from './utils/output.js';

// Re-export cache
export { CacheManager, createCacheManager, checkCacheExists, initCache } from './cache/index.js';

// Re-export config
export { ConfigManager, createConfigManager, generateConfigContent, configExists } from './config/index.js';

// Re-export modules
export * from './modules/index.js';

// Re-export AI client
export * from './proxy/ai-client.js';

// Re-export auth
export * from './auth/index.js';

// Re-export context packer
export * from './context/index.js';

// Re-export orchestrator
export * from './orchestrator.js';

// Re-export scorer (specific exports to avoid duplicate)
export { calculateHealthScore, generateTopActions, DEFAULT_WEIGHTS } from './scorer.js';

// Package version
export const VERSION = '2.0.0';
export const BINARY_NAME = 'ph';
