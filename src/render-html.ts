import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { UIDocument, UINode } from './tree.ts';
import type { Article, FeedData } from './fake-data.ts';

/**
 * Deliberately plain HTML renderer for newsfeed trees.
 *
 * Its only job is to let a human look at what the grammar produces. It knows
 * the newsfeed grammar's component names and slots; it is not a general
 * renderer. Every rendered element carries `data-path`, the node's path in
 * the tree, which is the identity later instrumentation and reward
 * attribution will key on.
 */
type Ctx = { screen: Record<string, string>; feed?: { name: string; articles: Article[] }; article?: Article };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function renderDocument(doc: UIDocument, data: FeedData): string {
  return renderNode(doc.tree, '', { screen: data.screen }, data);
}

function one(n: UINode | UINode[] | undefined): UINode | undefined {
  return Array.isArray(n) ? n[0] : n;
}
function many(n: UINode | UINode[] | undefined): UINode[] {
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
}
function sub(path: string, slot: string, i?: number): string {
  const base = path ? `${path}.${slot}` : slot;
  return i === undefined ? base : `${base}[${i}]`;
}

function renderNode(n: UINode, path: string, ctx: Ctx, data: FeedData): string {
  const p = n.props ?? {};
  const s = n.slots ?? {};
  switch (n.type) {
    case 'Screen': {
      const header = one(s.header);
      const sections = many(s.sections);
      return `<div class="screen density-${esc(p.density)}" data-path="${esc(path)}">` +
        (header ? renderNode(header, sub(path, 'header'), ctx, data) : '') +
        sections.map((sec, i) => renderNode(sec, sub(path, 'sections', i), ctx, data)).join('') +
        `</div>`;
    }
    case 'Header': {
      const title = one(s.title)!;
      const action = one(s.action);
      return `<header class="header" data-path="${esc(path)}">` +
        renderNode(title, sub(path, 'title'), ctx, data) +
        (action ? renderNode(action, sub(path, 'action'), ctx, data) : '') +
        `</header>`;
    }
    case 'Section': {
      const feed = data.feeds[p.source];
      if (!feed) throw new Error(`no fake feed for source '${p.source}'`);
      const fctx: Ctx = { ...ctx, feed };
      const heading = one(s.heading);
      const content = one(s.content)!;
      const footer = one(s.footer);
      return `<section class="section" data-source="${esc(p.source)}" data-path="${esc(path)}">` +
        (heading ? renderNode(heading, sub(path, 'heading'), fctx, data) : '') +
        renderNode(content, sub(path, 'content'), fctx, data) +
        (footer ? renderNode(footer, sub(path, 'footer'), fctx, data) : '') +
        `</section>`;
    }
    case 'Collection': {
      const feed = ctx.feed!;
      const limit = Number(p.limit);
      const lead = one(s.lead);
      const item = one(s.item)!;
      const articles = feed.articles.slice(0, limit);
      const parts: string[] = [];
      // A personal feed can be empty for a real user. Say so rather than pad it.
      if (articles.length === 0) parts.push(`<p class="empty">${esc(data.strings['empty'] ?? 'Nothing here yet.')}</p>`);
      articles.forEach((a, i) => {
        const actx: Ctx = { ...ctx, article: a };
        if (i === 0 && lead) parts.push(renderNode(lead, sub(path, 'lead'), actx, data));
        else parts.push(renderNode(item, sub(path, 'item'), actx, data));
      });
      return `<div class="collection layout-${esc(p.layout)}" data-path="${esc(path)}">${parts.join('')}</div>`;
    }
    case 'Card': {
      const media = one(s.media);
      const title = one(s.title)!;
      const meta = many(s.meta);
      const summary = one(s.summary);
      const actions = many(s.actions);
      const a = ctx.article!;
      // The article identity and enough content for the reader overlay, so
      // instrumentation can name what was opened and show something to read.
      // Live feeds often carry no author, in which case it is the source.
      const metaLine = [a.source, a.author !== a.source ? a.author : '', a.readTime].filter(Boolean).join(' · ');
      return `<article class="card variant-${esc(p.variant)}" data-path="${esc(path)}" data-article="${esc(a.title)}" data-meta="${esc(metaLine)}" data-body="${esc(a.body ?? a.dek)}"${a.url ? ` data-url="${esc(a.url)}"` : ''}>` +
        (media ? renderNode(media, sub(path, 'media'), ctx, data) : '') +
        `<div class="card-body">` +
        renderNode(title, sub(path, 'title'), ctx, data) +
        (meta.length ? `<div class="meta">${meta.map((m, i) => renderNode(m, sub(path, 'meta', i), ctx, data)).join('<span class="dot">·</span>')}</div>` : '') +
        (summary ? renderNode(summary, sub(path, 'summary'), ctx, data) : '') +
        (actions.length ? `<div class="actions">${actions.map((b, i) => renderNode(b, sub(path, 'actions', i), ctx, data)).join('')}</div>` : '') +
        `</div></article>`;
    }
    case 'Text': {
      const text = n.bind !== undefined ? resolveBind(n.bind, ctx) : data.strings[n.key!] ?? `[${n.key}]`;
      return `<p class="text role-${esc(p.role)}" style="-webkit-line-clamp:${esc(p.maxLines)}" data-path="${esc(path)}">${esc(text)}</p>`;
    }
    case 'Image': {
      const url = resolveBind(n.bind!, ctx);
      return `<img class="image" style="aspect-ratio:${esc(p.aspect.replace(':', '/'))}" src="${esc(url)}" alt="" data-path="${esc(path)}">`;
    }
    case 'Button': {
      const label = data.actionLabels[p.action] ?? p.action;
      return `<button class="button style-${esc(p.style)}" data-action="${esc(p.action)}" data-path="${esc(path)}">${esc(label)}</button>`;
    }
    default:
      throw new Error(`renderer has no case for component '${n.type}'`);
  }
}

function resolveBind(field: string, ctx: Ctx): string {
  if (ctx.article && field in ctx.article) return (ctx.article as unknown as Record<string, string>)[field];
  if (ctx.feed && field === 'name') return ctx.feed.name;
  if (field in ctx.screen) return ctx.screen[field];
  throw new Error(`cannot resolve binding '${field}' in this context`);
}

/** Styles for the rendered screens. Plain on purpose. */
export const screenCss = `
.screen { width: 390px; background: #fff; color: #111; font-family: -apple-system, system-ui, sans-serif; padding: 12px; box-sizing: border-box; overflow: hidden; }
.screen.density-compact { --gap: 6px; --pad: 8px; --fs: 13px; }
.screen.density-comfortable { --gap: 14px; --pad: 14px; --fs: 15px; }
.header { display: flex; align-items: center; justify-content: space-between; padding-bottom: var(--pad); }
.header .text { font-size: 22px; font-weight: 700; margin: 0; }
.section { margin-bottom: calc(var(--gap) * 1.5); }
.section > .text.role-title { font-size: 17px; font-weight: 700; margin: 0 0 var(--gap); }
.section > .text.role-label { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #666; margin: 0 0 var(--gap); }
.section > .button { margin-top: var(--gap); }
.collection { display: flex; gap: var(--gap); }
.collection.layout-stack { flex-direction: column; }
.collection.layout-carousel { flex-direction: row; overflow-x: auto; }
.collection.layout-carousel .card { flex: 0 0 220px; }
.collection.layout-grid { display: grid; grid-template-columns: 1fr 1fr; }
.card { display: flex; flex-direction: column; gap: 6px; }
.collection .empty { margin: 0; padding: var(--pad); color: #777; font-size: var(--fs); background: #f4f4f6; border-radius: 6px; }
.card.variant-hero { border-radius: 10px; overflow: hidden; }
.card.variant-hero .image { width: 100%; }
.card.variant-hero .text.role-title { font-size: 20px; font-weight: 700; }
.card.variant-standard { }
.card.variant-standard .image { width: 100%; border-radius: 6px; }
.card.variant-standard .text.role-title { font-size: var(--fs); font-weight: 600; }
.card.variant-compact { flex-direction: row; align-items: flex-start; }
.card.variant-compact .image { width: 64px; border-radius: 6px; flex: 0 0 64px; }
.card.variant-compact .text.role-title { font-size: var(--fs); font-weight: 600; }
.card-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.image { display: block; object-fit: cover; background: #ddd; }
.text { margin: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; font-size: var(--fs); line-height: 1.3; }
.text.role-body { color: #444; }
.text.role-caption, .text.role-label { font-size: 12px; color: #666; }
.text.role-label { font-weight: 600; }
.meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dot { color: #999; font-size: 12px; }
.actions { display: flex; gap: 8px; margin-top: 2px; }
.button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: default; }
.button.style-primary { background: #111; color: #fff; border-color: #111; }
.button.style-secondary { background: #f2f2f2; border-color: #f2f2f2; }
.button.style-ghost { border-color: transparent; color: #333; padding-left: 4px; padding-right: 4px; }
`;

export interface InstrumentOptions {
  user: string;
  session: number;
  /** Optional URL to POST the session record to on page hide (navigator.sendBeacon). */
  endpoint?: string;
}

let cachedClient: string | undefined;

/** The recorder and DOM binding, type-stripped for the browser. No bundler: two files concatenated. */
export function clientScript(): string {
  if (cachedClient) return cachedClient;
  const strip = (file: string) => {
    const src = readFileSync(new URL(`./client/${file}`, import.meta.url), 'utf8');
    const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return out.replace(/^export\s+/gm, '').replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  };
  cachedClient = `${strip('recorder.ts')}\n${strip('instrument.ts')}`;
  return cachedClient;
}

export const readerCss = `
.proteus-reader { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 10; }
.proteus-reader[hidden], #proteus-export[hidden] { display: none; }
.proteus-reader-inner { background: #fff; color: #111; width: min(560px, 92vw); max-height: 80vh; overflow-y: auto; padding: 20px 24px; border-radius: 12px; font-family: -apple-system, system-ui, sans-serif; line-height: 1.5; }
.proteus-reader-inner h1 { font-size: 22px; margin: 8px 0; }
.proteus-meta { color: #666; font-size: 13px; margin: 0 0 12px; }
.proteus-source { display: inline-block; margin-top: 8px; font-size: 14px; }
.proteus-close { float: right; font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; border: 1px solid #ccc; background: #f6f6f6; }
.card.opened .text.role-title { color: #555; }
.card.dismissed { opacity: .35; }
.proteus-toolbar { width: 390px; margin: 8px 0; display: flex; gap: 8px; align-items: flex-start; font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
#proteus-export { flex: 1; height: 80px; font-size: 11px; }
`;

/**
 * A complete, self-contained page: one screen, its styles, and, when
 * `instrument` is given, the recorder wired to it plus an export box. The
 * tree is embedded so the exported record carries what was shown.
 */
export function renderPage(doc: UIDocument, data: FeedData, instrument?: InstrumentOptions): string {
  let screen = renderDocument(doc, data);
  let extras = '';
  if (instrument) {
    const cfg = { user: instrument.user, session: instrument.session, grammar: doc.grammar, endpoint: instrument.endpoint, storageKey: `proteus:${instrument.user}:${instrument.session}` };
    screen = screen.replace('<div class="screen ', `<div data-proteus="${esc(JSON.stringify(cfg))}" class="screen `);
    extras = `
<div class="proteus-toolbar"><button id="proteus-export-button" type="button">Export session</button><textarea id="proteus-export" hidden readonly></textarea></div>
<script type="application/json" id="proteus-tree">${JSON.stringify(doc.tree).replace(/</g, '\\u003c')}</script>
<script>${clientScript()}</script>`;
  }
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proteus · ${esc(doc.grammar)}${instrument ? ` · ${esc(instrument.user)} session ${instrument.session}` : ''}</title>
<style>
body { margin: 0; padding: 16px; background: #e9e9ee; }
${screenCss}
${readerCss}
</style>
${screen}
${extras}
`;
}
