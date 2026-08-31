/**
 * 話の並びを「単行本」の形（巻 → 話）に組み直す。
 *
 * 巻の決め方は優先順に:
 *   1. 話ごとの volume 指定（手動で動かしたとき）
 *   2. data/chapters.json の volumes[].episodeIds に列挙されている
 *   3. volumes[].from / to の日付範囲に入る
 *   4. どれにも当てはまらないぶんは、時系列で autoVolumeSize 話ずつ自動的に巻へ束ねる
 */

import { byPublishedAsc } from './store.js';

const pad2 = (n) => String(n).padStart(2, '0');

function inRange(iso, from, to) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(from).getTime()) return false;
  // to は「その日を含む」扱いにする（日付だけ指定されたときに直感と合わせる）
  if (to) {
    const end = /T/.test(to) ? new Date(to).getTime() : new Date(to).getTime() + 24 * 3600 * 1000 - 1;
    if (t > end) return false;
  }
  return true;
}

export function buildBook(episodes, chaptersConfig = {}, options = {}) {
  const autoSize = Math.max(1, Number(options.autoVolumeSize ?? chaptersConfig.autoVolumeSize ?? 30));
  const defined = Array.isArray(chaptersConfig.volumes) ? chaptersConfig.volumes : [];
  const sorted = [...episodes].sort(byPublishedAsc);

  const explicitIds = new Map();
  defined.forEach((v) => (v.episodeIds || []).forEach((id) => explicitIds.set(String(id), v.id)));

  /** 巻ID -> 話配列 */
  const buckets = new Map();
  const put = (volumeId, ep) => {
    if (!buckets.has(volumeId)) buckets.set(volumeId, []);
    buckets.get(volumeId).push(ep);
  };

  const leftovers = [];
  for (const ep of sorted) {
    const forced = ep.volume ? String(ep.volume) : explicitIds.get(String(ep.id));
    if (forced) {
      put(forced, ep);
      continue;
    }
    const byDate = defined.find((v) => (v.from || v.to) && inRange(ep.publishedAt, v.from, v.to));
    if (byDate) {
      put(byDate.id, ep);
      continue;
    }
    leftovers.push(ep);
  }

  // 自動採番の巻は、定義済みの巻番号の続きから始める
  let autoSeq = defined.reduce((max, v) => {
    const n = Number(String(v.id).match(/(\d+)/)?.[1] || 0);
    return Math.max(max, n);
  }, 0);

  const autoVolumes = [];
  for (let i = 0; i < leftovers.length; i += autoSize) {
    autoSeq += 1;
    const id = `vol-${pad2(autoSeq)}`;
    const slice = leftovers.slice(i, i + autoSize);
    autoVolumes.push({ id, title: `第${autoSeq}巻`, auto: true });
    slice.forEach((ep) => put(id, ep));
  }

  const allVolumes = [...defined, ...autoVolumes];
  let globalNo = 0;

  const volumes = allVolumes
    .map((v) => {
      const eps = (buckets.get(v.id) || []).sort(byPublishedAsc);
      return { ...v, episodes: eps };
    })
    .filter((v) => v.episodes.length > 0)
    .sort((a, b) => byPublishedAsc(a.episodes[0], b.episodes[0]))
    .map((v, vi) => {
      const episodes = v.episodes.map((ep, i) => {
        globalNo += 1;
        return { ...ep, episodeNo: i + 1, globalNo, volumeId: v.id };
      });
      return {
        id: v.id,
        title: v.title || `第${vi + 1}巻`,
        subtitle: v.subtitle || '',
        auto: Boolean(v.auto),
        count: episodes.length,
        from: episodes[0]?.publishedAt || null,
        to: episodes[episodes.length - 1]?.publishedAt || null,
        episodes,
      };
    });

  return {
    volumes,
    totalEpisodes: globalNo,
    totalVolumes: volumes.length,
  };
}
