// 周度数据生成脚本：Node 18+ 直接运行 `node scripts/fetch-weekly.mjs`
//   周度 - 自动抓取：通达信行情协议取 880001 周K收盘点位（×100 = 全部 A 股总市值，亿元），
//          窗口为"上季度第一日至今"
// 输出 data/weekly.js（页面直接 <script> 引入，file:// 双击可开）
// 季度数据由 scripts/fetch.mjs 单独生成（data/data.js）

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetch880001Weekly } from './tdx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const today = new Date().toISOString().slice(0, 10);

// 上季度第一个自然日（如 2026-09-29 -> 2026-04-01）
function prevQuarterStart(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3); // 本季度 0..3
  const startMonth = ((q - 1 + 4) % 4) * 3;
  const year = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const weeklyBars = await fetch880001Weekly();

  // 周度市值：上季度第一日至今，周K date 为该周最后一个交易日
  const weeklyFrom = prevQuarterStart();
  const weekly = weeklyBars
    .filter((b) => b.date >= weeklyFrom)
    .map((b) => ({ date: b.date, value: Math.round(b.close * 100) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out = `// 由 scripts/fetch-weekly.mjs 生成于 ${today}，请勿手改
window.GDAP_WEEKLY = ${JSON.stringify(weekly, null, 1)};
`;
  await writeFile(join(DATA_DIR, 'weekly.js'), out);
  const last = weekly.at(-1);
  console.log(`880001 周K ${weekly.length} 根（自 ${weeklyFrom}），最新: ${last?.date} ${last?.value} 亿元`);
  console.log('已写入 data/weekly.js');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
