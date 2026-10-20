import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  markdownExportDir: string;
  wordpress: { url: string; username: string; password: string };
  github: { token: string; repo: string; branch: string };
  webhook: { url: string; secret: string };
  telegram: { botToken: string; chatId: string };
  discord: { webhookUrl: string };
  allowPrivateFetch: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    llmBaseUrl: (env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
    llmApiKey: env.LLM_API_KEY || 'ollama',
    llmModel: env.LLM_MODEL || 'llama3.2',
    markdownExportDir: path.resolve(env.MARKDOWN_EXPORT_DIR || './exports'),
    wordpress: {
      url: (env.WP_URL || '').replace(/\/$/, ''),
      username: env.WP_USERNAME || '',
      password: env.WP_APP_PASSWORD || '',
    },
    github: {
      token: env.GITHUB_TOKEN || '',
      repo: env.GITHUB_REPO || '',
      branch: env.GITHUB_BRANCH || 'main',
    },
    webhook: { url: env.WEBHOOK_URL || '', secret: env.WEBHOOK_SECRET || '' },
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },
    discord: { webhookUrl: env.DISCORD_WEBHOOK_URL || '' },
    allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === '1',
  };
}
