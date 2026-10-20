import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeoHtml } from '../src/web.js';

test('SEO parser extracts tags, links, headings, and missing alt text', () => {
  const html = `<!doctype html><html><head>
    <title>A useful and appropriately sized guide to local marketing</title>
    <meta name="description" content="A sufficiently descriptive summary that explains the purpose of this useful local marketing guide for readers and search engines alike.">
    <link rel="canonical" href="https://example.com/guide">
  </head><body>
    <h1>Local marketing</h1>
    <a href="/about">About</a><a href="https://other.example/resource">Resource</a>
    <img src="good.jpg" alt="A shop window"><img src="bad.jpg">
  </body></html>`;
  const audit = parseSeoHtml(html, 'https://example.com/guide');
  assert.equal(audit.title, 'A useful and appropriately sized guide to local marketing');
  assert.deepEqual(audit.h1, ['Local marketing']);
  assert.equal(audit.internalLinks, 1);
  assert.equal(audit.externalLinks, 1);
  assert.equal(audit.images, 2);
  assert.equal(audit.missingAlt, 1);
  assert.equal(audit.canonical, 'https://example.com/guide');
  assert.ok(audit.issues.includes('1 image(s) missing alt text'));
});

test('SEO parser reports important omissions', () => {
  const audit = parseSeoHtml('<html><body><p>Hello</p></body></html>', 'https://example.com');
  assert.ok(audit.issues.includes('Missing page title'));
  assert.ok(audit.issues.includes('Missing meta description'));
  assert.ok(audit.issues.includes('Missing H1'));
  assert.ok(audit.issues.includes('Missing canonical URL'));
});
