// 周度数据生成脚本：Node 18+ 直接运行 `node scripts/fetch-weekly.mjs`
//   周度 - 自动抓取：乐咕乐股「总市值/GDP」日频全A总市值序列，取每周最后一个交易日，
//          窗口为"上季度第一日至今"
//          （2026-10 起通达信 880001 免费K线通道失效，改用乐咕 source；详见 scripts/legu.mjs）
// 输出 data/weekly.js（页面直接 <script> 引入，file:// 双击可开）
// 季度数据由 scripts/fetch.mjs 单独生成（data/data.js）

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchLeguDailyCap, isoWeekKey, lastPerBucket } from './legu.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

// 上季度第一个自然日（如 2026-09-29 -> 2026-04-01）
function prevQuarterStart(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3); // 本季度 0..3
  const startMonth = ((q - 1 + 4) % 4) * 3;
  const year = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const daily = await fetchLeguDailyCap();
  console.log(`乐咕日频市值 ${daily.length} 条，最新: ${daily.at(-1).date}`);

  // 周度市值：上季度第一日至今，每周取最后一个交易日
  const weeklyFrom = prevQuarterStart();
  const weeklyRows = lastPerBucket(daily, isoWeekKey)
    .filter((r) => r.date >= weeklyFrom)
    .map((r) => ({ date: r.date, value: Math.round(r.marketCap) }));

  const weekly = weeklyRows.sort((a, b) => a.date.localeCompare(b.date));
  if (!weekly.length) throw new Error('本季度窗口内无数据：检查乐咕源可用性');
  const cross = weekly.map((w) => w.value).join(',');
  if (weekly.some((w) => !Number.isFinite(w.value) || w.value <= 0))
    throw new Error(`周度数值异常: ${cross}`);

  const out = `// 由 scripts/fetch-weekly.mjs 生成，请勿手改
window.GDAP_WEEKLY = ${JSON.stringify(weekly, null, 1)};
`;
  await writeFile(join(DATA_DIR, 'weekly.js'), out);
  const last = weekly.at(-1);
  console.log(
    `周度 ${weekly.length} 根（自 ${weeklyFrom}），最新: ${last?.date} ${last?.value} 亿元`,
  );
  console.log('已写入 data/weekly.js');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
