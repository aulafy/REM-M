import { renderMarkdown } from './markdown.js';
import { plainText, reviewOrder, dropDuplicateTitle, computeSteps, charStatus, formatDuration, friendlyError, translate, channelKey, PROVIDERS } from './guided-core.js';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } },
};
let lang = store.get('ocmo_lang') || 'es';
const tr = (key, vars) => translate(lang, key, vars);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (selector, root = document) => root.querySelector(selector);

const state = { settings: null, ollama: null, projects: [], project: null, drafts: [], jobs: [], open: null, aiChoice: null, reviewIdx: 0, notice: {}, busy: {}, editing: false, provider: 'openai', signature: '' };

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text(); let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.data = data; error.status = response.status; throw error; }
  return data;
}

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
}

function pickProject(projects) {
  const real = projects.filter((p) => !p.isDemo); const list = real.length ? real : projects;
  return list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

async function loadAll() {
  const [settings, projects, ollama] = await Promise.all([
    api('/api/settings').catch(() => ({ settings: {} })), api('/api/projects').catch(() => ({ projects: [] })), api('/api/engines/ollama').catch(() => ({ available: false, models: [] })),
  ]);
  state.settings = settings.settings || {}; state.projects = projects.projects || []; state.ollama = ollama; state.project = pickProject(state.projects);
  await refreshProjectData();
}

async function refreshProjectData() {
  if (!state.project) { state.drafts = []; state.jobs = []; return; }
  const [drafts, jobs] = await Promise.all([api(`/api/drafts?project=${state.project.id}`).catch(() => ({ drafts: [] })), api(`/api/jobs?project=${state.project.id}`).catch(() => ({ jobs: [] }))]);
  state.drafts = drafts.drafts || []; state.jobs = jobs.jobs || [];
  const fresh = await api('/api/projects').catch(() => null);
  if (fresh) { state.projects = fresh.projects; state.project = fresh.projects.find((p) => p.id === state.project.id) || state.project; }
}

const isWritten = (draft) => !draft.metadata?.needsBody && draft.channel !== 'briefing' && draft.status !== 'rejected';
const activeJobs = () => state.jobs.filter((job) => job.status === 'running' || job.status === 'queued');

function facts() {
  const project = state.project; const id = project?.id;
  const drafts = state.drafts;
  return {
    aiOk: store.get('ocmo_ai_ok') === '1' || !!project?.isDemo || store.get('ocmo_demo') === '1',
    project, understood: !!project && (store.get(`ocmo_und_${id}`) === '1' || !!project.isDemo),
    draftsWithBody: drafts.filter(isWritten).length,
    approvedCount: drafts.filter((d) => d.status === 'approved' || d.status === 'published').length,
    publishedOrScheduled: drafts.some((d) => d.status === 'published' || d.scheduledAt),
    copied: !!project && store.get(`ocmo_copied_${id}`) === '1',
    monthPlanStarted: state.jobs.some((job) => job.kind === 'month-plan' && job.status !== 'failed' && job.status !== 'cancelled') || (!state.jobs.some((job) => job.kind === 'month-plan') && drafts.some((d) => d.metadata?.monthlyPlan)),
    monthSkipped: !!project && store.get(`ocmo_month_skip_${id}`) === '1',
  };
}

function helpBtn(key) { return `<button type="button" class="help-btn" data-help="${key}" aria-label="${esc(tr('top.help'))}">?</button>`; }
function errorBox(stepId) {
  const entry = state.notice[stepId]; if (!entry) return '';
  if (entry.kind === 'wait') return `<div class="notice wait"><span class="spin"></span> ${esc(entry.message)}</div>`;
  if (entry.kind === 'ok') return `<div class="notice ok">${esc(entry.message)}</div>`;
  return `<div class="notice bad">${esc(entry.message)}${entry.details ? `<details><summary>${esc(tr('tech.details'))}</summary><pre>${esc(entry.details)}</pre></details>` : ''}</div>`;
}
function setNotice(stepId, notice) { if (notice) state.notice[stepId] = notice; else delete state.notice[stepId]; }
function fail(stepId, error) { const f = friendlyError(error, lang); setNotice(stepId, { kind: 'bad', message: f.message, details: f.details }); render(); }


/* ---------- step renderers ---------- */
function stepAi() {
  const ollama = state.ollama || { available: false, models: [] };
  const usable = (ollama.models || []).filter((m) => !m.small); const models = usable.length ? usable : (ollama.models || []);
  const provider = PROVIDERS[state.provider];
  const localPanel = state.aiChoice === 'local' ? `<div class="panel">${ollama.available && models.length ? `<p>${esc(tr('ai.local.found', { model: models[0].name }))}</p>
      <label for="local-model" class="sr">${esc(tr('ai.local.title'))}</label><select id="local-model">${models.map((m) => `<option>${esc(m.name)}</option>`).join('')}</select>
      <div class="row"><button class="btn" data-act="use-local">${esc(tr('btn.useThis'))}</button></div>` : `<p>${esc(tr('ai.local.missing'))}</p><p>${esc(tr('ai.local.step1'))}</p><p>${esc(tr('ai.local.step2'))}</p><code>ollama pull qwen3:8b</code><p>${esc(tr('ai.local.step3'))}</p><p class="hint">${esc(tr('ai.local.needs'))}</p><div class="row"><button class="btn secondary" data-act="check-again">${esc(tr('btn.checkAgain'))}</button></div>`}</div>` : '';
  const onlinePanel = state.aiChoice === 'online' ? `<div class="panel"><label for="provider">${esc(tr('ai.online.provider'))}</label><select id="provider">${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}" ${id === state.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <div class="how"><b>${esc(tr('ai.online.where'))}</b><br>${esc(tr('ai.online.s1', { site: provider.site }))}<br>${esc(tr('ai.online.s2', { section: provider.section }))}<br>${esc(tr('ai.online.s3', { prefix: provider.prefix }))}</div>
      <label for="api-key">${esc(tr('ai.online.key'))}</label><input id="api-key" type="password" autocomplete="off" placeholder="${esc(provider.prefix)}…" spellcheck="false" value="${esc(state.apiKey || '')}">
      <div class="row"><button class="btn" data-act="use-online">${esc(tr('btn.test'))}</button></div></div>` : '';
  return `<p>${esc(tr('ai.choose'))} ${helpBtn('h.ai')}</p>
    <div class="cards">
      <button class="choice ${state.aiChoice === 'local' ? 'open' : ''}" data-act="choose-local"><h4>${esc(tr('ai.local.title'))}${ollama.available && models.length ? `<span class="badge">${esc(tr('ai.recommended'))}</span>` : ''}</h4><small>${esc(ollama.available && models.length ? tr('ai.local.found', { model: models[0].name }) : tr('ai.local.needs'))}</small></button>${localPanel}
      <button class="choice ${state.aiChoice === 'online' ? 'open' : ''}" data-act="choose-online"><h4>${esc(tr('ai.online.title'))}</h4><small>${esc(tr('ai.online.help'))}</small></button>${onlinePanel}
      <button class="choice" data-act="demo"><h4>${esc(tr('ai.demo.title'))}</h4><small>${esc(tr('ai.demo.help'))}</small></button>
    </div>${errorBox('ai')}`;
}

function stepBusiness() {
  const noSite = state.noSite;
  return `<form id="biz-form" novalidate>${noSite ? `<label for="biz-name">${esc(tr('biz.name'))}</label><input id="biz-name" required maxlength="120"><label for="biz-desc">${esc(tr('biz.desc'))}</label><textarea id="biz-desc" required maxlength="1000"></textarea>`
    : `<label for="biz-url">${esc(tr('biz.url'))}</label><input id="biz-url" type="url" inputmode="url" placeholder="https://" required autocomplete="url"><small>${esc(tr('biz.urlHint'))}</small>`}
    <label for="biz-lang">${esc(tr('biz.lang'))}</label><select id="biz-lang"><option value="es" ${lang === 'es' ? 'selected' : ''}>Español</option><option value="en" ${lang === 'en' ? 'selected' : ''}>English</option></select>
    <div class="row"><button class="btn big" type="submit" ${state.busy.biz ? 'disabled' : ''}>${state.busy.biz ? `<span class="spin"></span> ${esc(tr('biz.reading'))}` : esc(tr('btn.next'))}</button><button type="button" class="link" data-act="toggle-site">${esc(noSite ? tr('biz.url') : tr('biz.noSite'))}</button></div>
    ${state.busy.biz ? `<p class="hint">${esc(tr('biz.readingHelp'))}</p>` : ''}${errorBox('business')}</form>`;
}

function stepUnderstood() {
  const p = state.project; if (!p) return '';
  if (state.editing) return `<form id="und-form"><label for="u-name">${esc(tr('biz.name'))}</label><input id="u-name" value="${esc(p.name)}" maxlength="120"><label for="u-desc">${esc(tr('und.title.what'))}</label><textarea id="u-desc" maxlength="1000">${esc(p.description)}</textarea><label for="u-aud">${esc(tr('und.title.who'))}</label><textarea id="u-aud" maxlength="500">${esc(p.audience)}</textarea><label for="u-tone">${esc(tr('und.title.tone'))}</label><input id="u-tone" value="${esc(p.tone)}" maxlength="200">
    <div class="row"><button class="btn" type="submit">${esc(tr('btn.save'))}</button><button type="button" class="btn secondary" data-act="cancel-edit">${esc(tr('btn.cancel'))}</button></div></form>`;
  const item = (label, value) => `<div class="item"><small>${esc(label)}</small><p>${value ? esc(value) : '<span class="hint">—</span>'}</p></div>`;
  return `<p class="hint">${esc(tr('und.hint'))}</p><div class="summary">${item(tr('biz.name'), p.name)}${item(tr('und.title.what'), p.description)}${item(tr('und.title.who'), p.audience)}${item(tr('und.title.tone'), p.tone)}</div>
    <div class="row"><button class="btn big" data-act="confirm-und">${esc(tr('btn.confirm'))}</button><button class="btn secondary" data-act="edit-und">${esc(tr('btn.edit'))}</button></div>`;
}

function stepPosts() {
  const job = state.jobs.find((j) => j.kind === 'onboarding' && (j.status === 'running' || j.status === 'queued')) || null;
  const failed = state.jobs.filter((j) => j.kind === 'onboarding').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const stage = job?.payload?.stage || 'health'; const written = state.drafts.filter(isWritten).length;
  const rows = [['health', tr('posts.m1')], ['strategy', tr('posts.m2')], ['drafts', tr('posts.m3', { n: Math.min(written + 1, 5), total: 5 })]];
  const order = ['health', 'strategy', 'drafts']; const at = Math.max(0, order.indexOf(stage));
  if (job || state.busy.agents) return `<div class="work">${rows.map(([id, text], i) => `<div class="${i < at ? 'ok' : i === at ? 'on' : ''}"><span class="dot"></span>${esc(text)}</div>`).join('')}</div><p class="hint">${esc(tr('posts.leave'))}</p>`;
  if (failed && failed.status === 'failed') { const f = friendlyError(failed.error, lang); return `<div class="notice bad">${esc(f.message)}<details><summary>${esc(tr('tech.details'))}</summary><pre>${esc(f.details)}</pre></details></div><div class="row"><button class="btn" data-act="retry-job" data-id="${esc(failed.id)}">${esc(tr('btn.retry'))}</button></div>`; }
  return `<div class="row"><button class="btn big" data-act="make-posts">${esc(tr('btn.start'))}</button></div>${errorBox('posts')}`;
}

function mockup(draft) {
  const p = state.project; const initial = esc((p?.name || 'O').trim().charAt(0).toUpperCase());
  const status = charStatus(draft.quality?.count ?? draft.body.length, draft.quality?.limit, lang);
  const key = channelKey(draft.channel);
  return `<article class="post" aria-label="${esc(draft.title)}"><div class="post-head"><span class="avatar" aria-hidden="true">${initial}</span><div><b>${esc(p?.name || '')}</b><small>${esc(tr('review.where', { channel: tr(`channel.${key}`) }))}</small></div></div>
    ${key === 'blog' || key === 'newsletter' ? `<div class="post-text doc"><h4>${esc(draft.title)}</h4>${renderMarkdown(dropDuplicateTitle(draft.title, draft.body))}</div>` : `<div class="post-text" id="post-text">${esc(plainText(draft.body))}</div>`}
    <div class="post-foot"><span class="${status.ok ? 'good' : 'bad'}">${esc(status.text)}</span><span>${draft.quality?.limit ? `${draft.quality.count}/${draft.quality.limit}` : ''}</span></div></article>`;
}

function stepReview() {
  const queue = state.drafts.filter((d) => isWritten(d) && d.status === 'pending').sort(reviewOrder);
  const approved = state.drafts.filter((d) => d.status === 'approved' || d.status === 'published').length;
  if (!queue.length) return `<div class="celebrate"><div class="big-emoji"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></div><p>${esc(tr('review.empty'))}</p></div>`;
  const idx = Math.min(state.reviewIdx, queue.length - 1); const draft = queue[idx];
  const angle = draft.metadata?.angle ? `<p class="hint"><b>${esc(tr('review.why'))}:</b> ${esc(draft.metadata.angle)}</p>` : '';
  if (state.busy[draft.id]) return `${mockup(draft)}<div class="notice wait"><span class="spin"></span> ${esc(tr('review.rewrite'))}</div>`;
  return `<p class="hint">${esc(tr('review.of', { n: idx + 1, total: queue.length }))}${approved ? ` · ${esc(tr('review.approvedN', { n: approved }))}` : ''} ${helpBtn('h.approve')}</p>${mockup(draft)}${angle}
    <div class="chips" role="group" aria-label="${esc(tr('btn.change'))}"><button class="chip" data-act="rewrite" data-id="${esc(draft.id)}" data-fb="Make it shorter and more direct">${esc(tr('review.shorter'))}</button><button class="chip" data-act="rewrite" data-id="${esc(draft.id)}" data-fb="Make it friendlier and more conversational">${esc(tr('review.friendlier'))}</button><button class="chip" data-act="rewrite" data-id="${esc(draft.id)}" data-fb="Make it more professional and precise">${esc(tr('review.pro'))}</button><button class="chip" data-act="rewrite" data-id="${esc(draft.id)}" data-fb="Take a completely different angle on the same topic">${esc(tr('review.other'))}</button></div>
    <div class="actions"><button class="btn big" data-act="approve" data-id="${esc(draft.id)}">${esc(tr('btn.approve'))}</button>${queue.length > 1 ? `<button class="btn secondary" data-act="next-post">${esc(tr('btn.skipPost'))}</button>` : ''}<button class="btn danger" data-act="discard" data-id="${esc(draft.id)}">${esc(tr('btn.discard'))}</button></div>${errorBox('review')}`;
}

function stepPublish() {
  const list = state.drafts.filter((d) => d.status === 'approved');
  if (!list.length) return `<p>${esc(tr('pub.empty'))}</p>`;
  return `<p>${esc(tr('pub.title'))} ${helpBtn('h.calendar')}</p><div class="approved-list">${list.map((d) => `<article class="post"><div class="post-text">${esc((() => { const t = ['linkedin', 'x'].includes(d.channel) ? plainText(d.body) : plainText(dropDuplicateTitle(d.title, d.body)); return t.length > 600 ? `${t.slice(0, 600)}…` : t; })())}</div><div class="post-foot"><span>${esc(tr(`channel.${channelKey(d.channel)}`))}${d.scheduledAt ? ` · ${esc(new Date(d.scheduledAt).toLocaleString(lang))}` : ''}</span></div><div style="padding:0 16px 16px"><div class="how"><b>${esc(tr('pub.how'))}:</b> ${esc(tr(`how.${channelKey(d.channel)}`))}</div><div class="row"><button class="btn" data-act="copy" data-id="${esc(d.id)}">${esc(tr('btn.copy'))}</button>${d.scheduledAt ? '' : `<button class="btn secondary" data-act="schedule" data-id="${esc(d.id)}">${esc(tr('btn.addCalendar'))}</button>`}</div></div></article>`).join('')}</div>${errorBox('publish')}`;
}

function stepMonth() {
  const job = state.jobs.find((j) => j.kind === 'month-plan' && (j.status === 'running' || j.status === 'queued'));
  if (job || facts().monthPlanStarted) return `<div class="notice ok">${esc(tr('month.started'))}</div>`;
  const failedMonth = state.jobs.filter((j) => j.kind === 'month-plan').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (failedMonth && failedMonth.status === 'failed') return `<div class="notice bad">${esc(tr('month.failed'))}<details><summary>${esc(tr('tech.details'))}</summary><pre>${esc(failedMonth.error || '')}</pre></details></div><div class="row"><button class="btn big" data-act="retry-month" data-id="${esc(failedMonth.id)}">${esc(tr('btn.retryMonth'))}</button><button class="btn secondary" data-act="skip-month">${esc(tr('btn.skip'))}</button></div>`;
  const e = state.estimate; const time = e ? formatDuration(e.totalSeconds, lang) : '…';
  return `<p>${esc(tr('month.help'))}</p><p class="hint">${esc(tr('month.estimate', { time }))}</p><div class="row"><button class="btn big" data-act="make-month">${esc(tr('btn.createPlan'))}</button><button class="btn secondary" data-act="skip-month">${esc(tr('btn.skip'))}</button></div>${errorBox('month')}`;
}


function calendarHtml() {
  const items = state.drafts.filter((d) => d.channel !== 'briefing' && d.status !== 'rejected').map((d) => ({ d, at: d.scheduledAt || d.metadata?.plannedAt || null })).filter((x) => x.at && !Number.isNaN(Date.parse(x.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!items.length) return `<section class="calendar"><h2>${esc(tr('cal.title'))}</h2><p class="hint">${esc(tr('cal.empty'))}</p></section>`;
  const weekStart = (iso) => { const date = new Date(iso); const day = (date.getDay() + 6) % 7; date.setDate(date.getDate() - day); date.setHours(0, 0, 0, 0); return date; };
  const groups = new Map(); for (const item of items) { const key = weekStart(item.at).getTime(); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  const label = { writing: tr('cal.writing'), pending: tr('cal.review'), approved: tr('cal.approved'), published: tr('cal.published') };
  const html = [...groups.entries()].map(([key, list]) => `<div class="week"><h3>${esc(tr('cal.week', { date: new Date(key).toLocaleDateString(lang, { day: 'numeric', month: 'short' }) }))}</h3>${list.map(({ d, at }) => {
    const status = d.metadata?.needsBody ? 'writing' : d.status; const date = new Date(at).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' });
    const action = status === 'pending' ? `<button class="btn secondary small" data-act="review-this" data-id="${esc(d.id)}">${esc(tr('cal.btnReview'))}</button>` : status === 'approved' ? `<button class="btn secondary small" data-act="copy-cal" data-id="${esc(d.id)}">${esc(tr('cal.btnCopy'))}</button>` : '';
    return `<div class="cal-item"><time>${esc(date)}</time><div class="cal-main"><b>${esc(d.title)}</b><small>${esc(tr(`channel.${channelKey(d.channel)}`))}</small></div><span class="status ${esc(status)}">${esc(label[status] || status)}</span>${action}</div>`;
  }).join('')}</div>`).join('');
  return `<section class="calendar" id="calendar"><h2>${esc(tr('cal.title'))}</h2><p class="hint">${esc(tr('cal.help'))} ${esc(tr('cal.count', { n: items.length }))}</p>${html}</section>`;
}

const RENDERERS = { ai: stepAi, business: stepBusiness, understood: stepUnderstood, posts: stepPosts, review: stepReview, publish: stepPublish, month: stepMonth };

/* ---------- main render ---------- */
function render() {
  const f = facts(); const plan = computeSteps(f); const app = $('#app');
  document.documentElement.lang = lang; $('#lang').textContent = tr('top.lang'); $('#advanced').textContent = tr('top.advanced');
  const currentIdx = plan.steps.findIndex((s) => s.status === 'current');
  const allDone = plan.doneCount === plan.total || (plan.current === null);
  const pct = Math.round((plan.doneCount / plan.total) * 100);
  const banner = state.project?.isDemo ? `<div class="banner"><span><span class="tag">${esc(tr('demo.badge'))}</span>${esc(tr('demo.banner'))}</span><button class="btn secondary" data-act="leave-demo">${esc(tr('demo.leave'))}</button></div>` : '';
  const stepsHtml = plan.steps.map((s, i) => {
    const open = s.status === 'current' || state.open === s.id; const timeKey = s.id === 'posts' ? tr('step.posts.time', { time: formatDuration(state.postsEta || 180, lang) }) : s.id === 'month' ? tr('step.month.time', { time: formatDuration(state.estimate?.totalSeconds || 1200, lang) }) : tr(`step.${s.id}.time`);
    const head = `<div class="step-head" ${s.status === 'done' ? `data-act="toggle-step" data-id="${s.id}" tabindex="0" role="button" aria-expanded="${open}"` : ''}><span class="num" aria-hidden="true">${s.status === 'done' ? '✓' : i + 1}</span><h3>${esc(s.status === 'done' ? tr(`step.${s.id}.short`) : tr(`step.${s.id}.title`))}</h3>${s.optional ? `<span class="opt">${esc(tr('plan.optional'))}</span>` : ''}${s.status === 'done' ? `<span class="opt">${esc(tr('plan.reopen'))}</span>` : ''}</div>`;
    const body = open ? `<div class="step-body">${s.status === 'current' ? `<div class="meta"><div><b>${esc(tr('plan.why'))}:</b> ${esc(tr(`step.${s.id}.why`))}</div><div>${esc(tr('plan.time', { time: timeKey }))}</div><div><b>${esc(tr('plan.next'))}:</b> ${esc(tr(`step.${s.id}.next`))}</div></div>` : ''}${RENDERERS[s.id]()}</div>` : '';
    return `<section class="step ${s.status}" id="step-${s.id}" aria-current="${s.status === 'current' ? 'step' : 'false'}">${head}${body}</section>`;
  }).join('');
  const finale = allDone ? `<div class="step current"><div class="celebrate"><div class="big-emoji"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></div><h2>${esc(tr('done.title'))}</h2><p>${esc(tr('done.text'))}</p></div></div>` : '';
  app.innerHTML = `${banner}<div class="hero"><h1>${esc(tr('plan.title'))}</h1><p>${esc(tr('plan.intro'))}</p><div class="progress" role="progressbar" aria-valuenow="${plan.doneCount}" aria-valuemin="0" aria-valuemax="${plan.total}"><div class="bar"><i style="width:${pct}%"></i></div><b>${esc(tr('plan.done', { done: plan.doneCount, total: plan.total }))}</b></div></div>${finale}${stepsHtml}${calendarHtml()}<p class="hint" style="text-align:center">${esc(tr('safe.note'))}</p>`;
  updatePill(); bind(); if (currentIdx >= 0 && state.scrollTo !== undefined && state.scrollTo !== plan.current) $(`#step-${plan.current}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  state.scrollTo = plan.current;
}

function jobText(job) {
  if (job.kind === 'month-plan') return tr('month.started').split('.')[0] + ` ${job.progress || 0}/${job.total || 30}`;
  if (job.kind === 'onboarding') return tr('posts.working');
  return tr('posts.working');
}
function updatePill() {
  const jobs = activeJobs(); const pill = $('#job-pill');
  if (state.busy.agents) { pill.hidden = false; $('#job-text').textContent = tr('posts.working'); return; }
  pill.hidden = !jobs.length; if (jobs.length) $('#job-text').textContent = jobText(jobs[0]);
}

/* ---------- actions ---------- */
async function saveAi({ baseUrl, model, key }) {
  setNotice('ai', { kind: 'wait', message: tr('ai.testing') }); render();
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llmBaseUrl: baseUrl, llmModel: model, llmApiKey: key }) });
    await api('/api/settings/test-llm', { method: 'POST', body: '{}' });
    store.set('ocmo_ai_ok', '1'); setNotice('ai', null); toast(tr('ai.ok')); await loadAll(); render();
  } catch (error) { fail('ai', error); }
}

async function startBusiness(event) {
  event.preventDefault(); if (state.busy.biz) return;
  const language = $('#biz-lang').value; lang = language; store.set('ocmo_lang', lang);
  const typed = { url: $('#biz-url')?.value.trim() || '', name: $('#biz-name')?.value.trim() || '', description: $('#biz-desc')?.value.trim() || '' };
  try {
    state.busy.biz = true; setNotice('business', null); render();
    if (state.noSite) {
      const { name, description } = typed;
      if (!name || !description) throw new Error('name and description are required');
      const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, description, language, url: '' }) });
      state.project = project; await api(`/api/projects/${project.id}/strategy`, { method: 'POST', body: '{}' }).catch(() => null);
    } else {
      const url = typed.url; if (!url) throw new Error('url is required');
      const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      let profile = {};
      try { profile = (await api('/api/onboarding/profile', { method: 'POST', body: JSON.stringify({ url: normalized }) })).profile || {}; } catch (profileError) { if (/private|blocked|invalid/i.test(profileError.message)) throw profileError; }
      const response = await fetch('/api/onboarding/run?stream=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: normalized, language, profile: { name: profile.name, description: profile.description, audience: profile.audience, tone: profile.tone } }) });
      const text = await response.text();
      if (!response.ok) { let data = {}; try { data = JSON.parse(text); } catch { /* not JSON */ } if (data.project) { state.project = data.project; } const error = new Error(data.error || `HTTP ${response.status}`); throw error; }
    }
    state.busy.biz = false; await loadAll(); render(); startPolling();
  } catch (error) { state.busy.biz = false; if (/already exists/i.test(error.message)) { await loadAll(); setNotice('business', null); render(); return; } fail('business', error); }
}

async function makePosts() {
  const p = state.project; if (!p) return;
  try {
    state.busy.agents = true; render(); const channels = ['linkedin', 'x', 'newsletter'];
    for (const agent of channels) { await api(`/api/projects/${p.id}/agents/${agent}/run`, { method: 'POST', body: JSON.stringify({ task: `${p.name}: ${p.description}` }) }); await refreshProjectData(); render(); }
  } catch (error) { state.busy.agents = false; fail('posts', error); return; }
  state.busy.agents = false; await refreshProjectData(); render();
}

async function act(target) {
  const action = target.dataset.act; const id = target.dataset.id;
  try {
    if (action === 'choose-local') { state.aiChoice = state.aiChoice === 'local' ? null : 'local'; render(); }
    else if (action === 'choose-online') { state.aiChoice = state.aiChoice === 'online' ? null : 'online'; render(); }
    else if (action === 'check-again') { state.ollama = await api('/api/engines/ollama').catch(() => ({ available: false, models: [] })); render(); }
    else if (action === 'use-local') await saveAi({ baseUrl: state.ollama.baseUrl || 'http://localhost:11434/v1', model: $('#local-model').value, key: 'ollama' });
    else if (action === 'use-online') { const key = $('#api-key').value.trim(); if (!key) { setNotice('ai', { kind: 'bad', message: tr('ai.online.key') }); render(); return; } const p = PROVIDERS[state.provider]; await saveAi({ baseUrl: p.baseUrl, model: p.model, key }); }
    else if (action === 'demo') { await api('/api/demo', { method: 'POST', body: '{}' }); store.set('ocmo_demo', '1'); await loadAll(); render(); }
    else if (action === 'leave-demo') { store.set('ocmo_demo', '0'); state.projects = state.projects.filter((p) => !p.isDemo); const demo = state.project; if (demo?.isDemo) await api(`/api/projects/${demo.id}`, { method: 'DELETE' }).catch(() => null); await loadAll(); render(); }
    else if (action === 'toggle-site') { state.noSite = !state.noSite; render(); }
    else if (action === 'edit-und') { state.editing = true; render(); }
    else if (action === 'cancel-edit') { state.editing = false; render(); }
    else if (action === 'confirm-und') { store.set(`ocmo_und_${state.project.id}`, '1'); render(); }
    else if (action === 'make-posts') await makePosts();
    else if (action === 'retry-job') { await api(`/api/jobs/${id}/retry`, { method: 'POST', body: '{}' }); await refreshProjectData(); render(); startPolling(); }
    else if (action === 'next-post') { state.reviewIdx += 1; render(); }
    else if (action === 'approve') { await api(`/api/drafts/${id}/approve`, { method: 'POST', body: '{}' }); const first = state.drafts.every((d) => d.status !== 'approved'); await refreshProjectData(); if (first) toast(tr('done.first')); render(); }
    else if (action === 'discard') { await api(`/api/drafts/${id}/reject`, { method: 'POST', body: '{}' }); await refreshProjectData(); render(); }
    else if (action === 'rewrite') { state.busy[id] = true; render(); try { await api(`/api/drafts/${id}/regenerate`, { method: 'POST', body: JSON.stringify({ feedback: target.dataset.fb }) }); } finally { delete state.busy[id]; } await refreshProjectData(); render(); }
    else if (action === 'copy') { const d = state.drafts.find((x) => x.id === id); await navigator.clipboard.writeText(['linkedin', 'x'].includes(d.channel) ? plainText(d.body) : plainText(dropDuplicateTitle(d.title, d.body))); store.set(`ocmo_copied_${state.project.id}`, '1'); target.textContent = tr('btn.copied'); setTimeout(render, 900); }
    else if (action === 'schedule') { const when = new Date(); when.setDate(when.getDate() + 1); when.setHours(9, 0, 0, 0); await api(`/api/drafts/${id}/schedule`, { method: 'POST', body: JSON.stringify({ scheduledAt: when.toISOString() }) }); await refreshProjectData(); toast(tr('step.publish.short')); render(); }
    else if (action === 'make-month') { await api(`/api/projects/${state.project.id}/month-plan`, { method: 'POST', body: '{}' }); await refreshProjectData(); render(); startPolling(); }
    else if (action === 'retry-month') { await api(`/api/jobs/${id}/retry`, { method: 'POST', body: '{}' }); await refreshProjectData(); render(); startPolling(); }
    else if (action === 'review-this') { const queue = state.drafts.filter((d) => isWritten(d) && d.status === 'pending').sort(reviewOrder); const at = queue.findIndex((d) => d.id === id); if (at >= 0) state.reviewIdx = at; state.open = 'review'; render(); document.querySelector('#step-review')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else if (action === 'copy-cal') { const d = state.drafts.find((x) => x.id === id); await navigator.clipboard.writeText(['linkedin', 'x'].includes(d.channel) ? plainText(d.body) : plainText(dropDuplicateTitle(d.title, d.body))); store.set(`ocmo_copied_${state.project.id}`, '1'); toast(tr('btn.copied')); }
    else if (action === 'skip-month') { store.set(`ocmo_month_skip_${state.project.id}`, '1'); render(); }
    else if (action === 'toggle-step') { state.open = state.open === id ? null : id; render(); }
  } catch (error) { const stepId = { 'use-local': 'ai', 'use-online': 'ai', demo: 'ai', approve: 'review', discard: 'review', rewrite: 'review', copy: 'publish', schedule: 'publish', 'make-month': 'month' }[action] || 'review'; fail(stepId, error); }
}

function bind() {
  const app = $('#app');
  $('#biz-form')?.addEventListener('submit', startBusiness);
  $('#und-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/projects/${state.project.id}`, { method: 'PATCH', body: JSON.stringify({ name: $('#u-name').value, description: $('#u-desc').value, audience: $('#u-aud').value, tone: $('#u-tone').value }) }); state.editing = false; await refreshProjectData(); render(); } catch (error) { fail('understood', error); }
  });
  $('#api-key')?.addEventListener('input', (event) => { state.apiKey = event.target.value; });
  $('#provider')?.addEventListener('change', (event) => { state.provider = event.target.value; render(); });
  app.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', (event) => { event.stopPropagation(); act(el); });
    if (el.getAttribute('role') === 'button') el.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act(el); } });
  });
  app.querySelectorAll('[data-help]').forEach((el) => el.addEventListener('click', () => {
    const next = el.nextElementSibling; if (next?.classList.contains('bubble')) { next.remove(); return; }
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = tr(el.dataset.help); el.after(bubble);
  }));
}

let pollTimer = null;
function signature() { return JSON.stringify([state.jobs.map((j) => [j.id, j.status, j.progress, j.payload?.stage]), state.drafts.map((d) => [d.id, d.status, !!d.metadata?.needsBody])]); }
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!state.project) return;
    const before = signature(); await refreshProjectData();
    if (!activeJobs().length && !state.busy.agents) { clearInterval(pollTimer); }
    if (signature() !== before) render(); else updatePill();
  }, 3000);
}

$('#lang').addEventListener('click', () => { lang = lang === 'es' ? 'en' : 'es'; store.set('ocmo_lang', lang); render(); });

(async function boot() {
  try {
    await loadAll();
    state.estimate = (await api('/api/estimate?kind=month-plan').catch(() => ({}))).estimate || null;
    render(); if (activeJobs().length) startPolling();
  } catch (error) { $('#app').innerHTML = `<div class="notice bad">${esc(friendlyError(error, lang).message)}</div>`; }
})();
