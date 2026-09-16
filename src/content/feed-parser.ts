/**
 * RSS 2.0 and Atom parsing with no dependencies. Regex over the document,
 * which is enough for syndication feeds in the wild: items are flat, the
 * tags we want are few, and anything we cannot read becomes a missing
 * field rather than an error.
 *
 * Everything that comes out is plain text. Article HTML is reduced to
 * paragraphs here, once, so nothing downstream ever handles markup.
 */
export interface ParsedItem {
  title: string;
  url?: string;
  /** Short plain-text summary, one paragraph. */
  dek: string;
  /** Full plain text when the feed carries it, paragraphs joined by blank lines; otherwise the same as dek. */
  body: string;
  author?: string;
  /** Epoch ms; undefined when the feed gives no parseable date. */
  published?: number;
  categories: string[];
  imageUrl?: string;
}

export interface ParsedFeed {
  title?: string;
  items: ParsedItem[];
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', copy: '©', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Text of the first `<tag>` element, CDATA unwrapped and XML entities decoded. `tag` may carry a namespace prefix. */
function text(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'i');
  const m = re.exec(xml);
  if (!m) return undefined;
  const inner = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return (cdata ? cdata[1] : decodeEntities(inner)).trim();
}

function all(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const inner = m[1].trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
    out.push((cdata ? cdata[1] : decodeEntities(inner)).trim());
  }
  return out;
}

/** Value of `attr` on the first `<tag ...>` whose attributes satisfy `where`. */
function attr(xml: string, tag: string, attrName: string, where?: (attrs: string) => boolean): string | undefined {
  const re = new RegExp(`<${tag}(\\s[^>]*)?/?>`, 'gi');
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? '';
    if (where && !where(attrs)) continue;
    const v = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    if (v) return decodeEntities(v[2] ?? v[3] ?? '');
  }
  return undefined;
}

/** HTML to plain-text paragraphs: block boundaries become breaks, tags go, entities decode, whitespace collapses. */
export function htmlToParagraphs(html: string): string[] {
  const noBlocks = html
    .replace(/<(script|style|figure|iframe|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article|pre)\s*>|<br\s*\/?>|<hr\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(noBlocks)
    .split('\n')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

/** Cut to about `max` characters at a word boundary, with an ellipsis when cut. */
export function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

function firstImage(html: string | undefined): string | undefined {
  return html ? attr(html, 'img', 'src') : undefined;
}

function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function item(xml: string, atom: boolean): ParsedItem | undefined {
  const title = htmlToParagraphs(text(xml, 'title') ?? '').join(' ');
  if (!title) return undefined;
  let url: string | undefined;
  if (atom) {
    url = attr(xml, 'link', 'href', (a) => /rel\s*=\s*["']alternate["']/i.test(a)) ?? attr(xml, 'link', 'href', (a) => !/\brel\s*=/i.test(a)) ?? attr(xml, 'link', 'href');
  } else {
    url = text(xml, 'link') || attr(xml, 'link', 'href');
  }
  const summaryHtml = atom ? text(xml, 'summary') : text(xml, 'description');
  const contentHtml = atom ? text(xml, 'content') : text(xml, 'content:encoded');
  const summary = htmlToParagraphs(summaryHtml ?? '');
  const content = htmlToParagraphs(contentHtml ?? '');
  const body = (content.length ? content : summary).join('\n\n');
  const dek = truncate(summary[0] ?? content[0] ?? '');
  const author = atom
    ? (text(xml, 'name') ?? text(xml, 'author'))
    : (text(xml, 'dc:creator') ?? text(xml, 'author'));
  const published = parseDate(atom ? (text(xml, 'published') ?? text(xml, 'updated')) : (text(xml, 'pubDate') ?? text(xml, 'dc:date')));
  const categories = (atom ? xml.match(/<category\b[^>]*>/gi)?.map((c) => attr(c, 'category', 'term') ?? '') ?? [] : all(xml, 'category'))
    .map((c) => htmlToParagraphs(c).join(' ')).filter(Boolean);
  const imageUrl = attr(xml, 'media:content', 'url', (a) => !/\bmedium\s*=\s*["'](?!image)/i.test(a) && !/\btype\s*=\s*["'](?!image)/i.test(a))
    ?? attr(xml, 'media:thumbnail', 'url')
    ?? attr(xml, 'enclosure', 'url', (a) => /\btype\s*=\s*["']image\//i.test(a))
    ?? firstImage(contentHtml) ?? firstImage(summaryHtml);
  return { title, url: url?.trim() || undefined, dek, body, author: author?.trim() || undefined, published, categories, imageUrl: imageUrl?.trim() || undefined };
}

export function parseFeed(xml: string): ParsedFeed {
  const atom = /<feed\b[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml) || (!/<rss\b/i.test(xml) && /<feed\b/i.test(xml));
  const blocks = [...xml.matchAll(atom ? /<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi : /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].map((m) => m[1]);
  const firstBlock = blocks.length ? xml.search(atom ? /<entry\b/i : /<item\b/i) : xml.length;
  const head = xml.slice(0, firstBlock);
  const title = htmlToParagraphs(text(head, 'title') ?? '').join(' ') || undefined;
  const items: ParsedItem[] = [];
  for (const b of blocks) { const it = item(b, atom); if (it) items.push(it); }
  return { title, items };
}
