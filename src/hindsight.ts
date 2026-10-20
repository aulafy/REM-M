export class HindsightMemory {
  constructor(private settings: () => Record<string, string>, private fetcher: typeof fetch = fetch) {}
  enabled() { return this.settings().hindsightEnabled === '1'; }
  private base() { return (this.settings().hindsightUrl || 'http://127.0.0.1:8888').replace(/\/$/, ''); }
  async recall(query: string): Promise<string[]> {
    if (!this.enabled()) return [];
    try {
      const response = await this.fetcher(`${this.base()}/v1/default/banks/opencmo/memories/recall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: query.slice(0, 1000), budget: 'low', max_tokens: 500 }), signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return [];
      const payload = await response.json() as { results?: Array<{ text?: string; content?: string }> };
      return (payload.results || []).map((item) => String(item.text || item.content || '').trim()).filter(Boolean).slice(0, 6);
    } catch { return []; }
  }
  async retain(content: string) {
    if (!this.enabled() || !content.trim()) return false;
    try {
      const response = await this.fetcher(`${this.base()}/v1/default/banks/opencmo/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ async: true, items: [{ content: content.slice(0, 4000), tags: ['brand'] }] }), signal: AbortSignal.timeout(8_000) });
      return response.ok;
    } catch { return false; }
  }
}
