import { createRequire } from 'node:module';
import { AppError } from './errors.js';

type CheerioModule = { load(html: string): any };
let cheerio: CheerioModule | null = null;
try { cheerio = createRequire(import.meta.url)('cheerio') as CheerioModule; } catch { /* lightweight fallback below */ }

export interface SeoAudit {
  url: string;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  h1: string[];
  internalLinks: number;
  externalLinks: number;
  images: number;
  missingAlt: number;
  canonical: string | null;
  robotsMeta: string | null;
  hasSitemap: boolean | null;
  hasRobotsTxt: boolean | null;
  issues: string[];
}

export function normalizeUrl(raw: string): URL {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url;
  } catch {
    throw new AppError('A valid http(s) URL is required');
  }
}

export function extractPageText(html: string): string {
  if (cheerio) {
    const $ = cheerio.load(html);
    $('script,style,noscript,svg,nav,footer').remove();
    return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20_000);
  }
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, 20_000);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function simpleParseSeo(html: string, pageUrl: URL): Omit<SeoAudit, 'hasSitemap' | 'hasRobotsTxt'> {
  const title = decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim() || null;
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const descriptionTag = metaTags.find((tag) => attr(tag, 'name')?.toLowerCase() === 'description');
  const robotsTag = metaTags.find((tag) => attr(tag, 'name')?.toLowerCase() === 'robots');
  const metaDescription = descriptionTag ? decodeEntities(attr(descriptionTag, 'content') || '').trim() || null : null;
  const robotsMeta = robotsTag ? decodeEntities(attr(robotsTag, 'content') || '').trim() || null : null;
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  let internalLinks = 0;
  let externalLinks = 0;
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      const link = new URL(href, pageUrl);
      if (!['http:', 'https:'].includes(link.protocol)) continue;
      if (link.hostname === pageUrl.hostname) internalLinks += 1; else externalLinks += 1;
    } catch { /* malformed href */ }
  }
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];
  const missingAlt = imageTags.filter((tag) => !(attr(tag, 'alt') || '').trim()).length;
  const canonicalTag = (html.match(/<link\b[^>]*>/gi) || []).find((tag) => (attr(tag, 'rel') || '').toLowerCase().split(/\s+/).includes('canonical'));
  const canonical = canonicalTag ? attr(canonicalTag, 'href')?.trim() || null : null;
  return finishAudit(pageUrl, title, metaDescription, h1, internalLinks, externalLinks, imageTags.length, missingAlt, canonical, robotsMeta);
}

function finishAudit(pageUrl: URL, title: string | null, metaDescription: string | null, h1: string[], internalLinks: number, externalLinks: number, images: number, missingAlt: number, canonical: string | null, robotsMeta: string | null): Omit<SeoAudit, 'hasSitemap' | 'hasRobotsTxt'> {
  const issues: string[] = [];
  if (!title) issues.push('Missing page title');
  else if (title.length < 30 || title.length > 60) issues.push('Title should usually be 30–60 characters');
  if (!metaDescription) issues.push('Missing meta description');
  else if (metaDescription.length < 70 || metaDescription.length > 160) issues.push('Meta description should usually be 70–160 characters');
  if (h1.length === 0) issues.push('Missing H1');
  if (h1.length > 1) issues.push('Multiple H1 headings');
  if (missingAlt) issues.push(`${missingAlt} image(s) missing alt text`);
  if (!canonical) issues.push('Missing canonical URL');
  return { url: pageUrl.href, title, titleLength: title?.length || 0, metaDescription, h1, internalLinks, externalLinks, images, missingAlt, canonical, robotsMeta, issues };
}

export function parseSeoHtml(html: string, rawUrl: string): Omit<SeoAudit, 'hasSitemap' | 'hasRobotsTxt'> {
  const pageUrl = normalizeUrl(rawUrl);
  if (!cheerio) return simpleParseSeo(html, pageUrl);
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description" i]').attr('content')?.trim() || null;
  const h1 = $('h1').map((_: unknown, el: unknown) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean) as string[];
  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_: unknown, element: unknown) => {
    try {
      const link = new URL($(element).attr('href')!, pageUrl);
      if (!['http:', 'https:'].includes(link.protocol)) return;
      if (link.hostname === pageUrl.hostname) internalLinks += 1;
      else externalLinks += 1;
    } catch { /* malformed href */ }
  });
  const images = $('img').length;
  const missingAlt = $('img').filter((_: unknown, el: unknown) => !($(el).attr('alt') || '').trim()).length;
  const canonical = $('link[rel="canonical" i]').attr('href')?.trim() || null;
  const robotsMeta = $('meta[name="robots" i]').attr('content')?.trim() || null;
  return finishAudit(pageUrl, title, metaDescription, h1, internalLinks, externalLinks, images, missingAlt, canonical, robotsMeta);
}

async function fetchText(url: URL, fetcher: typeof fetch): Promise<{ text: string; status: number }> {
  try {
    const response = await fetcher(url, { headers: { 'user-agent': 'OpenCMO/0.1 (+local SEO audit)' }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    return { text: await response.text(), status: response.status };
  } catch (error) {
    throw new AppError(`Could not fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
}

export async function fetchPage(rawUrl: string, fetcher: typeof fetch = fetch): Promise<{ url: string; html: string; text: string }> {
  const url = normalizeUrl(rawUrl);
  const result = await fetchText(url, fetcher);
  if (result.status < 200 || result.status >= 300) throw new AppError(`Website returned HTTP ${result.status}`, 502);
  return { url: url.href, html: result.text, text: extractPageText(result.text) };
}

export async function auditUrl(rawUrl: string, fetcher: typeof fetch = fetch): Promise<SeoAudit> {
  const url = normalizeUrl(rawUrl);
  const page = await fetchText(url, fetcher);
  if (page.status < 200 || page.status >= 300) throw new AppError(`Website returned HTTP ${page.status}`, 502);
  const base = parseSeoHtml(page.text, url.href);
  const [robots, sitemap] = await Promise.all([
    fetchText(new URL('/robots.txt', url), fetcher).catch(() => ({ status: 0, text: '' })),
    fetchText(new URL('/sitemap.xml', url), fetcher).catch(() => ({ status: 0, text: '' })),
  ]);
  const hasRobotsTxt = robots.status >= 200 && robots.status < 300;
  const sitemapMentioned = /sitemap\s*:/i.test(robots.text);
  const hasSitemap = (sitemap.status >= 200 && sitemap.status < 300) || sitemapMentioned;
  if (!hasRobotsTxt) base.issues.push('robots.txt was not found');
  if (!hasSitemap) base.issues.push('sitemap.xml was not found');
  return { ...base, hasRobotsTxt, hasSitemap };
}
