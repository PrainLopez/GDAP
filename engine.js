(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DisciplineEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EPSILON = 1e-10;

  function EngineError(message, field) {
    this.name = 'EngineError';
    this.message = message;
    this.field = field || '';
    if (Error.captureStackTrace) Error.captureStackTrace(this, EngineError);
  }
  EngineError.prototype = Object.create(Error.prototype);
  EngineError.prototype.constructor = EngineError;

  function dateParts(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var parts = value.split('-').map(Number);
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 ||
        date.getUTCDate() !== parts[2]) return null;
    return parts;
  }

  function toISO(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(value, days) {
    var parts = dateParts(value);
    if (!parts) throw new EngineError('日期格式无效');
    return toISO(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days)));
  }

  function addMonths(value, months) {
    var parts = dateParts(value);
    if (!parts || !Number.isInteger(months)) throw new EngineError('日期或月数无效');
    var first = new Date(Date.UTC(parts[0], parts[1] - 1 + months, 1));
    var last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    return toISO(new Date(Date.UTC(
      first.getUTCFullYear(), first.getUTCMonth(), Math.min(parts[2], last.getUTCDate())
    )));
  }

  function annualizedReturn(value, startDate, endDate) {
    if (!Number.isFinite(value)) return null;
    var start = dateParts(startDate);
    var end = dateParts(endDate);
    if (!start || !end) return null;
    var days = (Date.UTC(end[0], end[1] - 1, end[2]) - Date.UTC(start[0], start[1] - 1, start[2])) / 86400000;
    if (days <= 0) return null;
    return Math.pow(1 + value, 365 / days) - 1;
  }

  function lowerBound(values, target) {
    var low = 0;
    var high = values.length;
    while (low < high) {
      var middle = (low + high) >> 1;
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function validate(quotes, product, config) {
    if (!Array.isArray(quotes) || !quotes.length) throw new EngineError('没有可用行情数据', 'product');
    if (!product || typeof product !== 'object') throw new EngineError('请先选择产品', 'product');
    if (!Number.isFinite(config.amount) || config.amount <= 0) {
      throw new EngineError('单次定投金额必须是大于 0 的有限数字', 'amount');
    }
    if (!Number.isInteger(config.holdingMonths) || config.holdingMonths <= 0) {
      throw new EngineError('持有月数必须是大于 0 的整数', 'holdingMonths');
    }
    if (!dateParts(config.startDate)) throw new EngineError('开始日期无效', 'startDate');
    if (!Number.isInteger(config.weekday) || config.weekday < 0 || config.weekday > 6) {
      throw new EngineError('定投星期无效', 'weekday');
    }
    if (!Array.isArray(config.disciplines)) throw new EngineError('纪律配置无效', 'disciplines');
    config.disciplines.forEach(function (rule, index) {
      if (rule.direction !== 'up' && rule.direction !== 'down') {
        throw new EngineError('第 ' + (index + 1) + ' 条纪律方向无效', 'disciplines');
      }
      if (!Number.isFinite(rule.threshold)) {
        throw new EngineError('第 ' + (index + 1) + ' 条纪律的越过百分比必须是有限数字', 'disciplines');
      }
      if (!Number.isFinite(rule.sellPercent) || rule.sellPercent < 0 || rule.sellPercent > 100) {
        throw new EngineError('第 ' + (index + 1) + ' 条纪律的卖出比例必须在 0–100% 之间', 'disciplines');
      }
    });

    var previous = '';
    quotes.forEach(function (quote, index) {
      if (!dateParts(quote.date) || (index && quote.date <= previous)) {
        throw new EngineError('行情日期必须严格递增且格式有效', 'product');
      }
      ['open', 'high', 'low', 'close'].forEach(function (key) {
        if (!Number.isFinite(quote[key]) || quote[key] <= 0) {
          throw new EngineError('行情包含无效价格：' + quote.date, 'product');
        }
      });
      previous = quote.date;
    });

    var endDate = addMonths(config.startDate, config.holdingMonths);
    if (config.startDate < quotes[0].date || config.startDate > quotes[quotes.length - 1].date) {
      throw new EngineError('开始日期超出产品历史范围（' + quotes[0].date + ' 至 ' +
        quotes[quotes.length - 1].date + '）', 'startDate');
    }
    if (endDate > quotes[quotes.length - 1].date) {
      throw new EngineError('结束日期 ' + endDate + ' 超出历史终点 ' + quotes[quotes.length - 1].date +
        '，请推迟开始日期或缩短持有月数', 'holdingMonths');
    }
    return endDate;
  }

  function makePlans(config, dates, endDate) {
    var startDay = new Date(config.startDate + 'T00:00:00Z').getUTCDay();
    var scheduled = addDays(config.startDate, (config.weekday - startDay + 7) % 7);
    var plans = [];
    var sequence = 0;
    while (scheduled <= endDate) {
      var quoteIndex = lowerBound(dates, scheduled);
      var plan = {
        id: 'P' + (++sequence),
        scheduledDate: scheduled,
        executeDate: quoteIndex < dates.length && dates[quoteIndex] <= endDate ? dates[quoteIndex] : null,
        quoteIndex: quoteIndex
      };
      plans.push(plan);
      scheduled = addDays(scheduled, 7);
    }
    return plans;
  }

  function simulate(quotes, product, config) {
    var endDate = validate(quotes, product, config);
    var dates = quotes.map(function (quote) { return quote.date; });
    var plans = makePlans(config, dates, endDate);
    var executable = plans.filter(function (plan) { return plan.executeDate; });
    if (!executable.length) {
      throw new EngineError('所选区间内没有可执行定投，请调整开始日期、星期或持有月数', 'startDate');
    }

    var settlementDays = Number.isInteger(product.settlementDays) ? product.settlementDays : 1;
    if (settlementDays < 0 || settlementDays > 2) settlementDays = 1;
    var startIndex = lowerBound(dates, config.startDate);
    var endIndex = lowerBound(dates, addDays(endDate, 1)) - 1;
    var plansByDate = Object.create(null);
    executable.forEach(function (plan) {
      (plansByDate[plan.executeDate] || (plansByDate[plan.executeDate] = [])).push(plan);
    });

    var state = {
      shares: 0,
      cost: 0,
      invested: 0,
      redeemed: 0,
      realized: 0
    };
    var lots = [];
    var trades = [];
    var daily = [];
    var orders = [];
    var previousReturns = config.disciplines.map(function () { return null; });
    var tradeSequence = 0;

    plans.forEach(function (plan) {
      if (!plan.executeDate) {
        trades.push({
          id: 'T' + (++tradeSequence), type: 'buy', status: 'cancelled', planId: plan.id,
          scheduledDate: plan.scheduledDate, date: null, price: null, shares: 0, amount: 0,
          reason: '顺延日超过结束日，本次定投取消'
        });
      }
    });

    function recordSell(order, quote, status, shares, amount, reason, desired, available) {
      var trade = {
        id: 'T' + (++tradeSequence), type: 'sell', status: status,
        disciplineId: order.disciplineId, disciplineOrder: order.disciplineOrder,
        direction: order.direction, threshold: order.threshold, sellPercent: order.sellPercent,
        triggerDate: order.triggerDate, date: quote ? quote.date : null,
        price: quote ? quote.close : null, shares: shares, amount: amount,
        requestedShares: desired, availableShares: available, reason: reason || ''
      };
      trades.push(trade);
      return trade;
    }

    function executeSell(order, quote, quoteIndex) {
      var beforeShares = state.shares;
      var beforeCost = state.cost;
      var desired = beforeShares * order.sellPercent / 100;
      var available = lots.reduce(function (sum, lot) {
        return sum + (lot.availableIndex <= quoteIndex ? lot.shares : 0);
      }, 0);
      var shares = Math.min(desired, available);
      if (shares < EPSILON) shares = 0;
      if (!shares) {
        recordSell(order, quote, 'unfilled', 0, 0,
          beforeShares <= EPSILON ? '当前为空仓，无份额可卖' : '新份额仍在锁定期，无可用份额',
          desired, available);
        return;
      }

      var remainingToRemove = shares;
      lots.forEach(function (lot) {
        if (lot.availableIndex > quoteIndex || remainingToRemove <= EPSILON) return;
        var removed = Math.min(lot.shares, remainingToRemove);
        lot.shares -= removed;
        if (lot.shares < EPSILON) lot.shares = 0;
        remainingToRemove -= removed;
      });
      lots = lots.filter(function (lot) { return lot.shares > EPSILON; });

      var amount = shares * quote.close;
      var costRemoved = shares >= beforeShares - EPSILON ? state.cost : state.cost * shares / beforeShares;
      state.shares = Math.max(0, state.shares - shares);
      state.cost = Math.max(0, state.cost - costRemoved);
      state.redeemed += amount;
      state.realized += amount - costRemoved;
      if (state.shares <= EPSILON) {
        state.shares = 0;
        state.cost = 0;
      }
      var unfilled = desired - shares;
      var partial = unfilled > EPSILON;
      var recorded = recordSell(order, quote, partial ? 'partial' : 'filled', shares, amount,
        partial ? '可卖份额不足，未成交 ' + unfilled + ' 份不补单' : '', desired, available);
      recorded.costBefore = beforeCost;
      recorded.costRemoved = costRemoved;
      recorded.costPerShare = beforeCost / beforeShares;
      recorded.remainingCost = state.cost;
    }

    for (var i = startIndex; i <= endIndex; i += 1) {
      var quote = quotes[i];
      orders.forEach(function (order) {
        if (!order.done && order.executeIndex === i) {
          executeSell(order, quote, i);
          order.done = true;
        }
      });

      (plansByDate[quote.date] || []).forEach(function (plan) {
        var shares = config.amount / quote.close;
        state.shares += shares;
        state.cost += config.amount;
        state.invested += config.amount;
        lots.push({ shares: shares, availableIndex: i + settlementDays });
        trades.push({
          id: 'T' + (++tradeSequence), type: 'buy', status: 'filled', planId: plan.id,
          scheduledDate: plan.scheduledDate, date: quote.date, price: quote.close,
          shares: shares, amount: config.amount, reason: ''
        });
      });

      var marketValue = state.shares * quote.close;
      var holdingReturn = state.shares > EPSILON && state.cost > EPSILON ?
        marketValue / state.cost - 1 : null;
      var holdingProfit = marketValue - state.cost;
      var totalProfit = marketValue + state.redeemed - state.invested;
      daily.push({
        date: quote.date,
        close: quote.close,
        shares: state.shares,
        remainingCost: state.cost,
        marketValue: marketValue,
        invested: state.invested,
        redeemed: state.redeemed,
        realizedProfit: state.realized,
        holdingProfit: holdingProfit,
        holdingReturn: holdingReturn,
        totalProfit: totalProfit,
        totalReturn: state.invested > 0 ? totalProfit / state.invested : null
      });

      var signals = config.disciplines.map(function (rule, ruleIndex) {
        var previous = previousReturns[ruleIndex];
        var crossed = holdingReturn !== null && previous !== null && rule.threshold !== 0 && rule.sellPercent !== 0 && (
          rule.direction === 'up' ?
            previous < rule.threshold / 100 && holdingReturn >= rule.threshold / 100 :
            previous > rule.threshold / 100 && holdingReturn <= rule.threshold / 100
        );
        previousReturns[ruleIndex] = holdingReturn;
        return crossed ? { rule: rule, ruleIndex: ruleIndex } : null;
      });
      signals.forEach(function (signal) {
        if (!signal) return;
        var rule = signal.rule;
        orders.push({
          disciplineId: rule.id || 'D' + (signal.ruleIndex + 1),
          disciplineOrder: signal.ruleIndex + 1,
          direction: rule.direction,
          threshold: rule.threshold,
          sellPercent: rule.sellPercent,
          triggerDate: quote.date,
          executeIndex: i + 1,
          done: false
        });
      });
    }

    orders.forEach(function (order) {
      if (!order.done) {
        recordSell(order, null, 'cancelled', 0, 0, '期末之前没有下一交易日，卖单未成交', 0, 0);
      }
    });

    var last = daily[daily.length - 1];
    var realizedCost = last.redeemed - last.realizedProfit;
    var realizedReturn = realizedCost > EPSILON ? last.realizedProfit / realizedCost : null;
    return {
      config: {
        amount: config.amount,
        weekday: config.weekday,
        startDate: config.startDate,
        holdingMonths: config.holdingMonths,
        endDate: endDate,
        disciplines: config.disciplines
      },
      summary: {
        startDate: config.startDate,
        endDate: endDate,
        valuationDate: last.date,
        invested: last.invested,
        redeemed: last.redeemed,
        realizedProfit: last.realizedProfit,
        realizedReturn: realizedReturn,
        realizedAnnualizedReturn: annualizedReturn(realizedReturn, config.startDate, last.date),
        shares: last.shares,
        remainingCost: last.remainingCost,
        marketValue: last.marketValue,
        holdingProfit: last.holdingProfit,
        holdingReturn: last.holdingReturn,
        holdingAnnualizedReturn: annualizedReturn(last.holdingReturn, config.startDate, last.date),
        totalProfit: last.totalProfit,
        totalReturn: last.totalReturn,
        totalAnnualizedReturn: annualizedReturn(last.totalReturn, config.startDate, last.date)
      },
      daily: daily,
      trades: trades,
      plans: plans
    };
  }

  return {
    simulate: simulate,
    addMonths: addMonths,
    addDays: addDays,
    EngineError: EngineError
  };
});
