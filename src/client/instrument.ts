/// <reference lib="dom.iterable" />
/// <reference lib="dom" />
/**
 * DOM binding for the recorder. Embedded in a rendered page after
 * recorder.ts; assumes `createRecorder` is in scope and that the page has
 * been rendered by render-html.ts (elements carry data-path, cards carry
 * data-article, buttons carry data-action).
 *
 *   impression   a card or footer at least half visible for 300 ms
 *   open         click on a card (not on a button in it): opens the reader
 *   dwell,       reader closed; complete = the furthest scroll fraction
 *   complete     reached in the reader
 *   scroll_past  a card that had an impression left the viewport unopened
 *   action       click on a button
 *   session_end  page hidden or unloaded; the record is flushed to
 *                localStorage and, if configured, sent with sendBeacon
 *
 * Everything the page collects is exposed as window.proteus for export.
 */
declare function createRecorder(opts: { user: string; session: number; grammar: string; tree: unknown }): {
  impression(path: string, article?: string): void;
  open(path: string, article: string): boolean;
  close(fractionRead: number): void;
  scrollPast(path: string, article: string): void;
  action(path: string, action: string, article?: string): void;
  end(): void;
  record(): unknown;
  snapshot(): unknown;
  size(): number;
};

(function instrument() {
  const root = document.querySelector<HTMLElement>('.screen[data-proteus]');
  if (!root) return;
  const cfg = JSON.parse(root.getAttribute('data-proteus')!) as { user: string; session: number; grammar: string; endpoint?: string; storageKey: string };
  const tree = JSON.parse(document.getElementById('proteus-tree')!.textContent!);
  const rec = createRecorder({ user: cfg.user, session: cfg.session, grammar: cfg.grammar, tree });

  // Impressions and scroll-past.
  const timers = new Map<Element, number>();
  const impressed = new Set<Element>();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const path = el.dataset.path!;
      const article = el.dataset.article;
      if (e.isIntersecting && e.intersectionRatio >= 0.5) {
        if (!timers.has(el)) timers.set(el, window.setTimeout(() => { rec.impression(path, article); impressed.add(el); timers.delete(el); }, 300));
      } else {
        const tm = timers.get(el);
        if (tm !== undefined) { clearTimeout(tm); timers.delete(el); }
        if (impressed.has(el) && article && !el.classList.contains('opened')) rec.scrollPast(path, article);
      }
    }
  }, { threshold: [0, 0.5] });
  for (const el of root.querySelectorAll<HTMLElement>('.card[data-path], .section > .button[data-path]')) io.observe(el);

  // Reader overlay for opens.
  const reader = document.createElement('div');
  reader.className = 'proteus-reader';
  reader.hidden = true;
  reader.innerHTML = '<div class="proteus-reader-inner"><button class="proteus-close" type="button">Close</button><h1></h1><p class="proteus-meta"></p><div class="proteus-body"></div></div>';
  document.body.appendChild(reader);
  const inner = reader.querySelector<HTMLElement>('.proteus-reader-inner')!;
  let maxFraction = 0;
  const onScroll = () => {
    const denom = inner.scrollHeight - inner.clientHeight;
    const f = denom <= 0 ? 1 : inner.scrollTop / denom;
    if (f > maxFraction) maxFraction = f;
  };
  inner.addEventListener('scroll', onScroll);
  const closeReader = () => {
    if (reader.hidden) return;
    onScroll();
    rec.close(maxFraction);
    reader.hidden = true;
  };
  reader.querySelector('.proteus-close')!.addEventListener('click', closeReader);
  reader.addEventListener('click', (ev) => { if (ev.target === reader) closeReader(); });

  root.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const button = target.closest<HTMLElement>('.button[data-path]');
    if (button && root.contains(button)) {
      const card = button.closest<HTMLElement>('.card[data-path]');
      rec.action(button.dataset.path!, button.dataset.action!, card?.dataset.article);
      if (button.dataset.action === 'dismiss' && card) card.classList.add('dismissed');
      return;
    }
    const card = target.closest<HTMLElement>('.card[data-path]');
    if (!card || !root.contains(card)) return;
    if (!rec.open(card.dataset.path!, card.dataset.article!)) return;
    card.classList.add('opened');
    reader.querySelector('h1')!.textContent = card.dataset.article!;
    reader.querySelector('.proteus-meta')!.textContent = card.dataset.meta ?? '';
    // Content goes in as text, never as markup: article text is data.
    // A real article arrives as paragraphs separated by blank lines; the fake
    // data has one line, repeated so there is something to scroll.
    const body = card.dataset.body ?? '';
    const bodyEl = reader.querySelector('.proteus-body')!;
    bodyEl.textContent = '';
    const paras = body.split('\n\n').filter((s) => s.trim().length > 0);
    const repeat = paras.length <= 1 && !card.dataset.url ? 8 : 1;
    for (let i = 0; i < repeat; i++) for (const text of paras) { const para = document.createElement('p'); para.textContent = text; bodyEl.appendChild(para); }
    if (card.dataset.url && /^https?:\/\//.test(card.dataset.url)) {
      const link = document.createElement('a');
      link.className = 'proteus-source';
      link.href = card.dataset.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Read the original';
      bodyEl.appendChild(link);
    }
    maxFraction = 0;
    inner.scrollTop = 0;
    reader.hidden = false;
  });

  // Persist and (if configured) send. Going hidden flushes a snapshot but
  // keeps recording, since a backgrounded tab usually comes back; leaving
  // the page ends the session for good.
  const flush = (record: unknown) => {
    try { localStorage.setItem(cfg.storageKey, JSON.stringify(record)); } catch {}
    if (cfg.endpoint) {
      try { navigator.sendBeacon(cfg.endpoint, new Blob([JSON.stringify(record)], { type: 'application/json' })); } catch {}
    }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(rec.snapshot()); });
  window.addEventListener('pagehide', () => { closeReader(); rec.end(); flush(rec.record()); });

  const exportBox = document.getElementById('proteus-export') as HTMLTextAreaElement | null;
  const exportButton = document.getElementById('proteus-export-button');
  exportButton?.addEventListener('click', () => {
    closeReader();
    if (exportBox) { exportBox.value = JSON.stringify(rec.snapshot()); exportBox.hidden = false; exportBox.select(); }
  });

  (window as unknown as { proteus: unknown }).proteus = { recorder: rec, config: cfg, export: () => JSON.stringify(rec.snapshot()) };
})();
