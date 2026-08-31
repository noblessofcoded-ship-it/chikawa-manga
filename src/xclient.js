/**
 * X (Twitter) との通信をまとめたモジュール。
 *
 * 方針: 画像そのものは保存しない。ここで取り込むのは「どのポストが何話か」という
 * 索引情報（ポストID・公開日時・画像枚数・短いラベル）だけで、
 * 実際の漫画画像は閲覧時に X の公式埋め込みから配信される。
 */

const API = 'https://api.x.com/2';
const OEMBED = 'https://publish.twitter.com/oembed';
const TWITTER_EPOCH = 1288834974657n;

export class XError extends Error {
  constructor(message, { status = 0, hint = '' } = {}) {
    super(message);
    this.name = 'XError';
    this.status = status;
    this.hint = hint;
  }
}

/** Snowflake ID から公開時刻を復元する（API が使えない取り込み経路用） */
export function idToDate(id) {
  if (!/^\d+$/.test(String(id))) return null;
  const ms = (BigInt(id) >> 22n) + TWITTER_EPOCH;
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() > 2006 ? d.toISOString() : null;
}

/** ポストURL / ID / @user/status/... のいずれからでも {id, author} を取り出す */
export function parsePostRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d{8,25}$/.test(raw)) return { id: raw, author: null };
  const m = raw.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{8,25})/i);
  if (m) return { id: m[2], author: m[1] };
  const m2 = raw.match(/^@?([A-Za-z0-9_]{1,15})\/(\d{8,25})$/);
  if (m2) return { id: m2[2], author: m2[1] };
  return null;
}

function labelFrom(text) {
  const firstLine = String(text || '')
    .replace(/https?:\/\/\S+/g, '')       // 末尾の自動付与URLを落とす
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstLine) return '';
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
}

async function apiGet(path, params, token) {
  if (!token) {
    throw new XError('X API のトークンが設定されていません。', {
      hint: '環境変数 X_BEARER_TOKEN を設定するか、手動取り込み（URL貼り付け）を使ってください。',
    });
  }
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new XError(`X API に接続できませんでした: ${err.message}`, {
      hint: 'ネットワーク / プロキシ設定を確認してください。',
    });
  }

  if (res.status === 401) {
    throw new XError('X API に拒否されました (401)。', { status: 401, hint: 'X_BEARER_TOKEN が無効か期限切れです。' });
  }
  if (res.status === 403) {
    throw new XError('X API に権限がありません (403)。', {
      status: 403,
      hint: 'Free プランではタイムライン取得ができません。Basic 以上のプラン、または手動取り込みを使ってください。',
    });
  }
  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString('ja-JP') : 'しばらく後';
    throw new XError('X API のレート制限に達しました (429)。', { status: 429, hint: `${when} 以降にもう一度お試しください。` });
  }
  if (!res.ok) {
    throw new XError(`X API がエラーを返しました (${res.status})。`, { status: res.status });
  }
  return res.json();
}

export async function resolveUser(username, token) {
  const json = await apiGet(`/users/by/username/${encodeURIComponent(username)}`, {}, token);
  if (!json?.data?.id) {
    throw new XError(`@${username} が見つかりませんでした。`, { hint: 'config.json の accounts を確認してください。' });
  }
  return { id: json.data.id, username: json.data.username, name: json.data.name };
}

/**
 * 対象アカウントのポストを新しい順に取得し、話の索引レコードへ変換して返す。
 * sinceId を渡すと、それ以降の新着だけを取ってくる（＝「更新」ボタンの差分取得）。
 */
export async function fetchTimeline({ username, sinceId, max = 300, token, options = {} }) {
  const user = await resolveUser(username, token);
  const exclude = [];
  if (!options.includeReplies) exclude.push('replies');
  if (!options.includeRetweets) exclude.push('retweets');

  const episodes = [];
  let paginationToken;
  let pages = 0;

  while (episodes.length < max && pages < 20) {
    const json = await apiGet(
      `/users/${user.id}/tweets`,
      {
        max_results: Math.min(100, Math.max(5, max - episodes.length)),
        since_id: sinceId || undefined,
        pagination_token: paginationToken,
        exclude: exclude.join(',') || undefined,
        'tweet.fields': 'created_at,attachments,text',
        expansions: 'attachments.media_keys',
        'media.fields': 'type',
      },
      token,
    );
    pages += 1;

    const mediaTypes = new Map((json.includes?.media || []).map((m) => [m.media_key, m.type]));
    for (const t of json.data || []) {
      const keys = t.attachments?.media_keys || [];
      const imageCount = keys.filter((k) => mediaTypes.get(k) === 'photo').length;
      episodes.push({
        id: t.id,
        url: `https://x.com/${user.username}/status/${t.id}`,
        author: user.username,
        publishedAt: t.created_at || idToDate(t.id),
        label: labelFrom(t.text),
        imageCount,
      });
    }

    paginationToken = json.meta?.next_token;
    if (!paginationToken) break;
  }

  return { user, episodes };
}

/**
 * 公開 oEmbed から1件分の情報を得る（認証不要）。
 * 手動取り込みで著者名を確かめたいときに使う。取得できなくても致命的ではない。
 */
export async function fetchOEmbed(url) {
  const endpoint = new URL(OEMBED);
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('omit_script', '1');
  endpoint.searchParams.set('dnt', 'true');
  endpoint.searchParams.set('lang', 'ja');
  try {
    const res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
