const state = { projects: [], current: null, agents: [], selectedAgent: 'writer', connectors: [], drafts: [], selected: new Set(), language: navigator.language.startsWith('es') ? 'es' : 'en', pendingProfileText: '' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const words = {
  en: { strategy: 'Strategy', agents: 'Agents', inbox: 'Inbox', calendar: 'Calendar', empty: 'No drafts in this view.', noStrategy: 'No strategy yet. Generate one after configuring your LLM.', noSchedule: 'No scheduled content yet.', saved: 'Draft saved', approved: 'Draft approved', rejected: 'Draft rejected', published: 'Draft published', copy: 'Copy', save: 'Save edit', approve: 'Approve', reject: 'Reject', publish: 'Publish', schedule: 'Schedule', choose: 'Choose connector…' },
  es: { strategy: 'Estrategia', agents: 'Agentes', inbox: 'Bandeja', calendar: 'Calendario', empty: 'No hay borradores en esta vista.', noStrategy: 'Aún no hay estrategia. Genera una después de configurar tu LLM.', noSchedule: 'Aún no hay contenido programado.', saved: 'Borrador guardado', approved: 'Borrador aprobado', rejected: 'Borrador rechazado', published: 'Borrador publicado', copy: 'Copiar', save: 'Guardar edición', approve: 'Aprobar', reject: 'Rechazar', publish: 'Publicar', schedule: 'Programar', choose: 'Elegir conector…' },
};
const t = (key) => words[state.language]?.[key] || words.en[key] || key;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function streamApi(url, options, onProgress) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let result;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split('\n\n'); buffer = blocks.pop() || '';
    for (const block of blocks) {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const raw = block.match(/^data: (.+)$/m)?.[1];
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (event === 'progress') onProgress(data.message);
      if (event === 'error') throw new Error(data.error);
      if (event === 'result') result = data;
    }
    if (done) break;
  }
  return result;
}

function notify(message, error = false) {
  const toast = document.createElement('div'); toast.className = `toast${error ? ' error' : ''}`; toast.textContent = message;
  $('#toasts').append(toast); setTimeout(() => toast.remove(), 4500);
  $('#status').textContent = message; $('#status').classList.toggle('error', error);
  clearTimeout(notify.timer); notify.timer = setTimeout(() => { $('#status').textContent = ''; }, 4500);
}

async function load() {
  const [projectData, agentData, connectorData] = await Promise.all([api('/api/projects'), api('/api/agents'), api('/api/connectors')]);
  state.projects = projectData.projects; state.agents = agentData.agents; state.connectors = connectorData.connectors;
  $('#project-language').value = state.language;
  renderProjects(); renderAgents(); updateTranslations();
  if (state.projects.length) await selectProject(state.projects[0].id);
}

function updateTranslations() {
  ['strategy', 'knowledge', 'agents', 'inbox', 'calendar', 'policy'].forEach((id) => {
    const tab = $(`[data-tab="${id}"]`); if (tab) tab.childNodes[0].textContent = `${t(id)} `;
  });
  const copy = {
    '#new-project': ['+ New project', '+ Nuevo proyecto'], '#open-settings': ['⚙ Settings', '⚙ Ajustes'],
    '#strategy .panel-heading h2': ['Marketing strategy', 'Estrategia de marketing'], '#strategy .panel-heading p': ['Grounded in your website and business details.', 'Basada en tu sitio web y los datos del negocio.'],
    '#generate-strategy': ['Generate strategy', 'Generar estrategia'], '#agents .panel-heading h2': ['Marketing agents', 'Agentes de marketing'],
    '#agents .panel-heading p': ['Choose an agent, describe the assignment, then review its drafts.', 'Elige un agente, describe la tarea y revisa sus borradores.'],
    '#run-form button[type="submit"]': ['Run agent', 'Ejecutar agente'], '#inbox .panel-heading h2': ['Draft inbox', 'Bandeja de borradores'],
    '#inbox .panel-heading p': ['Edit, approve, reject, and publish. Publishing is disabled until approval.', 'Edita, aprueba, rechaza y publica. La publicación requiere aprobación.'],
    '#select-all': ['Select all', 'Seleccionar todo'], '#bulk-approve': ['Approve selected', 'Aprobar selección'], '#bulk-reject': ['Reject selected', 'Rechazar selección'],
    '#calendar .panel-heading h2': ['Content calendar', 'Calendario de contenido'], '#calendar .panel-heading p': ['Approved drafts scheduled for automatic publishing.', 'Borradores aprobados programados para publicación automática.'],
    '#empty h2': ['Create your first marketing workspace', 'Crea tu primer espacio de marketing'], '#empty button': ['Create project', 'Crear proyecto'],
    '#empty p': ['Add a business and its URL. OpenCMO can research its site, build a strategy, and draft work for your approval.', 'Añade un negocio y su URL. OpenCMO puede investigar el sitio, crear una estrategia y preparar borradores para tu aprobación.'],
    '#project-dialog h2': ['New project', 'Nuevo proyecto'], '#project-form button[type="submit"]': ['Create project', 'Crear proyecto'],
    '#settings-dialog h2': ['Settings', 'Ajustes'], '#settings-form button[type="submit"]': ['Save settings', 'Guardar ajustes'], '#test-llm': ['Test LLM connection', 'Probar conexión LLM'],
  };
  Object.entries(copy).forEach(([selector, values]) => { const element = $(selector); if (element) element.textContent = values[state.language === 'es' ? 1 : 0]; });
  const labels = [
    ['#project-form [name="name"]', 'Business name', 'Nombre del negocio'], ['#project-form [name="url"]', 'Website URL', 'URL del sitio web'],
    ['#project-form [name="description"]', 'Description', 'Descripción'], ['#project-form [name="audience"]', 'Audience', 'Audiencia'],
    ['#project-form [name="tone"]', 'Tone', 'Tono'], ['#project-form [name="language"]', 'Language', 'Idioma'], ['#project-form [name="competitors"]', 'Competitors', 'Competidores'],
  ];
  labels.forEach(([selector, en, es]) => { const label = $(selector)?.closest('label'); const node = label && [...label.childNodes].find((item) => item.nodeType === Node.TEXT_NODE && item.textContent.trim()); if (node) node.textContent = `${state.language === 'es' ? es : en} `; });
  document.documentElement.lang = state.language;
}

function renderProjects() {
  $('#projects').innerHTML = state.projects.map((p) => `<button data-project="${p.id}" class="${state.current?.id === p.id ? 'active' : ''}">${escapeHtml(p.name)}</button>`).join('');
  $$('[data-project]').forEach((button) => button.onclick = () => selectProject(button.dataset.project));
}

async function selectProject(id) {
  state.current = state.projects.find((project) => project.id === id);
  state.language = state.current.language || state.language; updateTranslations();
  $('#workspace-language').hidden = false; $('#workspace-language').value = state.language;
  $('#empty').hidden = true; $('#workspace').hidden = false; $('#project-title').textContent = state.current.name;
  $('#strategy-content').textContent = state.current.strategy || t('noStrategy');
  $('#strategy-content').classList.toggle('muted', !state.current.strategy);
  renderProjects(); renderAgents(); await Promise.all([loadDrafts(), loadGeoHistory(), loadKnowledge(), loadPolicy()]);
}

async function loadKnowledge() {
  const { documents } = await api(`/api/projects/${state.current.id}/knowledge`);
  $('#knowledge-list').innerHTML = documents.length ? documents.map((document) => `<article class="card knowledge-item"><div><strong>${escapeHtml(document.title)}</strong><p class="muted">${escapeHtml(document.source)} · ${new Date(document.createdAt).toLocaleString()}</p></div><button class="danger" data-delete-knowledge="${document.id}">Delete</button></article>`).join('') : '<div class="card empty-list">No knowledge documents yet.</div>';
  $$('[data-delete-knowledge]').forEach((button) => button.onclick = () => perform(async () => { await api(`/api/knowledge/${button.dataset.deleteKnowledge}`, { method: 'DELETE' }); await loadKnowledge(); }));
}

async function loadPolicy() {
  const data = await api('/api/policy');
  $('#stop-agents').textContent = data.paused ? 'Resume agents' : 'Stop all'; $('#stop-agents').dataset.paused = String(data.paused);
  $('#policy-floor').innerHTML = `<strong>Always handed to a human</strong><p class="muted">${data.floor.map((action) => escapeHtml(action.replaceAll('_', ' '))).join(' · ')}</p>`;
  $('#policy-form').innerHTML = Object.entries(data.policy).map(([action, mode]) => `<label>${escapeHtml(action.replaceAll('_', ' '))}<select name="${escapeHtml(action)}"><option ${mode === 'act' ? 'selected' : ''}>act</option><option ${mode === 'ask' ? 'selected' : ''}>ask</option><option ${mode === 'handoff' ? 'selected' : ''}>handoff</option></select></label>`).join('') + '<button class="primary" type="submit">Save policy</button>';
  $('#approval-list').innerHTML = data.approvals.length ? data.approvals.map((approval) => `<article class="card approval-item"><div><strong>${escapeHtml(approval.summary)}</strong><p class="muted">${escapeHtml(approval.agent)} · ${escapeHtml(approval.reason)}</p></div><div><button class="primary" data-approval="${approval.id}" data-decision="approve">Approve</button> <button class="danger" data-approval="${approval.id}" data-decision="reject">Reject</button></div></article>`).join('') : '<div class="card empty-list">No pending approvals.</div>';
  $('#activity-list').innerHTML = data.activity.length ? data.activity.map((entry) => `<p><strong>${escapeHtml(entry.action)}</strong> · ${escapeHtml(entry.decision)} <small>${escapeHtml(entry.actor || '')} · ${new Date(entry.at).toLocaleString()}</small></p>`).join('') : '<p class="muted">No activity yet.</p>';
  $$('[data-approval]').forEach((button) => button.onclick = () => perform(async () => { await api(`/api/approvals/${button.dataset.approval}/${button.dataset.decision}`, { method: 'POST' }); await Promise.all([loadPolicy(), loadDrafts()]); }));
}

async function loadGeoHistory() {
  const { history } = await api(`/api/projects/${state.current.id}/geo-history`); const panel = $('#geo-history');
  panel.hidden = !history.length;
  panel.querySelector('div').innerHTML = history.map((item) => `<div class="score" title="${new Date(item.createdAt).toLocaleString()}"><span style="height:${Math.max(3, item.score)}%"></span><small>${item.score}%</small></div>`).join('');
}

function renderAgents() {
  const spanish = { writer: 'Redacta artículos útiles a partir de un tema o palabra clave.', seo: 'Realiza una auditoría on-page y añade recomendaciones priorizadas.', geo: 'Mide la visibilidad de marca en preguntas de compradores.', reddit: 'Encuentra debates públicos y redacta respuestas útiles.', x: 'Crea publicaciones o hilos concisos para X.', linkedin: 'Crea publicaciones profesionales y prácticas.', newsletter: 'Redacta newsletters con asunto y texto de vista previa.', launch: 'Prepara lanzamientos para Hacker News o Product Hunt.' };
  $('#agent-grid').innerHTML = state.agents.map((a) => `<button class="agent ${a.id === state.selectedAgent ? 'selected' : ''}" data-agent="${a.id}"><h3>${escapeHtml(a.name)}</h3><p>${escapeHtml(state.language === 'es' ? spanish[a.id] || a.description : a.description)}</p></button>`).join('');
  $$('[data-agent]').forEach((button) => button.onclick = () => {
    state.selectedAgent = button.dataset.agent; $('#selected-agent').textContent = state.agents.find((a) => a.id === state.selectedAgent).name;
    $('#geo-options').hidden = state.selectedAgent !== 'geo'; renderAgents();
  });
}

async function loadDrafts() {
  const status = $('#draft-filter').value;
  const data = await api(`/api/drafts?project=${encodeURIComponent(state.current.id)}${status ? `&status=${status}` : ''}`);
  state.drafts = data.drafts; state.selected.clear();
  const all = status ? (await api(`/api/drafts?project=${encodeURIComponent(state.current.id)}`)).drafts : state.drafts;
  $('#pending-count').textContent = all.filter((draft) => draft.status === 'pending').length;
  renderDrafts(); renderCalendar(all);
}

function connectorOptions() {
  return `<option value="">${t('choose')}</option>${state.connectors.map((c) => `<option value="${c.id}" ${c.configured ? '' : 'disabled'}>${escapeHtml(c.name)}${c.configured ? '' : state.language === 'es' ? ' (sin configurar)' : ' (not configured)'}</option>`).join('')}`;
}

function diffText(before, after) {
  const oldLines = String(before).split('\n'); const newLines = String(after).split('\n'); const output = [];
  const length = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < length; i += 1) {
    if (oldLines[i] === newLines[i]) output.push(`  ${oldLines[i] || ''}`);
    else { if (oldLines[i] !== undefined) output.push(`- ${oldLines[i]}`); if (newLines[i] !== undefined) output.push(`+ ${newLines[i]}`); }
  }
  return output.join('\n');
}

function renderDrafts() {
  if (!state.drafts.length) { $('#drafts').innerHTML = `<div class="card empty-list">${t('empty')}</div>`; return; }
  $('#drafts').innerHTML = state.drafts.map((draft) => {
    const revisions = Array.isArray(draft.metadata.revisions) ? draft.metadata.revisions : [];
    return `<article class="card draft" tabindex="0" data-draft="${draft.id}">
      <div class="draft-head"><label class="draft-select"><input type="checkbox" class="pick"> <span class="badge ${draft.status}">${draft.status}</span></label><div class="draft-title"><small>${escapeHtml(draft.channel)} · ${escapeHtml(draft.agentId)}</small><input class="title-input" value="${escapeHtml(draft.title)}" ${draft.status === 'published' ? 'disabled' : ''}></div></div>
      <textarea ${draft.status === 'published' ? 'disabled' : ''}>${escapeHtml(draft.body)}</textarea>
      ${revisions.length ? `<details><summary>Edit diff and history (${revisions.length})</summary><pre class="diff">${escapeHtml(diffText(revisions.at(-1).body, draft.body))}</pre>${revisions.map((r, i) => `<div class="revision"><strong>Version ${i + 1} · ${new Date(r.editedAt).toLocaleString()}</strong><pre>${escapeHtml(r.body)}</pre></div>`).join('')}</details>` : ''}
      <div class="actions">
        <button class="secondary copy">${t('copy')}</button>${draft.status !== 'published' ? `<button class="secondary save">${t('save')}</button>` : ''}
        ${draft.status === 'pending' || draft.status === 'rejected' ? `<button class="primary approve">${t('approve')}</button>` : ''}
        ${draft.status === 'pending' || draft.status === 'approved' ? `<button class="danger reject">${t('reject')}</button>` : ''}
        ${draft.status === 'approved' ? `<select class="connector">${connectorOptions()}</select><button class="primary publish">${t('publish')}</button><input class="schedule-date" type="datetime-local" title="Schedule date"><button class="secondary schedule">${t('schedule')}</button>` : ''}
      </div>${draft.scheduledAt ? `<p class="scheduled">Scheduled ${new Date(draft.scheduledAt).toLocaleString()} via ${escapeHtml(draft.scheduledConnector)}</p>` : ''}</article>`;
  }).join('');
  $$('.draft').forEach((card) => bindDraft(card, state.drafts.find((draft) => draft.id === card.dataset.draft)));
}

function renderCalendar(drafts) {
  const scheduled = drafts.filter((draft) => draft.scheduledAt).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  $('#calendar-list').innerHTML = scheduled.length ? scheduled.map((draft) => `<article class="card calendar-item"><time>${new Date(draft.scheduledAt).toLocaleString()}</time><div><strong>${escapeHtml(draft.title)}</strong><p>${escapeHtml(draft.channel)} · ${escapeHtml(draft.scheduledConnector)}</p></div></article>`).join('') : `<div class="card empty-list">${t('noSchedule')}</div>`;
}

function bindDraft(card, draft) {
  card.querySelector('.pick').onchange = (event) => event.target.checked ? state.selected.add(draft.id) : state.selected.delete(draft.id);
  card.querySelector('.copy').onclick = () => perform(async () => { await navigator.clipboard.writeText(card.querySelector('textarea').value); notify('Copied to clipboard'); });
  card.querySelector('.save')?.addEventListener('click', () => perform(async () => {
    await api(`/api/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ title: card.querySelector('.title-input').value, body: card.querySelector('textarea').value }) }); notify(t('saved')); await loadDrafts();
  }));
  card.querySelector('.approve')?.addEventListener('click', () => transition(draft.id, 'approve'));
  card.querySelector('.reject')?.addEventListener('click', () => transition(draft.id, 'reject'));
  card.querySelector('.publish')?.addEventListener('click', () => perform(async () => {
    const connector = card.querySelector('.connector').value; if (!connector) throw new Error('Choose a connector first');
    await api(`/api/drafts/${draft.id}/publish`, { method: 'POST', body: JSON.stringify({ connector }) }); notify(t('published')); await loadDrafts();
  }));
  card.querySelector('.schedule')?.addEventListener('click', () => perform(async () => {
    const connector = card.querySelector('.connector').value; const date = card.querySelector('.schedule-date').value;
    if (!connector || !date) throw new Error('Choose a connector and date');
    await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: JSON.stringify({ connector, scheduledAt: new Date(date).toISOString() }) }); notify('Draft scheduled'); await loadDrafts();
  }));
}

async function transition(id, action) {
  await perform(async () => { await api(`/api/drafts/${id}/${action}`, { method: 'POST' }); notify(t(action === 'approve' ? 'approved' : 'rejected')); await loadDrafts(); });
}

async function perform(action, button) {
  try { if (button) button.disabled = true; await action(); } catch (error) { notify(error.message, true); } finally { if (button) button.disabled = false; }
}

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }

$$('[data-open-project],#new-project').forEach((button) => button.onclick = () => $('#project-dialog').showModal());
$('[data-close]').onclick = () => $('#project-dialog').close();
$('#project-form').onsubmit = (event) => perform(async () => {
  event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget));
  const data = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
  state.projects.unshift(data.project); $('#project-dialog').close(); event.currentTarget.reset(); renderProjects(); await selectProject(data.project.id);
  if (state.pendingProfileText) { await api(`/api/projects/${data.project.id}/knowledge`, { method: 'POST', body: JSON.stringify({ title: 'Website profile', source: data.project.url, text: state.pendingProfileText }) }); state.pendingProfileText = ''; await loadKnowledge(); }
  notify('Project created');
}, event.submitter);
$$('.tab').forEach((tab) => tab.onclick = () => { $$('.tab,.panel').forEach((el) => el.classList.remove('active')); tab.classList.add('active'); $(`#${tab.dataset.tab}`).classList.add('active'); });
$('#draft-filter').onchange = () => perform(loadDrafts);
$('#generate-strategy').onclick = (event) => perform(async () => {
  $('#generate-strategy').classList.add('loading');
  const data = await streamApi(`/api/projects/${state.current.id}/strategy?stream=1`, { method: 'POST', body: '{}' }, (message) => notify(message));
  state.current = data.project; state.projects = state.projects.map((p) => p.id === data.project.id ? data.project : p); $('#strategy-content').textContent = data.project.strategy; $('#strategy-content').classList.remove('muted'); notify('Strategy generated');
}, event.currentTarget).finally(() => $('#generate-strategy').classList.remove('loading'));
$('#run-form').onsubmit = (event) => perform(async () => {
  event.preventDefault(); const progress = $('#run-progress'); progress.hidden = false;
  const payload = { task: $('#task').value, questionCount: Number($('#question-count').value), questions: $('#geo-questions').value.split('\n').map((value) => value.trim()).filter(Boolean) };
  const data = await streamApi(`/api/projects/${state.current.id}/agents/${state.selectedAgent}/run?stream=1`, { method: 'POST', body: JSON.stringify(payload) }, (message) => progress.querySelector('span:last-child').textContent = message);
  $('#task').value = ''; notify(`${data.drafts.length} draft${data.drafts.length === 1 ? '' : 's'} created`); $('[data-tab="inbox"]').click(); await Promise.all([loadDrafts(), loadGeoHistory()]);
}, event.submitter).finally(() => { $('#run-progress').hidden = true; });

$('#select-all').onclick = () => { $$('.pick').forEach((box) => { box.checked = true; state.selected.add(box.closest('.draft').dataset.draft); }); };
async function bulk(action) { if (!state.selected.size) return notify('Select at least one draft', true); await perform(async () => { await api('/api/drafts/bulk', { method: 'POST', body: JSON.stringify({ ids: [...state.selected], action }) }); notify(`Selected drafts ${action}d`); await loadDrafts(); }); }
$('#bulk-approve').onclick = () => bulk('approve'); $('#bulk-reject').onclick = () => bulk('reject');
document.addEventListener('keydown', (event) => {
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  const card = document.activeElement?.closest?.('.draft'); if (!card) return;
  if (event.key === 'a') card.querySelector('.approve')?.click();
  if (event.key === 'r') card.querySelector('.reject')?.click();
  if (event.key === 'e') card.querySelector('textarea')?.focus();
});

$('#workspace-language').onchange = (event) => perform(async () => {
  const data = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ language: event.target.value }) });
  state.current = data.project; state.projects = state.projects.map((p) => p.id === data.project.id ? data.project : p); state.language = data.project.language; updateTranslations(); notify('Project language updated');
  renderAgents(); renderDrafts();
});

$('#open-settings').onclick = () => perform(async () => {
  const data = await api('/api/settings'); const form = $('#settings-form');
  Object.entries(data.settings).forEach(([key, value]) => { if (!form.elements[key]) return; if (form.elements[key].type === 'checkbox') form.elements[key].checked = value === '1'; else form.elements[key].value = value; }); renderSettingsMeta(data); $('#settings-dialog').showModal();
});
$('[data-close-settings]').onclick = () => $('#settings-dialog').close();
$('#settings-form').onsubmit = (event) => perform(async () => {
  event.preventDefault(); await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
  state.connectors = (await api('/api/connectors')).connectors; $('#settings-dialog').close(); notify('Settings saved'); await loadDrafts();
}, event.submitter);
$('#test-llm').onclick = (event) => perform(async () => {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(settingsPayload()) });
  await api('/api/settings/test-llm', { method: 'POST' }); notify('LLM connection works');
}, event.currentTarget);

$('#profile-site').onclick = (event) => perform(async () => {
  const form = $('#project-form'); const url = form.elements.url.value; if (!url) throw new Error('Enter a website URL first');
  const { profile } = await api('/api/onboarding/profile', { method: 'POST', body: JSON.stringify({ url }) });
  for (const key of ['name', 'description', 'audience', 'tone']) if (profile[key] && !form.elements[key].value) form.elements[key].value = profile[key];
  state.pendingProfileText = profile.text || ''; notify('Website profile ready for review');
}, event.currentTarget);

$('#knowledge-file').onchange = async (event) => { const file = event.target.files[0]; if (file) $('#knowledge-text').value = await file.text(); };
$('#knowledge-form').onsubmit = (event) => perform(async () => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); await api(`/api/projects/${state.current.id}/knowledge`, { method: 'POST', body: JSON.stringify(body) }); event.currentTarget.reset(); await loadKnowledge(); notify('Knowledge document added'); }, event.submitter);
$('#import-site').onclick = (event) => perform(async () => { await api(`/api/projects/${state.current.id}/knowledge/import-site`, { method: 'POST' }); await loadKnowledge(); notify('Website imported'); }, event.currentTarget);
$('#policy-form').onsubmit = (event) => perform(async () => { event.preventDefault(); await api('/api/policy', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await loadPolicy(); notify('Policy saved'); }, event.submitter);
$('#stop-agents').onclick = (event) => perform(async () => { const paused = event.currentTarget.dataset.paused !== 'true'; await api('/api/agents/stop', { method: 'POST', body: JSON.stringify({ paused }) }); await loadPolicy(); notify(paused ? 'All agents stopped and approval queue cleared' : 'Agents resumed'); }, event.currentTarget);

function settingsPayload() { const form = $('#settings-form'); const result = Object.fromEntries(new FormData(form)); for (const name of ['ragEmbeddings', 'briefsEnabled', 'briefTelegram', 'hindsightEnabled']) result[name] = form.elements[name].checked ? '1' : '0'; return result; }
$('#settings-form').onsubmit = (event) => perform(async () => {
  event.preventDefault(); await api('/api/settings', { method: 'PUT', body: JSON.stringify(settingsPayload()) });
  state.connectors = (await api('/api/connectors')).connectors; $('#settings-dialog').close(); notify('Settings saved'); await loadDrafts();
}, event.submitter);
$('#create-backup').onclick = (event) => perform(async () => { await api('/api/backups', { method: 'POST' }); notify('Backup created'); const data = await api('/api/settings'); renderSettingsMeta(data); }, event.currentTarget);

function renderSettingsMeta(data) {
  $('#llm-stats').textContent = `${data.llm.calls24h} calls · ${data.llm.errors24h} errors · ${data.llm.avgMs} ms average · ${data.llm.tokens24h} estimated tokens (24h)`;
  $('#integrity-status').textContent = `Database integrity: ${data.integrity}`;
  $('#backup-list').innerHTML = data.backups.length ? data.backups.map((item) => `<p>${escapeHtml(item.name)} · ${Math.ceil(item.size / 1024)} KB <button type="button" class="danger" data-restore="${escapeHtml(item.name)}">Restore</button></p>`).join('') : '<p class="muted">No backups yet.</p>';
  $$('[data-restore]').forEach((button) => button.onclick = () => perform(async () => { if (!confirm('Restore this backup on the next app restart? A safety copy will be kept.')) return; await api(`/api/backups/${encodeURIComponent(button.dataset.restore)}/restore`, { method: 'POST' }); notify('Restore staged. Restart OpenCMO to apply it.'); }));
}

load().catch((error) => notify(error.message, true));
