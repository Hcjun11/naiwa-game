/* ==========================================================================
 * 《奶娃》通用工具库
 * 经典脚本：挂载到 window.NW.util，同时兼容 Node（globalThis.NW.util）
 * 规则：纯函数尽量无副作用；DOM / localStorage / audio 相关必须 try/catch 降级
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG;
  var U = (NW.util = {});

  /* ---------------- 数学 / 缓动 ---------------- */
  U.clamp = function (v, min, max) { return v < min ? min : (v > max ? max : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.invLerp = function (a, b, v) { return a === b ? 0 : (v - a) / (b - a); };
  U.remap = function (v, a, b, c, d) { return c + (d - c) * U.clamp(U.invLerp(a, b, v), 0, 1); };
  U.damp = function (cur, target, lambda, dt) {
    return U.lerp(cur, target, 1 - Math.exp(-lambda * dt));
  };
  U.easeInQuad = function (t) { return t * t; };
  U.easeOutQuad = function (t) { return t * (2 - t); };
  U.easeInOutQuad = function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; };
  U.easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };
  U.easeInOutCubic = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  U.easeOutBack = function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  U.easeOutElastic = function (t) {
    if (t <= 0) return 0; if (t >= 1) return 1;
    var c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  };
  U.pulse = function (t, freq, phase) { return 0.5 + 0.5 * Math.sin((t * (freq || 1) + (phase || 0)) * Math.PI * 2); };

  /* ---------------- 随机 ---------------- */
  U.mulberry32 = function (seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  U.rand = function (rng, a, b) {
    if (a === undefined) { a = 0; b = 1; }
    return a + (rng ? rng() : Math.random()) * (b - a);
  };
  U.randInt = function (rng, a, b) { return Math.floor(U.rand(rng, a, b + 1)); };
  U.chance = function (p, rng) { return (rng ? rng() : Math.random()) < p; };
  U.pick = function (arr, rng) { return arr[Math.floor((rng ? rng() : Math.random()) * arr.length)]; };
  U.shuffle = function (arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  };
  U.weightedPick = function (table, rng) {
    var total = 0, i;
    for (i = 0; i < table.length; i++) total += table[i][1];
    var r = (rng ? rng() : Math.random()) * total;
    for (i = 0; i < table.length; i++) {
      r -= table[i][1];
      if (r <= 0) return table[i][0];
    }
    return table[table.length - 1][0];
  };
  U.uid = (function () { var n = 0; return function (p) { n += 1; return (p || 'id') + n; }; })();

  /* ---------------- 格式化 ---------------- */
  U.formatScore = function (n) {
    n = Math.max(0, Math.round(n || 0));
    var s = String(n), out = '', c = 0, i;
    for (i = s.length - 1; i >= 0; i--) {
      out = s[i] + out; c++;
      if (c % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
  };
  U.formatTime = function (sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  };
  U.formatShort = function (n) {
    n = Math.max(0, n || 0);
    if (n >= 100000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return U.formatScore(n);
  };
  U.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  /* ---------------- 颜色 ---------------- */
  U.rgba = function (hex, alpha) {
    var h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var num = parseInt(h, 16);
    var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha === undefined ? 1 : alpha) + ')';
  };
  U.mix = function (hexA, hexB, t) {
    function parse(h) {
      h = String(h).replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    var a = parse(hexA), b = parse(hexB);
    var r = Math.round(a[0] + (b[0] - a[0]) * t);
    var g = Math.round(a[1] + (b[1] - a[1]) * t);
    var bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  };
  U.lighten = function (hex, t) { return U.mix(hex, '#FFFFFF', t); };
  U.darken = function (hex, t) { return U.mix(hex, '#000000', t); };

  /* ---------------- Canvas 绘制辅助 ---------------- */
  U.roundRectPath = function (ctx, x, y, w, h, r) {
    var rr = Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  };
  U.fillRoundRect = function (ctx, x, y, w, h, r, fill) {
    U.roundRectPath(ctx, x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; }
    ctx.fill();
  };
  U.strokeRoundRect = function (ctx, x, y, w, h, r, stroke, lw) {
    U.roundRectPath(ctx, x, y, w, h, r);
    if (stroke) ctx.strokeStyle = stroke;
    if (lw) ctx.lineWidth = lw;
    ctx.stroke();
  };
  U.fillEllipse = function (ctx, cx, cy, rx, ry, fill) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
    if (fill) ctx.fillStyle = fill;
    ctx.fill();
  };
  U.fillCircle = function (ctx, cx, cy, r, fill) {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.1, r), 0, Math.PI * 2);
    if (fill) ctx.fillStyle = fill;
    ctx.fill();
  };
  U.fillStar = function (ctx, cx, cy, outer, inner, points, rotation, fill) {
    var n = points || 5, i;
    ctx.beginPath();
    for (i = 0; i < n * 2; i++) {
      var ang = (i * Math.PI) / n + (rotation || 0);
      var rad = i % 2 === 0 ? outer : inner;
      var x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (fill) ctx.fillStyle = fill;
    ctx.fill();
  };
  U.text = function (ctx, str, x, y, opts) {
    opts = opts || {};
    ctx.save();
    ctx.font = (opts.weight || '700') + ' ' + (opts.size || 24) + 'px ' + (opts.font || CFG.fonts.ui);
    ctx.textAlign = opts.align || 'center';
    ctx.textBaseline = opts.baseline || 'middle';
    if (opts.shadow) {
      ctx.fillStyle = opts.shadow;
      ctx.fillText(str, x + (opts.shadowX || 0), y + (opts.shadowY || 3));
    }
    ctx.fillStyle = opts.color || '#fff';
    ctx.fillText(str, x, y);
    ctx.restore();
  };

  /* ---------------- 投影（伪 3D） ----------------
   * 世界坐标 -> 逻辑屏幕坐标（540×960）
   * @param x 横向、y 高度、z 前方；camX 相机横向偏移（默认 0）
   */
  U.project = function (x, y, z, camX) {
    var c = CFG.cam;
    var dz = z - c.camZ;
    if (dz < 0.35) dz = 0.35;
    var scale = c.f / dz;
    return {
      x: CFG.W / 2 + (x - (camX || 0)) * scale,
      y: c.horizonY + (c.camY - (y || 0)) * scale,
      scale: scale
    };
  };
  U.projectScale = function (z) {
    var dz = z - CFG.cam.camZ;
    if (dz < 0.35) dz = 0.35;
    return CFG.cam.f / dz;
  };

  /* ---------------- 时间 ---------------- */
  U.now = function () {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  };

  /* ---------------- 本地存储（安全降级） ---------------- */
  var memoryStore = {};
  U.storage = {
    get: function (key, fallback) {
      var raw = null;
      try {
        raw = global.localStorage ? global.localStorage.getItem(key) : memoryStore[key];
      } catch (e) {
        raw = memoryStore[key];
      }
      if (raw === null || raw === undefined) raw = memoryStore[key];
      if (raw === null || raw === undefined) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try {
        var raw = JSON.stringify(value);
        if (global.localStorage) global.localStorage.setItem(key, raw);
        else memoryStore[key] = raw;
        return true;
      } catch (e) {
        memoryStore[key] = JSON.stringify(value);
        return false;
      }
    },
    remove: function (key) {
      try {
        if (global.localStorage) global.localStorage.removeItem(key);
        delete memoryStore[key];
      } catch (e) { delete memoryStore[key]; }
    }
  };

  /* ---------------- 杂项 ---------------- */
  U.deepClone = function (obj) { return JSON.parse(JSON.stringify(obj)); };
  U.mergeDeep = function (target, source) {
    var out = target;
    for (var k in source) {
      if (!Object.prototype.hasOwnProperty.call(source, k)) continue;
      var sv = source[k];
      if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
        if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {};
        U.mergeDeep(out[k], sv);
      } else if (out[k] === undefined) {
        out[k] = Array.isArray(sv) ? sv.slice() : sv;
      }
    }
    return out;
  };
  U.vibrate = function (ms) {
    try { if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(ms); } catch (e) { }
  };
  U.loadImage = function (src, onload, onerror) {
    if (typeof global.Image === 'undefined') return null;
    var img = new global.Image();
    img.onload = function () { if (onload) onload(img); };
    img.onerror = function () { if (onerror) onerror(); };
    img.src = src;
    return img;
  };
  U.createCanvas = function (w, h) {
    var c = global.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  U.once = function (fn) {
    var done = false;
    return function () { if (done) return; done = true; return fn.apply(null, arguments); };
  };
  U.noop = function () { };
})(typeof window !== 'undefined' ? window : globalThis);
