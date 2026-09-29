// 数据生成脚本：Node 18+ 直接运行 `node scripts/fetch.mjs`
//   GDP  - 自动抓取：东方财富数据中心（转引国家统计局），DOMESTICL_PRODUCT_BASE 为当季累计值（亿元）
//   市值 - 自动抓取：通达信行情协议取 880001 季度K线收盘点位（×100 = 全部 A 股总市值，亿元）
//          data/market_cap.manual.json 可覆盖指定季度（如 [{"quarter":"2025Q4","value":1050000}]）
// 输出 data/data.js（页面直接 <script> 引入，file:// 双击可开）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetch880001Quarterly } from './tdx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const MANUAL_FILE = join(DATA_DIR, 'market_cap.manual.json');

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

// ---------- GDP ----------
async function fetchGdp() {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPT_ECONOMY_GDP&columns=REPORT_DATE,TIME,DOMESTICL_PRODUCT_BASE,SUM_SAME' +
    '&pageSize=500&sortColumns=REPORT_DATE&sortTypes=1';
  const json = await getJson(url);
  if (!json.success) throw new Error(`GDP 接口失败: ${json.message}`);

  const quarters = [];
  for (const r of json.result.data) {
    const d = new Date(r.REPORT_DATE);
    const year = d.getFullYear();
    const q = (d.getMonth() + 1) / 3; // 3,6,9,12 月 -> Q1..Q4
    const cumulative = r.DOMESTICL_PRODUCT_BASE; // 亿元，年初累计
    if (!Number.isInteger(q) || cumulative == null) continue;
    quarters.push({ year, q, cumulative });
  }
  quarters.sort((a, b) => a.year - b.year || a.q - b.q);

  let prevSameYear = null;
  const singles = [];
  for (const it of quarters) {
    const single =
      it.q === 1 ? it.cumulative : it.cumulative - (prevSameYear ?? 0);
    singles.push({ ...it, single: Math.round(single * 10) / 10 });
    prevSameYear = it.cumulative;
  }
  for (let i = 0; i < singles.length; i++) {
    if (i >= 4) {
      const prev = singles.slice(i - 4, i).reduce((s, x) => s + x.single, 0);
      singles[i].prevTtm = Math.round(prev * 10) / 10; // 之前四个季度之和，亿元
    }
  }

  // 只保留 GDP 已正式公布的季度：进行中的季度（市值未收盘、分母口径不齐）不显示，
  // 待统计局公布当季 GDP 后（季后约 15-18 天）该季度点自动出现
  return singles;
}

// ---------- 主流程 ----------
async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const today = new Date().toISOString().slice(0, 10);

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [gdp, bars] = await Promise.all([fetchGdp(), fetch880001Quarterly()]);
  console.log(`GDP 季度数: ${gdp.length}，最新: ${gdp.at(-1).year}Q${gdp.at(-1).q}`);

  // 880001 季度K收盘点位 × 100 = 总市值（亿元）
  const fromTdx = bars.map((b) => {
    const y = b.date.slice(0, 4);
    const q = Math.ceil(Number(b.date.slice(5, 7)) / 3);
    return { quarter: `${y}Q${q}`, date: b.date, value: Math.round(b.close * 100) };
  });

  // 手工覆盖（格式 [{"quarter":"2025Q4","value":1050000}]，单位亿元）
  const manual = await readJsonSafe(MANUAL_FILE, []);
  const merged = new Map(fromTdx.map((m) => [m.quarter, m]));
  for (const m of manual) merged.set(m.quarter, { ...m, manual: true });
  const marketCap = [...merged.values()].sort((a, b) => a.quarter.localeCompare(b.quarter));

  const out = `// 由 scripts/fetch.mjs 生成于 ${today}，请勿手改
window.GDAP_DATA = ${JSON.stringify({ gdp, marketCap }, null, 1)};
`;
  await writeFile(join(DATA_DIR, 'data.js'), out);
  const last = marketCap.at(-1);
  console.log(`880001 市值点 ${marketCap.length} 个，最新: ${last.quarter}（${last.date || '手工'}）${last.value} 亿元`);
  console.log('已写入 data/data.js');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
