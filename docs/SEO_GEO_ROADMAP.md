# SEO, GEO, and Agency Intelligence Roadmap

This document describes the next analytical capabilities planned for OpenCMO. It is an engineering roadmap, not a claim that every listed feature already exists.

OpenCMO should remain local-first, evidence-led, and provider-neutral. Every feature below must work with either:

- a local model exposed by Ollama;
- a remote OpenAI-compatible API; or
- no language model at all when a deterministic algorithm is sufficient.

The preferred design is **measure first, interpret second**. Crawling, scoring, clustering, and change detection should produce reproducible evidence. A language model may explain those findings, classify intent, or draft a response, but it must not invent measurements.

## What is already implemented

- Deterministic checks for titles, descriptions, headings, canonical URLs, language, image alt text, social metadata, JSON-LD presence, internal links, `robots.txt`, and `sitemap.xml`.
- Safe, robots-aware website fetching with SSRF, redirect, timeout, and response-size controls.
- Search Console CSV import and opportunity scoring.
- Competitor page comparisons.
- BM25 retrieval, optional embeddings, reciprocal-rank fusion, and cited brand knowledge.
- Sampled AI-answer visibility checks with mention, citation, domain, and competitor evidence.
- SEO/GEO history, agency reports, Prometheus metrics, and Grafana dashboards.
- Local Ollama and remote OpenAI-compatible model support behind one LLM boundary.
- Human approval before publishing.

## Principles and non-goals

1. **No secret ranking formula claims.** OpenCMO can find technical problems and performance opportunities; it cannot promise positions in a search engine or an AI answer.
2. **GEO is sampled, not universal.** Results depend on provider, model, location, date, prompt, and web-search availability.
3. **Deterministic evidence wins.** Store the source URL, observed value, timestamp, algorithm version, and confidence for every recommendation.
4. **AI output is untrusted until validated.** Structured output must pass a schema and factual claims should resolve to stored sources.
5. **Local by default.** Sending data to an external provider must be an explicit configuration choice.
6. **Human-controlled side effects.** Generated changes, outreach, and publishing remain reviewable drafts.

## Capability map

| Capability | Deterministic core | Local Ollama | External AI API | External data/API |
| --- | --- | --- | --- | --- |
| Technical crawl and indexability | Yes | Explain fixes | Explain fixes | Optional Search Console |
| Duplicate and near-duplicate pages | SimHash/MinHash | Label clusters | Label clusters | No |
| Internal-link graph | Graph algorithms | Suggest anchors | Suggest anchors | No |
| Keyword and page clustering | BM25 + embeddings | Local embeddings and labels | Hosted embeddings and labels | Search Console recommended |
| Search-intent classification | Rules + confidence | Yes | Yes | No |
| Content briefs and refresh plans | Evidence assembly | Yes | Yes | Optional SERP/search provider |
| GEO answer sampling | Exact evidence parser | Offline simulation only | Live search-enabled checks | Provider search/citations |
| Entity and citation analysis | Entity/domain matching | Extraction | Extraction | Optional knowledge graph |
| Forecasting and anomaly detection | Time-series algorithms | Explain anomalies | Explain anomalies | Analytics/Search Console |
| Brand and tone QA | Rule checks | Yes | Yes | No |
| Image understanding and alt drafts | File checks | Vision model when available | Vision API | No |

## Phase 1 — technical SEO engine

### Crawl inventory and URL normalization

- Crawl from the canonical start URL and sitemaps with configurable limits, politeness delays, and robots compliance.
- Normalize scheme, host, ports, fragments, trailing slashes, query parameters, and percent encoding without merging URLs that may represent different content.
- Record status code, redirect chain, canonical target, robots directives, content type, response time, HTML size, rendered/non-rendered source, and discovery source.
- Detect redirect loops, chains, soft 404 candidates, broken internal links, mixed protocols, blocked resources, and sitemap/indexability conflicts.

### Internal-link graph

- Build a directed graph in which pages are nodes and internal links are edges.
- Calculate crawl depth, in-degree, out-degree, orphan candidates, strongly connected components, and a damping-based internal PageRank score.
- Identify important pages with weak internal authority and overly deep pages.
- Generate anchor suggestions only after the target page and surrounding source text have been supplied as evidence.

### Canonical and duplicate clustering

- Compare declared canonicals, redirects, sitemap membership, normalized URLs, titles, and content fingerprints.
- Use token shingles plus SimHash or MinHash for near-duplicate detection.
- Report conflicting canonical signals rather than trying to predict the search engine's final canonical choice.

### Structured data

- Parse JSON-LD and validate syntax, required fields, URL consistency, and entity identifiers.
- Match types and properties against a versioned Schema.org vocabulary.
- Provide templates for common supported types, but never fabricate reviews, ratings, authors, prices, or availability.

### Performance and accessibility signals

- Accept Lighthouse/PageSpeed or CrUX exports and preserve field/lab distinctions.
- Track Core Web Vitals, image weight, render-blocking resources, font loading, DOM size, and change over time.
- Keep performance scoring separate from search-performance claims.

## Phase 2 — search performance intelligence

### Native Search Console connector

- Add OAuth-based, read-only Search Console access while retaining CSV import.
- Ingest daily query, page, country, device, search appearance, and search-type dimensions incrementally.
- Store the API's aggregation and freshness metadata so partial data is not presented as final.

### Opportunity scoring

Use an explainable configurable score instead of an opaque model. A starting form is:

```text
opportunity = log1p(impressions)
            × expected_ctr_gap(position, observed_ctr)
            × business_priority
            × freshness_weight
            × confidence
```

The UI should expose every factor. It should support:

- high-impression, low-CTR opportunities;
- striking-distance queries;
- declining pages and content decay;
- new/lost queries;
- device or country gaps;
- brand/non-brand separation;
- page-query cannibalization;
- anomaly detection using robust z-scores or EWMA baselines.

### Topic and intent clustering

- Combine lexical BM25 similarity with cosine similarity from embeddings.
- Cluster with agglomerative clustering or HDBSCAN when enough data exists.
- Detect navigational, informational, commercial, transactional, local, and support intent with confidence and an editable label.
- Use the LLM to name clusters and explain them, not to silently determine the underlying measurements.

### Content gap and decay

- Compare a site's topic clusters with approved competitor inventories.
- Calculate coverage, freshness, internal authority, query demand, and conversion relevance.
- Produce refresh briefs grounded in the existing page, Search Console rows, brand knowledge, and cited competitor facts.

## Phase 3 — GEO and answer-engine observability

GEO measurements should be stored by provider, model, model version when available, search mode, locale, question, and timestamp.

### Buyer-question set

- Generate questions from services, audiences, Search Console queries, support questions, sales notes, and competitor categories.
- Deduplicate with lexical and embedding similarity.
- Maintain stable benchmark questions for trends and a rotating discovery set for new demand.
- Require human approval before a question becomes part of the benchmark.

### Evidence metrics

- **Brand mention rate:** answers containing a normalized brand/entity match.
- **Citation rate:** answers citing the project's verified domain.
- **Qualified citation rate:** citations resolving to a relevant, indexable project page.
- **Competitor share of voice:** competitor mentions divided by all recognized brands in the sample.
- **Recommendation position:** ordinal placement only when the answer actually presents an ordered list.
- **Answer stability:** agreement across repeated samples, with temperature and prompt held constant where possible.
- **Source diversity:** unique cited domains and concentration by domain.
- **Entity consistency:** agreement between the answer, organization facts, and verified source material.
- **Claim support:** fraction of extracted factual claims linked to a cited passage; this is a confidence measure, not proof of truth.

### Entity graph and citation readiness

- Build a project entity graph from Organization/Person/Product/Service/Place schema, verified profiles, and brand knowledge.
- Detect inconsistent names, URLs, descriptions, social profiles, founders, locations, and products.
- Score pages for extractable definitions, attributable facts, clear authorship, dates, primary evidence, and stable URLs.
- Audit `llms.txt` only as an experimental convention; do not present it as a ranking requirement or a guaranteed standard.

### Provider adapters

- Keep live-search adapters separate from the generic LLM interface because citations and search controls differ by provider.
- Preserve the raw answer, parsed citations, request configuration, costs when available, and parser version.
- Add replayable fixtures so parser changes can be tested without repeatedly paying providers.

## Phase 4 — agency workflows and local AI utilities

### Useful agency modules

- Multi-client health and SLA dashboard.
- Recurring audit scheduler with change-only alerts.
- White-label reports with client annotations and approval history.
- Content briefs, outlines, repurposing, and refresh suggestions.
- Brand voice and prohibited-claim checks.
- Editorial calendar balancing topics, funnel stages, formats, and channels.
- Local SEO checks for NAP consistency, location pages, review themes, and response drafts.
- Review and survey sentiment/topic extraction with personally identifiable information redaction.
- Conversion hypothesis backlog tied to landing pages and measured outcomes.
- Campaign UTM builder and naming-policy validator.
- Budget, token, latency, and model-quality comparisons across local and remote providers.
- Exportable evidence bundles for clients and auditors.

### Local model tasks suited to Ollama

- Classifying intent, funnel stage, sentiment, entities, and content type.
- Naming deterministic clusters.
- Summarizing stored evidence and generating client-friendly explanations.
- Drafting briefs, titles, descriptions, schema proposals, alt text, social variants, and review responses.
- Embedding private brand documents for retrieval.
- Checking tone and terminology against a local brand guide.

Tasks that require current public-web evidence still need a controlled crawler, a search-enabled provider, or another explicit data source. A local model by itself must not be described as performing a live search.

## Provider-neutral implementation contract

Every AI-backed feature should declare:

```ts
interface IntelligenceTask<I, O> {
  id: string;
  version: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  evidence: EvidenceReference[];
  privacy: 'local-only' | 'external-allowed';
  run(input: I, provider: ModelProvider): Promise<O>;
  validate(output: O, evidence: EvidenceReference[]): ValidationResult;
}
```

Recommended runtime behavior:

- prefer structured JSON output and validate it before storage;
- use temperature `0` for extraction and classification;
- record provider, model, duration, token counts, schema version, and validation result without storing secrets;
- retry malformed output once, then fail visibly;
- cache by normalized input hash and task version;
- support an explicit local-only policy per project;
- run golden-set evaluations before changing default models or prompts.

## Evaluation

Each feature needs a fixture set and measurable acceptance criteria:

- precision/recall for issue and entity detection;
- cluster coherence plus human correction rate;
- citation parser accuracy by provider;
- factual-support rate against supplied evidence;
- schema-valid output rate;
- latency, tokens, memory, and cost;
- reproducibility across repeated runs;
- percentage of recommendations accepted, edited, or rejected by users;
- downstream Search Console or conversion change, reported as correlation rather than automatic causation.

## Suggested implementation order

1. Crawl inventory, URL table, and technical issue model.
2. Internal-link graph and duplicate clustering.
3. Native read-only Search Console synchronization and daily snapshots.
4. Explainable opportunity, decay, cannibalization, and anomaly detectors.
5. Topic clustering and evidence-grounded content briefs.
6. Versioned GEO benchmark sets and provider adapters.
7. Entity/citation readiness and answer-stability metrics.
8. Agency scheduling, alerting, evaluation, and cost controls.

## Authoritative references

- [Google Search Central documentation](https://developers.google.com/search/docs)
- [Google canonicalization guidance](https://developers.google.com/search/docs/crawling-indexing/canonicalization)
- [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
- [Google Search Console API](https://developers.google.com/webmaster-tools/v1/api_reference_index)
- [Search Analytics query reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Schema.org vocabulary](https://schema.org/)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama embeddings](https://docs.ollama.com/capabilities/embeddings)
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

