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

# v0.5 PRODUCT PASS B — sellable to freelancers/agencies + fixes
Fixes found in manual QA of v0.4 (do first):
- Wizard step 1: the cloud-provider form is always visible even when a local Ollama model is selected; collapse it unless "Use a cloud provider" is chosen. Filter embedding-only models (nomic-embed, *embed*, bge-*) out of the chat model list. Mark models <7B with a "small — advice may be unreliable" badge.
- Today card shows score 78 and "No site check yet" simultaneously (demo) — make consistent.
- Demo drafts show "Sources used (0)": give demo drafts sample sources.
Features:
1. **White-label client reports**: "Export report" produces a single self-contained, print-friendly HTML (and print CSS for PDF) with: cover (project logo/name, agency name, accent color from Settings → Branding), executive summary, health score + issues with plain-language impact and fix, GEO visibility, top opportunities, 30-day plan, next steps. No OpenCMO branding unless "Powered by" toggle is on. Works offline.
2. **Search Console import**: upload GSC "Queries" CSV (EN/ES column names) → opportunities table (impressions high, position 8–30, CTR low), each with a button "Draft an article for this query" that sends it to the Writer agent with the query and context.
3. **Competitor comparison**: add up to 5 competitor URLs; run the deterministic audit on each (safe fetcher) and show a side-by-side table (title/meta quality, headings, schema, OG, speed proxy = html size), plus "where they beat you" list. No LLM needed for the table.
4. **Multi-project overview** (agency view): a home screen listing all projects with health score, pending approvals, next scheduled post and overdue items; one-click open.
5. **Landing page** in /docs (static, no build, GitHub Pages ready): hero, how it works (3 steps), features, "local-first & approval-first" trust section, comparison with okara.ai and SaaS tools (honest), FAQ, install section, MIT badge, "for freelancers & agencies" section about white-label reports. EN + ES versions. Plus docs/LAUNCH.md with a launch checklist (GitHub topics, Product Hunt/HN/Reddit post drafts, pricing ideas for an optional hosted/managed offering — clearly labelled as ideas).
6. **Install in one command**: `npx`-style bin entry (`bin/opencmo.js`, with `--port`, `--data-dir`, opens browser), `start.command` for macOS double-click, Dockerfile already exists: verify and add `docker compose up` quickstart to README top.
7. **Trust & safety page** in-app (Rules tab intro): plain-language explanation of what the AI can and cannot do, what leaves the computer, and where data is stored.
Add tests, update README/CHANGELOG, bump 0.5.0, no new deps, no commits.

# v0.6 PASS C — reliability with real local models (found by testing on aulafy.net with qwen3.5 9B @ ~13 tok/s)
Real-run findings: strategy generation took 291 s; "Generate my month" FAILED with a 300 s timeout because it asks one LLM call for 30 full bodies. A product people pay for must not depend on a single multi-minute call. Do:
1. **Background job system**: `jobs` table (id, project_id, kind, status queued|running|done|failed|cancelled, progress, total, message, error, created/updated). A single-concurrency in-process worker (LLM calls are serialized; cap by LLM_MAX_CONCURRENCY default 1). Jobs survive restart (running → queued on boot). API: GET /api/jobs?project=, POST /api/jobs/:id/cancel, GET /api/jobs/stream (SSE). UI: persistent progress chip in the header ("Writing your plan 7/30"), non-blocking, with cancel; toast on completion; failures show retry.
2. **Month plan in 2 phases**: (a) outline in 4 weekly batches of ~7–8 items each as compact JSON (topic, title, channel, angle — no bodies), robust JSON extraction/repair + one retry per batch, dedupe titles; create drafts immediately with status pending and `body` placeholder + metadata.needsBody=true; (b) a job fills bodies one draft at a time (short, channel-limited prompts, grounded in knowledge chunks), so the user sees the calendar fill in within ~2 minutes and can start reviewing while the rest is written. Each draft card gets "Write this one now" (priority) and shows a "writing…" state. Never publish drafts that still need a body (policy + UI guard + test).
3. **Strategy**: restructure into a concise structured doc (≤ ~450 words: positioning, ICP, 5 keyword themes, 3 competitors to investigate, channel plan, 3 quick wins), streamed token-by-token to the UI; run as a job. Wizard uses the same jobs so closing the tab does not lose work.
4. **Time/effort honesty**: before running, show an estimate based on measured tokens/sec of the configured model (store rolling tokens/sec from llm_calls); warn when estimate > 5 min and suggest a faster model or cloud provider. Settings: optional separate "fast model" for bodies.
5. **Timeouts**: per-call timeout applies per batch/draft (not the whole task); clear partial results are kept on failure.
6. Tests with a stub LLM covering: batch outline parse/repair, job resume after restart, no publish of needsBody drafts, cancel. Update README/CHANGELOG, bump 0.6.0, no new deps, no commits.

# v0.7 PROFESSIONAL POLISH (visual + product + repo)
The owner says the app must look and feel professional, like a paid B2B product (think Linear/Vercel/Stripe dashboards, not a prototype). Everything stays local (git local only, never add remotes, never publish). No new dependencies, vanilla JS/CSS, no build step. Keep tests green; add tests for any new logic.
1. **Design system** in public/styles.css: CSS custom-property tokens (color scale, semantic colors, spacing 4/8px grid, radii, shadows, type scale), system font stack with tabular numerals for metrics, **light theme by default** with a polished dark theme (prefers-color-scheme + manual toggle persisted in localStorage with try/catch). Consistent components: buttons (primary/secondary/ghost/danger, sizes, loading state), inputs/selects/textarea with labels and help text, badges (status colors with accessible contrast ≥4.5:1), cards, tables, tabs, modals/drawers, toasts, tooltips, skeletons, empty states.
2. **Icons & brand**: replace every emoji/glyph (⚙ ■ ✓ ☁ etc.) with a small inline SVG icon set (stroke icons, 16/20px) defined once; new simple logo mark + favicon (SVG) + apple-touch icon; sensible <title> per view.
3. **Layout**: refined left sidebar (project switcher with search, sections: Overview/Today, Inbox, Calendar, Knowledge, Reports, Settings), top bar with breadcrumb, project health pill and the job progress chip; content max-width and consistent page headers with primary action on the right; responsive down to 360px with a bottom/slide-over nav.
4. **Key screens**: (a) Today: KPI row (health, AI visibility, pending, scheduled) + "next actions" list + activity timeline; (b) Inbox: split view (list left with channel icon, status, filters, search; editor right with live char counter, sources, quality checks, approve/reject/schedule), bulk actions bar, keyboard nav; (c) Calendar: true month grid with drafts as chips, drag-free click-to-schedule, week/month toggle; (d) Strategy rendered as formatted Markdown (headings, lists, bold) instead of raw text — implement a tiny safe Markdown renderer with escaping + tests against XSS; (e) Settings as sectioned page with sticky save and connection status indicators; (f) agency overview as a clean table/cards toggle.
5. **Polish details**: no layout shift on load, skeletons for async content, optimistic UI where safe, friendly empty states with one clear CTA, consistent microcopy in EN/ES (sentence case), long titles wrap (no truncation without tooltip), focus-visible rings, prefers-reduced-motion respected, print stylesheet for the report matches the design system.
6. **Repo professionalism (local)**: rewrite README top (one-line pitch, feature grid, quickstart, architecture diagram in Mermaid, configuration table, security model, FAQ), add CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md (reporting), .editorconfig, issue/PR templates under .github/, docs/ARCHITECTURE.md; consistent package.json metadata (description, keywords, license, engines, repository field left empty/omitted). Bump 0.7.0 + CHANGELOG.
No commits, no remotes, no network publishing.

# v0.8 GUIDED MODE — "mastícaselo todo" to a NON-TECHNICAL user (highest priority)
Owner feedback: "no se entiende qué hacer; hay que dárselo todo muy masticado al usuario no técnico". Target user: a shop owner / freelancer / small-business founder who has never heard of LLM, RAG, SEO, GEO, agents, policy, connectors. They must always know (1) where they are, (2) what to do next, (3) why, (4) how long it takes, (5) what happens after. Keep zero new deps, vanilla JS, tests green, no commits, no remotes.
1. **Guided mode is the default** (toggle "Simple / Advanced" in the top bar, persisted). Simple mode hides: Knowledge, Rules/Policy, connectors, backups, job internals, raw JSON, model names. Advanced shows everything as today.
2. **"Your plan" home** (replaces Today in Simple mode): a numbered checklist stepper with big cards, always highlighting ONE current step with a single primary button, a time estimate ("about 2 minutes"), a one-sentence "why", and a "what happens next" line. Steps: 1 Connect your AI (auto-detected; otherwise guided sub-flow) → 2 Tell us about your business (just website URL or a 3-field form; skip URL if no website) → 3 Check what we understood (editable plain-language summary: what you sell, who for, tone — confirm/fix) → 4 Get your first 5 posts (generate, show progress as a friendly bar with messages like "Reading your website… Writing post 2 of 5…") → 5 Review & approve (one post at a time, big Approve / Change it / Skip buttons, "why this post" line) → 6 Publish or copy (copy-to-clipboard with per-network "how to post this" mini-guide; connectors only in Advanced) → 7 Your month plan (optional). Completed steps collapse with a check; the user can reopen. Progress ring "3 of 7 done".
3. **Plain-language vocabulary** (EN/ES), applied everywhere in Simple mode: Agents→"Helpers"/"Asistentes" named by outcome ("Write an article", "Check my website", "See if AI recommends me", "Posts for LinkedIn/X", "Weekly newsletter", "Launch announcement"); Inbox→"To review"/"Para revisar"; Knowledge→"About my business"/"Sobre mi negocio"; Rules→"Safety"/"Seguridad" (one sentence: "Nothing is posted without your OK"); Health score→"Website check-up"; GEO→"Do AI assistants recommend you?"; Strategy→"Your marketing plan". No unexplained acronyms; every technical term gets a "?" help popover with a 1–2 sentence explanation + example.
4. **AI connection for non-technical people**: a guided sub-flow "Get AI working" with 3 clearly explained options as cards: (a) "Free & private on your computer" (detect Ollama; if missing show numbered steps with copyable commands and a "Check again" button, plain explanation of RAM/disk needs); (b) "Use an online AI (fastest)" with provider picker, 4-step "where do I get my key" instructions per provider, paste key, "Test" button with human errors ("That key didn't work: check you copied all of it"); (c) "Just try the demo first". Recommend automatically based on detected hardware/RAM and models.
5. **Every screen gets a coach header**: title, 1-line purpose, "What to do here" (max 3 bullets), and a primary CTA. Empty states always say what to click. Add a dismissible "Need help?" panel with the 5 most common questions per screen.
6. **Friendly progress & errors**: replace spinners with step-by-step messages and time-remaining estimates; every error has plain wording + a fix button (retry / open the guide / switch to demo); never show stack traces, HTTP codes or model names in Simple mode (put them behind "Technical details").
7. **Review flow for approvals**: one-at-a-time card stack with large buttons; shows channel icon, a preview that looks like the real post (LinkedIn/X card mockup), character counter in plain words ("fits"/"too long by 12"), and "Make it shorter / friendlier / more professional" quick-rewrite chips.
8. **First-run tour**: 5-step highlight tour (skippable) the first time; plus a persistent "Where am I?" progress bar.
9. **Success moments**: after the first approved post, show a celebration + "Next: schedule it for tomorrow 9:00" suggestion.
10. Tests: stepper state machine (pure functions) incl. skipping/resuming, vocabulary mapping completeness EN/ES (every UI key present in both), no jargon leakage in Simple mode strings (test list of banned words: LLM, RAG, SSRF, JSON, API, GEO, token, endpoint, policy, connector, webhook), accessibility labels. Update README with a "For non-technical users" section, bump 0.8.0, CHANGELOG.
