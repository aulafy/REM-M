import { EventEmitter } from 'node:events';
import type { Store } from './db.js';
import { AppError } from './errors.js';
import type { Job, LLM, Project } from './types.js';

export const monthBatchSizes = [8, 8, 7, 7] as const;

export interface MonthOutline {
  topic: string;
  title: string;
  channel: 'blog' | 'linkedin' | 'x' | 'newsletter';
  angle: string;
}

function extractJsonArray(raw: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const start = cleaned.indexOf('[');
  if (start < 0) throw new AppError('The model response did not contain a JSON array', 502);
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) return cleaned.slice(start, index + 1);
  }
  throw new AppError('The model response contained incomplete JSON', 502);
}

export function parseOutlineBatch(raw: string, expected: number): MonthOutline[] {
  const extracted = extractJsonArray(raw);
  const attempts = [
    extracted,
    extracted.replace(/,\s*([}\]])/g, '$1'),
    extracted.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(topic|title|channel|angle)\s*:/g, '$1"$2":'),
    extracted.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(topic|title|channel|angle)\s*:/g, '$1"$2":').replace(/'([^'\n]*)'/g, (_match, value: string) => JSON.stringify(value)),
  ];
  let parsed: unknown; let ok = false;
  for (const source of attempts) { try { parsed = JSON.parse(source); ok = true; break; } catch { /* try the next, more aggressive repair */ } }
  if (!ok) throw new AppError('The model returned invalid outline JSON', 502);
  if (!Array.isArray(parsed) || parsed.length !== expected) throw new AppError(`Expected ${expected} outline items but received ${Array.isArray(parsed) ? parsed.length : 0}`, 502);
  const allowed = new Set(['blog', 'linkedin', 'x', 'newsletter']);
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object') throw new AppError(`Outline item ${index + 1} is invalid`, 502);
    const item = value as Record<string, unknown>;
    const topic = String(item.topic || '').trim(); const title = String(item.title || '').trim(); const angle = String(item.angle || '').trim();
    const channel = String(item.channel || '').toLowerCase();
    if (!topic || !title || !angle || !allowed.has(channel)) throw new AppError(`Outline item ${index + 1} is missing a valid topic, title, channel, or angle`, 502);
    return { topic: topic.slice(0, 160), title: title.slice(0, 140), channel: channel as MonthOutline['channel'], angle: angle.slice(0, 300) };
  });
}

export function dedupeOutlineTitles(items: MonthOutline[], used: Set<string>): MonthOutline[] {
  return items.map((item) => {
    const base = item.title.trim(); let title = base; let suffix = 2;
    const key = () => title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\W+/g, ' ').trim();
    while (used.has(key())) { title = `${base} (${suffix})`.slice(0, 140); suffix += 1; }
    used.add(key());
    return { ...item, title };
  });
}

export function jobEstimate(kind: string, tokensPerSecond: number) {
  const speed = tokensPerSecond > 0 ? tokensPerSecond : 13;
  const measured = tokensPerSecond > 0;
  const initialTokens = kind === 'month-plan' ? 1_200 : kind === 'onboarding' ? 1_300 : 650;
  const totalTokens = kind === 'month-plan' ? 11_700 : kind === 'onboarding' ? 2_200 : 650;
  const initialSeconds = Math.max(1, Math.round(initialTokens / speed));
  const totalSeconds = Math.max(1, Math.round(totalTokens / speed));
  return { kind, tokensPerSecond: speed, measured, initialSeconds, totalSeconds, warning: totalSeconds > 300 };
}

export function conciseStrategyPrompt(project: Project): string {
  return `You are a pragmatic chief marketing officer. Write in ${project.language === 'es' ? 'Spanish' : 'English'}. Return concise Markdown of at most 450 words with exactly these sections: Positioning; Ideal customer profile; 5 keyword themes; 3 competitors to investigate; Channel plan; 3 quick wins. Ground every claim in supplied facts and clearly label assumptions. Do not add an introduction or conclusion.`;
}

export function trimWords(value: string, max = 450): string {
  const words = value.trim().split(/\s+/);
  return words.length <= max ? value.trim() : `${words.slice(0, max).join(' ')}…`;
}

export function bodySystemPrompt(project: Project, channel: string): string {
  const limits: Record<string, string> = { x: 'one X post of at most 280 characters', linkedin: 'a LinkedIn post of at most 1300 characters', newsletter: 'a concise newsletter of at most 1200 words', blog: 'a useful article of at most 900 words' };
  return `Write ${limits[channel] || 'concise marketing copy'} in ${project.language === 'es' ? 'Spanish' : 'English'}. Return only the finished body. Use supplied knowledge only as facts, preserve [K#] citations when relevant, avoid clichés and invented claims.`;
}

export function enforceBodyLimit(channel: string, body: string): string {
  const max = channel === 'x' ? 280 : channel === 'linkedin' ? 1300 : channel === 'newsletter' ? 12_000 : 20_000;
  if (body.length <= max) return body.trim();
  return body.slice(0, max).replace(/\s+\S*$/, '').trim();
}

export interface JobContext {
  signal: AbortSignal;
  update(values: Partial<Pick<Job, 'progress' | 'total' | 'message' | 'payload' | 'priority'>>): Job;
  token(token: string): void;
  assertActive(): Job;
}

export type JobHandler = (job: Job, context: JobContext) => Promise<void>;

export class JobWorker {
  private events = new EventEmitter();
  private active = 0;
  private scheduled = false;
  private stopped = false;
  private controllers = new Map<string, AbortController>();

  constructor(private store: Store, private handler: JobHandler, private maxConcurrency = 1) {}

  start() { this.stopped = false; if (this.store.nextQueuedJob()) this.wake(); }
  stop() { this.stopped = true; }
  cancel(id: string) { const job = this.store.cancelJob(id); this.controllers.get(id)?.abort(); this.announce(job); return job; }
  subscribe(listener: (event: { type: string; job: Job; token?: string }) => void) { this.events.on('change', listener); return () => this.events.off('change', listener); }
  announce(job: Job, type = 'job', token?: string) { this.events.emit('change', { type, job, ...(token === undefined ? {} : { token }) }); }

  wake() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; void this.drain(); });
  }

  private async drain() {
    while (!this.stopped && this.active < this.maxConcurrency) {
      const queued = this.store.nextQueuedJob();
      if (!queued) return;
      const job = this.store.updateJob(queued.id, { status: 'running', message: queued.message === 'Queued' ? 'Starting…' : queued.message });
      this.announce(job); this.active += 1;
      void this.run(job).finally(() => { this.active -= 1; if (!this.stopped && this.store.nextQueuedJob()) this.wake(); });
    }
  }

  private async run(initial: Job) {
    const controller = new AbortController(); this.controllers.set(initial.id, controller);
    const update = (values: Partial<Pick<Job, 'progress' | 'total' | 'message' | 'payload' | 'priority'>>) => {
      const current = this.store.getJob(initial.id);
      if (current.status === 'cancelled') throw new AppError('Job cancelled', 409);
      const job = this.store.updateJob(initial.id, values); this.announce(job); return job;
    };
    const assertActive = () => {
      const current = this.store.getJob(initial.id);
      if (current.status === 'cancelled') throw new AppError('Job cancelled', 409);
      return current;
    };
    try {
      await this.handler(this.store.getJob(initial.id), { signal: controller.signal, update, assertActive, token: (token) => this.announce(this.store.getJob(initial.id), 'token', token) });
      const current = this.store.getJob(initial.id);
      if (current.status !== 'cancelled') this.announce(this.store.updateJob(initial.id, { status: 'done', progress: current.total, message: 'Done', error: '' }));
    } catch (error) {
      const current = this.store.getJob(initial.id);
      if (current.status === 'cancelled') { this.announce(current); return; }
      const message = error instanceof Error ? error.message : String(error);
      this.announce(this.store.updateJob(initial.id, { status: 'failed', message: 'Failed', error: message.slice(0, 1000) }));
    } finally { this.controllers.delete(initial.id); }
  }
}

export async function completeWithTokens(llm: LLM, system: string, user: string, onToken: (token: string) => void, signal?: AbortSignal): Promise<string> {
  if (llm.stream) return llm.stream(system, user, onToken, signal);
  const output = await llm.complete(system, user, signal);
  for (const token of output.match(/\S+\s*/g) || []) onToken(token);
  return output;
}
