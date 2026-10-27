(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    scope: 'all',
    product: null,
    quotes: [],
    result: null,
    searchResults: [],
    activeResult: -1,
    searchToken: 0,
    loadToken: 0,
    searchTimer: null,
    priceChart: null,
    returnChart: null,
    simulationWorker: null,
    running: false,
    runSequence: 0,
    ruleSequence: 0,
    rules: [
      { id: 'D1', direction: 'down', threshold: '-25', sellPercent: '50' },
      { id: 'D2', direction: 'down', threshold: '-40', sellPercent: '50' },
      { id: 'D3', direction: 'up', threshold: '75', sellPercent: '50' },
      { id: 'D4', direction: 'up', threshold: '120', sellPercent: '50' }
    ]
  };
  state.ruleSequence = state.rules.reduce(function (max, rule) {
    return Math.max(max, Number(rule.id.slice(1)) || 0);
  }, 0);

  var numberFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var shareFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
    });
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
  }

  function formatNumber(value, signed) {
    if (!Number.isFinite(value)) return '—';
    return (signed && value > 0 ? '+' : '') + numberFormatter.format(value);
  }

  function formatPercent(value, signed) {
    if (!Number.isFinite(value)) return '—';
    return (signed && value > 0 ? '+' : '') + numberFormatter.format(value * 100) + '%';
  }

  function valueClass(value) {
    return value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  }

  function numericValue(value) {
    return String(value).trim() === '' ? NaN : Number(value);
  }

  function setSearchStatus(message, isError) {
    $('searchStatus').textContent = message || '';
    $('searchStatus').classList.toggle('error', Boolean(isError));
  }

  function closeSearch() {
    $('searchResults').hidden = true;
    $('productSearch').setAttribute('aria-expanded', 'false');
    $('productSearch').removeAttribute('aria-activedescendant');
    state.activeResult = -1;
  }

  function renderSearchResults() {
    var list = $('searchResults');
    list.innerHTML = state.searchResults.map(function (product, index) {
      return '<li role="presentation"><button type="button" role="option" id="product-option-' + index +
        '" data-index="' + index + '" aria-selected="' + (index === state.activeResult) + '"' +
        (index === state.activeResult ? ' class="active"' : '') + '>' +
        '<span class="result-name">' + escapeHTML(product.name) + '</span>' +
        '<span class="result-code">' + escapeHTML(product.code) + '</span>' +
        '<span class="result-type">' + escapeHTML(product.typeLabel) +
        (product.category ? ' · ' + escapeHTML(product.category) : '') + '</span></button></li>';
    }).join('');
    list.hidden = !state.searchResults.length;
    $('productSearch').setAttribute('aria-expanded', String(Boolean(state.searchResults.length)));
    if (state.activeResult >= 0) {
      $('productSearch').setAttribute('aria-activedescendant', 'product-option-' + state.activeResult);
      var active = $('product-option-' + state.activeResult);
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  }

  function searchProducts() {
    var query = $('productSearch').value.trim();
    if (!query) {
      state.searchResults = [];
      closeSearch();
      setSearchStatus('');
      return;
    }
    var token = ++state.searchToken;
    var requests = [];
    if (state.scope !== 'otc') requests.push(window.MarketData.searchExchange(query));
    if (state.scope !== 'exchange') requests.push(window.MarketData.searchFunds(query));
    setSearchStatus(state.scope === 'otc' ? '正在加载并搜索基金目录…' : '正在搜索…');

    Promise.allSettled(requests).then(function (settled) {
      if (token !== state.searchToken) return;
      var products = [];
      var errors = [];
      settled.forEach(function (entry) {
        if (entry.status === 'fulfilled') products = products.concat(entry.value);
        else errors.push(entry.reason);
      });
      state.searchResults = products.slice(0, 30);
      state.activeResult = state.searchResults.length ? 0 : -1;
      renderSearchResults();
      if (errors.length) {
        setSearchStatus(errors[0].message + (products.length ? '；当前显示其他来源结果' : ''), true);
      } else {
        setSearchStatus(products.length ? '找到 ' + products.length + ' 个产品' : '未找到支持的产品，请尝试完整代码或名称');
      }
    });
  }

  function selectProduct(product) {
    if (!product) return;
    cancelSimulation();
    state.product = product;
    state.quotes = [];
    state.result = null;
    $('productSearch').value = product.code + '  ' + product.name;
    $('clearSearch').hidden = false;
    closeSearch();
    setSearchStatus('');
    $('selectedProduct').hidden = false;
    $('selectedName').textContent = product.name;
    $('selectedCode').textContent = product.code;
    $('selectedType').textContent = product.typeLabel + (product.market ? ' · ' + product.market : '');
    $('selectedRule').textContent = product.rule.label;
    $('selectedRuleReason').textContent = product.rule.reason;
    $('selectedRange').textContent = '正在读取历史范围';
    renderSummary();
    renderTrades();
    renderReturnChart();
    loadHistory(true);
  }

  function showDataError(message) {
    $('dataAlertText').textContent = message;
    $('dataAlert').hidden = false;
  }

  function setDefaultDates(reset) {
    if (!state.quotes.length) return;
    var first = state.quotes[0].date;
    var last = state.quotes[state.quotes.length - 1].date;
    $('startDate').min = first;
    $('startDate').max = last;
    var current = $('startDate').value;
    if (reset || !current || current < first || current > last) {
      var months = numericValue($('holdingMonths').value);
      if (!Number.isInteger(months) || months <= 0) months = 36;
      var start = window.DisciplineEngine.addMonths(last, -months);
      if (start < first) start = first;
      $('startDate').value = start;
    }
    updateEndDate();
  }

  function updateEndDate() {
    var start = $('startDate').value;
    var months = numericValue($('holdingMonths').value);
    var preview = $('endDatePreview');
    try {
      preview.textContent = '至 ' + window.DisciplineEngine.addMonths(start, months);
      preview.style.color = '';
    } catch (error) {
      preview.textContent = '结束日期待确定';
    }
    if (state.quotes.length && /^\d{4}-\d{2}-\d{2}$/.test(start) && Number.isInteger(months) && months > 0) {
      var end = window.DisciplineEngine.addMonths(start, months);
      var last = state.quotes[state.quotes.length - 1].date;
      preview.style.color = end > last ? 'var(--error)' : '';
    }
  }

  function loadHistory(resetDates) {
    if (!state.product) return;
    cancelSimulation();
    var product = state.product;
    var token = ++state.loadToken;
    state.quotes = [];
    state.result = null;
    $('dataAlert').hidden = true;
    $('chartLoading').hidden = false;
    $('priceChartEmpty').hidden = true;
    syncRunButton();
    $('reloadHistory').disabled = true;
    $('showFullHistory').disabled = true;
    $('historySubtitle').textContent = product.type === 'otc-fund' ? '正在读取历史净值' : '正在读取后复权日 K';
    renderSummary();
    renderTrades();
    renderReturnChart();

    window.MarketData.loadHistory(product).then(function (quotes) {
      if (token !== state.loadToken) return;
      state.quotes = quotes;
      $('selectedRange').textContent = quotes[0].date + ' 至 ' + quotes[quotes.length - 1].date +
        ' · ' + quotes.length + ' 个行情日';
      setDefaultDates(resetDates);
      syncRunButton();
      $('showFullHistory').disabled = false;
      renderPriceChart(false);
    }).catch(function (error) {
      if (token !== state.loadToken) return;
      $('selectedRange').textContent = '历史范围不可用';
      $('historySubtitle').textContent = '历史行情加载失败';
      $('priceChartEmpty').innerHTML = '<span>历史行情加载失败，请重试</span>';
      $('priceChartEmpty').hidden = false;
      showDataError(error.message || '数据加载失败，请重试');
    }).finally(function () {
      if (token !== state.loadToken) return;
      $('chartLoading').hidden = true;
      $('reloadHistory').disabled = false;
    });
  }

  function renderRules() {
    var list = $('disciplineList');
    if (!state.rules.length) {
      list.innerHTML = '<div class="discipline-empty">未设置卖出纪律</div>';
      return;
    }
    list.innerHTML = state.rules.map(function (rule, index) {
      var up = rule.direction === 'up';
      return '<div class="discipline-card ' + (up ? 'up' : 'down') + '" data-rule-id="' + rule.id + '">' +
        '<div class="rule-top"><span class="rule-name">纪律 ' + String(index + 1).padStart(2, '0') + ' · ' +
        (up ? '向上越过' : '向下越过') + '</span><div class="rule-actions">' +
        '<button type="button" class="icon-button" data-action="move-up" title="上移纪律" aria-label="上移第 ' + (index + 1) + ' 条纪律" ' + (index === 0 ? 'disabled' : '') + '><i data-lucide="arrow-up"></i></button>' +
        '<button type="button" class="icon-button" data-action="move-down" title="下移纪律" aria-label="下移第 ' + (index + 1) + ' 条纪律" ' + (index === state.rules.length - 1 ? 'disabled' : '') + '><i data-lucide="arrow-down"></i></button>' +
        '<button type="button" class="icon-button" data-action="delete" title="删除纪律" aria-label="删除第 ' + (index + 1) + ' 条纪律"><i data-lucide="trash-2"></i></button>' +
        '</div></div><div class="rule-fields">' +
        '<label class="rule-field"><span>方向</span><select data-field="direction" aria-label="第 ' + (index + 1) + ' 条纪律方向">' +
        '<option value="up"' + (up ? ' selected' : '') + '>向上</option><option value="down"' + (!up ? ' selected' : '') + '>向下</option></select></label>' +
        '<label class="rule-field"><span>越过 %</span><input type="number" step="any" data-field="threshold" aria-label="第 ' + (index + 1) + ' 条纪律越过百分比" value="' + escapeHTML(rule.threshold) + '"></label>' +
        '<label class="rule-field"><span>卖出 %</span><input type="number" min="0" max="100" step="any" data-field="sellPercent" aria-label="第 ' + (index + 1) + ' 条纪律卖出比例" value="' + escapeHTML(rule.sellPercent) + '"></label>' +
        '</div></div>';
    }).join('');
    refreshIcons();
  }

  function readConfig() {
    return {
      amount: numericValue($('amount').value),
      weekday: Number($('weekday').value),
      startDate: $('startDate').value,
      holdingMonths: numericValue($('holdingMonths').value),
      disciplines: state.rules.map(function (rule) {
        return {
          id: rule.id,
          direction: rule.direction,
          threshold: numericValue(rule.threshold),
          sellPercent: numericValue(rule.sellPercent)
        };
      })
    };
  }

  function syncRunButton() {
    $('runDock').hidden = !state.quotes.length;
    $('runSimulation').disabled = !state.quotes.length || state.running;
  }

  function setRunning(running) {
    state.running = running;
    $('runSimulation').classList.toggle('running', running);
    $('runSimulation').setAttribute('aria-busy', String(running));
    $('runSimulation').innerHTML = running ?
      '<span class="spinner" aria-hidden="true"></span><span>正在模拟…</span>' :
      '<i data-lucide="play" aria-hidden="true"></i><span>开始模拟</span>';
    syncRunButton();
    refreshIcons();
  }

  function cancelSimulation() {
    state.runSequence += 1;
    if (state.simulationWorker) state.simulationWorker.terminate();
    state.simulationWorker = null;
    if (state.running) setRunning(false);
  }

  function finishSimulation(id, result, error) {
    if (id !== state.runSequence) return;
    setRunning(false);
    if (error) {
      state.result = null;
      renderReturnChart();
      renderSummary();
      renderTrades();
      renderPriceChart(false);
      $('configError').textContent = error.message || '计算失败，请检查配置';
      $('configError').hidden = false;
      var field = error.field && $(error.field);
      if (field) {
        field.classList.add('invalid');
        field.focus();
      }
      return;
    }
    state.result = result;
    renderPriceChart(true);
    renderReturnChart();
    renderSummary();
    renderTrades();
  }

  function quoteIndex(date) {
    var low = 0;
    var high = state.quotes.length;
    while (low < high) {
      var middle = (low + high) >> 1;
      if (state.quotes[middle].date < date) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function tradeDescription(trade) {
    return (trade.direction === 'up' ? '向上越过 ' : '向下越过 ') +
      formatNumber(trade.threshold) + '% · 卖出 ' + formatNumber(trade.sellPercent) + '%';
  }

  function priceTooltip(params) {
    var list = Array.isArray(params) ? params : [params];
    if (!list.length) return '';
    var date = list[0].axisValue || (list[0].data && list[0].data.coord && list[0].data.coord[0]);
    if (!date) return '';
    var quote = state.quotes[quoteIndex(date)];
    if (!quote || quote.date !== date) return '';
    var html = '<div style="font:12px/1.7 var(--sans);min-width:180px"><strong style="font-family:var(--mono)">' + date + '</strong>';
    if (state.product.type === 'otc-fund') {
      html += '<div>复权净值：<span style="font-family:var(--mono)">' + quote.close.toFixed(4) + '</span></div>';
    } else {
      html += '<div>开盘 ' + quote.open.toFixed(2) + '　最高 ' + quote.high.toFixed(2) + '</div>' +
        '<div>收盘 ' + quote.close.toFixed(2) + '　最低 ' + quote.low.toFixed(2) + '</div>';
    }
    if (state.result) {
      var sells = state.result.trades.filter(function (trade) {
        return trade.type === 'sell' && trade.date === date && (trade.status === 'filled' || trade.status === 'partial');
      });
      sells.forEach(function (trade) {
      html += '<div style="border-top:1px solid #e1e4e8;margin-top:5px;padding-top:5px">' +
          '<strong>卖出成交 · ' + escapeHTML(tradeDescription(trade)) + '</strong>' +
          '<div>触发日 ' + trade.triggerDate + '　成交日 ' + trade.date + '</div>' +
          '<div>价格 ' + formatNumber(trade.price) + '　份额 ' + shareFormatter.format(trade.shares) + '</div>' +
          '<div>每份额持仓成本 ' + formatNumber(trade.costPerShare) + ' 元</div></div>';
      });
    }
    return html + '</div>';
  }

  function renderPriceChart(zoomToSimulation) {
    if (!state.quotes.length) {
      $('priceChartEmpty').hidden = false;
      return;
    }
    if (!window.echarts) {
      $('priceChartEmpty').innerHTML = '<span>图表库加载失败，请检查网络后刷新；计算与明细仍可使用</span>';
      $('priceChartEmpty').hidden = false;
      return;
    }
    $('priceChartEmpty').hidden = true;
    if (!state.priceChart) state.priceChart = window.echarts.init($('priceChart'));
    var dates = state.quotes.map(function (quote) { return quote.date; });
    var isFund = state.product.type === 'otc-fund';
    var sellsByDate = Object.create(null);
    if (state.result) {
      state.result.trades.forEach(function (trade) {
        if (trade.type === 'sell' && trade.date && (trade.status === 'filled' || trade.status === 'partial')) {
          (sellsByDate[trade.date] || (sellsByDate[trade.date] = [])).push(trade);
        }
      });
    }
    var marks = Object.keys(sellsByDate).map(function (date) {
      var trades = sellsByDate[date];
      return { coord: [date, trades[0].price], count: trades.length, trades: trades };
    });
    var series = isFund ? {
      name: '复权净值', type: 'line', data: state.quotes.map(function (quote) { return quote.close; }),
      showSymbol: false, lineStyle: { width: 1.5, color: '#0969da' }, itemStyle: { color: '#0969da' }
    } : {
      name: '后复权日 K', type: 'candlestick',
      data: state.quotes.map(function (quote) { return [quote.open, quote.close, quote.low, quote.high]; }),
      itemStyle: { color: '#cf222e', color0: '#2da44e', borderColor: '#cf222e', borderColor0: '#1a7f37' }
    };
    series.markPoint = {
      symbol: 'pin', symbolSize: 42,
      itemStyle: { color: '#bf3989' },
      label: { color: '#fff', fontSize: 10, formatter: function (point) { return point.data.count > 1 ? '卖' + point.data.count : '卖'; } },
      data: marks
    };
    if (state.result) {
      series.markArea = {
        silent: true, itemStyle: { color: 'rgba(9,105,218,0.045)' },
        data: [[{ xAxis: state.result.daily[0].date }, { xAxis: state.result.summary.valuationDate }]]
      };
    }
    var subtitle = dates[0] + ' 至 ' + dates[dates.length - 1] + ' · ' + (isFund ? '分红再投资复权净值' : '后复权 OHLC');
    if (state.result) subtitle += ' · 模拟至 ' + state.result.summary.valuationDate;
    $('historySubtitle').textContent = subtitle;

    state.priceChart.setOption({
      animation: false,
      textStyle: { fontFamily: '-apple-system, PingFang SC, Microsoft YaHei, sans-serif', color: '#6a737d' },
      grid: { left: 62, right: 22, top: 25, bottom: 74 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, confine: true, formatter: priceTooltip },
      xAxis: { type: 'category', data: dates, boundaryGap: !isFund, axisLine: { lineStyle: { color: '#d0d7de' } }, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', scale: true, position: 'left', splitLine: { lineStyle: { color: '#eaeef2' } }, axisLabel: { formatter: function (value) { return numberFormatter.format(value); } } },
      dataZoom: [
        { type: 'inside', start: 0, end: 100, minValueSpan: 5 },
        { type: 'slider', start: 0, end: 100, height: 20, bottom: 18, borderColor: '#e1e4e8', fillerColor: 'rgba(9,105,218,.12)', handleStyle: { color: '#0969da' }, dataBackground: { lineStyle: { color: '#8c959f' }, areaStyle: { color: '#eaeef2' } }, textStyle: { fontSize: 10 } }
      ],
      series: [series]
    }, true);

    var startPercent = 0;
    var endPercent = 100;
    if (zoomToSimulation && state.result && dates.length > 1) {
      var start = Math.max(0, quoteIndex(state.result.config.startDate) - 3);
      var end = Math.min(dates.length - 1, quoteIndex(state.result.summary.valuationDate) + 3);
      startPercent = start / (dates.length - 1) * 100;
      endPercent = end / (dates.length - 1) * 100;
    }
    state.priceChart.dispatchAction({ type: 'dataZoom', start: startPercent, end: endPercent });
    state.priceChart.resize();
  }

  function renderReturnChart() {
    if (!state.result) {
      $('returnChartEmpty').hidden = false;
      if (state.returnChart) state.returnChart.clear();
      $('returnSubtitle').textContent = '当前市值 ÷ 剩余持仓成本 − 1';
      return;
    }
    if (!window.echarts) {
      $('returnChartEmpty').innerHTML = '<span>图表库未加载，收益率数值见下方结果</span>';
      $('returnChartEmpty').hidden = false;
      return;
    }
    $('returnChartEmpty').hidden = true;
    if (!state.returnChart) state.returnChart = window.echarts.init($('returnChart'));
    var daily = state.result.daily;
    $('returnSubtitle').textContent = state.result.config.startDate + ' 至 ' + state.result.summary.valuationDate + ' · 空仓区间留空';
    state.returnChart.setOption({
      animation: false,
      textStyle: { fontFamily: '-apple-system, PingFang SC, Microsoft YaHei, sans-serif', color: '#6a737d' },
      grid: { left: 62, right: 22, top: 22, bottom: 58 },
      tooltip: {
        trigger: 'axis', confine: true,
        formatter: function (params) {
          var point = params[0];
          var day = daily[point.dataIndex];
          return '<strong style="font-family:var(--mono)">' + day.date + '</strong><br>' +
            '持有收益率：' + formatPercent(day.holdingReturn, true) + '<br>' +
            '持有收益额：' + formatNumber(day.holdingProfit, true) + ' 元<br>' +
            '剩余成本：' + formatNumber(day.remainingCost) + ' 元';
        }
      },
      xAxis: { type: 'category', data: daily.map(function (day) { return day.date; }), boundaryGap: false, axisLine: { lineStyle: { color: '#d0d7de' } }, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#eaeef2' } }, axisLabel: { formatter: function (value) { return numberFormatter.format(value * 100) + '%'; } } },
      dataZoom: [{ type: 'inside', start: 0, end: 100 }, { type: 'slider', start: 0, end: 100, height: 14, bottom: 12, borderColor: '#e1e4e8', fillerColor: 'rgba(9,105,218,.12)', textStyle: { fontSize: 9 } }],
      series: [{
        name: '持有收益率', type: 'line', data: daily.map(function (day) { return day.holdingReturn; }),
        showSymbol: false, connectNulls: false, lineStyle: { width: 1.7, color: '#0969da' },
        itemStyle: { color: '#0969da' }, areaStyle: { color: 'rgba(9,105,218,.07)' },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: '#8c959f', type: 'dashed' }, data: [{ yAxis: 0 }] }
      }]
    }, true);
    state.returnChart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    state.returnChart.resize();
  }

  function metric(label, value, subvalue, signed) {
    return '<div class="metric' + (label.indexOf('整体') === 0 ? ' primary-metric' : '') + '">' +
      '<span>' + label + '</span><strong class="' + (signed ? valueClass(value.raw) : '') + '">' + value.text + '</strong>' +
      (subvalue ? '<small class="' + (signed ? valueClass(subvalue.raw) : '') + '">' + subvalue.text + '</small>' : '') + '</div>';
  }

  function rateDetail(rate, annualized) {
    return '收益率 ' + formatPercent(rate, true) + ' · 年化 ' + formatPercent(annualized, true);
  }

  function renderSummary() {
    if (!state.result) {
      $('valuationDate').textContent = '等待模拟';
      $('summaryGrid').innerHTML = [
        '<div class="metric"><span>累计投入</span><strong>—</strong></div>',
        '<div class="metric"><span>累计赎回</span><strong>—</strong></div>',
        '<div class="metric"><span>已实现收益</span><strong>—</strong><small>—</small></div>',
        '<div class="metric"><span>最终等效份额</span><strong>—</strong></div>',
        '<div class="metric"><span>剩余成本</span><strong>—</strong></div>',
        '<div class="metric"><span>最终市值</span><strong>—</strong></div>',
        '<div class="metric"><span>持有收益</span><strong>—</strong><small>—</small></div>',
        '<div class="metric primary-metric"><span>整体收益（含赎回）</span><strong>—</strong><small>—</small></div>'
      ].join('');
      return;
    }
    var summary = state.result.summary;
    $('valuationDate').textContent = '估值日 ' + summary.valuationDate + ' · 自然结束日 ' + summary.endDate;
    $('summaryGrid').innerHTML =
      metric('累计投入（元）', { text: formatNumber(summary.invested), raw: summary.invested }) +
      metric('累计赎回（元）', { text: formatNumber(summary.redeemed), raw: summary.redeemed }) +
      metric('已实现收益（元）', { text: formatNumber(summary.realizedProfit, true), raw: summary.realizedProfit },
        { text: rateDetail(summary.realizedReturn, summary.realizedAnnualizedReturn), raw: summary.realizedReturn }, true) +
      metric('最终等效份额', { text: Number.isFinite(summary.shares) ? shareFormatter.format(summary.shares) : '—', raw: summary.shares }) +
      metric('剩余成本（元）', { text: formatNumber(summary.remainingCost), raw: summary.remainingCost }) +
      metric('最终市值（元）', { text: formatNumber(summary.marketValue), raw: summary.marketValue }) +
      '<div class="metric"><span>持有收益</span><strong class="' + valueClass(summary.holdingProfit) + '">' + formatNumber(summary.holdingProfit, true) + '</strong><small>' + rateDetail(summary.holdingReturn, summary.holdingAnnualizedReturn) + '</small></div>' +
      '<div class="metric primary-metric"><span>整体收益（含赎回）</span><strong class="' + valueClass(summary.totalProfit) + '">' + formatNumber(summary.totalProfit, true) + '</strong><small>' + rateDetail(summary.totalReturn, summary.totalAnnualizedReturn) + '</small></div>';
  }

  function renderTrades() {
    var filter = $('tradeFilter').value;
    var trades = state.result ? state.result.trades.slice() : [];
    trades.sort(function (a, b) {
      var aDate = a.date || a.scheduledDate || a.triggerDate || '';
      var bDate = b.date || b.scheduledDate || b.triggerDate || '';
      return aDate.localeCompare(bDate) || Number(a.id.slice(1)) - Number(b.id.slice(1));
    });
    var filtered = trades.filter(function (trade) {
      if (filter === 'buy' || filter === 'sell') return trade.type === filter;
      if (filter === 'issue') return trade.status !== 'filled';
      return true;
    });
    $('tradeCount').textContent = filtered.length + ' / ' + trades.length + ' 笔记录';
    if (!filtered.length) {
      $('tradeRows').innerHTML = '<tr><td colspan="8" class="empty-cell">暂无匹配记录</td></tr>';
      return;
    }
    var statusLabels = { filled: '成交', partial: '部分成交', unfilled: '未成交', cancelled: '已取消' };
    $('tradeRows').innerHTML = filtered.map(function (trade) {
      var isBuy = trade.type === 'buy';
      var kind = isBuy ? '定投买入' : (trade.direction === 'up' ? '纪律卖出 · 向上' : '纪律卖出 · 向下');
      var detail = isBuy ? trade.planId : tradeDescription(trade);
      var scheduled = isBuy ? trade.scheduledDate : trade.triggerDate;
      return '<tr>' +
        '<td data-label="状态"><span class="status-badge ' + trade.status + '">' + statusLabels[trade.status] + '</span></td>' +
        '<td data-label="类型 / 纪律"><span class="trade-kind">' + kind + '</span><small class="trade-detail">' + escapeHTML(detail) + '</small></td>' +
        '<td data-label="计划 / 触发日" class="mono">' + escapeHTML(scheduled) + '</td>' +
        '<td data-label="成交日" class="mono">' + escapeHTML(trade.date || '—') + '</td>' +
        '<td data-label="价格" class="numeric">' + (trade.price == null ? '—' : formatNumber(trade.price)) + '</td>' +
        '<td data-label="等效份额" class="numeric">' + shareFormatter.format(trade.shares || 0) + '</td>' +
        '<td data-label="金额（元）" class="numeric">' + formatNumber(trade.amount) + '</td>' +
        '<td data-label="未成交原因" class="trade-reason">' + escapeHTML(trade.reason || '—') + '</td></tr>';
    }).join('');
  }

  function runSimulation(event) {
    event.preventDefault();
    if (state.running) return;
    $('configError').hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('.invalid'), function (field) { field.classList.remove('invalid'); });
    if (!state.product || !state.quotes.length) {
      $('configError').textContent = '请先选择产品并成功加载历史行情';
      $('configError').hidden = false;
      return;
    }
    var id = ++state.runSequence;
    setRunning(true);
    try {
      if (!state.simulationWorker) {
        state.simulationWorker = new Worker('simulation-worker.js');
        state.simulationWorker.onmessage = function (message) {
          finishSimulation(message.data.id, message.data.result, message.data.error);
        };
        state.simulationWorker.onerror = function () {
          cancelSimulation();
          finishSimulation(state.runSequence, null, { message: '计算线程启动失败，请通过本地 HTTP 服务打开页面后重试' });
        };
      }
      state.simulationWorker.postMessage({
        id: id, quotes: state.quotes, product: state.product, config: readConfig()
      });
    } catch (error) {
      cancelSimulation();
      finishSimulation(state.runSequence, null, { message: error.message || '计算线程启动失败，请重试' });
    }
  }

  $('productSearch').addEventListener('input', function () {
    $('clearSearch').hidden = !this.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(searchProducts, 280);
  });
  $('productSearch').addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!state.searchResults.length) return;
      event.preventDefault();
      var delta = event.key === 'ArrowDown' ? 1 : -1;
      state.activeResult = (state.activeResult + delta + state.searchResults.length) % state.searchResults.length;
      renderSearchResults();
    } else if (event.key === 'Enter' && state.activeResult >= 0) {
      event.preventDefault();
      selectProduct(state.searchResults[state.activeResult]);
    } else if (event.key === 'Escape') {
      closeSearch();
    }
  });
  $('searchResults').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-index]');
    if (button) selectProduct(state.searchResults[Number(button.dataset.index)]);
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.search-wrap')) closeSearch();
  });
  $('clearSearch').addEventListener('click', function () {
    ++state.searchToken;
    $('productSearch').value = '';
    this.hidden = true;
    state.searchResults = [];
    closeSearch();
    setSearchStatus('');
    $('productSearch').focus();
  });
  document.querySelectorAll('[data-scope]').forEach(function (button) {
    button.addEventListener('click', function () {
      state.scope = this.dataset.scope;
      document.querySelectorAll('[data-scope]').forEach(function (item) {
        var active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      if ($('productSearch').value.trim()) searchProducts();
    });
  });

  $('addRule').addEventListener('click', function () {
    var id = 'D' + (++state.ruleSequence);
    state.rules.push({ id: id, direction: 'up', threshold: '10', sellPercent: '50' });
    renderRules();
    var card = document.querySelector('[data-rule-id="' + id + '"] select');
    if (card) card.focus();
  });
  $('disciplineList').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var card = button.closest('[data-rule-id]');
    var index = state.rules.findIndex(function (rule) { return rule.id === card.dataset.ruleId; });
    if (index < 0) return;
    if (button.dataset.action === 'delete') state.rules.splice(index, 1);
    if (button.dataset.action === 'move-up' && index > 0) {
      state.rules.splice(index - 1, 0, state.rules.splice(index, 1)[0]);
    }
    if (button.dataset.action === 'move-down' && index < state.rules.length - 1) {
      state.rules.splice(index + 1, 0, state.rules.splice(index, 1)[0]);
    }
    renderRules();
  });
  $('disciplineList').addEventListener('input', function (event) {
    var field = event.target.dataset.field;
    var card = event.target.closest('[data-rule-id]');
    if (!field || !card) return;
    var rule = state.rules.find(function (item) { return item.id === card.dataset.ruleId; });
    if (!rule) return;
    rule[field] = event.target.value;
    event.target.classList.remove('invalid');
    if (field === 'direction') {
      card.classList.toggle('up', rule.direction === 'up');
      card.classList.toggle('down', rule.direction === 'down');
      var index = state.rules.indexOf(rule);
      card.querySelector('.rule-name').textContent = '纪律 ' + String(index + 1).padStart(2, '0') +
        ' · ' + (rule.direction === 'up' ? '向上越过' : '向下越过');
    }
  });

  $('simulatorForm').addEventListener('submit', function (event) { event.preventDefault(); });
  $('runSimulation').addEventListener('click', runSimulation);
  $('simulatorForm').addEventListener('input', function (event) {
    event.target.classList.remove('invalid');
    $('configError').hidden = true;
    if (event.target.id === 'startDate' || event.target.id === 'holdingMonths') updateEndDate();
  });
  $('tradeFilter').addEventListener('change', renderTrades);
  $('showFullHistory').addEventListener('click', function () { renderPriceChart(false); });
  $('reloadHistory').addEventListener('click', function () { loadHistory(false); });
  $('retryLoad').addEventListener('click', function () { loadHistory(false); });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.priceChart) state.priceChart.resize();
      if (state.returnChart) state.returnChart.resize();
    }, 120);
  });
  window.addEventListener('lucide-ready', refreshIcons);
  window.addEventListener('charts-ready', function () {
    if (state.quotes.length) renderPriceChart(Boolean(state.result));
    if (state.result) renderReturnChart();
  });

  renderRules();
  updateEndDate();
  refreshIcons();
})();
