# Contributing to OpenCMO

Thanks for helping improve OpenCMO. Open an issue before a large change so the intended behavior can be agreed first. Keep the app local-first, preserve the human approval gate, and prefer the existing stack over new dependencies.

## Development

Use Node.js 20 or 22, then run:

```bash
npm install
npx tsc --noEmit
npm test
npm run dev
```

Add focused `node:test` coverage for new logic. Never include API keys, local databases, generated exports, or `.env` files. Pull requests should explain user-visible behavior, security implications, and manual verification.

## Product and code principles

- Keep publishing behind explicit human approval and route agent side effects through the policy gate.
- Preserve local-first operation, the zero-build browser client, and support for arbitrary OpenAI-compatible endpoints.
- Prefer small, testable TypeScript modules and native browser APIs over new dependencies.
- Use the design-system tokens in `public/styles.css`; check both themes, keyboard focus, English/Spanish copy, and layouts at 360px before submitting UI changes.
- Keep user-facing errors actionable and never log prompt text, credentials, or private project content.

## Pull requests

Keep changes focused. Include tests for new logic, screenshots for visual changes, and a concise note about anything intentionally left out. Run both required checks locally before requesting review. See [the architecture guide](docs/ARCHITECTURE.md) for module ownership and safety boundaries.
