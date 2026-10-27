const test = require('node:test');
const assert = require('node:assert/strict');
require('../market-data.js');

test('普通股票和无法识别的场内基金使用 T+1', () => {
  assert.equal(global.MarketData.detectRule({ name: '贵州茅台', type: 'stock' }).settlementDays, 1);
  assert.equal(global.MarketData.detectRule({ name: '沪深300ETF', type: 'exchange-fund' }).settlementDays, 1);
});

test('场外 QDII 使用 T+2', () => {
  const product = { name: '示例纳斯达克QDII', type: 'otc-fund', category: 'QDII' };
  assert.equal(global.MarketData.detectRule(product).settlementDays, 2);
});

test('可识别的债券、黄金、货币和跨境场内基金使用 T+0', () => {
  ['国债ETF', '黄金ETF', '货币ETF', '恒生科技ETF'].forEach((name) => {
    assert.equal(global.MarketData.detectRule({ name, type: 'exchange-fund' }).settlementDays, 0);
  });
});

test('场外债券基金不因名称误判为 T+0', () => {
  assert.equal(global.MarketData.detectRule({ name: '纯债债券A', type: 'otc-fund' }).settlementDays, 1);
});
