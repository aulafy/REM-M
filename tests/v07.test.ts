import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderMarkdown } from '../public/markdown.js';

test('v0.7 safe Markdown renders the supported strategy structure', () => {
  const html = renderMarkdown('# Positioning\n\nA **clear** plan with *focus*.\n\n- First\n- Second\n\n1. Ship\n2. Measure');
  assert.match(html, /<h2>Positioning<\/h2>/);
  assert.match(html, /<strong>clear<\/strong>/);
  assert.match(html, /<em>focus<\/em>/);
  assert.match(html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(html, /<ol><li>Ship<\/li><li>Measure<\/li><\/ol>/);
});

test('v0.7 Markdown escapes HTML, attributes, and script payloads', () => {
  const html = renderMarkdown('# <img src=x onerror=alert(1)>\n\n<script>alert("x")</script> **safe**');
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>safe<\/strong>/);
});

test('v0.7 browser shell includes professional navigation, theme, inbox, and calendar surfaces', async () => {
  const [html, css, js] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/app-v04.js', import.meta.url), 'utf8'),
  ]);
  for (const marker of ['project-search', 'theme-toggle', 'mobile-nav-toggle', 'health-pill', 'calendar-grid', 'inbox-workspace']) assert.match(html, new RegExp(marker));
  for (const token of ['--space-1', '--radius-md', '--shadow-lg', '[data-theme="dark"]', 'prefers-reduced-motion', '@media print']) assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(js, /renderMarkdown/);
  assert.match(js, /localStorage\.setItem\('opencmo-theme'/);
  assert.match(js, /renderCalendar/);
});
