import type { Store } from './db.js';
import type { Draft, GeoHistory, HealthHistory, Project, SearchOpportunity } from './types.js';

const DAY_MS = 86_400_000;

function clampDays(value: number): number {
  return [7, 30, 90].includes(value) ? value : 30;
}

function issueCount(health: HealthHistory | undefined, drafts: Draft[]): number {
  const latestSeo = drafts.find((draft) => draft.agentId === 'seo');
  const audit = latestSeo?.metadata.audit as { issues?: unknown[] } | undefined;
  if (Array.isArray(audit?.issues)) return audit.issues.length;
  return Array.isArray(health?.report.issues) ? health.report.issues.length : 0;
}

function trend<T extends { score: number }>(items: T[]): number {
  return items.length > 1 ? items.at(-1)!.score - items.at(-2)!.score : 0;
}

function countBy<T>(items: T[], key: (item: T) => string): Array<{ name: string; value: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) || 0) + 1);
  return [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function buildProjectAnalytics(input: {
  project: Project;
  drafts: Draft[];
  health: HealthHistory[];
  geo: GeoHistory[];
  opportunities: SearchOpportunity[];
  llm: ReturnType<Store['llmStats']>;
  days?: number;
  now?: Date;
}) {
  const days = clampDays(Number(input.days));
  const now = input.now || new Date();
  const since = now.getTime() - days * DAY_MS;
  const inRange = (value: string) => Date.parse(value) >= since;
  const draftsInRange = input.drafts.filter((draft) => inRange(draft.createdAt));
  const publishedInRange = input.drafts.filter((draft) => draft.status === 'published' && inRange(draft.updatedAt));
  const latestHealth = input.health.at(-1);
  const latestGeo = input.geo.at(-1);
  const reviewed = input.drafts.filter((draft) => ['approved', 'rejected', 'published'].includes(draft.status));
  const accepted = reviewed.filter((draft) => ['approved', 'published'].includes(draft.status)).length;

  const contentDays = new Map<string, { created: number; published: number }>();
  for (let offset = Math.min(days, 31) - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    contentDays.set(day, { created: 0, published: 0 });
  }
  for (const draft of draftsInRange) {
    const item = contentDays.get(draft.createdAt.slice(0, 10));
    if (item) item.created += 1;
  }
  for (const draft of publishedInRange) {
    const item = contentDays.get(draft.updatedAt.slice(0, 10));
    if (item) item.published += 1;
  }

  return {
    project: { id: input.project.id, name: input.project.name },
    rangeDays: days,
    generatedAt: now.toISOString(),
    summary: {
      healthScore: latestHealth?.score ?? null,
      healthTrend: trend(input.health),
      geoScore: latestGeo?.score ?? null,
      geoTrend: trend(input.geo),
      seoIssuesOpen: issueCount(latestHealth, input.drafts),
      opportunities: input.opportunities.length,
      contentCreated: draftsInRange.length,
      published: publishedInRange.length,
      approvalRate: reviewed.length ? Math.round((accepted / reviewed.length) * 100) : null,
    },
    series: {
      health: input.health.filter((item) => inRange(item.createdAt)).map((item) => ({ at: item.createdAt, value: item.score })),
      geo: input.geo.filter((item) => inRange(item.createdAt)).map((item) => ({ at: item.createdAt, value: item.score })),
      content: [...contentDays].map(([at, values]) => ({ at, ...values })),
      llmLatency: input.llm.recent.filter((item) => inRange(item.at)).reverse().map((item) => ({ at: item.at, value: item.ms, status: item.status, purpose: item.purpose })),
    },
    distribution: {
      statuses: countBy(input.drafts, (draft) => draft.status),
      channels: countBy(draftsInRange, (draft) => draft.channel || 'other').slice(0, 8),
    },
    operations: {
      calls24h: input.llm.calls24h,
      errors24h: input.llm.errors24h,
      avgMs: input.llm.avgMs,
      tokens24h: input.llm.tokens24h,
      tokensPerSecond: input.llm.tokensPerSecond,
    },
  };
}

function prometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metric(lines: string[], help: string, name: string, samples: Array<{ labels?: Record<string, string>; value: number }>) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const sample of samples) {
    const labels = sample.labels && Object.keys(sample.labels).length
      ? `{${Object.entries(sample.labels).map(([key, value]) => `${key}="${prometheusLabel(value)}"`).join(',')}}`
      : '';
    lines.push(`${name}${labels} ${Number.isFinite(sample.value) ? sample.value : 0}`);
  }
}

export function prometheusMetrics(store: Store): string {
  const lines: string[] = [];
  const projects = store.listProjects();
  const rows = projects.map((project) => {
    const drafts = store.listDrafts(project.id);
    const health = store.listHealthHistory(project.id).at(-1);
    const geo = store.listGeoHistory(project.id).at(-1);
    return { project, drafts, health, geo, opportunities: store.listSearchOpportunities(project.id) };
  });
  const labels = (project: Project) => ({ project_id: project.id, project: project.name });

  metric(lines, 'Latest deterministic website health score from 0 to 100.', 'opencmo_site_health_score', rows.map((row) => ({ labels: labels(row.project), value: row.health?.score ?? 0 })));
  metric(lines, 'Latest directional AI visibility score from 0 to 100.', 'opencmo_ai_visibility_score', rows.map((row) => ({ labels: labels(row.project), value: row.geo?.score ?? 0 })));
  metric(lines, 'Open SEO issues in the latest available audit.', 'opencmo_seo_issues_open', rows.map((row) => ({ labels: labels(row.project), value: issueCount(row.health, row.drafts) })));
  metric(lines, 'Search Console opportunities currently stored.', 'opencmo_search_opportunities', rows.map((row) => ({ labels: labels(row.project), value: row.opportunities.length })));

  for (const status of ['pending', 'approved', 'rejected', 'published']) {
    metric(lines, `Drafts currently in ${status} status.`, `opencmo_drafts_${status}`, rows.map((row) => ({ labels: labels(row.project), value: row.drafts.filter((draft) => draft.status === status).length })));
  }

  const llm = store.llmStats();
  metric(lines, 'Observed LLM calls in the last 24 hours.', 'opencmo_llm_calls_24h', [{ value: llm.calls24h }]);
  metric(lines, 'Observed failed LLM calls in the last 24 hours.', 'opencmo_llm_errors_24h', [{ value: llm.errors24h }]);
  metric(lines, 'Observed LLM tokens in the last 24 hours.', 'opencmo_llm_tokens_24h', [{ value: llm.tokens24h }]);
  metric(lines, 'Average successful LLM call duration in milliseconds.', 'opencmo_llm_average_duration_ms', [{ value: llm.avgMs }]);
  metric(lines, 'Rolling observed LLM output throughput.', 'opencmo_llm_tokens_per_second', [{ value: llm.tokensPerSecond }]);
  return `${lines.join('\n')}\n`;
}
