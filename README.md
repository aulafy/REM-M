# OpenCMO

OpenCMO is a local-first, open-source “AI CMO.” It researches a business, builds a marketing strategy, runs focused marketing agents, and puts every output into a review inbox. **Nothing is published until a human explicitly approves it.**

It uses an OpenAI-compatible LLM endpoint and defaults to a local [Ollama](https://ollama.com/) server. The app itself has no required cloud service.

## Quick start

Requirements: Node.js 20 or newer and an OpenAI-compatible model server.

```bash
cp .env.example .env
npm install
npm start
```

Open <http://127.0.0.1:3000>. For the default Ollama configuration, install Ollama and run:

```bash
ollama pull llama3.2
ollama serve
```

Change `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` in `.env` to use another compatible provider. `LLM_TIMEOUT_MS` controls the request timeout and defaults to 300000 (five minutes), which is useful for slower local models; it can also be changed in Settings. Project data is stored in `data/opencmo.sqlite`. Markdown publications go to `exports/` by default.

## What v0.2 includes

- URL onboarding and an LLM-generated strategy covering positioning, ICP, keyword themes, competitors to investigate, and channels
- Writer, SEO, GEO, Reddit, X, LinkedIn, Newsletter, and HN/Product Hunt launch agents
- Deterministic SEO checks for title, description, H1s, links, image alt text, canonical URL, Open Graph and Twitter tags, HTML language, JSON-LD, up to 20 internal links, robots.txt, and sitemap.xml
- Reddit public JSON research with copy-only, human-reviewed reply drafts
- A draft inbox with editing and enforced `pending → approved → published` workflow (rejection and re-approval are supported)
- Markdown, WordPress REST, GitHub Contents API, generic webhook, Telegram, and Discord connectors
- A small JSON HTTP API and dependency-free browser UI
- Browser settings with masked credentials, streamed run progress, GEO score history, and English/Spanish project output
- An approved-content calendar with automatic due publishing, edit history, bulk review, shortcuts, dark mode, and mobile layouts
- SSRF protection, basic API rate limiting, Docker support, and Node 20/22 CI

GEO results are a directional sample from the configured model, not proof of visibility across commercial AI search products. Reddit replies are never posted automatically. The WordPress connector publishes posts immediately only after the corresponding OpenCMO draft has been approved.

## Connector configuration

Markdown export is always available. Optional connectors appear disabled until all required variables are set:

| Connector | Variables |
| --- | --- |
| WordPress | `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` |
| GitHub | `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/repository`), optional `GITHUB_BRANCH` |
| Webhook | `WEBHOOK_URL`, optional bearer `WEBHOOK_SECRET` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Discord | `DISCORD_WEBHOOK_URL` |

GitHub writes Markdown into `content/`. WordPress uses an application password. The webhook receives `{ event, draft, project }` as JSON.

## API

All request and response bodies are JSON.

```text
GET  /api/health
GET/PUT /api/settings
POST /api/settings/test-llm
GET  /api/projects
POST /api/projects
PATCH /api/projects/:id
POST /api/projects/:id/strategy
GET  /api/agents
POST /api/projects/:id/agents/:agent/run  { "task": "..." }
GET  /api/drafts?project=&status=
PATCH /api/drafts/:id                    { "body": "..." }
POST /api/drafts/bulk
POST /api/drafts/:id/approve
POST /api/drafts/:id/reject
POST /api/drafts/:id/schedule
POST /api/drafts/:id/publish             { "connector": "markdown" }
GET  /api/connectors
```

Example:

```bash
curl -s http://127.0.0.1:3000/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","url":"https://example.com","audience":"small teams","tone":"practical"}'
```

## Architecture

```text
Browser (vanilla HTML/CSS/JS)
        │ JSON
        ▼
Hono API ─── agents ─── OpenAI-compatible LLM
   │            │
SQLite      website / Reddit research
   │
approval state machine ─── scheduler/connector ─── Markdown / WordPress / GitHub / webhook / Telegram / Discord
```

The Hono app is assembled in `src/app.ts`; dependencies such as the LLM and `fetch` are injectable. `src/db.ts` owns the SQLite schema and draft state machine. Agent implementations live in `src/agents.ts`, deterministic web analysis in `src/web.ts`, and publisher adapters in `src/connectors.ts`.

## Development

```bash
npm run dev
npm test
npx tsc --noEmit
```

Tests use Node's built-in test runner and an LLM stub; they do not need a model server.

Docker users can run `docker compose up --build`. To start the optional Ollama container too, use `docker compose --profile ollama up --build`, then point the app at `http://ollama:11434/v1`.

## Screenshots

> Screenshots placeholder — strategy, agent progress, draft inbox, content calendar, and settings views will be added here.

## OpenCMO and okara.ai

| | OpenCMO | okara.ai |
| --- | --- | --- |
| License | MIT, source available | Proprietary service |
| Data location | Local SQLite by default | Hosted service |
| Model choice | Any OpenAI-compatible endpoint, including Ollama | Service-managed |
| Publishing safety | Explicit approval enforced in the state machine | See vendor documentation |
| Extensibility | TypeScript agents and connectors | Product integrations |

This table describes OpenCMO's design, not an independent feature audit of okara.ai. Vendor capabilities and pricing can change.

## Roadmap

- Webflow and Framer publishing
- Scheduled agent runs and approval reminders
- Richer crawl-based SEO audits and analytics integrations
- More connector-specific previews and publication history
- Encrypted-at-rest credential storage and multi-user authentication for network deployments

## Disclaimer

OpenCMO is not affiliated with, endorsed by, or sponsored by okara.ai. Review generated content and external-service permissions before publishing.

## License

MIT © OpenCMO contributors
