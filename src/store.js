import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { byPublishedAsc } from '../public/lib/sort.js';

export { byPublishedAsc };

const EPISODES = join(DATA_DIR, 'episodes.json');
const CHAPTERS = join(DATA_DIR, 'chapters.json');

const EMPTY_LIBRARY = { updatedAt: null, lastSync: null, episodes: [] };

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} が壊れています: ${err.message}`);
  }
}

function writeJson(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function loadLibrary() {
  const lib = readJson(EPISODES, EMPTY_LIBRARY);
  lib.episodes = Array.isArray(lib.episodes) ? lib.episodes : [];
  return lib;
}

export function saveLibrary(lib) {
  lib.updatedAt = new Date().toISOString();
  lib.episodes.sort(byPublishedAsc);
  writeJson(EPISODES, lib);
  return lib;
}

export function loadChapters() {
  return readJson(CHAPTERS, { volumes: [] });
}

export function saveChapters(chapters) {
  writeJson(CHAPTERS, chapters);
  return chapters;
}

/**
 * 取得した話を既存ライブラリへ統合する。
 * 既存の id はスキップし、手で付けたタイトル・巻の指定は上書きしない。
 */
export function mergeEpisodes(lib, incoming) {
  const index = new Map(lib.episodes.map((e) => [String(e.id), e]));
  const added = [];
  const refreshed = [];

  for (const ep of incoming) {
    const id = String(ep.id);
    const existing = index.get(id);
    if (!existing) {
      const record = { ...ep, id, addedAt: new Date().toISOString() };
      lib.episodes.push(record);
      index.set(id, record);
      added.push(record);
      continue;
    }
    // 取得元由来の項目だけ更新し、手動編集分（title / volume / note）は温存する
    let changed = false;
    for (const key of ['url', 'author', 'publishedAt', 'label', 'imageCount']) {
      if (ep[key] !== undefined && ep[key] !== existing[key]) {
        existing[key] = ep[key];
        changed = true;
      }
    }
    if (changed) refreshed.push(existing);
  }

  lib.episodes.sort(byPublishedAsc);
  return { added, refreshed };
}

/** アカウントごとの最新取得済みポストID（差分取得の since_id に使う） */
export function latestIdFor(lib, account) {
  const ids = lib.episodes
    .filter((e) => (e.author || '').toLowerCase() === account.toLowerCase())
    .map((e) => String(e.id))
    .filter((id) => /^\d+$/.test(id));
  if (!ids.length) return null;
  // Snowflake ID は桁数が揃っていれば辞書順＝時系列順
  return ids.reduce((a, b) => (a.length === b.length ? (a > b ? a : b) : a.length > b.length ? a : b));
}
