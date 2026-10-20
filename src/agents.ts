import type { AgentDefinition, AgentRunOptions, DraftInput, LLM, Project } from './types.js';
import { AppError } from './errors.js';
import { auditUrl } from './web.js';

export const agentDefinitions: AgentDefinition[] = [
  { id: 'writer', name: 'Writer', description: 'Drafts useful long-form articles from a topic or keyword.', systemPrompt: 'You are a senior content marketer. Write specific, useful, evidence-conscious prose. Never invent customer claims or statistics. Return polished Markdown.' },
  { id: 'seo', name: 'SEO', description: 'Runs a deterministic on-page audit and adds prioritized recommendations.', systemPrompt: 'You are a technical SEO specialist. Prioritize concrete fixes from the supplied audit. Do not claim checks that were not performed.' },
  { id: 'geo', name: 'GEO', description: 'Tests brand visibility in simulated buyer questions and drafts a gap analysis.', systemPrompt: 'You specialize in visibility in AI answers. Analyze supplied questions and answers conservatively, then recommend content that makes the brand clearly citable.' },
  { id: 'reddit', name: 'Reddit', description: 'Finds relevant public discussions and drafts helpful, non-promotional replies.', systemPrompt: 'You write genuinely helpful Reddit replies. Answer the question directly, disclose affiliations where relevant, avoid hype, and never pretend to have personal experience.' },
  { id: 'x', name: 'X', description: 'Creates concise posts or threads for X.', systemPrompt: 'You write sharp, credible posts for X. Avoid engagement bait and fabricated facts. Return plain text with thread posts numbered when needed.' },
  { id: 'linkedin', name: 'LinkedIn', description: 'Creates practical professional posts for LinkedIn.', systemPrompt: 'You write thoughtful LinkedIn posts with a clear point, useful detail, and restrained formatting. Avoid generic inspiration and fake anecdotes.' },
  { id: 'newsletter', name: 'Newsletter', description: 'Drafts useful email newsletters with subject and preview text.', systemPrompt: 'You write valuable email newsletters. Lead with reader value, use a clear subject and preview line, and include one restrained call to action. Never invent claims.' },
  { id: 'launch', name: 'HN / Product Hunt', description: 'Drafts candid launch posts adapted for Hacker News or Product Hunt.', systemPrompt: 'You write transparent launch posts for Hacker News and Product Hunt. Explain what was built, for whom, why, tradeoffs, and invite useful feedback. Avoid hype and vote solicitation.' },
];

function context(project: Project): string {
  return `Business: ${project.name}\nURL: ${project.url || 'not supplied'}\nDescription: ${project.description || 'not supplied'}\nAudience: ${project.audience || 'not supplied'}\nTone: ${project.tone || 'not supplied'}\nCompetitors: ${project.competitors?.join(', ') || 'not supplied'}\nOutput language: ${project.language === 'es' ? 'Spanish' : 'English'} (write the complete output in this language)\nStrategy:\n${project.strategy || 'not generated yet'}`;
}

function firstLineTitle(text: string, fallback: string): string {
  const line = text.split('\n').find((item) => item.trim())?.replace(/^#+\s*/, '').trim();
  return (line || fallback).slice(0, 140);
}

async function runWriter(project: Project, task: string, llm: LLM): Promise<DraftInput[]> {
  const body = await llm.complete(agentDefinitions[0].systemPrompt, `${context(project)}\n\nWrite a complete article for this assignment: ${task}\nUse a descriptive title, headings, and a practical conclusion.`);
  return [{ channel: 'blog', title: firstLineTitle(body, task), body, metadata: { task } }];
}

async function runSeo(project: Project, task: string, llm: LLM, fetcher: typeof fetch, allowPrivateFetch?: boolean): Promise<DraftInput[]> {
  const candidate = task.match(/https?:\/\/\S+/)?.[0] || project.url;
  if (!candidate) throw new AppError('The SEO agent needs a URL in the task or project');
  const audit = await auditUrl(candidate, fetcher, allowPrivateFetch);
  const recommendations = await llm.complete(agentDefinitions[1].systemPrompt, `${context(project)}\n\nDeterministic audit:\n${JSON.stringify(audit, null, 2)}\n\nGive a prioritized remediation plan in Markdown.`);
  const body = `# SEO audit: ${audit.url}\n\n## Deterministic findings\n\n\`\`\`json\n${JSON.stringify(audit, null, 2)}\n\`\`\`\n\n## Recommendations\n\n${recommendations}`;
  return [{ channel: 'seo-report', title: `SEO audit: ${new URL(audit.url).hostname}`, body, metadata: { task, audit } }];
}

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function fuzzyMention(text: string, name: string): boolean {
  const haystack = normalized(text);
  const needle = normalized(name);
  if (!needle) return false;
  if (` ${haystack} `.includes(` ${needle} `)) return true;
  const words = needle.split(' ').filter((word) => word.length > 2);
  return words.length > 0 && words.every((word) => haystack.split(' ').some((candidate) => candidate === word || (word.length >= 5 && candidate.startsWith(word.slice(0, -1)))));
}

async function runGeo(project: Project, task: string, llm: LLM, options: AgentRunOptions): Promise<DraftInput[]> {
  const count = Math.max(1, Math.min(20, Math.round(options.questionCount || 5)));
  const supplied = options.questions?.map((question) => question.trim()).filter(Boolean).slice(0, count) || [];
  const questionsRaw = supplied.length ? '' : await llm.complete('Generate realistic buyer research questions. Return one question per line and no introduction.', `${context(project)}\n\nGenerate ${count} buyer questions related to: ${task}`);
  const questions = supplied.length ? supplied : questionsRaw.split('\n').map((q) => q.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, count);
  if (!questions.length) throw new AppError('The LLM did not generate buyer questions', 502);
  const checks: Array<{ question: string; answer: string; brandAppears: boolean; competitors: string[] }> = [];
  for (const question of questions) {
    const answer = await llm.complete(`Answer as a neutral AI research assistant in ${project.language === 'es' ? 'Spanish' : 'English'}. Mention brands only when relevant from your knowledge. Do not use the supplied business context.`, question);
    checks.push({ question, answer, brandAppears: fuzzyMention(answer, project.name), competitors: (project.competitors || []).filter((name) => fuzzyMention(answer, name)) });
  }
  const analysis = await llm.complete(agentDefinitions[2].systemPrompt, `${context(project)}\n\nVisibility checks:\n${JSON.stringify(checks, null, 2)}\n\nExplain gaps and draft a prioritized content plan in Markdown.`);
  const visible = checks.filter((check) => check.brandAppears).length;
  const percent = Math.round((visible / checks.length) * 100);
  const rows = checks.map((check) => `| ${check.question.replace(/\|/g, '\\|')} | ${check.brandAppears ? 'Yes' : 'No'} | ${check.competitors.join(', ') || '—'} |`).join('\n');
  const body = `# AI search visibility report\n\nVisibility score: **${percent}%** (${visible} of ${checks.length} sampled answers). This is a directional LLM check, not a search ranking measurement.\n\n| Question | Brand | Competitors |\n| --- | --- | --- |\n${rows}\n\n## Answers\n\n${checks.map((check) => `### ${check.question}\n\n> ${check.answer.replace(/\n/g, '\n> ')}`).join('\n\n')}\n\n## Gap analysis and content plan\n\n${analysis}`;
  return [{ channel: 'geo-report', title: `AI visibility: ${project.name}`, body, metadata: { task, checks, score: { visible, total: checks.length, percent } } }];
}

type RedditChild = { data?: { title?: string; selftext?: string; subreddit?: string; permalink?: string; url?: string } };

async function runReddit(project: Project, task: string, llm: LLM, fetcher: typeof fetch): Promise<DraftInput[]> {
  const url = new URL('https://www.reddit.com/search.json');
  url.searchParams.set('q', task);
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('limit', '5');
  let response: Response;
  try {
    response = await fetcher(url, { headers: { 'user-agent': 'OpenCMO/0.1 (local research tool)' }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new AppError(`Reddit search failed: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  if (!response.ok) throw new AppError(`Reddit search returned HTTP ${response.status}`, 502);
  const payload = await response.json() as { data?: { children?: RedditChild[] } };
  const threads = (payload.data?.children || []).map((child) => child.data).filter((item): item is NonNullable<typeof item> => Boolean(item?.title));
  if (!threads.length) throw new AppError('No relevant Reddit threads were found', 404);
  const drafts: DraftInput[] = [];
  for (const thread of threads.slice(0, 3)) {
    const threadUrl = thread.permalink ? `https://www.reddit.com${thread.permalink}` : thread.url || '';
    const body = await llm.complete(agentDefinitions[3].systemPrompt, `${context(project)}\n\nThread title: ${thread.title}\nSubreddit: r/${thread.subreddit || 'unknown'}\nPost: ${(thread.selftext || '').slice(0, 4000)}\n\nDraft a reply for human review. Do not force a brand mention. If mentioning the business, explicitly disclose the connection.`);
    drafts.push({ channel: 'reddit-copy', title: `Reply: ${thread.title}`.slice(0, 140), body, metadata: { task, subreddit: thread.subreddit, threadUrl, copyOnly: true } });
  }
  return drafts;
}

async function runSocial(agent: AgentDefinition, channel: string, project: Project, task: string, llm: LLM): Promise<DraftInput[]> {
  const instruction = channel === 'x'
    ? 'Draft either one post under 280 characters or a thread of at most 5 individually numbered posts.'
    : 'Draft one LinkedIn post, ideally under 1,500 characters.';
  const body = await llm.complete(agent.systemPrompt, `${context(project)}\n\nAssignment: ${task}\n${instruction}`);
  return [{ channel, title: `${agent.name}: ${task}`.slice(0, 140), body, metadata: { task } }];
}

async function runNewsletter(project: Project, task: string, llm: LLM): Promise<DraftInput[]> {
  const agent = agentDefinitions.find((item) => item.id === 'newsletter')!;
  const body = await llm.complete(agent.systemPrompt, `${context(project)}\n\nAssignment: ${task}\nReturn Markdown beginning with Subject and Preview text, followed by the complete newsletter.`);
  return [{ channel: 'newsletter', title: firstLineTitle(body, `Newsletter: ${task}`), body, metadata: { task } }];
}

async function runLaunch(project: Project, task: string, llm: LLM): Promise<DraftInput[]> {
  const agent = agentDefinitions.find((item) => item.id === 'launch')!;
  const body = await llm.complete(agent.systemPrompt, `${context(project)}\n\nLaunch details: ${task}\nDraft two labeled variants: Hacker News Show HN and Product Hunt. Observe each community's norms.`);
  return [{ channel: 'launch-copy', title: `Launch: ${task}`.slice(0, 140), body, metadata: { task, copyOnly: true } }];
}

export async function runAgent(id: string, project: Project, task: string, llm: LLM, fetcher: typeof fetch = fetch, options: AgentRunOptions = {}): Promise<DraftInput[]> {
  const cleanTask = task.trim();
  if (!cleanTask) throw new AppError('task is required');
  switch (id) {
    case 'writer': return runWriter(project, cleanTask, llm);
    case 'seo': return runSeo(project, cleanTask, llm, fetcher, options.allowPrivateFetch);
    case 'geo': return runGeo(project, cleanTask, llm, options);
    case 'reddit': return runReddit(project, cleanTask, llm, fetcher);
    case 'x': return runSocial(agentDefinitions[4], 'x', project, cleanTask, llm);
    case 'linkedin': return runSocial(agentDefinitions[5], 'linkedin', project, cleanTask, llm);
    case 'newsletter': return runNewsletter(project, cleanTask, llm);
    case 'launch': return runLaunch(project, cleanTask, llm);
    default: throw new AppError('Agent not found', 404);
  }
}
