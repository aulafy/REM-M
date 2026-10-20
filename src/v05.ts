import type { Draft, GeoHistory, HealthHistory, Project, SearchOpportunity } from './types.js';
import type { SeoAudit } from './web.js';

export interface ParsedSearchQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function csvRows(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); if (row.some((value) => value.trim())) rows.push(row); row = []; field = ''; }
    else field += char;
  }
  row.push(field.replace(/\r$/, '')); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function numberValue(value: string): number {
  const cleaned = value.trim().replace(/\s/g, '').replace(/%$/, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '');
  const number = Number(cleaned); return Number.isFinite(number) ? number : 0;
}

export function parseGscQueriesCsv(csv: string): ParsedSearchQuery[] {
  const rows = csvRows(csv); if (rows.length < 2) return [];
  const headers = rows[0].map(normalizedHeader);
  const find = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const indexes = {
    query: find('query', 'queries', 'consulta', 'consultas'), clicks: find('clicks', 'clics'),
    impressions: find('impressions', 'impresiones'), ctr: find('ctr'), position: find('position', 'posicion'),
  };
  if (Object.values(indexes).some((index) => index < 0)) throw new Error('CSV must include Query/Consulta, Clicks/Clics, Impressions/Impresiones, CTR, and Position/Posición');
  return rows.slice(1).flatMap((values) => {
    const query = (values[indexes.query] || '').trim(); if (!query) return [];
    const ctrRaw = values[indexes.ctr] || ''; const ctrNumber = numberValue(ctrRaw);
    return [{ query, clicks: numberValue(values[indexes.clicks] || ''), impressions: numberValue(values[indexes.impressions] || ''), ctr: ctrRaw.includes('%') ? ctrNumber / 100 : ctrNumber, position: numberValue(values[indexes.position] || '') }];
  });
}

export function findSearchOpportunities(rows: ParsedSearchQuery[]): Array<Omit<SearchOpportunity, 'id' | 'projectId' | 'createdAt'>> {
  const eligible = rows.filter((row) => row.position >= 8 && row.position <= 30 && row.impressions > 0);
  const impressions = eligible.map((row) => row.impressions).sort((a, b) => a - b);
  const median = impressions.length ? impressions[Math.floor((impressions.length - 1) / 2)] : 0;
  const highThreshold = Math.max(10, median);
  return eligible.filter((row) => row.impressions >= highThreshold && row.ctr < 0.05).map((row) => ({
    ...row, score: Math.round(row.impressions * (1 - Math.min(1, row.ctr)) * (31 - row.position) * 100) / 100,
  })).sort((a, b) => b.score - a.score || b.impressions - a.impressions).slice(0, 100);
}

export interface CompetitorMetric {
  url: string; title: 'good' | 'weak' | 'missing'; meta: 'good' | 'weak' | 'missing'; headings: number;
  schema: boolean; openGraph: number; htmlBytes: number;
}

export function competitorMetric(audit: SeoAudit): CompetitorMetric {
  const title = !audit.title ? 'missing' : audit.titleLength >= 30 && audit.titleLength <= 60 ? 'good' : 'weak';
  const metaLength = audit.metaDescription?.length || 0;
  const meta = !audit.metaDescription ? 'missing' : metaLength >= 70 && metaLength <= 160 ? 'good' : 'weak';
  return { url: audit.url, title, meta, headings: audit.h1.length, schema: audit.hasJsonLd, openGraph: [audit.openGraph.title, audit.openGraph.description, audit.openGraph.image].filter(Boolean).length, htmlBytes: audit.htmlBytes || 0 };
}

export function whereCompetitorsBeatYou(yours: CompetitorMetric, competitors: CompetitorMetric[]): Array<{ url: string; advantages: string[] }> {
  const quality = { missing: 0, weak: 1, good: 2 };
  return competitors.map((item) => {
    const advantages: string[] = [];
    if (quality[item.title] > quality[yours.title]) advantages.push('title');
    if (quality[item.meta] > quality[yours.meta]) advantages.push('meta description');
    if (Math.abs(item.headings - 1) < Math.abs(yours.headings - 1)) advantages.push('H1 structure');
    if (item.schema && !yours.schema) advantages.push('structured data');
    if (item.openGraph > yours.openGraph) advantages.push('social sharing tags');
    if (item.htmlBytes > 0 && yours.htmlBytes > 0 && item.htmlBytes < yours.htmlBytes * 0.8) advantages.push('lighter HTML');
    return { url: item.url, advantages };
  }).filter((item) => item.advantages.length);
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function issueAdvice(issue: string, es: boolean): { impact: string; fix: string } {
  const value = issue.toLowerCase();
  if (value.includes('meta')) return es ? { impact: 'La página puede atraer menos clics desde buscadores.', fix: 'Escribe una descripción clara de 70–160 caracteres.' } : { impact: 'The page may earn fewer search clicks.', fix: 'Write a clear 70–160 character description.' };
  if (value.includes('title')) return es ? { impact: 'Buscadores y lectores entienden peor la página.', fix: 'Usa un título único y descriptivo de 30–60 caracteres.' } : { impact: 'Search engines and readers may misunderstand the page.', fix: 'Use a unique, descriptive 30–60 character title.' };
  if (value.includes('schema') || value.includes('json')) return es ? { impact: 'Los buscadores tienen menos contexto estructurado.', fix: 'Añade datos estructurados JSON-LD relevantes.' } : { impact: 'Search engines have less structured context.', fix: 'Add relevant JSON-LD structured data.' };
  if (value.includes('sitemap') || value.includes('robots')) return es ? { impact: 'Los buscadores pueden descubrir peor el sitio.', fix: 'Publica el archivo indicado y enlázalo correctamente.' } : { impact: 'Search engines may have trouble discovering the site.', fix: 'Publish the named file and link it correctly.' };
  return es ? { impact: 'Puede reducir la claridad o la capacidad de descubrimiento.', fix: 'Revisa el hallazgo y corrige primero las páginas más importantes.' } : { impact: 'This can reduce clarity or discoverability.', fix: 'Review the finding and fix the highest-value pages first.' };
}

export function buildClientReport(input: {
  project: Project; health: HealthHistory | null; geo: GeoHistory | null; drafts: Draft[]; opportunities: SearchOpportunity[];
  branding: Record<string, string>; generatedAt?: Date;
}): string {
  const { project, health, geo, drafts, opportunities, branding } = input; const es = project.language === 'es';
  const accent = /^#[0-9a-f]{6}$/i.test(branding.brandingAccentColor || '') ? branding.brandingAccentColor : '#176a46';
  const agency = branding.brandingAgencyName?.trim() || (es ? 'Informe de marketing' : 'Marketing report');
  const logo = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(branding.brandingLogoData || '') ? `<img class="logo" alt="" src="${branding.brandingLogoData}">` : '';
  const issues = Array.isArray(health?.report.issues) ? health!.report.issues.map(String).slice(0, 12) : [];
  const plan = drafts.filter((draft) => draft.metadata.plannedAt || draft.scheduledAt).sort((a, b) => String(a.scheduledAt || a.metadata.plannedAt).localeCompare(String(b.scheduledAt || b.metadata.plannedAt))).slice(0, 30);
  const top = opportunities.slice(0, 8);
  const summary = es
    ? `${project.name} tiene una salud web de ${health?.score ?? '—'}/100, una visibilidad en IA de ${geo?.score ?? '—'}% y ${drafts.filter((draft) => draft.status === 'pending').length} borradores pendientes de revisión.`
    : `${project.name} has a website health score of ${health?.score ?? '—'}/100, AI visibility of ${geo?.score ?? '—'}%, and ${drafts.filter((draft) => draft.status === 'pending').length} drafts awaiting review.`;
  const issueRows = issues.length ? issues.map((issue) => { const advice = issueAdvice(issue, es); return `<tr><td>${escapeHtml(issue)}</td><td>${escapeHtml(advice.impact)}</td><td>${escapeHtml(advice.fix)}</td></tr>`; }).join('') : `<tr><td colspan="3">${es ? 'No hay problemas registrados.' : 'No recorded issues.'}</td></tr>`;
  const opportunityRows = top.length ? top.map((item) => `<tr><td>${escapeHtml(item.query)}</td><td>${item.impressions.toLocaleString()}</td><td>${(item.ctr * 100).toFixed(1)}%</td><td>${item.position.toFixed(1)}</td></tr>`).join('') : `<tr><td colspan="4">${es ? 'Importa consultas de Search Console para ver oportunidades.' : 'Import Search Console queries to identify opportunities.'}</td></tr>`;
  const planRows = plan.length ? plan.map((draft) => `<tr><td>${escapeHtml(new Date(draft.scheduledAt || String(draft.metadata.plannedAt)).toLocaleDateString(project.language || 'en'))}</td><td>${escapeHtml(draft.channel)}</td><td>${escapeHtml(draft.title)}</td><td>${escapeHtml(draft.status)}</td></tr>`).join('') : `<tr><td colspan="4">${es ? 'Genera un plan mensual para completar esta sección.' : 'Generate a monthly plan to fill this section.'}</td></tr>`;
  const nextSteps = [...issues.slice(0, 3).map((issue) => issueAdvice(issue, es).fix), ...(top.length ? [es ? `Crear contenido para “${top[0].query}”.` : `Create content for “${top[0].query}”.`] : []), es ? 'Revisar y aprobar los mejores borradores; nada se publica automáticamente.' : 'Review and approve the strongest drafts; nothing publishes automatically.'].slice(0, 5);
  const labels = es ? { report: 'Informe de marketing', executive: 'Resumen ejecutivo', health: 'Salud del sitio', finding: 'Hallazgo', impact: 'Impacto', fix: 'Cómo corregirlo', geo: 'Visibilidad en IA', appeared: 'apariciones', opportunities: 'Oportunidades principales', query: 'Consulta', impressions: 'Impresiones', position: 'Posición', plan: 'Plan de 30 días', date: 'Fecha', channel: 'Canal', title: 'Título', status: 'Estado', next: 'Próximos pasos', generated: 'Generado' } : { report: 'Marketing report', executive: 'Executive summary', health: 'Website health', finding: 'Finding', impact: 'Plain-language impact', fix: 'How to fix it', geo: 'AI visibility', appeared: 'mentions', opportunities: 'Top opportunities', query: 'Query', impressions: 'Impressions', position: 'Position', plan: '30-day plan', date: 'Date', channel: 'Channel', title: 'Title', status: 'Status', next: 'Next steps', generated: 'Generated' };
  return `<!doctype html><html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(project.name)} — ${labels.report}</title><style>:root{--accent:${accent};--ink:#18201b;--muted:#627069;--line:#dce4df}*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,sans-serif;color:var(--ink)}main{max-width:980px;margin:auto;padding:52px}.cover{min-height:70vh;display:flex;flex-direction:column;justify-content:center;border-bottom:8px solid var(--accent);page-break-after:always}.logo{max-width:180px;max-height:90px;object-fit:contain;margin-bottom:30px}.kicker{color:var(--accent);font-weight:800;text-transform:uppercase;letter-spacing:.12em}h1{font-size:56px;line-height:1.05;margin:.2em 0}h2{margin-top:42px;border-bottom:2px solid var(--accent);padding-bottom:8px}h3{color:var(--accent)}.score{font-size:46px;font-weight:800;color:var(--accent)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid var(--line);border-radius:10px;padding:20px}table{width:100%;border-collapse:collapse;margin:12px 0 28px;font-size:13px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px;vertical-align:top}th{background:#f3f7f4;color:#435149}footer{margin-top:50px;color:var(--muted);font-size:12px}@media(max-width:650px){main{padding:24px}.grid{grid-template-columns:1fr}h1{font-size:38px}}@media print{@page{margin:14mm}main{max-width:none;padding:0}.cover{min-height:245mm}.no-break,table{break-inside:avoid}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><main><section class="cover">${logo}<p class="kicker">${escapeHtml(agency)}</p><h1>${escapeHtml(project.name)}</h1><p>${labels.report}</p><p>${labels.generated}: ${escapeHtml((input.generatedAt || new Date()).toLocaleDateString(project.language || 'en'))}</p></section><section><h2>${labels.executive}</h2><p>${escapeHtml(summary)}</p><div class="grid"><div class="card"><h3>${labels.health}</h3><div class="score">${health?.score ?? '—'}<small>/100</small></div></div><div class="card"><h3>${labels.geo}</h3><div class="score">${geo?.score ?? '—'}<small>%</small></div><p>${geo ? `${geo.visible}/${geo.total} ${labels.appeared}` : '—'}</p></div></div><h2>${labels.health}</h2><table><thead><tr><th>${labels.finding}</th><th>${labels.impact}</th><th>${labels.fix}</th></tr></thead><tbody>${issueRows}</tbody></table><h2>${labels.opportunities}</h2><table><thead><tr><th>${labels.query}</th><th>${labels.impressions}</th><th>CTR</th><th>${labels.position}</th></tr></thead><tbody>${opportunityRows}</tbody></table><h2>${labels.plan}</h2><table><thead><tr><th>${labels.date}</th><th>${labels.channel}</th><th>${labels.title}</th><th>${labels.status}</th></tr></thead><tbody>${planRows}</tbody></table><h2>${labels.next}</h2><ol>${nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></section><footer>${branding.brandingPoweredBy === '1' ? 'Powered by OpenCMO · ' : ''}${escapeHtml(agency)}</footer></main></body></html>`;
}
