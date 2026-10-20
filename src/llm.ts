import { AppError } from './errors.js';
import type { LLM } from './types.js';

export class OpenAICompatibleLLM implements LLM {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  async complete(system: string, user: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.7 }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      const hint = /localhost|127\.0\.0\.1/.test(this.baseUrl) ? ' Is Ollama running? Start it with "ollama serve" and make sure the configured model is installed.' : '';
      throw new AppError(`LLM request failed: ${error instanceof Error ? error.message : String(error)}.${hint}`, 502);
    }
    if (!response.ok) throw new AppError(`LLM returned ${response.status}: ${(await response.text()).slice(0, 500)}`, 502);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new AppError('LLM returned no content', 502);
    return content;
  }

  async test(): Promise<string> {
    return this.complete('Reply with exactly: OK', 'Connection test');
  }
}
