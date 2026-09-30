import { decodeEntities, firstTagText, markupToText, metaContent, normaliseWhitespace, stripElement } from './xml.js';
import type { Extracted } from './types.js';

/**
 * Article extraction from a web page.
 *
 * The problem is that a news page is mostly navigation, promos and comments,
 * and reading those aloud is worse than useless. The approach here is the one
 * readability algorithms converge on: score candidate containers by how much
 * of their content is prose rather than markup, and take the winner.
 *
 * Scoring favours text length and paragraph count, and penalises link density,
 * which is the signal that separates an article body from a navigation block --
 * a menu is nearly all anchor text, an article is nearly none.
 */

/** Containers that are never the article body, however much text they hold. */
const BOILERPLATE = /(?:^|[\s_-])(?:nav|menu|header|footer|sidebar|comment|share|social|promo|advert|ad|banner|related|recommend|newsletter|subscribe|cookie|consent|breadcrumb|pagination|masthead|modal|popup|skip)(?:$|[\s_-])/i;

interface Candidate {
  html: string;
  score: number;
}

export function extractHtml(html: string, sourceUrl?: string): Extracted {
  const title = extractTitle(html) ?? (sourceUrl ? titleFromUrl(sourceUrl) : null);
  const author = metaContent(html, [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']byl["'][^>]+content=["']([^"']+)["']/i,
  ]);

  let body = html;
  for (const tag of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg', 'figure']) {
    body = stripElement(body, tag);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');

  const best = bestCandidate(body);
  const text = markupToText(best ?? body);

  return {
    text: normaliseWhitespace(text),
    title: title ?? undefined,
    author: author ?? undefined,
  };
}

/** Score every plausible container and return the markup of the best one. */
function bestCandidate(html: string): string | null {
  const candidates: Candidate[] = [];

  // Semantic containers first: if the page marked up its own article, trust it.
  for (const tag of ['article', 'main']) {
    for (const block of matchElements(html, tag)) {
      candidates.push({ html: block, score: scoreBlock(block) * 1.5 });
    }
  }
  for (const block of matchElements(html, 'div')) {
    // Skip containers whose class or id names them as furniture.
    const openTag = /^<div\b[^>]*>/i.exec(block)?.[0] ?? '';
    if (BOILERPLATE.test(openTag.replace(/[-_]/g, ' '))) continue;
    candidates.push({ html: block, score: scoreBlock(block) });
  }
  for (const block of matchElements(html, 'section')) {
    candidates.push({ html: block, score: scoreBlock(block) });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0]!;
  return winner.score > 0 ? winner.html : null;
}

/**
 * Score one container. Text volume and paragraph count push the score up; a
 * high proportion of anchor text pushes it sharply down.
 */
function scoreBlock(block: string): number {
  const textLength = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (textLength < 180) return 0;

  const linkText = (block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/gi) ?? [])
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
  const linkDensity = textLength > 0 ? linkText / textLength : 1;
  if (linkDensity > 0.5) return 0;

  const paragraphs = (block.match(/<p\b/gi) ?? []).length;
  const commas = (block.match(/,/g) ?? []).length;

  // Length dominates, paragraphs and commas confirm it is prose, link density scales it back.
  return (textLength + paragraphs * 120 + commas * 12) * (1 - linkDensity);
}

/**
 * Find balanced occurrences of one tag. Written as an explicit depth scan
 * because nested `<div>`s are universal and a non-greedy regex would stop at
 * the first inner close tag.
 */
function matchElements(html: string, tag: string): string[] {
  const out: string[] = [];
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const tokenRe = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, 'gi');

  let open: RegExpExecArray | null;
  while ((open = openRe.exec(html)) !== null) {
    if (open[0].endsWith('/>')) continue;
    tokenRe.lastIndex = open.index;
    let depth = 0;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(html)) !== null) {
      if (token[0].startsWith('</')) depth -= 1;
      else depth += 1;
      if (depth === 0) {
        out.push(html.slice(open.index, token.index + token[0].length));
        break;
      }
    }
    // Cap the work on pathological pages rather than scanning a 2MB DOM repeatedly.
    if (out.length >= 400) break;
  }
  return out;
}

function extractTitle(html: string): string | null {
  const meta = metaContent(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
  ]);
  if (meta) return meta;

  const h1 = firstTagText(html, 'h1');
  if (h1 && h1.length > 3) return h1;

  const title = firstTagText(html, 'title');
  if (!title) return null;
  // Strip the trailing " | Site Name" most pages append.
  return decodeEntities(title).replace(/\s*[|–—·]\s*[^|–—·]{1,40}$/, '').trim() || title;
}

function titleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.split('/').filter(Boolean).pop();
    if (!slug) return parsed.hostname;
    return slug
      .replace(/\.[a-z]{2,5}$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || parsed.hostname;
  } catch {
    return null;
  }
}
