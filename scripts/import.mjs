#!/usr/bin/env node
/**
 * ポストURLをまとめて取り込む。
 *   npm run import -- https://x.com/.../status/123 https://x.com/.../status/456
 *   cat urls.txt | npm run import
 */
import { runImport } from '../src/sync.js';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const args = process.argv.slice(2);
const piped = (await readStdin()).split(/\s+/).filter(Boolean);
const refs = [...args, ...piped];

if (!refs.length) {
  console.error('取り込むポストURLを渡してください。');
  process.exit(1);
}

const report = await runImport(refs);
console.log(`  取り込み: 新規 ${report.added} 話 / 合計 ${report.total} 話`);
if (report.invalid.length) console.log(`  読み取れなかったもの: ${report.invalid.join(', ')}`);
