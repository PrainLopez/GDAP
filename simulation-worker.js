/* global importScripts, DisciplineEngine */
'use strict';

importScripts('engine.js');

self.onmessage = function (event) {
  var payload = event.data;
  try {
    var result = DisciplineEngine.simulate(payload.quotes, payload.product, payload.config);
    self.postMessage({ id: payload.id, result: result });
  } catch (error) {
    self.postMessage({
      id: payload.id,
      error: { message: error.message || '计算失败，请检查配置', field: error.field || '' }
    });
  }
};
