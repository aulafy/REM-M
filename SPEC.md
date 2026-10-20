# OpenCMO — spec (MIT, local-first "AI CMO")

Open-source alternative to okara.ai's "AI CMO": marketing agents that research, draft and (only after HUMAN APPROVAL) publish. Runs locally with `npm start`.

## Stack
Node >=20, TypeScript (tsx, no build step needed for dev), Hono server, better-sqlite3, vanilla HTML/CSS/JS UI served statically (no frontend framework). Zero cloud dependency: LLM via any OpenAI-compatible endpoint (default Ollama `http://localhost:11434/v1`, configurable in `.env`: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL).

## Core concepts
- **Project**: a business (name, url, description, audience, tone). Onboarding = enter URL → fetch + extract text → LLM builds a "Strategy doc" (positioning, ICP, keywords, competitors, channels).
- **Agent**: id, name, system prompt, `run(project, task)` → produces **Drafts**.
- **Draft**: status `pending | approved | rejected | published`, channel, title, body, metadata. NOTHING is published without explicit approval click.
- **Connector**: `publish(draft)` implementations, each optional, configured by env tokens.

## Agents (v0.1)
1. Writer — blog posts/articles from keywords.
2. SEO — audits a URL (title, meta, h1, links, missing alt, sitemap/robots) deterministically + LLM recommendations.
3. GEO — "AI search visibility": generates the questions buyers ask LLMs, checks whether the brand appears in answers from the configured LLM, outputs gaps + content to fix them.
4. Reddit — finds relevant subreddits/threads via Reddit public JSON search, drafts helpful non-spammy replies (never auto-posts; copy-only).
5. X — tweet/thread drafts.
6. LinkedIn — post drafts.

## Connectors (v0.1)
- Markdown export to a folder (always works).
- WordPress REST (application password).
- GitHub (commit markdown file to a repo via API).
- Webhook (generic POST).
Others (Webflow, Framer, Telegram…) listed in README roadmap.

## HTTP API (JSON)
- GET/POST /api/projects, POST /api/projects/:id/strategy
- GET /api/agents, POST /api/projects/:id/agents/:agent/run {task}
- GET /api/drafts?project=&status=, PATCH /api/drafts/:id (edit body), POST /api/drafts/:id/approve|reject|publish {connector}
- GET /api/connectors (which are configured)

## UI (single page, /)
Sidebar: projects. Tabs: Strategy · Agents (run with a task box) · Inbox (drafts with edit / approve / reject / publish dropdown). Clean, light, minimal.

## Repo hygiene
LICENSE (MIT, "OpenCMO contributors"), README (EN, with quickstart, architecture, roadmap, "not affiliated with okara.ai"), .env.example, .gitignore (node_modules, data/, .env), `npm test` with node:test covering SEO audit parser, draft approval state machine (publish before approve must fail), and an LLM stub.

# v0.2 improvements (do all, keep tests green, add tests for new logic)
1. **Settings UI + API**: configure LLM base URL/model/key and connector credentials from the browser (stored in SQLite `settings`, API keys never returned in full—mask them). "Test LLM connection" button. Env vars remain defaults.
2. **Streaming**: agent runs and strategy generation stream progress via SSE (`/api/.../run?stream=1`); UI shows live output and a spinner; clear error messages when the LLM is unreachable (with Ollama hint).
3. **Better GEO**: configurable list of N questions, run each against the LLM, detect brand/competitor mentions with simple fuzzy matching, show a visibility score and per-question table; store history per project so score trends are visible.
4. **More agents/connectors**: Newsletter agent, Hacker News/Product Hunt launch-post agent; Telegram connector (bot token + chat id) and Discord webhook connector.
5. **Content calendar**: schedule approved drafts for a date; a lightweight in-process scheduler publishes due drafts (only already-approved ones) every minute; UI calendar/list view.
6. **UI polish**: dark mode (prefers-color-scheme), draft diff of edits, bulk approve/reject, copy button, keyboard shortcuts (a/r/e in inbox), toast notifications, empty states, mobile layout. Still vanilla JS, no build step.
7. **i18n**: UI + agent output language selectable per project (en/es at least); default from browser.
8. **Ops**: Dockerfile + docker-compose.yml (with optional Ollama service), GitHub Actions CI (node 20/22: npm ci, tsc --noEmit, npm test), CONTRIBUTING.md, SECURITY note (SSRF guard: URL fetchers must block private/loopback IPs unless ALLOW_PRIVATE_FETCH=1; add tests), basic rate limit on API, bind to 127.0.0.1 by default.
9. **README**: add screenshots placeholder section, comparison table vs okara.ai, updated roadmap. Bump to v0.2.0.

# v0.3: port useful parts of REM-L (MIT, same author)
Reference source (read-only, JS): /private/tmp/claude-501/-Users-mac-carpeta-sin-t-tulo/914086e3-df1f-4e55-95dc-75c912c20edb/scratchpad/reml/src/lib/ (rag.mjs, policy.mjs, agents.mjs, llmlog.mjs, webprofile.mjs, scheduler.mjs, telegram.mjs, notify.mjs, backup-engine.mjs, hindsight.mjs). Port the IDEAS to our TypeScript/Hono/better-sqlite3 code (do not copy invoicing/tax/macOS stuff). Attribute in README ("ideas ported from REM-L"). Zero new dependencies. Add tests for each.
1. **Brand knowledge base (RAG)**: per-project documents (paste text / upload .md/.txt, or "import from my site") chunked + BM25 (Spanish stopwords + accent folding, as rag.mjs) with optional Ollama embeddings fused by RRF. Every agent retrieves top-k chunks and injects them as quoted DATA (never instructions) in its prompt, with citations. UI tab "Knowledge".
2. **Action policy + kill switch**: port policy.mjs: per-action modes act|ask|handoff, a hard FLOOR in code that no setting can unlock (publish_without_approval, delete_data, export_data, change_settings, change_policy, connect_channel). Route every agent side effect (create draft, schedule, publish, save_memory) through one `runAction()` like agents.mjs; approvals table, append-only activity log (jsonl), "Stop all" button that pauses agents and clears the queue. UI: Policy panel + Activity log.
3. **LLM observability**: port llmlog.mjs: record every LLM call (purpose, model, ms, tokens, status; never prompt text) in SQLite, hourly cap (setting llm_max_per_hour, default 60), 24h stats shown in Settings.
4. **Safer site fetching**: adopt webprofile.mjs's fetcher: http/https only, DNS lookup filtering of private IPs (also after redirects, anti DNS-rebinding), size/time/redirect limits, honor robots.txt, polite UA. Use it for SEO audit, GEO, and onboarding.
5. **Website profile onboarding (no-LLM first)**: extract JSON-LD, OpenGraph, meta, social links, contact info, main headings from the project's URL, prefill project fields and knowledge base; LLM only fills gaps with closed, validated JSON output (validateDraft-style strict validation, bounded lengths). User reviews before saving.
6. **Daily briefs**: port scheduler idea: "Morning" agent (what is pending approval, scheduled for today, GEO trend change, SEO issues open) and "Evening" agent (what was published, tomorrow's schedule), read-only, run at configurable times and catch up on start; output as a Briefing draft; optional Telegram notification (bot token+chat id; notify only, never executes actions from incoming messages).
7. **Backups & integrity**: daily automatic SQLite backup (VACUUM INTO) keeping last 20, manual backup/restore in Settings, integrity_check at startup with clear UI message.
8. **Optional long-term memory**: optional Hindsight integration (hindsight.mjs) behind a setting, off by default; recall results are DATA only. Skip if time is short.
Bump version to 0.3.0; update README (features, security model, attribution) and CHANGELOG.md.

# v0.4 PRODUCT PASS A — make it sellable and genuinely useful
Audience: non-technical founders, freelancers and small agencies. Today it is a developer tool (mixed EN/ES labels like "knowledge"/"policy", duplicate projects, empty states that say "configure your LLM", no guidance). Goal: a first-time user gets real value within 3 minutes and understands what to do next every day. Keep zero new deps, vanilla JS UI, tests green (add tests), no commits.
1. **First-run wizard** (full-screen, skippable, resumable): Step 1 choose AI engine: auto-detect Ollama (list installed models, warn if <7B: "small models give unreliable advice"), or cloud presets (OpenRouter, OpenAI, Anthropic-compatible gateway, Groq, Gemini OpenAI-compat) with key field + "Test" button; Step 2 enter site URL + language → run onboarding profile; Step 3 live-progress "Analyzing your site…" producing in one go: Site Health Report (score 0–100 from deterministic checks), strategy, and 5 starter drafts; ends on the Home dashboard.
2. **Home / "Today" dashboard per project** (default tab): health score with trend, "Your next 3 actions" (ranked from open SEO issues, pending approvals, empty calendar days, stale GEO), pending approvals count, this week's schedule, last brief. Every card has one primary button. No jargon.
3. **"Generate my month"**: one click builds a 30-day multi-channel content plan from strategy + knowledge base (topics, channel, date, angle) as drafts in `pending`, auto-spread on the calendar; user bulk-approves. Never publishes by itself (policy floor stays).
4. **Draft quality guardrails**: each draft shows "Sources used" (knowledge chunks cited); per-channel limits enforced (X 280/thread, LinkedIn ~1300, meta description 155, etc.) with live counters; "AI-sounding phrases" check that flags clichés and offers a one-click rewrite; "Regenerate with feedback" box.
5. **Polish & consistency**: dedupe projects by normalized URL (merge prompt); fully translate every UI string (en/es; no leftover English tab names or "PROJECTS"); tab names: Today, Strategy, Knowledge, Agents, Inbox, Calendar, Rules; friendly errors with a fix button (e.g. LLM unreachable → open Settings / wizard); loading skeletons; undo for reject; keyboard shortcut help (?); accessible focus states; mobile layout checked.
6. **Demo mode**: "Try with a sample business" creates a fictitious project with canned strategy, drafts and GEO history without needing any LLM, clearly labelled DEMO and deletable.
7. **Settings simplification**: Basic (AI engine, language, folder for exports) vs Advanced (connectors, backups, Telegram, Hindsight, rate caps).
Update README (screenshots section can stay placeholders), CHANGELOG, bump 0.4.0.
