const state = { projects: [], current: null, agents: [], selectedAgent: 'writer', connectors: [], drafts: [] };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function notify(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { $('#status').textContent = ''; }, 5000);
}

async function load() {
  const [projectData, agentData, connectorData] = await Promise.all([api('/api/projects'), api('/api/agents'), api('/api/connectors')]);
  state.projects = projectData.projects;
  state.agents = agentData.agents;
  state.connectors = connectorData.connectors;
  renderProjects();
  renderAgents();
  if (state.projects.length) await selectProject(state.projects[0].id);
}

function renderProjects() {
  $('#projects').innerHTML = state.projects.map((p) => `<button data-project="${p.id}" class="${state.current?.id === p.id ? 'active' : ''}">${escapeHtml(p.name)}</button>`).join('');
  $$('[data-project]').forEach((button) => button.onclick = () => selectProject(button.dataset.project));
}

async function selectProject(id) {
  state.current = state.projects.find((project) => project.id === id);
  $('#empty').hidden = true;
  $('#workspace').hidden = false;
  $('#project-title').textContent = state.current.name;
  $('#strategy-content').textContent = state.current.strategy || 'No strategy yet. Generate one after configuring your local LLM.';
  $('#strategy-content').classList.toggle('muted', !state.current.strategy);
  renderProjects();
  await loadDrafts();
}

function renderAgents() {
  $('#agent-grid').innerHTML = state.agents.map((a) => `<button class="agent ${a.id === state.selectedAgent ? 'selected' : ''}" data-agent="${a.id}"><h3>${escapeHtml(a.name)}</h3><p>${escapeHtml(a.description)}</p></button>`).join('');
  $$('[data-agent]').forEach((button) => button.onclick = () => {
    state.selectedAgent = button.dataset.agent;
    $('#selected-agent').textContent = state.agents.find((a) => a.id === state.selectedAgent).name;
    renderAgents();
  });
}

async function loadDrafts() {
  const status = $('#draft-filter').value;
  const data = await api(`/api/drafts?project=${encodeURIComponent(state.current.id)}${status ? `&status=${status}` : ''}`);
  state.drafts = data.drafts;
  const all = status ? (await api(`/api/drafts?project=${encodeURIComponent(state.current.id)}`)).drafts : state.drafts;
  $('#pending-count').textContent = all.filter((draft) => draft.status === 'pending').length;
  renderDrafts();
}

function renderDrafts() {
  if (!state.drafts.length) { $('#drafts').innerHTML = '<div class="card empty-list">No drafts in this view.</div>'; return; }
  $('#drafts').innerHTML = state.drafts.map((draft) => `<article class="card draft" data-draft="${draft.id}">
    <div class="draft-head"><div><span class="badge ${draft.status}">${draft.status}</span> <small>${escapeHtml(draft.channel)} · ${escapeHtml(draft.agentId)}</small><h3>${escapeHtml(draft.title)}</h3></div></div>
    <textarea ${draft.status === 'published' ? 'disabled' : ''}>${escapeHtml(draft.body)}</textarea>
    <div class="actions">
      ${draft.status !== 'published' ? '<button class="secondary save">Save edit</button>' : ''}
      ${draft.status === 'pending' || draft.status === 'rejected' ? '<button class="primary approve">Approve</button>' : ''}
      ${draft.status === 'pending' || draft.status === 'approved' ? '<button class="danger reject">Reject</button>' : ''}
      ${draft.status === 'approved' ? `<select class="connector"><option value="">Choose connector…</option>${state.connectors.map((c) => `<option value="${c.id}" ${c.configured ? '' : 'disabled'}>${escapeHtml(c.name)}${c.configured ? '' : ' (not configured)'}</option>`).join('')}</select><button class="primary publish">Publish</button>` : ''}
    </div></article>`).join('');
  $$('.draft').forEach((card) => bindDraft(card, state.drafts.find((draft) => draft.id === card.dataset.draft)));
}

function bindDraft(card, draft) {
  card.querySelector('.save')?.addEventListener('click', () => perform(async () => {
    await api(`/api/drafts/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ body: card.querySelector('textarea').value }) });
    notify('Draft saved'); await loadDrafts();
  }));
  card.querySelector('.approve')?.addEventListener('click', () => perform(async () => { await api(`/api/drafts/${draft.id}/approve`, { method: 'POST' }); notify('Draft approved'); await loadDrafts(); }));
  card.querySelector('.reject')?.addEventListener('click', () => perform(async () => { await api(`/api/drafts/${draft.id}/reject`, { method: 'POST' }); notify('Draft rejected'); await loadDrafts(); }));
  card.querySelector('.publish')?.addEventListener('click', () => perform(async () => {
    const connector = card.querySelector('.connector').value;
    if (!connector) throw new Error('Choose a connector first');
    await api(`/api/drafts/${draft.id}/publish`, { method: 'POST', body: JSON.stringify({ connector }) });
    notify('Draft published'); await loadDrafts();
  }));
}

async function perform(action, button) {
  try { if (button) button.disabled = true; await action(); } catch (error) { notify(error.message, true); } finally { if (button) button.disabled = false; }
}

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }

$$('[data-open-project],#new-project').forEach((button) => button.onclick = () => $('#project-dialog').showModal());
$('[data-close]').onclick = () => $('#project-dialog').close();
$('#project-form').onsubmit = (event) => perform(async () => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  const data = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
  state.projects.unshift(data.project); $('#project-dialog').close(); event.currentTarget.reset(); renderProjects(); await selectProject(data.project.id); notify('Project created');
}, event.submitter);
$$('.tab').forEach((tab) => tab.onclick = () => { $$('.tab,.panel').forEach((el) => el.classList.remove('active')); tab.classList.add('active'); $(`#${tab.dataset.tab}`).classList.add('active'); });
$('#draft-filter').onchange = () => perform(loadDrafts);
$('#generate-strategy').onclick = (event) => perform(async () => {
  const data = await api(`/api/projects/${state.current.id}/strategy`, { method: 'POST' });
  state.current = data.project; state.projects = state.projects.map((p) => p.id === data.project.id ? data.project : p); $('#strategy-content').textContent = data.project.strategy; $('#strategy-content').classList.remove('muted'); notify('Strategy generated');
}, event.currentTarget);
$('#run-form').onsubmit = (event) => perform(async () => {
  event.preventDefault();
  const task = $('#task').value;
  const data = await api(`/api/projects/${state.current.id}/agents/${state.selectedAgent}/run`, { method: 'POST', body: JSON.stringify({ task }) });
  $('#task').value = ''; notify(`${data.drafts.length} draft${data.drafts.length === 1 ? '' : 's'} created`); document.querySelector('[data-tab="inbox"]').click(); await loadDrafts();
}, event.submitter);

load().catch((error) => notify(error.message, true));
