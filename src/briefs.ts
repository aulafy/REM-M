import type { Store } from './db.js';

export function buildBrief(store: Store, projectId: string, period: 'morning' | 'evening', at = new Date()) {
  const project = store.getProject(projectId); const facts = store.briefingFacts(projectId, at);
  const spanish = project.language === 'es';
  if (period === 'morning') return {
    channel: 'briefing', title: spanish ? `Resumen de la mañana — ${at.toISOString().slice(0, 10)}` : `Morning brief — ${at.toISOString().slice(0, 10)}`,
    body: spanish ? `# Resumen de la mañana\n\n- Pendientes de aprobación: ${facts.pending}\n- Programados para hoy: ${facts.scheduledToday}\n- Cambio GEO: ${facts.geoChange >= 0 ? '+' : ''}${facts.geoChange} puntos\n- Incidencias SEO abiertas: ${facts.seoIssuesOpen}` : `# Morning brief\n\n- Pending approval: ${facts.pending}\n- Scheduled today: ${facts.scheduledToday}\n- GEO trend: ${facts.geoChange >= 0 ? '+' : ''}${facts.geoChange} points\n- Open SEO issues: ${facts.seoIssuesOpen}`,
    metadata: { period, facts, readOnly: true },
  };
  return {
    channel: 'briefing', title: spanish ? `Resumen de la tarde — ${at.toISOString().slice(0, 10)}` : `Evening brief — ${at.toISOString().slice(0, 10)}`,
    body: spanish ? `# Resumen de la tarde\n\n- Publicados hoy: ${facts.publishedToday}\n- Programados para mañana: ${facts.scheduledTomorrow}` : `# Evening brief\n\n- Published today: ${facts.publishedToday}\n- Scheduled tomorrow: ${facts.scheduledTomorrow}`,
    metadata: { period, facts, readOnly: true },
  };
}

export function briefIsDue(settings: Record<string, string>, period: 'morning' | 'evening', now = new Date()) {
  const enabled = settings.briefsEnabled !== '0'; if (!enabled) return false;
  const localDay = now.toLocaleDateString('sv-SE'); if (settings[`briefLast${period}`] === localDay) return false;
  const [hour, minute] = (settings[`${period}BriefTime`] || (period === 'morning' ? '08:00' : '18:00')).split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
}
