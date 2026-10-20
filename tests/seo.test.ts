import test from 'node:test';
import assert from 'node:assert/strict';
import { auditUrl, parseSeoHtml } from '../src/web.js';

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

test('SEO parser extracts social, language, JSON-LD, and canonical findings', () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>A title that is comfortably within the accepted SEO range</title>
    <meta name="description" content="This description contains enough useful detail to fit within the accepted deterministic range for a search result summary.">
    <link rel="canonical" href="https://example.com/guide">
    <meta property="og:title" content="Open Graph title"><meta property="og:description" content="Open Graph description">
    <meta property="og:image" content="/social.png"><meta property="og:url" content="https://example.com/guide">
    <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Twitter title">
    <meta name="twitter:description" content="Twitter description"><meta name="twitter:image" content="/twitter.png">
    <script type="application/ld+json">{"@type":"Article"}</script>
  </head><body><h1>Guide</h1></body></html>`;
  const audit = parseSeoHtml(html, 'https://www.example.com/guide');
  assert.equal(audit.htmlLang, 'en');
  assert.equal(audit.openGraph.title, 'Open Graph title');
  assert.equal(audit.twitterCard.card, 'summary_large_image');
  assert.equal(audit.hasJsonLd, true);
  assert.equal(audit.jsonLdCount, 1);
  assert.equal(audit.issues.some((issue) => issue.startsWith('Canonical URL differs')), false);
  assert.equal(audit.warnings.some((warning) => warning.includes('www/apex')), true);
});

test('SEO parser treats a genuinely different canonical as an error', () => {
  const audit = parseSeoHtml('<html lang="en"><head><link rel="canonical" href="/other"></head></html>', 'https://example.com/page');
  assert.ok(audit.issues.includes('Canonical URL differs from audited URL: https://example.com/other'));
});

test('SEO audit checks at most 20 unique internal links with HEAD and records failures', async () => {
  const links = Array.from({ length: 22 }, (_, index) => `<a href="/page-${index}">Page</a>`).join('');
  const html = `<html lang="en"><head><title>A useful title in the accepted deterministic length range</title>
    <meta name="description" content="A sufficiently detailed page description that fits the deterministic length requirements used by this SEO audit.">
    <link rel="canonical" href="https://example.com/"><meta property="og:title" content="Title">
    <meta property="og:description" content="Description"><meta property="og:image" content="/image.png">
    <meta name="twitter:card" content="summary"><meta name="twitter:title" content="Title">
    <meta name="twitter:description" content="Description"><meta name="twitter:image" content="/image.png">
    <script type="application/ld+json">{}</script></head><body><h1>Home</h1>${links}</body></html>`;
  const headUrls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'HEAD') {
      headUrls.push(url);
      return new Response(null, { status: url.endsWith('/page-3') ? 404 : 200 });
    }
    if (url.endsWith('/robots.txt')) return new Response('Sitemap: https://example.com/sitemap.xml', { status: 200 });
    if (url.endsWith('/sitemap.xml')) return new Response('<urlset/>', { status: 200 });
    return new Response(html, { status: 200 });
  };
  const audit = await auditUrl('https://example.com/', fetcher, true);
  assert.equal(audit.checkedInternalLinks, 20);
  assert.equal(headUrls.length, 20);
  assert.deepEqual(audit.brokenInternalLinks, [{ url: 'https://example.com/page-3', status: 404 }]);
  assert.ok(audit.issues.includes('1 broken internal link(s) found'));
});

test('internal-link HEAD redirects are SSRF-guarded', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'HEAD') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml')) return new Response('', { status: 200 });
    return new Response('<html><head><link rel="canonical" href="http://93.184.216.34/"></head><body><a href="/account">Account</a></body></html>', { status: 200 });
  };
  const audit = await auditUrl('http://93.184.216.34/', fetcher, false);
  assert.equal(audit.brokenInternalLinks.length, 1);
  assert.equal(audit.brokenInternalLinks[0].status, null);
  assert.match(audit.brokenInternalLinks[0].error || '', /private|loopback|blocked/i);
});
