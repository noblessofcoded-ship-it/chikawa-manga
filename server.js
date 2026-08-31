import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { config, bearerToken, PUBLIC_DIR } from './src/config.js';
import { loadLibrary, saveLibrary, loadChapters } from './src/store.js';
import { buildBook } from './src/chapters.js';
import { runSync, runImport } from './src/sync.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('リクエストが大きすぎます');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON として読めませんでした');
  }
}

function currentBook() {
  const lib = loadLibrary();
  const chapters = loadChapters();
  const book = buildBook(lib.episodes, chapters, { autoVolumeSize: config.autoVolumeSize });
  return { lib, chapters, book };
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep) && file !== join(PUBLIC_DIR, 'index.html')) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/library' && req.method === 'GET') {
      const { lib, book } = currentBook();
      return json(res, 200, {
        updatedAt: lib.updatedAt,
        lastSync: lib.lastSync,
        accounts: config.accounts,
        hasToken: Boolean(bearerToken),
        ...book,
      });
    }

    if (pathname === '/api/update' && req.method === 'POST') {
      const body = await readBody(req);
      const report = await runSync({ full: Boolean(body.full) });
      const { book } = currentBook();
      return json(res, 200, { report, ...book });
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      const refs = String(body.text || '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!refs.length) return json(res, 400, { error: '取り込むポストURLがありません。' });
      const report = await runImport(refs, { enrich: body.enrich !== false });
      const { book } = currentBook();
      return json(res, 200, { report, ...book });
    }

    // 話ごとの手直し（タイトルを付ける / 別の巻へ移す / 除外する）
    const epMatch = pathname.match(/^\/api\/episodes\/(\d+)$/);
    if (epMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const id = epMatch[1];
      const lib = loadLibrary();
      const idx = lib.episodes.findIndex((e) => String(e.id) === id);
      if (idx === -1) return json(res, 404, { error: 'その話は登録されていません。' });

      if (req.method === 'DELETE') {
        lib.episodes.splice(idx, 1);
      } else {
        const body = await readBody(req);
        const ep = lib.episodes[idx];
        if (typeof body.title === 'string') ep.title = body.title.slice(0, 120);
        if (typeof body.note === 'string') ep.note = body.note.slice(0, 500);
        if (body.volume === null || typeof body.volume === 'string') ep.volume = body.volume || undefined;
      }
      saveLibrary(lib);
      const { book } = currentBook();
      return json(res, 200, book);
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    return await serveStatic(req, res, pathname);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

/** 同じWi-Fi上のスマホから開くためのアドレス */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

server.listen(config.port, () => {
  console.log(`\n  ちいかわ書架\n`);
  console.log(`    このPCから    http://localhost:${config.port}`);
  for (const addr of lanAddresses()) {
    console.log(`    スマホから    http://${addr}:${config.port}   (同じWi-Fiに繋いでください)`);
  }
  console.log(`\n  取り込み対象 : ${config.accounts.map((a) => '@' + a).join(', ') || '(未設定)'}`);
  console.log(`  X API トークン: ${bearerToken ? '設定済み' : '未設定（手動取り込みは使えます）'}\n`);
});
