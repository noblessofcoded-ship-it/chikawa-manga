/** 話の並び順。サーバーとブラウザの両方から使う。 */
export function byPublishedAsc(a, b) {
  const d = new Date(a.publishedAt) - new Date(b.publishedAt);
  if (d !== 0) return d;
  // 同時刻の連投は ID 昇順（Snowflake ID は時系列順）
  return String(a.id).localeCompare(String(b.id));
}
