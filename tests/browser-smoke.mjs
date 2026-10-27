import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = process.env.GDAP_ORIGIN || 'http://127.0.0.1:4173';
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'gdap-chrome-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (chunk) => { chromeErrors += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`等待超时：${description}`);
}

let socket;
let sequence = 0;
const pending = new Map();
const pageErrors = [];
const requests = [];

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function navigate(path) {
  await send('Page.navigate', { url: `${origin}/${path}` });
  await waitFor(() => evaluate('document.readyState === "complete"'), `${path} 加载`);
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(tmpdir(), name);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  console.log(`截图：${path}`);
}

try {
  const portFile = await waitFor(async () => {
    const path = join(profile, 'DevToolsActivePort');
    return existsSync(path) ? path : null;
  }, 'Chrome 调试端口');
  const [port] = readFileSync(portFile, 'utf8').split('\n');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails);
    } else if (message.method === 'Network.requestWillBeSent') {
      requests.push(message.params.request.url);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__workerCount = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); window.__workerCount += 1; }
      };
    `
  });

  await navigate('simulator.html');
  await waitFor(() => evaluate('document.querySelectorAll(".discipline-card").length === 4'), '默认纪律')
    .catch(async (error) => {
      console.error(await evaluate('document.body.innerText'));
      console.error(pageErrors);
      throw error;
    });
  assert.equal(await evaluate('document.getElementById("holdingMonths").value'), '36');
  assert.equal(await evaluate('document.getElementById("runDock").hidden'), true);
  assert.equal(await evaluate('document.querySelector(".app-nav-link[aria-current=page]").textContent'), '纪律模拟器');

  await evaluate('document.getElementById("addRule").click()');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".discipline-card")].map(card => card.dataset.ruleId)'),
    ['D1', 'D2', 'D3', 'D4', 'D5']);
  assert.equal(await evaluate('document.activeElement.closest(".discipline-card").dataset.ruleId'), 'D5');
  await evaluate(`(() => {
    const input = document.querySelector('[data-rule-id="D5"] [data-field="threshold"]');
    input.value = '33';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('addRule').click();
  })()`);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-field=threshold]")].map(input => Number(input.value))'),
    [-25, -40, 75, 120, 33, 10]);
  await evaluate('document.querySelector("[data-rule-id=D6] [data-action=delete]").click()');
  await evaluate('document.querySelector("[data-rule-id=D5] [data-action=delete]").click()');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-field=threshold]")].map(input => Number(input.value))'),
    [-25, -40, 75, 120]);
  await evaluate('document.getElementById("addRule").click()');

  await evaluate(`(() => {
    const product = {
      code: 'TEST', name: '测试产品', type: 'stock', typeLabel: '股票', market: '测试',
      settlementDays: 0, rule: { label: 'T+0', reason: '浏览器测试' }
    };
    const quotes = [
      ['2024-01-01', 100], ['2024-01-02', 130], ['2024-01-03', 130], ['2024-03-01', 100]
    ].map(([date, close]) => ({ date, open: close, high: close, low: close, close }));
    MarketData.searchExchange = async () => [product];
    MarketData.searchFunds = async () => [];
    MarketData.loadHistory = async () => quotes;
    const search = document.getElementById('productSearch');
    search.value = 'TEST';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate('document.querySelector("#searchResults button")'), '模拟产品搜索');
  await evaluate('document.querySelector("#searchResults button").click()');
  await waitFor(() => evaluate('!document.getElementById("runDock").hidden'), '历史行情就绪');
  assert.equal(await evaluate('document.getElementById("runSimulation").disabled'), false);

  await evaluate(`(() => {
    document.getElementById('startDate').value = '2024-01-01';
    document.getElementById('holdingMonths').value = '1';
    document.getElementById('startDate').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('holdingMonths').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('.discipline-card').forEach((card, index) => {
      const values = { direction: 'up', threshold: String((index + 1) * 5), sellPercent: '10' };
      for (const [field, value] of Object.entries(values)) {
        const input = card.querySelector('[data-field="' + field + '"]');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const amount = document.getElementById('amount');
    amount.value = '200';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  assert.equal(await evaluate('document.getElementById("valuationDate").textContent'), '等待模拟');
  assert.equal(await evaluate('window.__workerCount'), 0);
  await evaluate('document.getElementById("amount").value = "100"');

  const running = await evaluate(`(() => {
    document.getElementById('runSimulation').click();
    const button = document.getElementById('runSimulation');
    return { disabled: button.disabled, busy: button.getAttribute('aria-busy'), text: button.textContent };
  })()`);
  assert.deepEqual(running, { disabled: true, busy: 'true', text: '正在模拟…' });
  await waitFor(() => evaluate('document.getElementById("valuationDate").textContent.includes("2024-01-03")'), 'Worker 模拟结果')
    .catch(async (error) => {
      console.error(await evaluate(`({
        valuation: document.getElementById('valuationDate').textContent,
        configError: document.getElementById('configError').textContent,
        dataError: document.getElementById('dataAlertText').textContent,
        button: document.getElementById('runSimulation').textContent,
        workers: window.__workerCount
      })`));
      console.error(pageErrors);
      throw error;
    });
  assert.equal(await evaluate('window.__workerCount'), 1);
  assert.equal(await evaluate('document.getElementById("runSimulation").disabled'), false);
  const rateDetails = await evaluate('[...document.querySelectorAll("#summaryGrid .metric small")].map(node => node.textContent)');
  assert.equal(rateDetails.length, 3);
  assert.ok(rateDetails.every((text) => text.includes('收益率') && text.includes('年化')));
  await evaluate(`(() => {
    document.getElementById('tradeFilter').value = 'sell';
    document.getElementById('tradeFilter').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await evaluate('document.querySelectorAll("#tradeRows tr").length'), 5);
  const tooltip = await evaluate(`echarts.getInstanceByDom(document.getElementById('priceChart'))
    .getOption().tooltip[0].formatter([{ axisValue: '2024-01-03' }])`);
  assert.match(tooltip, /每份额持仓成本 100\.00 元/);
  assert.doesNotMatch(tooltip, /卖出前持仓成本|本次结转成本/);

  const oldSummary = await evaluate('document.getElementById("summaryGrid").textContent');
  await evaluate(`(() => {
    const amount = document.getElementById('amount');
    amount.value = '300';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  assert.equal(await evaluate('document.getElementById("summaryGrid").textContent'), oldSummary);
  assert.equal(await evaluate('window.__workerCount'), 1);

  await evaluate('document.getElementById("simulatorForm").requestSubmit()');
  await sleep(200);
  assert.equal(await evaluate('document.getElementById("summaryGrid").textContent'), oldSummary,
    '表单自身提交不应启动计算');
  await evaluate('document.getElementById("amount").focus()');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(200);
  assert.equal(await evaluate('document.getElementById("summaryGrid").textContent'), oldSummary,
    '定投输入框按 Enter 不应重算');
  await evaluate('document.querySelector("[data-field=threshold]").focus()');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(200);
  assert.equal(await evaluate('document.getElementById("summaryGrid").textContent'), oldSummary,
    '纪律输入框按 Enter 不应重算');

  await evaluate(`(() => {
    document.getElementById('amount').value = '0';
    document.getElementById('runSimulation').click();
  })()`);
  await waitFor(() => evaluate('!document.getElementById("configError").hidden'), 'Worker 配置错误');
  assert.match(await evaluate('document.getElementById("configError").textContent'), /单次定投金额/);
  assert.equal(await evaluate('document.getElementById("runSimulation").disabled'), false);
  assert.equal(await evaluate('document.getElementById("valuationDate").textContent'), '等待模拟');
  await evaluate(`(() => {
    document.getElementById('amount').value = '300';
    document.getElementById('runSimulation').click();
  })()`);
  await waitFor(() => evaluate('document.getElementById("valuationDate").textContent.includes("2024-01-03")'), 'Worker 错误后重跑');
  assert.equal(await evaluate('window.__workerCount'), 1);

  const dock = await evaluate(`(() => {
    const rect = document.getElementById('runDock').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.ok(dock.top >= 58 && dock.bottom <= dock.viewport && !dock.overflow);
  await screenshot('gdap-simulator-desktop.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const tabletLayout = await evaluate(`(() => {
    const dock = document.getElementById('runDock').getBoundingClientRect();
    const config = document.querySelector('.config-panel').getBoundingClientRect();
    const results = document.querySelector('.results-panel').getBoundingClientRect();
    return { dockBottom: dock.bottom, viewport: innerHeight, columnsAligned: config.right <= results.left };
  })()`);
  assert.ok(tabletLayout.dockBottom <= tabletLayout.viewport && tabletLayout.columnsAligned);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate('scrollTo(0, 0)');
  await screenshot('gdap-simulator-mobile.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate('index.html');
  await waitFor(() => evaluate('window.ReactCharts && document.querySelectorAll("#chartMain svg").length > 0'), '主页图表', 30000);
  assert.equal(await evaluate('document.querySelector(".app-nav-link[aria-current=page]").textContent'), '巴菲特指标');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await screenshot('gdap-home-desktop.png');

  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(requests.some((url) => /fonts\.googleapis|fonts\.gstatic|jsdelivr/.test(url)), false);
  console.log('浏览器回归通过：第五条纪律、Worker、手动计算、成本提示、导航与响应式布局。');
} finally {
  if (socket) socket.close();
  if (chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([once(chrome, 'exit'), sleep(2000)]);
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (chrome.exitCode && chrome.exitCode !== 0) console.error(chromeErrors);
}
