import { AppError } from './errors.js';
import type { Store } from './db.js';
import type { LLM } from './types.js';

export class ObservedLLM implements LLM {
  constructor(private inner: LLM, private store: Store, private purpose: string, private model: string) {}
  async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    return this.observe(system, user, () => this.inner.complete(system, user, signal));
  }
  async stream(system: string, user: string, onToken: (token: string) => void, signal?: AbortSignal): Promise<string> {
    return this.observe(system, user, async () => {
      if (this.inner.stream) return this.inner.stream(system, user, onToken, signal);
      const output = await this.inner.complete(system, user, signal);
      for (const token of output.match(/\S+\s*/g) || []) onToken(token);
      return output;
    });
  }
  private async observe(system: string, user: string, operation: () => Promise<string>): Promise<string> {
    const settings = this.store.getSettings();
    const configuredCap = Number(settings.llm_max_per_hour || settings.llmMaxPerHour || 60);
    const cap = Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : 60;
    if (this.store.countLlmCallsSince(new Date(Date.now() - 3_600_000).toISOString()) >= cap) throw new AppError('Hourly LLM call limit reached', 429);
    const started = Date.now();
    try {
      const output = await operation();
      const usage = (this.inner as LLM & { takeUsage?: () => { tokensIn: number; tokensOut: number } | null }).takeUsage?.();
      this.store.recordLlmCall({ purpose: this.purpose, model: this.model, ms: Date.now() - started, tokensIn: usage?.tokensIn ?? Math.ceil((system.length + user.length) / 4), tokensOut: usage?.tokensOut ?? Math.ceil(output.length / 4), status: 'ok' });
      return output;
    } catch (error) {
      this.store.recordLlmCall({ purpose: this.purpose, model: this.model, ms: Date.now() - started, tokensIn: Math.ceil((system.length + user.length) / 4), tokensOut: 0, status: 'error', error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      throw error;
    }
  }
}
