/**
 * ちいかわ書架 — 単行本のように読むためのリーダー。
 *
 * 漫画の画像はこのアプリには保存されていない。各話のページは X の公式埋め込みを
 * その場で呼び出して表示するので、画像は X（権利者側）から配信される。
 * このアプリが持っているのは「どのポストが何巻の何話か」という索引だけ。
 */

import { buildBook } from './lib/chapters.js';
import { parsePostRef, idToDate } from './lib/postref.js';

const $ = (sel) => document.querySelector(sel);

const el = {
  stage: $('#stage'),
  book: $('#book'),
  spread: $('#spread'),
  navPrev: $('#nav-prev'),
  navNext: $('#nav-next'),
  slider: $('#slider'),
  indicator: $('#page-indicator'),
  barSub: $('#bar-sub'),
  btnToc: $('#btn-toc'),
  btnMark: $('#btn-mark'),
  btnUpdate: $('#btn-update'),
  toc: $('#toc'),
  tocList: $('#toc-list'),
  tocSearch: $('#toc-search'),
  tocClose: $('#toc-close'),
  scrim: $('#scrim'),
  dialog: $('#update-dialog'),
  updateBody: $('#update-body'),
  manualInput: $('#manual-input'),
  btnManual: $('#btn-manual'),
  btnExport: $('#btn-export'),
  toast: $('#toast'),
};

const STORE_KEY = 'chikawa-book/progress';
const MARK_KEY = 'chikawa-book/bookmarks';
const LOCAL_KEY = 'chikawa-book/local-episodes';

const state = {
  library: null,
  pages: [],
  spreads: [],
  current: 0,      // spreads のindex
  busy: false,
  singlePage: false,
  bookmarks: readJSON(MARK_KEY, []),
};

/* ------------------------------------------------------------------ 保存 */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても読書は続けられる */ }
}

/* --------------------------------------------------- 書架の読み込み経路 */

/**
 * 動かし方が2通りある:
 *   server — npm start でサーバーごと動かす。取り込みはサーバー側が行う。
 *   static — GitHub Pages などに置いた静的ファイルだけで動かす（iPhone単体向け）。
 *            リポジトリの data/ を読み、この端末で足した分は localStorage に持つ。
 */
let mode = 'server';

async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const localEpisodes = () => readJSON(LOCAL_KEY, []);
const saveLocalEpisodes = (list) => writeJSON(LOCAL_KEY, list);

/** リポジトリのdata/と、この端末で足した分を合わせて章立てする */
async function buildStaticLibrary() {
  const [file, chapters] = await Promise.all([
    fetchJSON('./data/episodes.json'),
    fetchJSON('./data/chapters.json').catch(() => ({ volumes: [] })),
  ]);
  const shared = Array.isArray(file.episodes) ? file.episodes : [];
  const known = new Set(shared.map((e) => String(e.id)));
  const mine = localEpisodes().filter((e) => !known.has(String(e.id)));

  return {
    ...buildBook([...shared, ...mine], chapters),
    updatedAt: file.updatedAt || null,
    lastSync: file.lastSync || null,
    accounts: file.accounts || [],
    hasToken: false,
    localCount: mine.length,
  };
}

/** サーバーが居ればそちら、居なければ静的モードへ落とす */
async function loadLibraryData() {
  try {
    const data = await fetchJSON('./api/library');
    mode = 'server';
    return data;
  } catch {
    mode = 'static';
    return buildStaticLibrary();
  }
}

/** 静的モードでの手動取り込み。ネットワークに触らず、ポストIDから日時を復元する。 */
function importLocally(text) {
  const refs = String(text).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const list = localEpisodes();
  const seen = new Set(list.map((e) => String(e.id)));
  const invalid = [];
  let added = 0;

  for (const raw of refs) {
    const ref = parsePostRef(raw);
    if (!ref) { invalid.push(raw); continue; }
    if (seen.has(ref.id)) continue;
    const author = ref.author || state.library?.accounts?.[0] || 'i';
    list.push({
      id: ref.id,
      url: `https://x.com/${author}/status/${ref.id}`,
      author,
      publishedAt: idToDate(ref.id),
      label: '',
      imageCount: null,
      addedAt: new Date().toISOString(),
    });
    seen.add(ref.id);
    added += 1;
  }
  saveLocalEpisodes(list);
  return { added, invalid, total: list.length };
}

/* ------------------------------------------------------------ ページ組み */

function buildPages(library) {
  const pages = [{ kind: 'cover' }];
  if (!library.volumes.length) {
    pages.push({ kind: 'empty' });
    return pages;
  }
  pages.push({ kind: 'contents' });
  for (const volume of library.volumes) {
    pages.push({ kind: 'volume', volume });
    for (const episode of volume.episodes) {
      pages.push({ kind: 'episode', episode, volume });
    }
  }
  pages.push({ kind: 'colophon' });
  return pages;
}

/**
 * 右綴じの本の開き方に合わせて、表紙だけ単独・以降は2ページずつ束ねる。
 * 画面が狭いときは、実際の文庫のように1ページずつめくる。
 */
function buildSpreads(pages, single) {
  if (single) return pages.map((_, i) => [i]);
  const spreads = [[0]];
  for (let i = 1; i < pages.length; i += 2) {
    spreads.push(pages[i + 1] === undefined ? [i] : [i, i + 1]);
  }
  return spreads;
}

/** 画面幅が変わったとき、いま開いているページを見失わないように組み直す */
function rebuildSpreads() {
  const anchor = (state.spreads[state.current] || [0])[0] ?? 0;
  state.spreads = buildSpreads(state.pages, state.singlePage);
  state.current = Math.max(0, spreadOfPage(anchor));
  renderSpread();
}

/* -------------------------------------------------------------- 描画補助 */

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};

const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function episodeTitle(ep) {
  return ep.title || ep.label || `${fmtDate(ep.publishedAt)} の話`;
}

/* --------------------------------------------------------- 各ページの中身 */

function renderCover(page, root) {
  const plate = node('div', 'plate');
  plate.append(
    node('p', 'plate__kicker', 'ナガノ'),
    node('h1', 'plate__title', 'ちいかわ'),
    node('div', 'plate__rule'),
    node('p', 'plate__sub', state.library?.totalEpisodes
      ? `全${state.library.totalVolumes}巻 ／ ${state.library.totalEpisodes}話`
      : '書架'),
  );
  if (state.library?.lastSync) {
    plate.append(node('p', 'plate__sub', `最終更新 ${fmtDate(state.library.lastSync)}`));
  }
  root.append(plate);
}

function renderEmpty(page, root) {
  const plate = node('div', 'plate');
  plate.append(node('p', 'plate__kicker', 'はじめに'), node('h2', 'plate__title', '書架はまだ空です'));
  const note = node('div', 'plate__note');
  note.innerHTML = mode === 'static'
    ? `右上の<strong>「更新」</strong>で配信元の索引を読み直します。<br><br>
       この端末だけで話を足すには、更新パネルの<strong>「手動で足す」</strong>に
       ポストのURLを貼り付けてください。X アプリの共有からURLをコピーして、
       ここに貼るだけです。足した分はこの端末に保存されます。<br><br>
       取り込むのは「どのポストが何話か」という索引だけで、
       画像は読むときに X の公式埋め込みから表示されます。`
    : `右上の<strong>「更新」</strong>を押すと、設定したアカウントの新着を取りに行きます。<br><br>
       X API のトークン（<code>X_BEARER_TOKEN</code>）を入れておくと自動で、
       入っていない場合も更新パネルからポストのURLを貼り付けて手で足せます。<br><br>
       取り込むのは「どのポストが何話か」という索引だけで、
       画像は読むときに X の公式埋め込みから表示されます。`;
  plate.append(note);
  root.append(plate);
}

function renderContents(page, root) {
  const plate = node('div', 'plate');
  plate.style.justifyContent = 'flex-start';
  plate.append(node('p', 'plate__kicker', 'もくじ'), node('div', 'plate__rule'));

  const list = node('div');
  list.style.cssText = 'width:100%;max-width:34ch;font-family:"Hiragino Mincho ProN",serif;font-size:13px;line-height:2.3;';
  for (const v of state.library.volumes) {
    const row = node('div');
    row.style.cssText = 'display:flex;justify-content:space-between;gap:10px;border-bottom:1px dotted var(--rule);cursor:pointer;';
    row.append(node('span', null, v.title), node('span', null, `${v.count}話`));
    row.addEventListener('click', () => goToVolume(v.id));
    list.append(row);
  }
  plate.append(list);
  root.append(plate);
}

function renderVolume(page, root) {
  const v = page.volume;
  const plate = node('div', 'plate');
  plate.append(
    node('p', 'plate__kicker', v.subtitle || '　'),
    node('h2', 'plate__title', v.title),
    node('div', 'plate__rule'),
    node('p', 'plate__sub', `${v.count}話　${fmtDate(v.from)} – ${fmtDate(v.to)}`),
  );
  root.append(plate);
}

function renderEpisode(page, root) {
  const { episode: ep, volume } = page;
  const wrap = node('article', 'ep');

  const head = node('div', 'ep__head');
  const left = node('div');
  left.append(
    node('div', 'ep__no', `${volume.title}　第${ep.episodeNo}話`),
    node('h3', 'ep__title', episodeTitle(ep)),
  );
  head.append(left, node('div', 'ep__date', fmtDate(ep.publishedAt)));

  const frame = node('div', 'ep__frame');
  frame.append(node('p', 'ep__loading', '読み込んでいます…'));

  const foot = node('div', 'ep__foot');
  const link = node('a', null, 'Xで開く');
  link.href = ep.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  foot.append(link);

  wrap.append(head, frame, foot);
  root.append(wrap);
  mountEmbed(frame, ep);
}

function renderColophon(page, root) {
  const plate = node('div', 'plate');
  plate.append(node('p', 'plate__kicker', 'おくづけ'), node('div', 'plate__rule'));
  const note = node('div', 'plate__note');
  const accounts = (state.library.accounts || []).map((a) => `@${a}`).join('、') || '(未設定)';
  note.innerHTML = `
    収録　${state.library.totalEpisodes}話（全${state.library.totalVolumes}巻）<br>
    取り込み元　${accounts}<br>
    最終更新　${state.library.lastSync ? fmtDate(state.library.lastSync) : 'まだ'}<br><br>
    漫画の著作権はナガノ先生にあります。このアプリはポストの索引と表示順だけを持っていて、
    画像そのものは保存していません。各ページは X の公式埋め込みを通して表示されます。`;
  plate.append(note);
  root.append(plate);
}

const RENDERERS = {
  cover: renderCover,
  empty: renderEmpty,
  contents: renderContents,
  volume: renderVolume,
  episode: renderEpisode,
  colophon: renderColophon,
};

/* ---------------------------------------------------------- 埋め込み表示 */

function waitForWidgets(timeout = 9000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (window.twttr?.widgets?.createTweet) return resolve(window.twttr.widgets);
      if (Date.now() - started > timeout) return reject(new Error('widgets.js が読み込めませんでした'));
      setTimeout(poll, 120);
    })();
  });
}

async function mountEmbed(frame, ep) {
  const token = Symbol('mount');
  frame.dataset.mount = String(ep.id);
  frame._token = token;

  const fail = () => {
    if (frame._token !== token) return;
    frame.textContent = '';
    const box = node('div', 'ep__fallback');
    box.innerHTML = `この環境では埋め込みを表示できませんでした。<br><a href="${ep.url}" target="_blank" rel="noopener noreferrer">Xでこの話を開く →</a>`;
    frame.append(box);
  };

  try {
    const widgets = await waitForWidgets();
    if (frame._token !== token) return;
    frame.textContent = '';
    const rendered = await widgets.createTweet(String(ep.id), frame, {
      lang: 'ja',
      dnt: true,
      conversation: 'none',
      align: 'center',
      theme: isDark() ? 'dark' : 'light',
      width: 480,
    });
    if (frame._token !== token) return;
    if (!rendered) fail();
  } catch {
    fail();
  }
}

/* -------------------------------------------------------------- 見開き描画 */

function renderSpread(direction) {
  const spread = state.spreads[state.current] || [0];
  const paint = () => {
    el.spread.textContent = '';
    el.spread.classList.toggle('is-single', spread.length === 1);

    // 右綴じ＝右ページが手前。DOM は左→右の順に並ぶので、逆順に差し込む。
    const ordered = [...spread].reverse();
    for (const [i, pageIndex] of ordered.entries()) {
      const page = state.pages[pageIndex];
      const side = spread.length === 1 ? 'right' : (i === 0 && spread.length === 2 ? 'left' : 'right');
      const root = node('section', `page page--${side}`);
      (RENDERERS[page.kind] || renderEmpty)(page, root);
      root.append(node('div', 'page__no', String(pageIndex + 1)));
      el.spread.append(root);
    }
    updateChrome();
  };

  if (!direction) return paint();

  el.spread.classList.add(direction === 'next' ? 'turn-next' : 'turn-prev');
  setTimeout(() => {
    paint();
    el.spread.classList.remove('turn-next', 'turn-prev');
  }, 190);
}

function updateChrome() {
  const spread = state.spreads[state.current] || [];
  const first = state.pages[spread[0]];
  const ep = spread.map((i) => state.pages[i]).find((p) => p?.kind === 'episode');

  el.navNext.disabled = state.current >= state.spreads.length - 1;
  el.navPrev.disabled = state.current <= 0;
  el.slider.max = String(Math.max(0, state.spreads.length - 1));
  el.slider.value = String(state.current);

  el.indicator.textContent = `${spread.map((i) => i + 1).join('–')} / ${state.pages.length}`;
  el.barSub.textContent = ep
    ? `${ep.volume.title}　第${ep.episode.episodeNo}話　${fmtDate(ep.episode.publishedAt)}`
    : first?.kind === 'volume' ? first.volume.title : '';

  const marked = ep && state.bookmarks.includes(String(ep.episode.id));
  el.btnMark.textContent = marked ? 'しおり ●' : 'しおり';

  if (ep) writeJSON(STORE_KEY, { episodeId: String(ep.episode.id), at: Date.now() });
  highlightToc();
}

/* ------------------------------------------------------------------ 移動 */

function goTo(index, direction) {
  const clamped = Math.max(0, Math.min(state.spreads.length - 1, index));
  if (clamped === state.current && direction) return;
  const dir = direction || (clamped > state.current ? 'next' : 'prev');
  state.current = clamped;
  renderSpread(dir);
}

const next = () => goTo(state.current + 1, 'next');
const prev = () => goTo(state.current - 1, 'prev');

function spreadOfPage(pageIndex) {
  return state.spreads.findIndex((s) => s.includes(pageIndex));
}

function goToEpisode(id) {
  const pageIndex = state.pages.findIndex((p) => p.kind === 'episode' && String(p.episode.id) === String(id));
  if (pageIndex === -1) return false;
  goTo(spreadOfPage(pageIndex));
  return true;
}

function goToVolume(volumeId) {
  const pageIndex = state.pages.findIndex((p) => p.kind === 'volume' && p.volume.id === volumeId);
  if (pageIndex === -1) return;
  goTo(spreadOfPage(pageIndex));
  closeToc();
}

/* ------------------------------------------------------------------ 目次 */

function renderToc(filter = '') {
  const q = filter.trim().toLowerCase();
  el.tocList.textContent = '';
  if (!state.library?.volumes?.length) {
    el.tocList.append(node('p', 'ep__loading', 'まだ1話も入っていません。'));
    return;
  }

  for (const v of state.library.volumes) {
    const eps = v.episodes.filter((ep) => {
      if (!q) return true;
      return `${episodeTitle(ep)} ${fmtDate(ep.publishedAt)} ${v.title}`.toLowerCase().includes(q);
    });
    if (!eps.length) continue;

    const head = node('div', 'toc__vol');
    head.append(node('span', 'toc__vol-title', v.title), node('span', 'toc__vol-count', `${v.count}話`));
    head.addEventListener('click', () => goToVolume(v.id));
    el.tocList.append(head);

    for (const ep of eps) {
      const btn = node('button', 'toc__ep');
      btn.type = 'button';
      btn.dataset.epId = String(ep.id);
      btn.append(
        node('span', 'toc__ep-no', `${ep.episodeNo}話`),
        node('span', 'toc__ep-label', episodeTitle(ep)),
      );
      if (state.bookmarks.includes(String(ep.id))) btn.append(node('span', 'toc__mark', '●'));
      btn.append(node('span', 'toc__ep-date', fmtDate(ep.publishedAt)));
      btn.addEventListener('click', () => {
        goToEpisode(ep.id);
        if (window.matchMedia('(max-width: 860px)').matches) closeToc();
      });
      el.tocList.append(btn);
    }
  }
  highlightToc();
}

function highlightToc() {
  const spread = state.spreads[state.current] || [];
  const ep = spread.map((i) => state.pages[i]).find((p) => p?.kind === 'episode');
  const id = ep ? String(ep.episode.id) : null;
  el.tocList.querySelectorAll('.toc__ep').forEach((b) => {
    b.classList.toggle('is-current', b.dataset.epId === id);
  });
}

function openToc() {
  el.toc.hidden = false;
  el.scrim.hidden = false;
  el.btnToc.setAttribute('aria-expanded', 'true');
  const current = el.tocList.querySelector('.toc__ep.is-current');
  if (current) current.scrollIntoView({ block: 'center' });
}
function closeToc() {
  el.toc.hidden = true;
  el.scrim.hidden = true;
  el.btnToc.setAttribute('aria-expanded', 'false');
}

/* ---------------------------------------------------------------- 更新 */

function toast(message, ms = 3200) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function showReport(report) {
  el.updateBody.textContent = '';
  const list = node('ul', 'report');
  const add = (k, v, cls) => {
    const li = node('li');
    li.append(node('span', null, k), node('span', cls, v));
    list.append(li);
  };
  add('新しく入った話', `${report.added} 話`);
  if (report.refreshed) add('情報を更新した話', `${report.refreshed} 話`);
  if (report.skipped) add('対象外（画像なし等）', `${report.skipped} 件`);
  add('書架の合計', `${report.total} 話`);
  el.updateBody.append(list);

  for (const e of report.errors || []) {
    const p = node('p', 'err');
    p.textContent = `${e.account ? '@' + e.account + ': ' : ''}${e.message}${e.hint ? ' — ' + e.hint : ''}`;
    el.updateBody.append(p);
  }
}

async function runUpdate() {
  if (state.busy) return;
  state.busy = true;
  el.btnUpdate.disabled = true;
  el.btnUpdate.querySelector('.spinner').hidden = false;
  el.btnUpdate.querySelector('.btn-label').textContent = '取得中';

  try {
    let report;
    if (mode === 'static') {
      // 配信元の data/ を読み直す（GitHub Actions などで更新された分が入ってくる）
      const before = state.library?.totalEpisodes || 0;
      const library = await buildStaticLibrary();
      applyLibrary(library, { keepPlace: true });
      report = {
        added: Math.max(0, library.totalEpisodes - before),
        refreshed: 0,
        skipped: 0,
        total: library.totalEpisodes,
        errors: [],
      };
    } else {
      const res = await fetch('./api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '更新に失敗しました');
      applyLibrary(data, { keepPlace: true });
      report = data.report;
    }

    showReport(report);
    if (report.added > 0) {
      toast(`${report.added}話ぶん増えました`);
    } else if (report.errors?.length) {
      el.dialog.showModal();
    } else {
      toast('新しい話はありませんでした');
    }
  } catch (err) {
    el.updateBody.textContent = '';
    el.updateBody.append(node('p', 'err', err.message));
    el.dialog.showModal();
  } finally {
    state.busy = false;
    el.btnUpdate.disabled = false;
    el.btnUpdate.querySelector('.spinner').hidden = true;
    el.btnUpdate.querySelector('.btn-label').textContent = '更新';
  }
}

async function runManualImport() {
  const text = el.manualInput.value.trim();
  if (!text) return toast('URLを貼り付けてください');
  el.btnManual.disabled = true;
  try {
    let report;
    if (mode === 'static') {
      report = importLocally(text);
      applyLibrary(await buildStaticLibrary(), { keepPlace: true });
    } else {
      const res = await fetch('./api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '取り込みに失敗しました');
      applyLibrary(data, { keepPlace: true });
      report = data.report;
    }
    el.manualInput.value = '';
    const invalid = report.invalid?.length ? `（${report.invalid.length}件は読み取れませんでした）` : '';
    toast(`${report.added}話を書架に加えました${invalid}`);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    el.btnManual.disabled = false;
  }
}

/**
 * この端末で足した分を JSON で書き出す。
 * リポジトリの data/episodes.json へ移して共有したいときや、
 * 端末を替えるときの控えとして使う。
 */
async function exportLocal() {
  const list = localEpisodes();
  if (!list.length) return toast('この端末で足した話はまだありません');
  const text = JSON.stringify(list, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast(`${list.length}件をコピーしました`);
  } catch {
    // クリップボードが使えない環境では、選んでコピーできるように出す
    el.manualInput.value = text;
    el.manualInput.select();
    toast('上の欄に出しました。選択してコピーしてください', 5000);
  }
}

/* ---------------------------------------------------------------- 起動 */

function applyLibrary(library, { keepPlace = false } = {}) {
  const before = keepPlace ? currentEpisodeId() : null;
  state.library = library;
  state.pages = buildPages(library);
  state.spreads = buildSpreads(state.pages, state.singlePage);
  renderToc(el.tocSearch.value);

  if (before && goToEpisode(before)) return;
  state.current = Math.min(state.current, state.spreads.length - 1);
  renderSpread();
}

function currentEpisodeId() {
  const spread = state.spreads[state.current] || [];
  const ep = spread.map((i) => state.pages[i]).find((p) => p?.kind === 'episode');
  return ep ? String(ep.episode.id) : null;
}

function restorePlace() {
  const saved = readJSON(STORE_KEY, null);
  if (saved?.episodeId && goToEpisode(saved.episodeId)) {
    toast('前回の続きから開きました');
  }
}

function bindEvents() {
  el.navNext.addEventListener('click', next);
  el.navPrev.addEventListener('click', prev);
  el.slider.addEventListener('input', () => goTo(Number(el.slider.value)));

  el.btnToc.addEventListener('click', () => (el.toc.hidden ? openToc() : closeToc()));
  el.tocClose.addEventListener('click', closeToc);
  el.scrim.addEventListener('click', closeToc);
  el.tocSearch.addEventListener('input', () => renderToc(el.tocSearch.value));

  el.btnUpdate.addEventListener('click', runUpdate);
  el.btnManual.addEventListener('click', runManualImport);
  el.btnExport.addEventListener('click', exportLocal);

  el.btnMark.addEventListener('click', () => {
    const id = currentEpisodeId();
    if (!id) return toast('この見開きには話がありません');
    const i = state.bookmarks.indexOf(id);
    if (i === -1) { state.bookmarks.push(id); toast('しおりを挟みました'); }
    else { state.bookmarks.splice(i, 1); toast('しおりを外しました'); }
    writeJSON(MARK_KEY, state.bookmarks);
    updateChrome();
    renderToc(el.tocSearch.value);
  });

  // 右綴じ: → で前へ戻り、← で先へ進む
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    switch (e.key) {
      case 'ArrowLeft': case 'PageDown': case ' ': next(); e.preventDefault(); break;
      case 'ArrowRight': case 'PageUp': prev(); e.preventDefault(); break;
      case 'Home': goTo(0); break;
      case 'End': goTo(state.spreads.length - 1); break;
      case 't': case 'T': el.toc.hidden ? openToc() : closeToc(); break;
      case 'Escape': closeToc(); break;
      default: break;
    }
  });

  // スワイプ
  let startX = 0, startY = 0, tracking = false;
  el.stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  el.stage.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 55 || Math.abs(dy) > Math.abs(dx)) return;
    dx < 0 ? next() : prev();   // 左へ払う＝先へ進む
  }, { passive: true });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderSpread());

  const narrow = window.matchMedia('(max-width: 860px)');
  state.singlePage = narrow.matches;
  narrow.addEventListener('change', (e) => {
    state.singlePage = e.matches;
    if (state.pages.length) rebuildSpreads();
  });
}

async function main() {
  bindEvents();
  try {
    const library = await loadLibraryData();
    applyLibrary(library);
    el.btnExport.hidden = mode !== 'static';
    restorePlace();
    if (!library.totalEpisodes) el.barSub.textContent = '「更新」から取り込みを始めてください';
  } catch (err) {
    el.spread.textContent = '';
    const root = node('section', 'page page--right');
    const plate = node('div', 'plate');
    plate.append(node('h2', 'plate__title', 'よみこめません'), node('p', 'plate__note', err.message));
    root.append(plate);
    el.spread.append(root);
  }
}

main();
