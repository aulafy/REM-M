import type { Draft, Project } from './types.js';
import type { SeoAudit } from './web.js';

export interface SiteHealth {
  score: number;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  issues: string[];
}

export function normalizeProjectUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    const port = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80') ? '' : url.port;
    return `${url.hostname}${port ? `:${port}` : ''}${url.pathname}`;
  } catch { return value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
}

export function siteHealthFromAudit(audit: SeoAudit): SiteHealth {
  const checks = [
    { label: 'Page title', ok: Boolean(audit.title && audit.titleLength >= 30 && audit.titleLength <= 60), detail: audit.title || 'Missing' },
    { label: 'Meta description', ok: Boolean(audit.metaDescription && audit.metaDescription.length >= 70 && audit.metaDescription.length <= 160), detail: audit.metaDescription || 'Missing' },
    { label: 'One clear H1', ok: audit.h1.length === 1, detail: `${audit.h1.length} found` },
    { label: 'Image alt text', ok: audit.missingAlt === 0, detail: `${audit.missingAlt} missing` },
    { label: 'Canonical URL', ok: Boolean(audit.canonical), detail: audit.canonical || 'Missing' },
    { label: 'Social sharing tags', ok: Boolean(audit.openGraph.title && audit.openGraph.description && audit.openGraph.image), detail: 'Open Graph title, description and image' },
    { label: 'Page language', ok: Boolean(audit.htmlLang), detail: audit.htmlLang || 'Missing' },
    { label: 'Structured data', ok: audit.hasJsonLd, detail: audit.hasJsonLd ? `${audit.jsonLdCount} block(s)` : 'Missing' },
    { label: 'robots.txt', ok: audit.hasRobotsTxt === true, detail: audit.hasRobotsTxt ? 'Found' : 'Missing' },
    { label: 'Sitemap', ok: audit.hasSitemap === true, detail: audit.hasSitemap ? 'Found' : 'Missing' },
    { label: 'Working internal links', ok: audit.brokenInternalLinks.length === 0, detail: `${audit.brokenInternalLinks.length} broken` },
  ];
  return { score: Math.round(checks.filter((check) => check.ok).length / checks.length * 100), checks, issues: [...audit.issues, ...audit.warnings] };
}

export const channelLimits: Record<string, { max: number; label: string; perPart?: number }> = {
  x: { max: 1400, perPart: 280, label: 'X thread (5 × 280)' },
  linkedin: { max: 1300, label: 'LinkedIn' },
  'meta-description': { max: 155, label: 'Meta description' },
  reddit: { max: 10_000, label: 'Reddit' },
  'reddit-copy': { max: 10_000, label: 'Reddit' },
  newsletter: { max: 12_000, label: 'Newsletter' },
};

const cliches = [
  /in today'?s (?:fast[- ]paced|digital) (?:world|landscape)/gi,
  /game[- ]changer/gi, /unlock (?:the )?(?:power|potential)/gi, /revolutioni[sz]e/gi,
  /take .+ to the next level/gi, /delve into/gi, /it'?s important to note/gi,
  /ever[- ]evolving/gi, /seamless(?:ly)?/gi, /cutting[- ]edge/gi, /leverage/gi,
  /transformative journey/gi, /whether you'?re .+ or .+/gi,
];

function xParts(body: string): string[] {
  const numbered = body.split(/\n(?=\s*\d+[.)]\s)/).map((part) => part.trim()).filter(Boolean);
  return numbered.length > 1 ? numbered : [body.trim()];
}

export function draftQuality(channel: string, body: string) {
  const limit = channelLimits[channel];
  const violations: string[] = [];
  if (limit && body.length > limit.max) violations.push(`${limit.label} limit is ${limit.max} characters (${body.length} used)`);
  if (channel === 'x') {
    const parts = xParts(body);
    if (parts.length > 5) violations.push(`X threads can contain at most 5 posts (${parts.length} found)`);
    parts.forEach((part, index) => { if (part.length > 280) violations.push(`X post ${index + 1} is ${part.length}/280 characters`); });
  }
  const phrases = [...new Set(cliches.flatMap((pattern) => [...body.matchAll(pattern)].map((match) => match[0])))];
  return { count: body.length, limit: limit?.max || null, label: limit?.label || null, violations, cliches: phrases };
}

export function starterDrafts(project: Pick<Project, 'name' | 'description' | 'audience' | 'language'>, raw: string): Array<{ channel: string; title: string; body: string; metadata: Record<string, unknown> }> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { parsed = null; }
  const list = Array.isArray(parsed) ? parsed : [];
  const channels = ['blog', 'linkedin', 'x', 'newsletter', 'meta-description'];
  const fallback = project.language === 'es'
    ? [
      ['La guía que nuestros clientes necesitan', `Una guía práctica de ${project.name} para ${project.audience || 'sus futuros clientes'}.`],
      [`Lo que aprendimos construyendo ${project.name}`, `${project.description || project.name}\n\nTres decisiones prácticas que pueden ayudar a nuestro público.`],
      [`Una idea útil de ${project.name}`, `${project.name}: una idea concreta para ayudar a ${project.audience || 'equipos como el tuyo'}.`],
      [`Noticias de ${project.name}`, `Asunto: Una idea útil para esta semana\n\nUn consejo práctico, una novedad y el siguiente paso.`],
      [`${project.name}: una forma más clara de avanzar`, `${project.name} ayuda a ${project.audience || 'pequeños equipos'} con un enfoque claro y práctico.`],
    ] : [
      ['The guide our customers need', `A practical ${project.name} guide for ${project.audience || 'future customers'}.`],
      [`What we learned building ${project.name}`, `${project.description || project.name}\n\nThree practical decisions that can help our audience.`],
      [`One useful idea from ${project.name}`, `${project.name}: one concrete idea to help ${project.audience || 'teams like yours'}.`],
      [`News from ${project.name}`, `Subject: One useful idea for this week\n\nOne practical tip, one update, and one next step.`],
      [`${project.name}: a clearer way forward`, `${project.name} helps ${project.audience || 'small teams'} with a clear, practical approach.`],
    ];
  return channels.map((channel, index) => {
    const item = list[index] && typeof list[index] === 'object' ? list[index] as Record<string, unknown> : {};
    return { channel, title: String(item.title || fallback[index][0]).slice(0, 140), body: String(item.body || fallback[index][1]), metadata: { starter: true, angle: String(item.angle || '') } };
  });
}

export function monthPlan(project: Project, raw: string, start = new Date()): Array<{ channel: string; title: string; body: string; metadata: Record<string, unknown> }> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { parsed = null; }
  const input = Array.isArray(parsed) ? parsed : [];
  const channels = ['blog', 'linkedin', 'x', 'newsletter'];
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(start); date.setDate(date.getDate() + index); date.setHours(9 + index % 8, 0, 0, 0);
    const candidate = input[index] && typeof input[index] === 'object' ? input[index] as Record<string, unknown> : {};
    const channel = channels.includes(String(candidate.channel)) ? String(candidate.channel) : channels[index % channels.length];
    const angle = String(candidate.angle || (project.language === 'es' ? 'Consejo práctico basado en la estrategia' : 'Practical strategy-led advice'));
    const title = String(candidate.title || candidate.topic || `${project.name}: ${angle}`).slice(0, 140);
    const body = String(candidate.body || (project.language === 'es' ? `${angle}\n\nBorrador inicial para revisar y completar.` : `${angle}\n\nStarter draft to review and complete.`));
    return { channel, title, body, metadata: { monthlyPlan: true, plannedAt: date.toISOString(), angle } };
  });
}

export function dashboardActions(project: Project, drafts: Draft[], geoDates: string[], language: 'en' | 'es') {
  const es = language === 'es'; const actions: Array<{ priority: number; title: string; detail: string; tab: string; label: string }> = [];
  const latestSeo = drafts.find((draft) => draft.agentId === 'seo');
  const issues = ((latestSeo?.metadata.audit as { issues?: unknown[] } | undefined)?.issues || []).length;
  if (issues) actions.push({ priority: 100, title: es ? `Corrige ${issues} problemas del sitio` : `Fix ${issues} website issues`, detail: es ? 'Empieza por los problemas con mayor impacto.' : 'Start with the highest-impact findings.', tab: 'agents', label: es ? 'Ver auditoría' : 'View audit' });
  const pending = drafts.filter((draft) => draft.status === 'pending').length;
  if (pending) actions.push({ priority: 90, title: es ? `Revisa ${pending} borradores` : `Review ${pending} drafts`, detail: es ? 'Nada se publica sin tu aprobación.' : 'Nothing publishes without your approval.', tab: 'inbox', label: es ? 'Revisar' : 'Review' });
  const nextWeek = Date.now() + 7 * 86_400_000;
  const plannedDays = new Set(drafts.map((draft) => draft.scheduledAt || String(draft.metadata.plannedAt || '')).filter((date) => date && Date.parse(date) < nextWeek).map((date) => date.slice(0, 10))).size;
  if (plannedDays < 4) actions.push({ priority: 80, title: es ? 'Llena los huecos de tu calendario' : 'Fill the gaps in your calendar', detail: es ? `${7 - plannedDays} días sin contenido esta semana.` : `${7 - plannedDays} days have no content this week.`, tab: 'calendar', label: es ? 'Generar el mes' : 'Generate my month' });
  const lastGeo = geoDates.at(-1); if (!lastGeo || Date.now() - Date.parse(lastGeo) > 14 * 86_400_000) actions.push({ priority: 70, title: es ? 'Comprueba si la IA menciona tu marca' : 'Check whether AI mentions your brand', detail: es ? 'La comprobación de visibilidad está pendiente o desactualizada.' : 'Your visibility check is missing or stale.', tab: 'agents', label: es ? 'Comprobar' : 'Run check' });
  if (!project.strategy) actions.push({ priority: 110, title: es ? 'Crea tu estrategia' : 'Build your strategy', detail: es ? 'Convierte los datos del sitio en un plan claro.' : 'Turn your website facts into a clear plan.', tab: 'strategy', label: es ? 'Crear estrategia' : 'Build strategy' });
  return actions.sort((a, b) => b.priority - a.priority).slice(0, 3);
}
