#!/usr/bin/env node
/** コマンドラインからの更新。 `npm run sync -- --full` で全件取り直し。 */
import { runSync } from '../src/sync.js';

const full = process.argv.includes('--full');
const report = await runSync({ full });

console.log(`\n  ${full ? '全件' : '差分'}取得: 新規 ${report.added} 話 / 更新 ${report.refreshed} 話 / 合計 ${report.total} 話`);
for (const a of report.accounts) {
  console.log(`   @${a.account}: +${a.added}${a.error ? `  ✗ ${a.error}` : ''}`);
}
for (const e of report.errors) {
  console.error(`   ! ${e.message}${e.hint ? `\n     → ${e.hint}` : ''}`);
}
process.exit(report.ok ? 0 : 1);
