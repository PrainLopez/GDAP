const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

function quotes(rows) {
  return rows.map(([date, close]) => ({ date, open: close, high: close, low: close, close }));
}

function config(overrides = {}) {
  return {
    amount: 100,
    weekday: 1,
    startDate: '2024-01-01',
    holdingMonths: 1,
    disciplines: [],
    ...overrides
  };
}

function product(settlementDays = 1) {
  return { name: '测试产品', type: 'stock', settlementDays };
}

function filled(result, type) {
  return result.trades.filter((trade) => trade.type === type && trade.status === 'filled');
}

test('自然月按月末收敛，支持闰年', () => {
  assert.equal(Engine.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(Engine.addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(Engine.addMonths('2024-03-31', 1), '2024-04-30');
  assert.equal(Engine.addMonths('2024-11-30', 3), '2025-02-28');
});

test('休市顺延且同一日多笔计划分别执行', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-15', 100], ['2024-02-01', 100], ['2024-03-01', 100]
  ]), product(), config({ weekday: 2 }));
  const buys = filled(result, 'buy');
  assert.equal(buys.filter((trade) => trade.date === '2024-01-15').length, 2);
  assert.equal(buys.filter((trade) => trade.date === '2024-02-01').length, 3);
  assert.deepEqual(buys.slice(0, 2).map((trade) => trade.scheduledDate), ['2024-01-02', '2024-01-09']);
});

test('顺延超过结束日的定投取消并保留原因', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-08', 100], ['2024-03-01', 100]
  ]), product(), config({ weekday: 2 }));
  assert.ok(result.trades.some((trade) => trade.type === 'buy' && trade.status === 'cancelled'));
  assert.ok(result.trades.every((trade) => !trade.date || trade.date <= result.summary.endDate));
});

test('结束日非交易日时使用此前最后行情日估值且不清仓', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-31', 120], ['2024-02-02', 150]
  ]), product(), config({ weekday: 1 }));
  assert.equal(result.summary.endDate, '2024-02-01');
  assert.equal(result.summary.valuationDate, '2024-01-31');
  assert.ok(result.summary.shares > 0);
});

test('历史边界和无可执行定投会阻止计算', () => {
  const data = quotes([['2024-01-01', 100], ['2024-03-01', 100]]);
  assert.throws(() => Engine.simulate(data, product(), config({ startDate: '2023-12-01' })), /开始日期超出/);
  assert.throws(() => Engine.simulate(data, product(), config({ holdingMonths: 3 })), /结束日期.*超出/);
  assert.throws(() => Engine.simulate(data, product(), config({ weekday: 2 })), /没有可执行定投/);
});

test('无效金额、月数、阈值和卖出比例会阻止计算', () => {
  const data = quotes([['2024-01-01', 100], ['2024-03-01', 100]]);
  assert.throws(() => Engine.simulate(data, product(), config({ amount: 0 })), /金额/);
  assert.throws(() => Engine.simulate(data, product(), config({ holdingMonths: 1.5 })), /月数/);
  assert.throws(() => Engine.simulate(data, product(), config({
    disciplines: [{ direction: 'up', threshold: NaN, sellPercent: 50 }]
  })), /有限数字/);
  assert.throws(() => Engine.simulate(data, product(), config({
    disciplines: [{ direction: 'up', threshold: 5, sellPercent: 101 }]
  })), /0–100%/);
});

test('向上穿越后下一交易日卖出，持续高于阈值不重复触发', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 110], ['2024-01-03', 120],
    ['2024-01-04', 90], ['2024-01-05', 105], ['2024-01-06', 105], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ id: 'up', direction: 'up', threshold: 5, sellPercent: 50 }]
  }));
  const sells = filled(result, 'sell');
  assert.deepEqual(sells.map((trade) => trade.triggerDate), ['2024-01-02', '2024-01-05']);
  assert.deepEqual(sells.map((trade) => trade.date), ['2024-01-03', '2024-01-06']);
});

test('向下穿越、阈值停留与重新穿越', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 90], ['2024-01-03', 80],
    ['2024-01-04', 70], ['2024-01-05', 100], ['2024-01-06', 90],
    ['2024-01-07', 90], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ direction: 'down', threshold: -5, sellPercent: 50 }]
  }));
  const sells = filled(result, 'sell');
  assert.deepEqual(sells.map((trade) => trade.triggerDate), ['2024-01-02', '2024-01-06']);
  assert.equal(sells.length, 2);
});

test('同日多条纪律统一判定，按排序依次计算剩余份额', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 120], ['2024-01-03', 120], ['2024-03-01', 100]
  ]), product(), config({ disciplines: [
    { id: 'first', direction: 'up', threshold: 5, sellPercent: 50 },
    { id: 'second', direction: 'up', threshold: 10, sellPercent: 50 }
  ] }));
  const sells = filled(result, 'sell');
  assert.equal(sells.length, 2);
  assert.ok(Math.abs(sells[0].shares - 0.5) < 1e-12);
  assert.ok(Math.abs(sells[1].shares - 0.25) < 1e-12);
  assert.deepEqual(sells.map((trade) => trade.disciplineId), ['first', 'second']);
});

for (const [lag, expectedStatus] of [[0, 'filled'], [1, 'filled'], [2, 'partial']]) {
  test(`T+${lag} 控制可卖份额，锁定期未成交部分不补单`, () => {
    const result = Engine.simulate(quotes([
      ['2024-01-01', 100], ['2024-01-02', 100], ['2024-01-05', 100],
      ['2024-01-08', 200], ['2024-01-09', 200], ['2024-01-10', 200], ['2024-03-01', 100]
    ]), product(lag), config({
      disciplines: [{ direction: 'up', threshold: 10, sellPercent: 100 }]
    }));
    const sell = result.trades.find((trade) => trade.type === 'sell' && trade.date === '2024-01-09');
    assert.equal(sell.status, expectedStatus);
    if (lag === 2) {
      assert.ok(Math.abs(sell.shares - 1) < 1e-12);
      assert.ok(sell.requestedShares > sell.shares);
      assert.match(sell.reason, /不补单/);
    } else {
      assert.ok(Math.abs(sell.shares - 1.5) < 1e-12);
    }
  });
}

test('同日连续卖出后空仓，后续卖单记录未成交原因', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 120], ['2024-01-03', 120], ['2024-03-01', 100]
  ]), product(), config({ disciplines: [
    { direction: 'up', threshold: 5, sellPercent: 100 },
    { direction: 'up', threshold: 10, sellPercent: 100 }
  ] }));
  const sell = result.trades.filter((trade) => trade.type === 'sell')[1];
  assert.equal(sell.status, 'unfilled');
  assert.match(sell.reason, /空仓/);
});

test('全部卖出后继续定投，空仓收益率为空且不触发纪律', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 110], ['2024-01-03', 110],
    ['2024-01-04', 500], ['2024-01-08', 100], ['2024-01-09', 110],
    ['2024-01-10', 110], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ direction: 'up', threshold: 3, sellPercent: 100 }]
  }));
  assert.equal(filled(result, 'buy').length, 2);
  assert.equal(filled(result, 'sell').length, 2);
  const empty = result.daily.find((day) => day.date === '2024-01-04');
  assert.equal(empty.shares, 0);
  assert.equal(empty.holdingReturn, null);
  assert.equal(filled(result, 'sell')[1].triggerDate, '2024-01-09');
});

test('0% 阈值保留但不产生卖单', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 0.01], ['2024-01-03', 100], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ direction: 'up', threshold: 0, sellPercent: 100 }]
  }));
  assert.equal(result.trades.filter((trade) => trade.type === 'sell').length, 0);
});

test('0% 卖出比例保留但不产生卖单', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 120], ['2024-01-03', 120], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ direction: 'up', threshold: 5, sellPercent: 0 }]
  }));
  assert.equal(result.trades.filter((trade) => trade.type === 'sell').length, 0);
});

test('移动平均成本及收益恒等关系成立', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-02', 120], ['2024-01-03', 120],
    ['2024-01-08', 60], ['2024-01-09', 90], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ direction: 'up', threshold: 5, sellPercent: 50 }]
  }));
  const s = result.summary;
  const realizedCost = s.redeemed - s.realizedProfit;
  assert.ok(Math.abs(s.invested - s.remainingCost - realizedCost) < 1e-8);
  assert.ok(Math.abs(s.holdingProfit - (s.marketValue - s.remainingCost)) < 1e-8);
  assert.ok(Math.abs(s.totalProfit - (s.realizedProfit + s.holdingProfit)) < 1e-8);
  assert.ok(Math.abs(s.totalProfit - (s.marketValue + s.redeemed - s.invested)) < 1e-8);
  assert.ok(Math.abs(s.holdingReturn - (s.marketValue / s.remainingCost - 1)) < 1e-8);
  assert.ok(Math.abs(s.totalReturn - s.totalProfit / s.invested) < 1e-8);
});

test('期末触发卖单不越界成交并记录原因', () => {
  const result = Engine.simulate(quotes([
    ['2024-01-01', 100], ['2024-01-31', 120], ['2024-03-01', 100]
  ]), product(), config({
    disciplines: [{ direction: 'up', threshold: 3, sellPercent: 100 }]
  }));
  const sell = result.trades.find((trade) => trade.type === 'sell');
  assert.equal(sell.status, 'cancelled');
  assert.equal(sell.date, null);
  assert.match(sell.reason, /期末/);
});
