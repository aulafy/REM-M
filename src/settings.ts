import type { Config } from './config.js';

export const settingKeys = [
  'llmBaseUrl', 'llmModel', 'llmApiKey',
  'wordpressUrl', 'wordpressUsername', 'wordpressPassword',
  'githubToken', 'githubRepo', 'githubBranch',
  'webhookUrl', 'webhookSecret',
  'telegramBotToken', 'telegramChatId', 'discordWebhookUrl',
] as const;

export const secretSettingKeys = new Set<string>(['llmApiKey', 'wordpressPassword', 'githubToken', 'webhookSecret', 'telegramBotToken']);

export function effectiveConfig(defaults: Config, settings: Record<string, string>): Config {
  const value = (key: string, fallback: string) => settings[key] ?? fallback;
  return {
    ...defaults,
    llmBaseUrl: value('llmBaseUrl', defaults.llmBaseUrl).replace(/\/$/, ''),
    llmModel: value('llmModel', defaults.llmModel),
    llmApiKey: value('llmApiKey', defaults.llmApiKey),
    wordpress: {
      url: value('wordpressUrl', defaults.wordpress.url).replace(/\/$/, ''),
      username: value('wordpressUsername', defaults.wordpress.username),
      password: value('wordpressPassword', defaults.wordpress.password),
    },
    github: {
      token: value('githubToken', defaults.github.token),
      repo: value('githubRepo', defaults.github.repo),
      branch: value('githubBranch', defaults.github.branch),
    },
    webhook: { url: value('webhookUrl', defaults.webhook.url), secret: value('webhookSecret', defaults.webhook.secret) },
    telegram: { botToken: value('telegramBotToken', defaults.telegram.botToken), chatId: value('telegramChatId', defaults.telegram.chatId) },
    discord: { webhookUrl: value('discordWebhookUrl', defaults.discord.webhookUrl) },
  };
}

export function publicSettings(config: Config): Record<string, string> {
  const values: Record<string, string> = {
    llmBaseUrl: config.llmBaseUrl, llmModel: config.llmModel, llmApiKey: config.llmApiKey,
    wordpressUrl: config.wordpress.url, wordpressUsername: config.wordpress.username, wordpressPassword: config.wordpress.password,
    githubToken: config.github.token, githubRepo: config.github.repo, githubBranch: config.github.branch,
    webhookUrl: config.webhook.url, webhookSecret: config.webhook.secret,
    telegramBotToken: config.telegram.botToken, telegramChatId: config.telegram.chatId, discordWebhookUrl: config.discord.webhookUrl,
  };
  for (const key of secretSettingKeys) values[key] = values[key] ? (values[key].length <= 4 ? '••••' : `••••${values[key].slice(-4)}`) : '';
  return values;
}
