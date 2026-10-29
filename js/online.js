/* ==========================================================================
 * 《奶娃》在线排行榜（无账号轻量后端）
 * 方案：使用 ntfy.sh 公共 topic 的消息缓存作为「最近 12 小时成绩墙」，
 *      客户端拉取最近消息并聚合（每个玩家保留最高分），排行榜打开时轮询刷新。
 * 断网 / 服务异常时自动回退到本地榜单（由 ui.js 处理）。
 * 对外 API：NW.online
 *   O.enabled            bool
 *   O.state              'idle'|'loading'|'ready'|'empty'|'error'
 *   O.updatedAt          number  (ms)
 *   O.fetch(mode, force) -> Promise<entries>
 *   O.submit(mode, score) -> Promise<bool>
 *   O.getRows(mode)      -> entries（已排序：{name, score, mode, time, tag, self}）
 *   O.prefetch()         预热拉取
 *   O.statusText()       给 UI 的状态文案
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG;
  var S = NW.save;
  var cfg = CFG.online || {};
  var O = (NW.online = {});

  /* 在线榜单开关：
   * - 配置启用才开启
   * - file:// 离线打开（本地单文件版 / 自动化测试）默认关闭，避免误投稿污染线上榜单；
   * - 可通过 URL 参数 &online=0 强制关闭，&online=1 在 http(s) 下强制开启。 */
  var queryOn = null;
  try {
    var qs = String((global.location && global.location.search) || '');
    if (/[?&]online=0(?:&|$)/.test(qs)) queryOn = false;
    else if (/[?&]online=1(?:&|$)/.test(qs)) queryOn = true;
  } catch (e0) { queryOn = null; }
  var isFile = false;
  try { isFile = String((global.location && global.location.protocol) || '') === 'file:'; } catch (e1) { isFile = false; }
  O.enabled = !!(cfg.enabled && cfg.topic && global.fetch) && (queryOn === true || (!isFile && queryOn !== false));
  O.state = 'idle';
  O.updatedAt = 0;
  O.error = '';
  O.rows = { endless: [], sprint: [] };
  O.rawCount = 0;

  var inflight = null;
  var lastFetchAt = 0;
  var lastSubmitAt = 0;

  function baseUrl() {
    var server = String(cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
    return server + '/' + encodeURIComponent(cfg.topic);
  }

  function cleanName(n) {
    var s = String(n == null ? '' : n).replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim();
    if (!s) s = '奶娃玩家';
    if (s.length > 12) s = s.slice(0, 12);
    return s;
  }

  function fetchWithTimeout(url, opts) {
    var timeout = cfg.timeoutMs || 6000;
    if (typeof global.AbortController === 'function') {
      var ctrl = new global.AbortController();
      var timer = global.setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, timeout);
      var o = opts || {};
      o.signal = ctrl.signal;
      return global.fetch(url, o).then(function (r) {
        global.clearTimeout(timer);
        return r;
      }, function (e) {
        global.clearTimeout(timer);
        throw e;
      });
    }
    return global.fetch(url, opts || {});
  }

  /** 单条消息数据校验（防脏数据/超大分数/过期） */
  function validEntry(d) {
    if (!d || typeof d !== 'object') return null;
    var score = Number(d.s);
    if (!isFinite(score) || score < 1 || score > (cfg.maxScore || 300000)) return null;
    var mode = d.m === 'sprint' ? 'sprint' : (d.m === 'endless' ? 'endless' : '');
    if (!mode) return null;
    var time = Number(d.t);
    var now = Date.now();
    if (!isFinite(time) || time > now + 10 * 60 * 1000 || time < now - 13 * 3600 * 1000) return null;
    var tag = (typeof d.tag === 'string' && /^[a-z0-9]{4,10}$/.test(d.tag)) ? d.tag : '';
    return { name: cleanName(d.n), score: Math.round(score), mode: mode, time: time, tag: tag };
  }

  function parseMessages(text) {
    if (!text) return [];
    var lines = String(text).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      try {
        var ev = JSON.parse(line);
        if (!ev || ev.event !== 'message') continue;
        var data = null;
        try { data = JSON.parse(ev.message); } catch (e) { continue; }
        var entry = validEntry(data);
        if (entry) out.push(entry);
      } catch (e2) { /* 忽略坏行 */ }
    }
    return out;
  }

  /** 每个玩家（tag 优先，否则昵称）只保留最高分，按分数排序 */
  function aggregate(rawEntries) {
    var best = {};
    for (var i = 0; i < rawEntries.length; i++) {
      var e = rawEntries[i];
      var key = e.tag ? ('tag:' + e.tag) : ('name:' + e.name);
      var cur = best[key];
      if (!cur || e.score > cur.score || (e.score === cur.score && e.time > cur.time)) best[key] = e;
    }
    var endless = [], sprint = [];
    for (var k in best) {
      if (!Object.prototype.hasOwnProperty.call(best, k)) continue;
      var item = {
        name: best[k].name,
        score: best[k].score,
        mode: best[k].mode,
        time: best[k].time,
        tag: best[k].tag,
        self: !!(best[k].tag && (S && S.playerTag) && best[k].tag === S.playerTag()),
        online: true
      };
      if (best[k].mode === 'sprint') sprint.push(item); else endless.push(item);
    }
    function byScore(a, b) { return b.score - a.score; }
    endless.sort(byScore);
    sprint.sort(byScore);
    O.rows.endless = endless;
    O.rows.sprint = sprint;
    O.rawCount = rawEntries.length;
  }

  O.fetch = function (mode, force) {
    var m = mode === 'sprint' ? 'sprint' : 'endless';
    if (!O.enabled) return Promise.resolve([]);
    if (inflight) return inflight.then(function () { return O.rows[m]; });
    if (!force && Date.now() - lastFetchAt < 3000) return Promise.resolve(O.rows[m]);
    O.state = 'loading';
    var url = baseUrl() + '/json?poll=1&since=' + encodeURIComponent(cfg.since || '12h') + '&_=' + Date.now();
    inflight = fetchWithTimeout(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        aggregate(parseMessages(text));
        O.state = O.rawCount > 0 ? 'ready' : 'empty';
        O.updatedAt = Date.now();
        O.error = '';
        lastFetchAt = Date.now();
        return O.rows[m];
      })
      .catch(function (err) {
        O.state = 'error';
        O.error = String((err && err.message) || err || 'network');
        return O.rows[m];
      })
      .then(function (rows) { inflight = null; return rows; }, function () { inflight = null; return O.rows[m]; });
    return inflight;
  };

  O.submit = function (mode, score) {
    if (!O.enabled) return Promise.resolve(false);
    var s = Math.round(Number(score) || 0);
    if (!(s > 0) || s > (cfg.maxScore || 300000)) return Promise.resolve(false);
    var now = Date.now();
    if (now - lastSubmitAt < (cfg.submitCooldownMs || 6000)) return Promise.resolve(false);
    lastSubmitAt = now;
    var payload = {
      n: cleanName(S && S.nickname ? S.nickname() : '奶娃玩家'),
      s: s,
      m: mode === 'sprint' ? 'sprint' : 'endless',
      t: now,
      tag: (S && S.playerTag ? S.playerTag() : '') || 'anon000',
      v: 1
    };
    return fetchWithTimeout(baseUrl(), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload)
    }).then(function (res) { return !!res.ok; }).catch(function () { return false; });
  };

  O.getRows = function (mode) {
    return O.rows[mode === 'sprint' ? 'sprint' : 'endless'] || [];
  };

  O.prefetch = function () {
    if (!O.enabled) return;
    O.fetch('endless', true).catch(function () { });
  };

  O.statusText = function () {
    if (!O.enabled) return '本地榜单 · 挑战最高分';
    if (O.state === 'loading') return '在线榜单同步中…';
    if (O.state === 'ready') {
      var d = new Date(O.updatedAt);
      var hh = ('0' + d.getHours()).slice(-2);
      var mm = ('0' + d.getMinutes()).slice(-2);
      var ss = ('0' + d.getSeconds()).slice(-2);
      return '在线实时榜 · ' + (O.rawCount || 0) + ' 条成绩 · ' + hh + ':' + mm + ':' + ss + ' 更新';
    }
    if (O.state === 'empty') return '在线实时榜 · 暂无成绩，跑一局上榜';
    return '本地榜单 · 在线服务暂不可用';
  };

  O.isLive = function () { return O.state === 'ready' || O.state === 'loading'; };
})(typeof window !== 'undefined' ? window : globalThis);
