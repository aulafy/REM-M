import { AppError } from './errors.js';
import type { LLM } from './types.js';

export class OpenAICompatibleLLM implements LLM {
  private usage: { tokensIn: number; tokensOut: number } | null = null;
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private fetcher: typeof fetch = fetch,
    private timeoutMs = 300_000,
  ) {}

  private requestBody(system: string, user: string, stream = false) {
    return JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3, reasoning_effort: process.env.LLM_REASONING_EFFORT || 'none', ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) });
  }

  private async request(system: string, user: string, stream = false, signal?: AbortSignal): Promise<Response> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: this.requestBody(system, user, stream), signal: signal ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new AppError(`LLM returned ${response.status}: ${(await response.text()).slice(0, 500)}`, 502);
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const hint = /localhost|127\.0\.0\.1/.test(this.baseUrl) ? ' Is Ollama running? Start it with "ollama serve" and make sure the configured model is installed.' : '';
      throw new AppError(`LLM request failed: ${error instanceof Error ? error.message : String(error)}.${hint}`, 502);
    }
  }

  async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(system, user, false, signal);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    this.usage = payload.usage ? { tokensIn: Number(payload.usage.prompt_tokens || 0), tokensOut: Number(payload.usage.completion_tokens || 0) } : null;
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new AppError('LLM returned no content', 502);
    return content;
  }

  async stream(system: string, user: string, onToken: (token: string) => void, signal?: AbortSignal): Promise<string> {
    const response = await this.request(system, user, true, signal);
    if (!response.body) throw new AppError('LLM returned no response stream', 502);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let output = ''; let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; if (done && buffer) { lines.push(buffer); buffer = ''; }
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue;
        let payload: { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try { payload = JSON.parse(raw); } catch { continue; }
        if (payload.usage) usage = payload.usage;
        const token = payload.choices?.[0]?.delta?.content || payload.choices?.[0]?.message?.content || '';
        if (token) { output += token; onToken(token); }
      }
      if (done) break;
    }
    if (!output.trim()) throw new AppError('LLM returned no content', 502);
    this.usage = usage ? { tokensIn: Number(usage.prompt_tokens || 0), tokensOut: Number(usage.completion_tokens || 0) } : { tokensIn: Math.ceil((system.length + user.length) / 4), tokensOut: Math.ceil(output.length / 4) };
    return output.trim();
  }

  takeUsage() { const usage = this.usage; this.usage = null; return usage; }

  async test(): Promise<string> {
    return this.complete('Reply with exactly: OK', 'Connection test');
  }
}
