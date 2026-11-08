// 乐咕乐股「总市值/GDP 巴菲特指标」接口封装
// https://legulegu.com/stockdata/marketcap-gdp
// 返回日频全A总市值序列（沪深北三所已上市股票，口径 ∑A股市值，单位亿元）
// 从 2005-04-08 起（此前 2026-10 通达信 880001 免费K线通道全面失效，改用本源）
//
// 后者在 2026-10 起标准协议 K 线命令被行情服务器端冻结，故整体切换。

import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const PAGE_URL = 'https://legulegu.com/stockdata/marketcap-gdp';
const API_URL =
  'https://legulegu.com/api/stockdata/marketcap-gdp/get-marketcap-gdp';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// md5(当天日期 ISO 格式) 为该接口的公开校验 token
function lgToken() {
  return createHash('md5')
    .update(new Date().toISOString().slice(0, 10))
    .digest('hex');
}

// 先取页面拿 CSRF 令牌与 Cookie，再带令牌调数据接口
export async function fetchLeguDailyCap(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const pageRes = await fetch(PAGE_URL, {
        headers: { 'User-Agent': UA },
      });
      if (!pageRes.ok) throw new Error(`页面 HTTP ${pageRes.status}`);
      const html = await pageRes.text();
      const m =
        html.match(/name="_csrf"[^>]*\s*content="([^"]+)"/) ||
        html.match(/content="([^"]+)"[^>]*name="_csrf"/);
      if (!m) throw new Error('页面缺少 _csrf 令牌！');
      // 拼出干净的 Cookie 头（仅 name=value，忽略 path 等属性）
      const cookie = pageRes.headers
        .getSetCookie()
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');

      const apiRes = await fetch(`${API_URL}?token=${lgToken()}`, {
        headers: {
          'User-Agent': UA,
          'X-CSRF-Token': m[1],
          Cookie: cookie,
          Referer: PAGE_URL,
        },
      });
      if (!apiRes.ok) throw new Error(`接口 HTTP ${apiRes.status}`);
      const json = await apiRes.json();
      const data = (json.data ?? json).map((r) => ({
        date: r.date,
        marketCap: Number(r.marketCap),
      }));
      if (!data.length) throw new Error('接口返回空序列！');
      data.sort((a, b) => a.date.localeCompare(b.date));
      return data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// ISO 周 key：同一周(周一为首日)共用一个 key
export function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1); // 本周一
  return d.toISOString().slice(0, 10);
}

// 每桶取「最后一个交易日」的值
export function lastPerBucket(daily, bucketFn) {
  const map = new Map();
  for (const row of daily) {
    const key = bucketFn(row.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const out = [];
  for (const rows of map.values())
    out.push(rows.at(-1) /* 日频序列已按日期升序 */);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
