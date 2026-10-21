import { AppError } from './errors.js';
import { fuzzyMention } from './agents.js';
import type { Project } from './types.js';

export interface VisibilityProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  site: string;
  section: string;
  prefix: string;
  searches: boolean;
  webSearchTool?: boolean;
}

// Assistants that search the live web and return the sources they used. A plain chat model answers from memory and
// knows nothing about most small businesses, so it would say "not mentioned" even when real people can find you.
export const VISIBILITY_PROVIDERS: VisibilityProvider[] = [
  { id: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', model: 'sonar', site: 'perplexity.ai', section: 'Settings → API', prefix: 'pplx-', searches: true },
  { id: 'openrouter', name: 'OpenRouter (web search)', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', site: 'openrouter.ai', section: 'Keys', prefix: 'sk-or-', searches: true, webSearchTool: true },
  { id: 'openai', name: 'OpenAI web search', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-search-preview', site: 'platform.openai.com', section: 'API keys', prefix: 'sk-', searches: true },
];

export interface AssistantAnswer { answer: string; citations: string[] }
export interface VisibilityCheck {
  question: string; answer: string; brandAppears: boolean; competitors: string[];
  mentioned: boolean; domainCited: boolean; citedDomains: string[];
}

const hostOf = (value: string): string => { try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };

export function extractCitations(payload: unknown): string[] {
  const data = payload as { citations?: unknown; search_results?: Array<{ url?: string }>; choices?: Array<{ message?: { annotations?: Array<{ url_citation?: { url?: string }; url?: string }> } }> };
  const urls: string[] = [];
  if (Array.isArray(data?.citations)) for (const item of data.citations) { if (typeof item === 'string') urls.push(item); else if (item && typeof (item as { url?: string }).url === 'string') urls.push((item as { url: string }).url); }
  if (Array.isArray(data?.search_results)) for (const item of data.search_results) if (typeof item?.url === 'string') urls.push(item.url);
  for (const annotation of data?.choices?.[0]?.message?.annotations || []) { const url = annotation.url_citation?.url || annotation.url; if (typeof url === 'string') urls.push(url); }
  return [...new Set(urls)].slice(0, 20);
}

function linksInAnswer(answer: string): string[] {
  const links = [...answer.matchAll(/https?:\/\/[^\s)\]}>,]+/gi)].map((match) => match[0].replace(/[.!?:;]+$/, ''));
  return [...new Set(links)].slice(0, 20);
}

export function analyzeAnswer(project: Pick<Project, 'name' | 'url' | 'competitors'>, question: string, result: AssistantAnswer): VisibilityCheck {
  const projectHost = hostOf(project.url || '');
  const citedDomains = [...new Set(result.citations.map(hostOf).filter(Boolean))];
  const domainCited = !!projectHost && citedDomains.some((host) => host === projectHost || host.endsWith(`.${projectHost}`));
  const mentioned = fuzzyMention(result.answer, project.name) || (!!projectHost && result.answer.toLowerCase().includes(projectHost));
  const competitors = (project.competitors || []).flatMap((value) => {
    const host = hostOf(value); const shortHost = host.split('.')[0]?.replace(/[-_]+/g, ' ') || '';
    const appears = fuzzyMention(result.answer, value) || (!!host && result.answer.toLowerCase().includes(host)) || (shortHost.length > 2 && fuzzyMention(result.answer, shortHost));
    return appears ? [host.includes('.') ? host : value] : [];
  });
  return { question, answer: result.answer, mentioned, domainCited, brandAppears: mentioned || domainCited, citedDomains: citedDomains.slice(0, 6), competitors: [...new Set(competitors)] };
}

export function fallbackQuestions(project: Pick<Project, 'name' | 'description' | 'language'>, count = 5): string[] {
  const es = project.language === 'es'; const what = (project.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const list = es
    ? [`¿Qué empresas o plataformas recomiendas para: ${what || project.name}?`, `¿Qué es ${project.name} y merece la pena?`, `Alternativas a ${project.name}`, `Opiniones sobre ${project.name}`, `¿Cuál es la mejor opción en España para: ${what || project.name}?`, `¿Cómo elijo entre las opciones para: ${what || project.name}?`]
    : [`Which companies or platforms do you recommend for: ${what || project.name}?`, `What is ${project.name} and is it worth it?`, `Alternatives to ${project.name}`, `Reviews of ${project.name}`, `What is the best option for: ${what || project.name}?`, `How do I choose between options for: ${what || project.name}?`];
  return list.slice(0, Math.max(1, Math.min(count, list.length)));
}

export async function askAssistant(fetcher: typeof fetch, provider: Pick<VisibilityProvider, 'baseUrl' | 'model' | 'webSearchTool'>, apiKey: string, question: string, language: string, signal?: AbortSignal): Promise<AssistantAnswer> {
  const system = language === 'es' ? 'Responde de forma útil y neutral, recomendando opciones concretas con nombre cuando existan, y cita tus fuentes.' : 'Answer helpfully and neutrally, recommend concrete named options when they exist, and cite your sources.';
  const requestBody: Record<string, unknown> = { model: provider.model, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] };
  if (provider.webSearchTool) requestBody.tools = [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }];
  let response: Response;
  try {
    response = await fetcher(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(90_000), signal]) : AbortSignal.timeout(90_000),
    });
  } catch (error) { throw new AppError(`Assistant request failed: ${error instanceof Error ? error.message : String(error)}`, 502); }
  if (!response.ok) throw new AppError(`Assistant returned ${response.status}: ${(await response.text()).slice(0, 300)}`, response.status === 401 || response.status === 403 ? 401 : 502);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const answer = String(payload.choices?.[0]?.message?.content || '').trim();
  if (!answer) throw new AppError('The assistant returned no answer', 502);
  return { answer, citations: [...new Set([...extractCitations(payload), ...linksInAnswer(answer)])].slice(0, 20) };
}

export function summarizeVisibility(checks: VisibilityCheck[]) {
  const visible = checks.filter((check) => check.brandAppears).length;
  const competitorTotals = new Map<string, number>(); const sources = new Map<string, number>();
  for (const check of checks) { for (const name of check.competitors) competitorTotals.set(name, (competitorTotals.get(name) || 0) + 1); for (const host of check.citedDomains) sources.set(host, (sources.get(host) || 0) + 1); }
  const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
  return { visible, total: checks.length, percent: checks.length ? Math.round((visible / checks.length) * 100) : 0, topCompetitors: top(competitorTotals), topSources: top(sources) };
}
