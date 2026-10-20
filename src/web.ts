import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  htmlLang: string | null;
  openGraph: { title: string | null; description: string | null; image: string | null; url: string | null };
  twitterCard: { card: string | null; title: string | null; description: string | null; image: string | null };
  hasJsonLd: boolean;
  jsonLdCount: number;
  checkedInternalLinks: number;
  brokenInternalLinks: Array<{ url: string; status: number | null; error?: string }>;
  hasSitemap: boolean | null;
  hasRobotsTxt: boolean | null;
  issues: string[];
  warnings: string[];
}

type ParsedSeoAudit = Omit<SeoAudit, 'hasSitemap' | 'hasRobotsTxt' | 'checkedInternalLinks' | 'brokenInternalLinks'> & { internalLinkUrls: string[] };

export function normalizeUrl(raw: string): URL {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url;
  } catch {
    throw new AppError('A valid http(s) URL is required');
  }
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || parts[0] >= 224;
  }
  if (isIP(value) === 6) return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  return false;
}

export async function assertSafeUrl(url: URL, allowPrivate = process.env.ALLOW_PRIVATE_FETCH === '1'): Promise<void> {
  if (allowPrivate) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isPrivateAddress(hostname)) {
    throw new AppError('Private and loopback URLs are blocked. Set ALLOW_PRIVATE_FETCH=1 only for trusted local targets.', 403);
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((result) => isPrivateAddress(result.address))) throw new AppError('URL resolves to a private or loopback address', 403);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`, 502);
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

function simpleParseSeo(html: string, pageUrl: URL): ParsedSeoAudit {
  const title = decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim() || null;
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const socialMeta = (name: string) => {
    const tag = metaTags.find((candidate) => [attr(candidate, 'name'), attr(candidate, 'property')].some((value) => value?.toLowerCase() === name));
    return tag ? decodeEntities(attr(tag, 'content') || '').trim() || null : null;
  };
  const descriptionTag = metaTags.find((tag) => attr(tag, 'name')?.toLowerCase() === 'description');
  const robotsTag = metaTags.find((tag) => attr(tag, 'name')?.toLowerCase() === 'robots');
  const metaDescription = descriptionTag ? decodeEntities(attr(descriptionTag, 'content') || '').trim() || null : null;
  const robotsMeta = robotsTag ? decodeEntities(attr(robotsTag, 'content') || '').trim() || null : null;
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  let internalLinks = 0;
  let externalLinks = 0;
  const internalLinkUrls: string[] = [];
  const seenInternalLinks = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      const link = new URL(href, pageUrl);
      if (!['http:', 'https:'].includes(link.protocol)) continue;
      if (link.hostname === pageUrl.hostname) {
        internalLinks += 1;
        link.hash = '';
        if (!seenInternalLinks.has(link.href)) { seenInternalLinks.add(link.href); internalLinkUrls.push(link.href); }
      } else externalLinks += 1;
    } catch { /* malformed href */ }
  }
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];
  const missingAlt = imageTags.filter((tag) => !(attr(tag, 'alt') || '').trim()).length;
  const canonicalTag = (html.match(/<link\b[^>]*>/gi) || []).find((tag) => (attr(tag, 'rel') || '').toLowerCase().split(/\s+/).includes('canonical'));
  const canonical = canonicalTag ? attr(canonicalTag, 'href')?.trim() || null : null;
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0];
  const htmlLang = htmlTag ? decodeEntities(attr(htmlTag, 'lang') || '').trim() || null : null;
  const openGraph = { title: socialMeta('og:title'), description: socialMeta('og:description'), image: socialMeta('og:image'), url: socialMeta('og:url') };
  const twitterCard = { card: socialMeta('twitter:card'), title: socialMeta('twitter:title'), description: socialMeta('twitter:description'), image: socialMeta('twitter:image') };
  const jsonLdCount = (html.match(/<script\b[^>]*>/gi) || []).filter((tag) => (attr(tag, 'type') || '').split(';')[0].trim().toLowerCase() === 'application/ld+json').length;
  return finishAudit(pageUrl, title, metaDescription, h1, internalLinks, externalLinks, imageTags.length, missingAlt, canonical, robotsMeta, htmlLang, openGraph, twitterCard, jsonLdCount, internalLinkUrls);
}

function sameWwwApexVariant(left: URL, right: URL): boolean {
  const withoutWww = (hostname: string) => hostname.toLowerCase().replace(/^www\./, '');
  return left.hostname !== right.hostname
    && withoutWww(left.hostname) === withoutWww(right.hostname)
    && left.protocol === right.protocol && left.port === right.port
    && left.pathname === right.pathname && left.search === right.search && left.hash === right.hash;
}

function finishAudit(
  pageUrl: URL,
  title: string | null,
  metaDescription: string | null,
  h1: string[],
  internalLinks: number,
  externalLinks: number,
  images: number,
  missingAlt: number,
  canonicalHref: string | null,
  robotsMeta: string | null,
  htmlLang: string | null,
  openGraph: SeoAudit['openGraph'],
  twitterCard: SeoAudit['twitterCard'],
  jsonLdCount: number,
  internalLinkUrls: string[],
): ParsedSeoAudit {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!title) issues.push('Missing page title');
  else if (title.length < 30 || title.length > 60) issues.push('Title should usually be 30–60 characters');
  if (!metaDescription) issues.push('Missing meta description');
  else if (metaDescription.length < 70 || metaDescription.length > 160) issues.push('Meta description should usually be 70–160 characters');
  if (h1.length === 0) issues.push('Missing H1');
  if (h1.length > 1) issues.push('Multiple H1 headings');
  if (missingAlt) issues.push(`${missingAlt} image(s) missing alt text`);
  let canonical: string | null = null;
  if (!canonicalHref) issues.push('Missing canonical URL');
  else {
    try {
      canonical = new URL(canonicalHref, pageUrl).href;
      if (!['http:', 'https:'].includes(new URL(canonical).protocol)) throw new Error('unsupported protocol');
      if (canonical !== pageUrl.href) {
        const canonicalUrl = new URL(canonical);
        if (sameWwwApexVariant(pageUrl, canonicalUrl)) warnings.push(`Canonical URL uses the same site's www/apex variant: ${canonical}`);
        else issues.push(`Canonical URL differs from audited URL: ${canonical}`);
      }
    } catch { issues.push(`Invalid canonical URL: ${canonicalHref}`); }
  }
  const missingOpenGraph = Object.entries(openGraph).filter(([key, value]) => key !== 'url' && !value).map(([key]) => `og:${key}`);
  if (missingOpenGraph.length) issues.push(`Missing Open Graph tag(s): ${missingOpenGraph.join(', ')}`);
  const missingTwitter = Object.entries(twitterCard).filter(([, value]) => !value).map(([key]) => `twitter:${key}`);
  if (missingTwitter.length) issues.push(`Missing Twitter card tag(s): ${missingTwitter.join(', ')}`);
  if (!htmlLang) issues.push('Missing html lang attribute');
  if (jsonLdCount === 0) issues.push('Missing JSON-LD structured data');
  return {
    url: pageUrl.href, title, titleLength: title?.length || 0, metaDescription, h1, internalLinks, externalLinks,
    images, missingAlt, canonical, robotsMeta, htmlLang, openGraph, twitterCard, hasJsonLd: jsonLdCount > 0,
    jsonLdCount, internalLinkUrls, issues, warnings,
  };
}

export function parseSeoHtml(html: string, rawUrl: string): ParsedSeoAudit {
  const pageUrl = normalizeUrl(rawUrl);
  if (!cheerio) return simpleParseSeo(html, pageUrl);
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description" i]').attr('content')?.trim() || null;
  const h1 = $('h1').map((_: unknown, el: unknown) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean) as string[];
  let internalLinks = 0;
  let externalLinks = 0;
  const internalLinkUrls: string[] = [];
  const seenInternalLinks = new Set<string>();
  $('a[href]').each((_: unknown, element: unknown) => {
    try {
      const link = new URL($(element).attr('href')!, pageUrl);
      if (!['http:', 'https:'].includes(link.protocol)) return;
      if (link.hostname === pageUrl.hostname) {
        internalLinks += 1;
        link.hash = '';
        if (!seenInternalLinks.has(link.href)) { seenInternalLinks.add(link.href); internalLinkUrls.push(link.href); }
      }
      else externalLinks += 1;
    } catch { /* malformed href */ }
  });
  const images = $('img').length;
  const missingAlt = $('img').filter((_: unknown, el: unknown) => !($(el).attr('alt') || '').trim()).length;
  const canonical = $('link[rel="canonical" i]').attr('href')?.trim() || null;
  const robotsMeta = $('meta[name="robots" i]').attr('content')?.trim() || null;
  const socialMeta = (name: string) => $(`meta[name="${name}" i], meta[property="${name}" i]`).first().attr('content')?.trim() || null;
  const htmlLang = $('html').first().attr('lang')?.trim() || null;
  const openGraph = {
    title: socialMeta('og:title'),
    description: socialMeta('og:description'),
    image: socialMeta('og:image'),
    url: socialMeta('og:url'),
  };
  const twitterCard = {
    card: socialMeta('twitter:card'),
    title: socialMeta('twitter:title'),
    description: socialMeta('twitter:description'),
    image: socialMeta('twitter:image'),
  };
  const jsonLdCount = $('script[type]').filter((_: unknown, el: unknown) => ($(el).attr('type') || '').split(';')[0].trim().toLowerCase() === 'application/ld+json').length;
  return finishAudit(pageUrl, title, metaDescription, h1, internalLinks, externalLinks, images, missingAlt, canonical, robotsMeta, htmlLang, openGraph, twitterCard, jsonLdCount, internalLinkUrls);
}

async function fetchText(url: URL, fetcher: typeof fetch, allowPrivate = process.env.ALLOW_PRIVATE_FETCH === '1'): Promise<{ text: string; status: number }> {
  try {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await assertSafeUrl(current, allowPrivate);
      const response = await fetcher(current, { headers: { 'user-agent': 'OpenCMO/0.2 (+local SEO audit)' }, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (redirects === 5) throw new AppError('Too many website redirects', 502);
        current = new URL(response.headers.get('location')!, current);
        if (!['http:', 'https:'].includes(current.protocol)) throw new AppError('Website redirected to an unsupported URL', 403);
        continue;
      }
      return { text: await response.text(), status: response.status };
    }
    throw new AppError('Too many website redirects', 502);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`Could not fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
}

async function checkInternalLink(url: URL, fetcher: typeof fetch, allowPrivate: boolean): Promise<{ url: string; status: number | null; error?: string } | null> {
  const original = url.href;
  try {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await assertSafeUrl(current, allowPrivate);
      const response = await fetcher(current, {
        method: 'HEAD',
        headers: { 'user-agent': 'OpenCMO/0.2 (+local SEO audit)' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (redirects === 5) throw new AppError('Too many redirects', 502);
        current = new URL(response.headers.get('location')!, current);
        if (!['http:', 'https:'].includes(current.protocol)) throw new AppError('Link redirected to an unsupported URL', 403);
        continue;
      }
      return response.status >= 400 ? { url: original, status: response.status } : null;
    }
    throw new AppError('Too many redirects', 502);
  } catch (error) {
    return { url: original, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchPage(rawUrl: string, fetcher: typeof fetch = fetch, allowPrivate = process.env.ALLOW_PRIVATE_FETCH === '1'): Promise<{ url: string; html: string; text: string }> {
  const url = normalizeUrl(rawUrl);
  const result = await fetchText(url, fetcher, allowPrivate);
  if (result.status < 200 || result.status >= 300) throw new AppError(`Website returned HTTP ${result.status}`, 502);
  return { url: url.href, html: result.text, text: extractPageText(result.text) };
}

export async function auditUrl(rawUrl: string, fetcher: typeof fetch = fetch, allowPrivate = process.env.ALLOW_PRIVATE_FETCH === '1'): Promise<SeoAudit> {
  const url = normalizeUrl(rawUrl);
  const page = await fetchText(url, fetcher, allowPrivate);
  if (page.status < 200 || page.status >= 300) throw new AppError(`Website returned HTTP ${page.status}`, 502);
  const parsed = parseSeoHtml(page.text, url.href);
  const { internalLinkUrls, ...base } = parsed;
  const linksToCheck = internalLinkUrls.slice(0, 20);
  const [robots, sitemap, linkResults] = await Promise.all([
    fetchText(new URL('/robots.txt', url), fetcher, allowPrivate).catch(() => ({ status: 0, text: '' })),
    fetchText(new URL('/sitemap.xml', url), fetcher, allowPrivate).catch(() => ({ status: 0, text: '' })),
    Promise.all(linksToCheck.map((link) => checkInternalLink(new URL(link), fetcher, allowPrivate))),
  ]);
  const hasRobotsTxt = robots.status >= 200 && robots.status < 300;
  const sitemapMentioned = /sitemap\s*:/i.test(robots.text);
  const hasSitemap = (sitemap.status >= 200 && sitemap.status < 300) || sitemapMentioned;
  if (!hasRobotsTxt) base.issues.push('robots.txt was not found');
  if (!hasSitemap) base.issues.push('sitemap.xml was not found');
  const brokenInternalLinks = linkResults.filter((result): result is NonNullable<typeof result> => result !== null);
  if (brokenInternalLinks.length) base.issues.push(`${brokenInternalLinks.length} broken internal link(s) found`);
  return { ...base, checkedInternalLinks: linksToCheck.length, brokenInternalLinks, hasRobotsTxt, hasSitemap };
}
