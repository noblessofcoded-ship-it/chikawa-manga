import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const PUBLIC_DIR = join(ROOT, 'public');

const DEFAULTS = {
  // 取り込み対象のXアカウント（@は不要）。複数指定可。
  accounts: ['ngnchiikawa'],
  // 1話としてカウントする最低画像枚数。0にすると画像なしポストも取り込む。
  minImages: 1,
  // リプライを取り込むか（連載は単独ポストが基本なので既定はfalse）
  includeReplies: false,
  // リポストを取り込むか
  includeRetweets: false,
  // 単行本1巻あたりの話数（volumes に該当がないぶんの自動割り当てに使う）
  autoVolumeSize: 30,
  // 1回の更新で遡って取得する最大件数（差分更新のとき）
  maxFetchPerUpdate: 300,
  // 全件取り直しのときの上限。X API 側が直近3200件しか返さないため、それに合わせる。
  maxBackfill: 3200,
  port: 5173,
};

function loadFile() {
  const p = join(ROOT, 'config.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[config] config.json を読めませんでした: ${err.message}`);
    return {};
  }
}

function loadEnv() {
  const out = {};
  if (process.env.X_ACCOUNTS) {
    out.accounts = process.env.X_ACCOUNTS.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
  }
  if (process.env.PORT) out.port = Number(process.env.PORT);
  return out;
}

export const config = { ...DEFAULTS, ...loadFile(), ...loadEnv() };
config.accounts = (config.accounts || []).map((a) => String(a).trim().replace(/^@/, '')).filter(Boolean);

export const bearerToken = process.env.X_BEARER_TOKEN || '';
