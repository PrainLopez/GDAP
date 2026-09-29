// 通达信标准行情协议最小客户端（TCP 7709），用于抓取 880001（通达信总市值指数）季度K线
// 协议格式参考 pytdx（https://github.com/rainx/pytdx）
// 880001 季度K收盘点位 × 100 = 全部 A 股总市值（亿元）

import net from 'node:net';
import zlib from 'node:zlib';

// 可用的行情服务器（国泰君安集群，按需可增删）
const HOSTS = [
  '117.34.114.13', '117.34.114.14', '117.34.114.15',
  '117.34.114.16', '117.34.114.17',
];
const PORT = 7709;

const SETUP_PKGS = [
  '0c0218930001030003000d0001',
  '0c0218940001030003000d0002',
  '0c031899000120002000db0fd5d0c9ccd6a4a8af0000008fc22540130000d500c9ccbdf0d7ea00000002',
].map((h) => Buffer.from(h, 'hex'));

const CAT_QUARTER = 10; // 季线
const CAT_WEEK = 5; // 周线
const MARKET_SH = 1; // 880001 挂在市场 1 下

function buildBarsPkg(market, code, category, start, count) {
  const buf = Buffer.alloc(40);
  let o = 0;
  o = buf.writeUInt16LE(0x10c, o);
  o = buf.writeUInt32LE(0x01016408, o);
  o = buf.writeUInt16LE(0x1c, o);
  o = buf.writeUInt16LE(0x1c, o);
  o = buf.writeUInt16LE(0x052d, o);
  o = buf.writeUInt16LE(market, o);
  buf.write(code, o, 6, 'ascii'); o += 6;
  o = buf.writeUInt16LE(category, o);
  o = buf.writeUInt16LE(1, o);
  o = buf.writeUInt16LE(start, o);
  o = buf.writeUInt16LE(count, o);
  o = buf.writeUInt32LE(0, o);
  o = buf.writeUInt32LE(0, o);
  o = buf.writeUInt16LE(0, o);
  return buf;
}

class TdxClient {
  constructor(host) {
    this.host = host;
    this.buf = Buffer.alloc(0);
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(PORT, this.host, resolve);
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); });
      this.sock.on('error', reject);
      this.sock.setTimeout(6000, () => reject(new Error('connect timeout')));
    });
  }
  async recv(n) {
    const deadline = Date.now() + 8000;
    while (this.buf.length < n) {
      if (Date.now() > deadline) throw new Error(`recv timeout want=${n} got=${this.buf.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async call(pkg) {
    this.sock.write(pkg);
    const head = await this.recv(0x10);
    const zipsize = head.readUInt16LE(12);
    const unzipsize = head.readUInt16LE(14);
    let body = await this.recv(zipsize);
    if (zipsize !== unzipsize) body = zlib.inflateSync(body);
    return body;
  }
  async setup() {
    for (const pkg of SETUP_PKGS) await this.call(pkg);
  }
  close() { this.sock?.destroy(); }
}

// 通达信的类 varint 有符号价格编码
function getPrice(data, pos) {
  let posByte = 6;
  let b = data[pos];
  let v = b & 0x3f;
  const sign = (b & 0x40) !== 0;
  if (b & 0x80) {
    while (true) {
      pos += 1;
      b = data[pos];
      v += (b & 0x7f) << posByte;
      posByte += 7;
      if (!(b & 0x80)) break;
    }
  }
  pos += 1;
  return [sign ? -v : v, pos];
}

// 指数K线响应解析（比普通股票K线多 4 字节涨跌家数）
function parseIndexBars(body) {
  const n = body.readUInt16LE(0);
  let pos = 2;
  const rows = [];
  let pre = 0;
  for (let i = 0; i < n; i++) {
    const zipday = body.readUInt32LE(pos); // 季线 category>=4：u32 = yyyyMMdd
    pos += 4;
    const year = Math.floor(zipday / 10000);
    const month = Math.floor((zipday % 10000) / 100);
    const day = zipday % 100;
    let od, cd;
    [od, pos] = getPrice(body, pos);
    [cd, pos] = getPrice(body, pos);
    [, pos] = getPrice(body, pos); // high diff
    [, pos] = getPrice(body, pos); // low diff
    pos += 12; // vol u32 + amount u32 + 涨跌家数 u16*2
    const openBase = od + pre;
    rows.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      close: (openBase + cd) / 1000,
    });
    pre = openBase + cd;
  }
  return rows;
}

// 抓取 880001 K线，返回 [{date, close}]（新到旧），失败时自动切换服务器
async function fetchBars(category, count, label) {
  let lastErr;
  for (const host of HOSTS) {
    const t = new TdxClient(host);
    try {
      await t.connect();
      await t.setup();
      const body = await t.call(buildBarsPkg(MARKET_SH, '880001', category, 0, count));
      const rows = parseIndexBars(body);
      if (!rows.length) throw new Error('空数据');
      console.log(`880001 ${label}：${rows.length} 条（服务器 ${host}）`);
      return rows;
    } catch (e) {
      lastErr = e;
      console.error(`${host} 失败：${e.message}，换下一台…`);
    } finally {
      t.close();
    }
  }
  throw lastErr;
}

// 全部季度K线（约 800 根，远超实际需要）
export function fetch880001Quarterly() {
  return fetchBars(CAT_QUARTER, 800, '季度K');
}

// 最近 60 根周K（约 14 个月，覆盖"上季度初至今"并留余量）
export function fetch880001Weekly() {
  return fetchBars(CAT_WEEK, 60, '周K');
}
