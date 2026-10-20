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
