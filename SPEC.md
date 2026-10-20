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
