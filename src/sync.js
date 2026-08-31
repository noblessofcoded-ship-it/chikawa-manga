import { config, bearerToken } from './config.js';
import { loadLibrary, saveLibrary, mergeEpisodes, latestIdFor } from './store.js';
import { fetchTimeline, fetchOEmbed, parsePostRef, idToDate, XError } from './xclient.js';

/**
 * 「更新」ボタンの実処理。
 * アカウントごとに、取り込み済みの最新ポスト以降だけを取りに行く（full:true で全件洗い直し）。
 */
export async function runSync({ full = false } = {}) {
  const lib = loadLibrary();
  const report = {
    startedAt: new Date().toISOString(),
    mode: full ? 'full' : 'incremental',
    accounts: [],
    added: 0,
    refreshed: 0,
    skipped: 0,
    errors: [],
  };

  if (!config.accounts.length) {
    report.errors.push({ message: '取り込み対象のアカウントが設定されていません。', hint: 'config.json の accounts を設定してください。' });
    return finish(lib, report, false);
  }

  let anySuccess = false;

  for (const account of config.accounts) {
    const entry = { account, added: 0, refreshed: 0, skipped: 0 };
    try {
      const sinceId = full ? null : latestIdFor(lib, account);
      const { episodes } = await fetchTimeline({
        username: account,
        sinceId,
        max: config.maxFetchPerUpdate,
        token: bearerToken,
        options: { includeReplies: config.includeReplies, includeRetweets: config.includeRetweets },
      });

      const kept = episodes.filter((ep) => {
        if (config.minImages > 0 && (ep.imageCount || 0) < config.minImages) {
          entry.skipped += 1;
          return false;
        }
        return true;
      });

      const { added, refreshed } = mergeEpisodes(lib, kept);
      entry.added = added.length;
      entry.refreshed = refreshed.length;
      entry.sinceId = sinceId;
      anySuccess = true;
    } catch (err) {
      entry.error = err.message;
      report.errors.push({
        account,
        message: err.message,
        hint: err instanceof XError ? err.hint : '',
      });
    }
    report.accounts.push(entry);
    report.added += entry.added;
    report.refreshed += entry.refreshed;
    report.skipped += entry.skipped;
  }

  return finish(lib, report, anySuccess);
}

/**
 * ポストURL（またはID）を貼り付けて取り込む経路。
 * X API のトークンが無くても使えるよう、公開日時はポストIDから復元する。
 */
export async function runImport(refs, { enrich = true } = {}) {
  const lib = loadLibrary();
  const report = { added: 0, refreshed: 0, invalid: [], startedAt: new Date().toISOString() };
  const incoming = [];

  for (const raw of refs) {
    const ref = parsePostRef(raw);
    if (!ref) {
      report.invalid.push(String(raw));
      continue;
    }
    const author = ref.author || config.accounts[0] || 'i';
    const record = {
      id: ref.id,
      url: `https://x.com/${author}/status/${ref.id}`,
      author,
      publishedAt: idToDate(ref.id),
      label: '',
      imageCount: null,
    };

    if (enrich) {
      const meta = await fetchOEmbed(record.url);
      if (meta?.author_url) {
        const name = meta.author_url.split('/').filter(Boolean).pop();
        if (name) {
          record.author = name;
          record.url = `https://x.com/${name}/status/${ref.id}`;
        }
      }
    }
    incoming.push(record);
  }

  const { added, refreshed } = mergeEpisodes(lib, incoming);
  report.added = added.length;
  report.refreshed = refreshed.length;
  saveLibrary(lib);
  report.total = lib.episodes.length;
  return report;
}

function finish(lib, report, persist) {
  if (persist) {
    lib.lastSync = report.startedAt;
    saveLibrary(lib);
  }
  report.total = lib.episodes.length;
  report.finishedAt = new Date().toISOString();
  report.ok = report.errors.length === 0;
  return report;
}
