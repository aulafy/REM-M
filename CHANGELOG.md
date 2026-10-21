# Changelog

## 0.9.0

- Added an in-app live AI visibility check for Perplexity, OpenRouter web search, and OpenAI web search.
- Buyer questions can be generated from the project profile or entered manually; results record exact answers, brand mentions, first-party citations, cited domains, and named competitors.
- Provider credentials are masked in the UI, stored only in the local SQLite settings table, and never returned by the API.
- Live checks feed the existing GEO history, dashboard trend, and white-label client report while remaining explicitly directional rather than claiming search-rank measurement.
- Added provider request, citation parsing, scoring, key-isolation, persistence, and browser-surface regression tests.

## 0.8.0
- Guided mode at `/` for non-technical users: seven-step plan, one highlighted step at a time with why / time / what happens next, plain-language copy (ES/EN), friendly errors, AI-connection helper (local, online with step-by-step key instructions, or demo), one-at-a-time review cards with a realistic preview, plain-text output for social networks and formatted newsletters/blog posts.
- Full app moved to `/advanced`.
- Projects can be corrected after onboarding (name, description, audience, tone).
- Speed estimates ignore cold-start outliers; `/api/health` reports the version from `package.json`.
- Pilot kit for testing with real non-technical users (`docs/PILOT.md`).

## 0.7.0

- Added a cohesive visual design system with semantic color, spacing, type, radius, shadow, component, dark-theme, reduced-motion, and print tokens.
- Reworked the app shell with a searchable project switcher, sectioned sidebar, breadcrumb top bar, health and job indicators, responsive slide-over navigation, and persistent manual theme selection.
- Upgraded Today with a four-KPI summary, ranked actions, site health, schedule, briefing, and recent activity surfaces.
- Rebuilt Inbox as a searchable split view with a compact draft list, focused editor, quality and source details, bulk controls, and existing keyboard actions.
- Added month/week calendar grids with period navigation and click-to-schedule for approved drafts.
- Added an escaped, dependency-free Markdown renderer for strategies with XSS regression coverage.
- Refined Settings into a sectioned drawer with sticky save controls and visible AI connection state, plus card/table agency overview modes.
- Added a reusable SVG icon set, new logo mark, favicon and touch icon, professional project metadata, documentation, and contribution templates.

## 0.6.0

- Added persistent background jobs with restart recovery, serialized LLM work, live SSE progress, cancellation, retry, and a persistent UI progress chip.
- Split monthly planning into four compact outline batches followed by one bounded, knowledge-grounded body call per draft; placeholders appear on the calendar immediately and can be prioritized individually.
- Added robust outline JSON extraction/repair with one retry per batch, duplicate-title prevention, and partial-result preservation on failure.
- Moved strategy and first-run strategy generation into background jobs, capped strategy output at roughly 450 words, and streamed strategy tokens into the UI.
- Added rolling tokens-per-second estimates, long-run warnings, and an optional fast model for monthly draft bodies.
- Prevented drafts with unfinished bodies from being approved, scheduled, bulk-approved, or published.

## 0.5.0

- Added offline, print-ready white-label client reports with configurable agency name, accent color, logo, and optional “Powered by OpenCMO”.
- Added English/Spanish Search Console Queries CSV imports, ranked search opportunities, and one-click Writer drafts.
- Added safe, deterministic comparisons for up to five competitors and a multi-project agency overview.
- Added the bilingual static landing site and launch checklist under `docs/`.
- Added the `opencmo` command, port and data-directory options, browser opening, macOS launcher, and Docker-first README quickstart.
- Added the in-app trust and safety explanation.
- Fixed wizard cloud-form visibility, embedding-only Ollama results, small-model badges, demo health copy, and demo draft sources.

## 0.4.0

- Added the resumable first-run wizard with Ollama detection, cloud presets, connection testing, deterministic site health, strategy generation, knowledge import, and five starter drafts.
- Added the per-project Today dashboard and 30-day multi-channel content planner.
- Added source visibility, channel-limit enforcement, live counters, AI-cliché flags, one-click rewrite, feedback-based regeneration, and reject undo.
- Added normalized-URL deduplication with merge, complete English/Spanish product navigation, friendly recovery actions, loading skeletons, shortcut help, focus styles, and mobile refinements.
- Added a removable, fully canned demo business that works without an LLM.
- Split Settings into Basic and Advanced sections and made the Markdown export folder configurable in the UI.

## 0.3.0

- Added per-project knowledge documents, chunking, Spanish-aware BM25, optional embedding/RRF retrieval, citations, and the Knowledge UI.
- Added the action-policy gate, hard safety floor, approvals, append-only activity log, and Stop all switch.
- Added LLM call metrics and an hourly cap without storing prompt text.
- Hardened site reads with DNS/private-network checks across redirects, limits, robots.txt, and a polite user agent.
- Added review-first website profiling, daily morning/evening briefs with optional Telegram notification, SQLite backups/integrity reporting, and optional Hindsight recall.
- Ported these ideas from REM-L (MIT, same author); invoicing, tax, and macOS features are not included.
