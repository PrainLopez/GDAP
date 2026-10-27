(function (root) {
  'use strict';

  var SEARCH_URL = 'https://searchapi.eastmoney.com/api/suggest/get';
  var KLINE_HOSTS = ['push2his.eastmoney.com', '33.push2his.eastmoney.com', '82.push2his.eastmoney.com'];
  var FUND_CATALOG_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';
  var requestSequence = 0;
  var catalogPromise = null;

  function DataError(message, code) {
    this.name = 'DataError';
    this.message = message;
    this.code = code || 'DATA_ERROR';
    if (Error.captureStackTrace) Error.captureStackTrace(this, DataError);
  }
  DataError.prototype = Object.create(Error.prototype);
  DataError.prototype.constructor = DataError;

  function jsonp(url, params, timeout) {
    return new Promise(function (resolve, reject) {
      var callback = '__gdapJsonp' + (++requestSequence) + '_' + Date.now();
      var script = document.createElement('script');
      var settled = false;
      var timer = setTimeout(function () {
        finish(new DataError('数据接口响应超时，请检查网络后重试', 'TIMEOUT'));
      }, timeout || 15000);

      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.remove();
        try { delete root[callback]; } catch (ignore) { root[callback] = undefined; }
        if (error) reject(error);
        else resolve(value);
      }

      root[callback] = function (payload) { finish(null, payload); };
      script.onerror = function () {
        finish(new DataError('数据接口加载失败，请检查网络、广告拦截设置后重试', 'NETWORK'));
      };
      script.src = url + '?' + Object.keys(params).map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      }).join('&') + '&cb=' + callback;
      document.head.appendChild(script);
    });
  }

  function loadScript(url, timeout) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var settled = false;
      var timer = setTimeout(function () {
        finish(new DataError('基金数据响应超时，请检查网络后重试', 'TIMEOUT'));
      }, timeout || 20000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.remove();
        if (error) reject(error);
        else resolve();
      }
      script.onload = function () { finish(); };
      script.onerror = function () {
        finish(new DataError('基金数据加载失败，请检查网络、广告拦截设置后重试', 'NETWORK'));
      };
      script.src = url;
      document.head.appendChild(script);
    });
  }

  function detectRule(product) {
    var name = String(product.name || '').toUpperCase();
    var category = String(product.category || '').toUpperCase();
    var text = name + ' ' + category;
    var exchange = product.type !== 'otc-fund';
    var qdii = /QDII|合格境内机构投资者/.test(text);
    var bond = /债券|转债|国债|政金债|信用债|可转债/.test(text);
    var gold = /黄金/.test(text);
    var money = /货币|现金添利|保证金/.test(text);
    var crossBorder = /QDII|恒生|H股|港股|纳斯达克|纳指|标普|道琼斯|德国|法国|日经|日本|中概|海外|全球|亚太|沙特|东南亚|美国| MSCI/.test(text);

    if (exchange && (bond || gold || money || crossBorder)) {
      var labels = [];
      if (bond) labels.push('债券');
      if (gold) labels.push('黄金');
      if (money) labels.push('货币');
      if (crossBorder) labels.push('跨境');
      return {
        settlementDays: 0,
        label: 'T+0',
        reason: '识别为' + labels.join('、') + '场内产品，新份额当日可卖'
      };
    }
    if (qdii) {
      return { settlementDays: 2, label: 'T+2', reason: '识别为 QDII，新份额两个行情日后可卖' };
    }
    return { settlementDays: 1, label: 'T+1', reason: '普通产品，新份额下一行情日可卖' };
  }

  function typeLabel(type) {
    if (type === 'stock') return '沪深京 A 股';
    if (type === 'exchange-fund') return '场内基金';
    return '场外公募基金';
  }

  function normalizeExchange(item) {
    var isStock = item.Classify === 'AStock';
    var isFund = item.Classify === 'Fund' && item.QuoteID;
    if ((!isStock && !isFund) || !item.Code || !item.Name || !item.QuoteID) return null;
    var product = {
      id: 'EM:' + item.QuoteID,
      code: item.Code,
      name: item.Name,
      pinyin: item.PinYin || '',
      quoteId: item.QuoteID,
      market: item.SecurityTypeName || '',
      type: isStock ? 'stock' : 'exchange-fund',
      typeLabel: typeLabel(isStock ? 'stock' : 'exchange-fund')
    };
    product.rule = detectRule(product);
    product.settlementDays = product.rule.settlementDays;
    return product;
  }

  function searchExchange(query) {
    return jsonp(SEARCH_URL, {
      input: query,
      type: 14,
      token: 'D43BF722C8E33BDC906FB84D85E326E8',
      count: 30
    }).then(function (payload) {
      var table = payload && payload.QuotationCodeTable;
      if (!table || !Array.isArray(table.Data)) {
        throw new DataError('搜索接口返回格式变化，请稍后重试或改用基金代码搜索', 'BAD_RESPONSE');
      }
      return table.Data.map(normalizeExchange).filter(Boolean).slice(0, 20);
    });
  }

  function getFundCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = loadScript(FUND_CATALOG_URL).then(function () {
      if (!Array.isArray(root.r)) {
        throw new DataError('基金目录格式变化，请稍后重试或直接搜索股票、场内基金', 'BAD_RESPONSE');
      }
      return root.r.map(function (row) {
        var product = {
          id: 'OF:' + row[0],
          code: row[0],
          pinyin: (row[1] || '') + ' ' + (row[4] || ''),
          name: row[2],
          category: row[3] || '',
          type: 'otc-fund',
          typeLabel: typeLabel('otc-fund')
        };
        product.rule = detectRule(product);
        product.settlementDays = product.rule.settlementDays;
        return product;
      });
    }).catch(function (error) {
      catalogPromise = null;
      throw error;
    });
    return catalogPromise;
  }

  function searchFunds(query) {
    var normalized = query.toLowerCase().replace(/\s+/g, '');
    return getFundCatalog().then(function (catalog) {
      return catalog.map(function (product) {
        var code = product.code.toLowerCase();
        var name = product.name.toLowerCase();
        var pinyin = product.pinyin.toLowerCase().replace(/\s+/g, '');
        var score = -1;
        if (code === normalized) score = 0;
        else if (name === normalized) score = 1;
        else if (code.indexOf(normalized) === 0) score = 2;
        else if (name.indexOf(normalized) === 0) score = 3;
        else if (pinyin.indexOf(normalized) === 0) score = 4;
        else if (code.indexOf(normalized) >= 0 || name.indexOf(normalized) >= 0) score = 5;
        else if (pinyin.indexOf(normalized) >= 0) score = 6;
        return { product: product, score: score };
      }).filter(function (entry) {
        return entry.score >= 0;
      }).sort(function (a, b) {
        return a.score - b.score || a.product.code.localeCompare(b.product.code);
      }).slice(0, 20).map(function (entry) { return entry.product; });
    });
  }

  function parseKlines(payload) {
    var data = payload && payload.data;
    if (!data || !Array.isArray(data.klines)) {
      throw new DataError('该产品没有可用日 K 历史，或接口暂不支持', 'NO_HISTORY');
    }
    var quotes = data.klines.map(function (line) {
      var cells = line.split(',');
      return {
        date: cells[0],
        open: Number(cells[1]),
        close: Number(cells[2]),
        high: Number(cells[3]),
        low: Number(cells[4])
      };
    }).filter(function (quote) {
      return /^\d{4}-\d{2}-\d{2}$/.test(quote.date) &&
        ['open', 'high', 'low', 'close'].every(function (key) {
          return Number.isFinite(quote[key]) && quote[key] > 0;
        });
    });
    if (!quotes.length) throw new DataError('该产品历史行情为空，无法模拟', 'NO_HISTORY');
    return quotes;
  }

  function fetchJSON(url, timeout) {
    return new Promise(function (resolve, reject) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new DataError('备用行情接口响应超时', 'TIMEOUT'));
      }, timeout || 20000);
      fetch(url, controller ? { signal: controller.signal } : undefined).then(function (response) {
        if (!response.ok) {
          throw new DataError('备用行情接口返回 ' + response.status, 'NETWORK');
        }
        return response.json();
      }).then(function (payload) {
        clearTimeout(timer);
        resolve(payload);
      }).catch(function (error) {
        clearTimeout(timer);
        reject(error instanceof DataError ? error : new DataError('备用行情接口加载失败，请检查网络或拦截设置', 'NETWORK'));
      });
    });
  }

  function parseTencentKlines(payload, symbol) {
    var rows = payload && payload.data && payload.data[symbol];
    rows = rows && (rows.qfqday || rows.day);
    if (!Array.isArray(rows)) return [];
    return rows.map(function (cells) {
      return {
        date: cells[0],
        open: Number(cells[1]),
        close: Number(cells[2]),
        high: Number(cells[3]),
        low: Number(cells[4])
      };
    }).filter(function (quote) {
      return /^\d{4}-\d{2}-\d{2}$/.test(quote.date) &&
        ['open', 'high', 'low', 'close'].every(function (key) {
          return Number.isFinite(quote[key]) && quote[key] > 0;
        });
    });
  }

  function addCalendarDays(value, days) {
    var parts = value.split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days)).toISOString().slice(0, 10);
  }

  function loadTencentHistory(product) {
    if (!product.quoteId) {
      return Promise.reject(new DataError('当前产品缺少交易所代码，不支持备用日 K 接口', 'NO_HISTORY'));
    }
    var symbol = (product.quoteId.charAt(0) === '1' ? 'sh' : 'sz') + product.code;
    var byDate = Object.create(null);
    var nextEnd = '2030-01-01';
    var previousEnd = '';
    var pageCount = 0;

    function mergeQuotes() {
      return Object.keys(byDate).sort().map(function (date) { return byDate[date]; });
    }

    function nextPage() {
      if (pageCount >= 25) return mergeQuotes();
      pageCount += 1;
      var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol +
        ',day,1990-01-01,' + nextEnd + ',1000,qfq';
      return fetchJSON(url).then(function (payload) {
        var quotes = parseTencentKlines(payload, symbol);
        var before = Object.keys(byDate).length;
        quotes.forEach(function (quote) {
          byDate[quote.date] = quote;
        });
        var earliest = quotes.length ? quotes[0].date : '';
        if (!quotes.length || Object.keys(byDate).length === before) return mergeQuotes();
        nextEnd = addCalendarDays(earliest, -1);
        if (nextEnd === previousEnd) return mergeQuotes();
        previousEnd = nextEnd;
        return nextPage();
      });
    }

    return nextPage().then(function (quotes) {
      if (!quotes.length) throw new DataError('备用接口没有该产品日 K 历史', 'NO_HISTORY');
      return quotes;
    }).catch(function (error) {
      throw new DataError('东财历史接口失败，备用接口(' + symbol + ')读取失败：' +
        (error.message || '未知错误'), error.code || 'NETWORK');
    });
  }

  function loadExchangeHistory(product) {
    var lastError;
    var chain = Promise.resolve(null);
    KLINE_HOSTS.forEach(function (host) {
      chain = chain.then(function (quotes) {
        if (quotes) return quotes;
        return jsonp('https://' + host + '/api/qt/stock/kline/get', {
          secid: product.quoteId,
          ut: 'fa5fd1943c7b386f172d6893dbfba10b',
          fields1: 'f1,f2,f3,f4,f5,f6',
          fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
          klt: 101,
          fqt: 2,
          beg: 0,
          end: 20500101,
          lmt: 1000000
        }, 18000).then(parseKlines).catch(function (error) {
          lastError = error;
          return null;
        });
      });
    });
    return chain.then(function (quotes) {
      if (quotes) return quotes;
      return loadTencentHistory(product).catch(function (fallbackError) {
        throw new DataError('东财历史接口失败，备用接口读取失败：' + fallbackError.message,
          fallbackError.code || 'NETWORK');
      });
    });
  }

  function loadFundHistory(product) {
    root.Data_netWorthTrend = undefined;
    root.fS_code = undefined;
    return loadScript('https://fund.eastmoney.com/pingzhongdata/' +
      encodeURIComponent(product.code) + '.js?v=' + Date.now()).then(function () {
        var trend = root.Data_netWorthTrend;
        if (root.fS_code !== product.code || !Array.isArray(trend) || !trend.length) {
          throw new DataError('该基金没有可用历史净值，可能已清算或接口暂不支持', 'NO_HISTORY');
        }
        var adjusted = null;
        var previousRaw = null;
        var quotes = trend.map(function (point) {
          var raw = Number(point.y);
          if (!Number.isFinite(point.x) || !Number.isFinite(raw) || raw <= 0) return null;
          var date = new Date(point.x).toISOString().slice(0, 10);
          if (adjusted === null) adjusted = raw;
          else {
            var reported = Number(point.equityReturn);
            var dailyReturn = Number.isFinite(reported) ? reported / 100 : raw / previousRaw - 1;
            adjusted *= 1 + dailyReturn;
          }
          previousRaw = raw;
          if (!Number.isFinite(adjusted) || adjusted <= 0) return null;
          return { date: date, open: adjusted, high: adjusted, low: adjusted, close: adjusted };
        }).filter(Boolean);
        if (!quotes.length) throw new DataError('该基金历史净值为空，无法模拟', 'NO_HISTORY');
        return quotes;
      });
  }

  function loadHistory(product) {
    return product.type === 'otc-fund' ? loadFundHistory(product) : loadExchangeHistory(product);
  }

  root.MarketData = {
    searchExchange: searchExchange,
    searchFunds: searchFunds,
    loadHistory: loadHistory,
    detectRule: detectRule,
    typeLabel: typeLabel,
    DataError: DataError
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
