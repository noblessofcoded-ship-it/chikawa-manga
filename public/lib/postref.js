/**
 * ポストURL / ID の解析。ネットワークに触らない純粋な処理だけを置く。
 * サーバーの取り込み処理からも、ブラウザだけで動く静的版からも使う。
 */

const TWITTER_EPOCH = 1288834974657n;

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

/** ポスト本文の1行目を、目次に並べる短いラベルにする */
export function labelFrom(text) {
  const firstLine = String(text || '')
    .replace(/https?:\/\/\S+/g, '')       // 末尾の自動付与URLを落とす
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstLine) return '';
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
}
