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

Change `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` in `.env` to use another compatible provider. Project data is stored in `data/opencmo.sqlite`. Markdown publications go to `exports/` by default.

## What v0.1 includes

- URL onboarding and an LLM-generated strategy covering positioning, ICP, keyword themes, competitors to investigate, and channels
- Writer, SEO, GEO, Reddit, X, and LinkedIn agents
- Deterministic SEO checks for title, description, H1s, links, image alt text, canonical URL, robots.txt, and sitemap.xml
- Reddit public JSON research with copy-only, human-reviewed reply drafts
- A draft inbox with editing and enforced `pending → approved → published` workflow (rejection and re-approval are supported)
- Markdown, WordPress REST, GitHub Contents API, and generic webhook connectors
- A small JSON HTTP API and dependency-free browser UI

GEO results are a directional sample from the configured model, not proof of visibility across commercial AI search products. Reddit replies are never posted automatically. The WordPress connector publishes posts immediately only after the corresponding OpenCMO draft has been approved.

## Connector configuration

Markdown export is always available. Optional connectors appear disabled until all required variables are set:

| Connector | Variables |
| --- | --- |
| WordPress | `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` |
| GitHub | `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/repository`), optional `GITHUB_BRANCH` |
| Webhook | `WEBHOOK_URL`, optional bearer `WEBHOOK_SECRET` |

GitHub writes Markdown into `content/`. WordPress uses an application password. The webhook receives `{ event, draft, project }` as JSON.

## API

All request and response bodies are JSON.

```text
GET  /api/health
GET  /api/projects
POST /api/projects
POST /api/projects/:id/strategy
GET  /api/agents
POST /api/projects/:id/agents/:agent/run  { "task": "..." }
GET  /api/drafts?project=&status=
PATCH /api/drafts/:id                    { "body": "..." }
POST /api/drafts/:id/approve
POST /api/drafts/:id/reject
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
approval state machine ─── connector ─── Markdown / WordPress / GitHub / webhook
```

The Hono app is assembled in `src/app.ts`; dependencies such as the LLM and `fetch` are injectable. `src/db.ts` owns the SQLite schema and draft state machine. Agent implementations live in `src/agents.ts`, deterministic web analysis in `src/web.ts`, and publisher adapters in `src/connectors.ts`.

## Development

```bash
npm run dev
npm test
npx tsc --noEmit
```

Tests use Node's built-in test runner and an LLM stub; they do not need a model server.

## Roadmap

- Webflow and Framer publishing
- Telegram and other notification channels
- Scheduled agent runs and approval reminders
- Richer crawl-based SEO audits and analytics integrations
- More connector-specific previews and publication history

## Disclaimer

OpenCMO is not affiliated with, endorsed by, or sponsored by okara.ai. Review generated content and external-service permissions before publishing.

## License

MIT © OpenCMO contributors
