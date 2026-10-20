import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { Connector, Draft, Project, PublishResult } from './types.js';

function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'draft';
}

async function requireOk(response: Response, name: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new AppError(`${name} returned HTTP ${response.status}: ${text.slice(0, 500)}`, 502);
  try { return JSON.parse(text); } catch { return { response: text.slice(0, 500) }; }
}

class MarkdownConnector implements Connector {
  id = 'markdown';
  name = 'Markdown export';
  configured = true;
  constructor(private directory: string) {}
  async publish(draft: Draft, project: Project): Promise<PublishResult> {
    await fs.mkdir(this.directory, { recursive: true });
    const filename = `${new Date().toISOString().slice(0, 10)}-${slugify(draft.title)}-${draft.id.slice(0, 8)}.md`;
    const destination = path.join(this.directory, filename);
    const frontmatter = `---\ntitle: ${JSON.stringify(draft.title)}\nproject: ${JSON.stringify(project.name)}\nchannel: ${JSON.stringify(draft.channel)}\ndate: ${JSON.stringify(new Date().toISOString())}\n---\n\n`;
    await fs.writeFile(destination, frontmatter + draft.body + '\n', { flag: 'wx' });
    return { path: destination };
  }
}

class WordPressConnector implements Connector {
  id = 'wordpress';
  name = 'WordPress';
  configured: boolean;
  constructor(private options: Config['wordpress'], private fetcher: typeof fetch) {
    this.configured = Boolean(options.url && options.username && options.password);
  }
  async publish(draft: Draft): Promise<PublishResult> {
    if (!this.configured) throw new AppError('WordPress connector is not configured', 400);
    const response = await this.fetcher(`${this.options.url}/wp-json/wp/v2/posts`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}` },
      body: JSON.stringify({ title: draft.title, content: draft.body, status: 'publish' }), signal: AbortSignal.timeout(30_000),
    });
    const data = await requireOk(response, 'WordPress') as { id?: number; link?: string };
    return { id: data.id, url: data.link };
  }
}

class GitHubConnector implements Connector {
  id = 'github';
  name = 'GitHub';
  configured: boolean;
  constructor(private options: Config['github'], private fetcher: typeof fetch) {
    this.configured = Boolean(options.token && /^[^/]+\/[^/]+$/.test(options.repo));
  }
  async publish(draft: Draft, project: Project): Promise<PublishResult> {
    if (!this.configured) throw new AppError('GitHub connector is not configured', 400);
    const filePath = `content/${new Date().toISOString().slice(0, 10)}-${slugify(draft.title)}.md`;
    const content = `---\ntitle: ${JSON.stringify(draft.title)}\nproject: ${JSON.stringify(project.name)}\n---\n\n${draft.body}\n`;
    const endpoint = `https://api.github.com/repos/${this.options.repo}/contents/${filePath}`;
    const response = await this.fetcher(endpoint, {
      method: 'PUT', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ message: `Publish ${draft.title}`, content: Buffer.from(content).toString('base64'), branch: this.options.branch }), signal: AbortSignal.timeout(30_000),
    });
    const data = await requireOk(response, 'GitHub') as { content?: { html_url?: string; path?: string } };
    return { url: data.content?.html_url, path: data.content?.path || filePath };
  }
}

class WebhookConnector implements Connector {
  id = 'webhook';
  name = 'Webhook';
  configured: boolean;
  constructor(private options: Config['webhook'], private fetcher: typeof fetch) { this.configured = Boolean(options.url); }
  async publish(draft: Draft, project: Project): Promise<PublishResult> {
    if (!this.configured) throw new AppError('Webhook connector is not configured', 400);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.secret) headers.authorization = `Bearer ${this.options.secret}`;
    const response = await this.fetcher(this.options.url, { method: 'POST', headers, body: JSON.stringify({ event: 'draft.published', draft, project }), signal: AbortSignal.timeout(30_000) });
    return await requireOk(response, 'Webhook') as PublishResult;
  }
}

export function createConnectors(config: Config, fetcher: typeof fetch = fetch): Connector[] {
  return [new MarkdownConnector(config.markdownExportDir), new WordPressConnector(config.wordpress, fetcher), new GitHubConnector(config.github, fetcher), new WebhookConnector(config.webhook, fetcher)];
}
