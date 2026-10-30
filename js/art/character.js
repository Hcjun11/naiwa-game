/* ==========================================================================
 * 《奶娃》角色绘制 —— NW.art.Character（v0.9.2）
 * 负责人：character-art（队友 B）
 * --------------------------------------------------------------------------
 * 对外 API（SPEC 4.1，v0.9.2 保持不变）：
 *   NW.art.Character.draw(ctx, opts)
 *       opts: { x, y, h, state, t, skin, lean, alpha, blink, squash, face }
 *       x,y  角色脚底中心（逻辑坐标）      h    角色总高度 px（80~320）
 *       state 'idle'|'run'|'laugh'|'hit'|'happy'|'levelup'|'jump'|'slide'
 *       skin  CFG.skins 中的对象（5 套配色全支持）
 *       face  可选覆盖：'laugh'|'smile'|'wow'|'dizzy'|'star'|'jump'|'slide'
 *   NW.art.Character.drawShadow(ctx, x, y, rx, alpha)
 *
 * v0.9.2 改动：
 *   1) 形象更贴近参考图 assets/refs/ref_laugh.png / ref_idle.png：
 *      脸整体上移（大嘴占满头部上半部、几乎无额头）、梨形身体、奶油大肚皮、
 *      深褐短手短脚、闭眼笑弧+大张嘴、小腮红；
 *   2) 手臂改为「上臂藏身后 + 前臂/手掌贴肚皮」的分层画法，彻底去掉 U 形把手观感；
 *   3) 新增 state：jump（收腿/手臂上扬/身体拉长/兴奋张嘴）、
 *      slide（压低前倾/手臂后摆/眯眼专注）。
 *
 * 设计说明：
 *   - 纯 Canvas 2D 程序化绘制，无图片 / 字体 / 其他模块依赖（NW.util 缺失时降级）。
 *   - 内部「设计空间」：角色高 = 100 单位，y 向下，脚底中心 (0,100)，头顶 (0,0)。
 *     绘制时 scale(h/100)，因此任意 h 都保持比例清晰（游戏内 h≈181px）。
 *   - Path2D 形状缓存 + 按 ctx 缓存的 CanvasGradient，每帧 0 次 path/gradient 重建。
 *   - ctx.save()/restore() 严格成对，不污染外部状态。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = (global.NW = global.NW || {});
  var art = (NW.art = NW.art || {});
  var CFG = NW.CFG || {};
  var U = NW.util || null;

  /* ======================================================================
   * 0. 颜色工具（优先用 NW.util，缺失时本地降级）
   * ==================================================================== */
  function parseHex(hex) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /* 生成 rgba 颜色串：同时支持 #hex 与 mix()/lighten() 产出的 rgb()/rgba() 字符串 */
  function rgba(color, a) {
    a = (a === undefined || a === null) ? 1 : a;
    var s = String(color === undefined || color === null ? '#000000' : color).trim();
    if (s.charAt(0) === '#' || /^[0-9a-fA-F]{3,8}$/.test(s)) {
      if (U && U.rgba) return U.rgba(s.charAt(0) === '#' ? s : '#' + s, a);
      var p = parseHex(s);
      return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')';
    }
    var m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var parts = m[1].split(',');
      var r = Math.round(parseFloat(parts[0]) || 0);
      var g = Math.round(parseFloat(parts[1]) || 0);
      var b = Math.round(parseFloat(parts[2]) || 0);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return 'rgba(0,0,0,' + a + ')';
  }
  function mix(a, b, t) {
    if (U && U.mix) return U.mix(a, b, t);
    var A = parseHex(a), B = parseHex(b);
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * t) + ',' +
      Math.round(A[1] + (B[1] - A[1]) * t) + ',' +
      Math.round(A[2] + (B[2] - A[2]) * t) + ')';
  }
  function lighten(hex, t) { return mix(hex, '#FFFFFF', t); }
  function darken(hex, t) { return mix(hex, '#000000', t); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ======================================================================
   * 1. 设计空间几何常量（角色高 100，y 向下，脚底 = 100）
   * ==================================================================== */
  /* 梨形/蛋形身体：头窄、肚子最宽、底部收圆（对齐参考图比例） */
  var BODY_HALF = [
    [0, 0],
    [6.2, 0.3], [11.6, 2.9], [14.1, 7.4],
    [15.2, 12.2], [14.9, 17.4], [15.2, 22.4],
    [17.0, 27.2], [20.0, 31.8], [23.4, 38.4],
    [26.0, 45.4], [27.4, 53.2], [27.0, 60.8],
    [24.6, 67.2], [19.2, 71.2], [12.4, 72.9],
    [6.2, 73.4], [0, 73.6]
  ];
  /* 奶油大肚皮：占身体正面大部分 */
  var BELLY_HALF = [
    [0, 30.8], [8.0, 31.2], [14.6, 35.2], [17.0, 42.0],
    [18.0, 49.2], [17.6, 56.4], [15.4, 63.2], [11.8, 68.2],
    [6.8, 70.4], [0, 70.8]
  ];
  /* 深褐色短脚（正面看是圆润的脚掌 + 脚趾） */
  var FOOT_HALF = [
    [0, -5.0], [5.0, -4.8], [8.0, -2.2], [9.4, 1.8],
    [9.0, 5.8], [5.2, 7.6], [0, 7.8]
  ];

  function buildSymmetric(half) {
    var out = [], i;
    for (i = 0; i < half.length; i++) out.push([half[i][0], half[i][1]]);
    for (i = half.length - 2; i >= 1; i--) out.push([-half[i][0], half[i][1]]);
    return out;
  }
  var BODY_PTS = buildSymmetric(BODY_HALF);
  var BELLY_PTS = buildSymmetric(BELLY_HALF);
  var FOOT_PTS = buildSymmetric(FOOT_HALF);

  /* 面部横向定位（纵向由表情预设 EXPR 决定：大嘴脸在头顶、微笑脸靠下） */
  var FACE = {
    eyeX: 6.9,       /* 双眼中心 x（参考图眼睛靠中间） */
    cheekX: 10.2,    /* 腮红中心 x */
    cheekDrop: 2.8   /* 腮红相对嘴中心下移 */
  };

  /* ======================================================================
   * 2. 曲线 / 路径工具
   * ==================================================================== */
  function traceCurve(c, pts, closed) {
    var n = pts.length, i;
    if (n < 2) return;
    c.moveTo(pts[0][0], pts[0][1]);
    var segs = closed ? n : n - 1;
    for (i = 0; i < segs; i++) {
      var p0 = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      var p1 = pts[i];
      var p2 = pts[(i + 1) % n];
      var p3 = pts[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      c.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    }
    if (closed) c.closePath();
  }

  var _paths = null;
  function getPaths() {
    if (_paths) return _paths;
    var P = {};
    if (typeof Path2D !== 'undefined') {
      try {
        P.body = new Path2D(); traceCurve(P.body, BODY_PTS, true);
        P.belly = new Path2D(); traceCurve(P.belly, BELLY_PTS, true);
        P.foot = new Path2D(); traceCurve(P.foot, FOOT_PTS, true);
        P.laugh = makeMouthPath('laugh');
        P.o = makeMouthPath('o');
      } catch (e) { P = null; }
    } else { P = null; }
    _paths = P || false;
    return _paths || null;
  }

  /* 填充 / 裁剪：优先用缓存 Path2D，无 Path2D 环境时现场重建路径 */
  function fillBody(ctx, name, pts, style) {
    var P = getPaths();
    ctx.fillStyle = style;
    if (P && P[name]) { ctx.fill(P[name]); return; }
    ctx.beginPath(); traceCurve(ctx, pts, true); ctx.fill();
  }
  function clipBody(ctx, name, pts) {
    var P = getPaths();
    if (P && P[name]) { ctx.clip(P[name]); return; }
    ctx.beginPath(); traceCurve(ctx, pts, true); ctx.clip();
  }
  function fillMouth(ctx, name, kind, style) {
    var P = getPaths();
    ctx.fillStyle = style;
    if (P && P[name]) { ctx.fill(P[name]); return; }
    ctx.beginPath(); traceMouth(ctx, kind); ctx.fill();
  }
  function clipMouth(ctx, name, kind) {
    var P = getPaths();
    if (P && P[name]) { ctx.clip(P[name]); return; }
    ctx.beginPath(); traceMouth(ctx, kind); ctx.clip();
  }

  /* 嘴形（局部坐标，嘴中心 0,0；laugh 为基准大嘴，grin 用缩放复用） */
  function traceMouth(c, kind) {
    if (kind === 'laugh') {
      c.moveTo(-11.2, -3.4);
      c.bezierCurveTo(-6.8, -6.8, 6.8, -6.8, 11.2, -3.4);
      c.bezierCurveTo(12.6, 1.8, 8.2, 8.6, 0, 8.6);
      c.bezierCurveTo(-8.2, 8.6, -12.6, 1.8, -11.2, -3.4);
      c.closePath();
    } else if (kind === 'o') {
      c.moveTo(0, -4.4);
      c.bezierCurveTo(3.0, -4.4, 3.8, -1.7, 3.8, 0.2);
      c.bezierCurveTo(3.8, 2.9, 1.9, 4.4, 0, 4.4);
      c.bezierCurveTo(-1.9, 4.4, -3.8, 2.9, -3.8, 0.2);
      c.bezierCurveTo(-3.8, -1.7, -3.0, -4.4, 0, -4.4);
      c.closePath();
    } else { /* wavy */
      c.moveTo(-6.8, 0);
      c.bezierCurveTo(-4.6, -3.0, -2.3, 3.0, 0, 0);
      c.bezierCurveTo(2.3, -3.0, 4.6, 3.0, 6.8, 0);
      c.lineTo(6.8, 1.6);
      c.bezierCurveTo(4.6, 4.6, 2.3, -1.4, 0, 1.6);
      c.bezierCurveTo(-2.3, 4.6, -4.6, -1.4, -6.8, 1.6);
      c.closePath();
    }
  }
  function makeMouthPath(kind) {
    var p = new Path2D();
    traceMouth(p, kind);
    return p;
  }

  function rotVec(x, y, ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    return [x * c - y * s, x * s + y * c];
  }

  /* Catmull-Rom 均匀采样（手臂 / 腿这些弯曲软管用） */
  function catmullSamples(pts, total) {
    var n = pts.length, out = [], i, j;
    var segs = n - 1;
    var per = Math.max(3, Math.ceil(total / segs));
    for (i = 0; i < segs; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
      var p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
      for (j = 0; j < per; j++) {
        var t = j / per, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    out.push([pts[n - 1][0], pts[n - 1][1]]);
    return out;
  }

  /* 变宽软管（「胶囊链」画法）：逐段圆头描边，天然无自交 / 细线 artifacts */
  function strokeTaper(ctx, pts, widths, style) {
    var s = catmullSamples(pts, 18);
    var n = s.length, i;
    ctx.strokeStyle = style;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (i = 1; i < n; i++) {
      var u0 = ((i - 1) / (n - 1)) * (widths.length - 1);
      var u1 = (i / (n - 1)) * (widths.length - 1);
      var i0 = Math.floor(u0), i1 = Math.min(widths.length - 1, i0 + 1);
      var w0 = widths[i0] + (widths[i1] - widths[i0]) * (u0 - i0);
      i0 = Math.floor(u1); i1 = Math.min(widths.length - 1, i0 + 1);
      var w1 = widths[i0] + (widths[i1] - widths[i0]) * (u1 - i0);
      ctx.lineWidth = Math.max(0.4, (w0 + w1) * 0.5);
      ctx.beginPath();
      ctx.moveTo(s[i - 1][0], s[i - 1][1]);
      ctx.lineTo(s[i][0], s[i][1]);
      ctx.stroke();
    }
  }

  /* 单条平滑折线路径（给阴影 / 高光描边用，单次 stroke 保证 alpha 均匀） */
  function smoothPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    var i;
    for (i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i][0] + pts[i + 1][0]) / 2;
      var my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    var L = pts[pts.length - 1];
    ctx.lineTo(L[0], L[1]);
  }

  function offsetPts(pts, dx, dy) {
    var out = [], i;
    for (i = 0; i < pts.length; i++) out.push([pts[i][0] + dx, pts[i][1] + dy]);
    return out;
  }

  /* ======================================================================
   * 3. 渐变缓存（按 ctx + skin 缓存；坐标写死在设计空间，可跨帧复用）
   * ==================================================================== */
  function skinKey(skin) {
    if (skin.id) return String(skin.id);
    return 'c:' + skin.body + skin.belly + skin.limb + skin.mouth;
  }
  function gradCache(ctx) {
    var c = ctx.__nwCharGrads;
    if (!c) {
      c = {};
      try { ctx.__nwCharGrads = c; } catch (e) { return null; }
    }
    return c;
  }
  function ensureGrads(ctx) {
    var c = gradCache(ctx);
    return c || {};
  }
  function mkRadial(ctx, x0, y0, r0, x1, y1, r1, stops) {
    var g = ctx.createRadialGradient(x0, y0, Math.max(0.001, r0), x1, y1, Math.max(0.01, r1));
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }
  function mkLinear(ctx, x0, y0, x1, y1, stops) {
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }

  function sharedGrads(ctx) {
    var cache = ensureGrads(ctx);
    var G = cache.__shared;
    if (G) return G;
    G = {};
    /* 单位空间软阴影（配合 translate/scale 使用） */
    G.softShadow = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, 'rgba(92,52,20,0.34)'], [0.55, 'rgba(92,52,20,0.16)'], [1, 'rgba(92,52,20,0)']
    ]);
    G.spec = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.36)'], [1, 'rgba(255,255,255,0)']
    ]);
    /* 接触阴影核心（中心深、边缘透明） */
    G.coreDark = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, 'rgba(60,34,14,0.5)'], [0.55, 'rgba(60,34,14,0.2)'], [1, 'rgba(60,34,14,0)']
    ]);
    cache.__shared = G;
    return G;
  }

  function skinGrads(ctx, skin) {
    var cache = ensureGrads(ctx);
    var key = skinKey(skin);
    var G = cache[key];
    if (G) return G;
    G = {};

    var bodyHi = skin.bodyHi, body = skin.body, bodyShade = skin.bodyShade;
    var belly = skin.belly, bellyShade = skin.bellyShade;
    var limb = skin.limb, limbShade = skin.limbShade;
    var eye = skin.eye;
    /* 阴影统一用「暖棕」而不是直接压暗肤色（避免发绿/发灰） */
    var shadowTone = mix(darken(bodyShade, 0.18), '#7A4A12', 0.32);

    /* 身体主光（左上高光 → 右下阴影，球体感） */
    G.body = mkRadial(ctx, -9, 2, 2, -6, 22, 82, [
      [0, lighten(bodyHi, 0.5)],
      [0.2, bodyHi],
      [0.45, lighten(body, 0.12)],
      [0.68, body],
      [0.86, mix(body, bodyShade, 0.35)],
      [1, mix(body, bodyShade, 0.8)]
    ]);
    /* 身体底部压暗（很轻，避免肚皮下缘发灰） */
    G.bodyBottom = mkLinear(ctx, 0, 50, 0, 77, [
      [0, rgba(darken(bodyShade, 0.4), 0)],
      [0.6, rgba(darken(bodyShade, 0.35), 0.12)],
      [1, rgba(darken(bodyShade, 0.42), 0.26)]
    ]);
    /* 肚子（奶油）：中心亮 → 边缘柔化融入身体 */
    G.belly = mkRadial(ctx, -2.6, 42, 2, -0.5, 50, 27, [
      [0, lighten(belly, 0.34)],
      [0.38, belly],
      [0.72, bellyShade],
      [0.92, rgba(bellyShade, 0.93)],
      [1, rgba(bellyShade, 0.84)]
    ]);
    /* 左侧轮廓补光 */
    G.rim = mkLinear(ctx, -31, 20, -16, 25, [
      [0, rgba(lighten(bodyHi, 0.55), 0.5)],
      [0.6, rgba(lighten(bodyHi, 0.55), 0.14)],
      [1, rgba(lighten(bodyHi, 0.55), 0)]
    ]);
    /* 右侧暗边 */
    G.edge = mkLinear(ctx, 31, 24, 15, 30, [
      [0, rgba(darken(bodyShade, 0.3), 0.26)],
      [0.65, rgba(darken(bodyShade, 0.3), 0.08)],
      [1, rgba(darken(bodyShade, 0.3), 0)]
    ]);
    /* 头顶高光（大范围柔和，不要硬高光斑） */
    G.headHi = mkRadial(ctx, -6.0, 4.2, 1, -5.8, 5.2, 20.0, [
      [0, 'rgba(255,255,255,0.34)'],
      [0.45, 'rgba(255,255,255,0.15)'],
      [1, 'rgba(255,255,255,0)']
    ]);
    /* 手臂：左上→右下 的斜面打光（双臂共用） */
    G.arm = mkLinear(ctx, -26, 22, 22, 50, [
      [0, lighten(body, 0.16)],
      [0.3, body],
      [0.56, mix(body, bodyShade, 0.5)],
      [0.82, bodyShade],
      [1, darken(bodyShade, 0.14)]
    ]);
    /* 前臂：上亮下暗的圆柱光（贴在奶油肚皮上也有清晰轮廓） */
    G.forearm = mkLinear(ctx, 0, 36, 0, 52, [
      [0, lighten(body, 0.26)],
      [0.42, body],
      [0.78, mix(body, bodyShade, 0.62)],
      [1, darken(bodyShade, 0.08)]
    ]);
    /* 腿 */
    G.leg = mkLinear(ctx, 0, 62, 0, 95, [
      [0, mix(body, bodyShade, 0.05)],
      [0.42, body],
      [0.8, mix(body, bodyShade, 0.38)],
      [1, mix(bodyShade, shadowTone, 0.35)]
    ]);
    /* 肚子高光 */
    G.bellyHi = mkRadial(ctx, -4.5, 41, 0.5, -4.0, 43, 15, [
      [0, 'rgba(255,255,255,0.38)'],
      [0.5, 'rgba(255,255,255,0.10)'],
      [1, 'rgba(255,255,255,0)']
    ]);
    /* 脚（局部：原点在脚踝） */
    G.foot = mkLinear(ctx, 0, -6, 0, 9, [
      [0, lighten(limb, 0.2)],
      [0.42, limb],
      [1, darken(limbShade, 0.08)]
    ]);
    G.footHi = mkRadial(ctx, -1.8, -3.4, 0.3, -1.2, -3.2, 7.0, [
      [0, 'rgba(255,255,255,0.4)'],
      [1, 'rgba(255,255,255,0)']
    ]);
    /* 手（局部：原点在手心） */
    G.hand = mkRadial(ctx, -1.8, -2.4, 0.5, 0, 0.6, 8.8, [
      [0, lighten(limb, 0.34)],
      [0.42, limb],
      [1, darken(limbShade, 0.06)]
    ]);
    G.handHi = mkRadial(ctx, -1.5, -2.2, 0.3, -1.2, -2.0, 5.0, [
      [0, 'rgba(255,255,255,0.4)'],
      [1, 'rgba(255,255,255,0)']
    ]);
    /* 眼睛（局部：原点在眼心） */
    G.eye = mkRadial(ctx, -1.1, -1.5, 0.3, 0, 0, 5.2, [
      [0, mix(eye, '#FFFFFF', 0.4)],
      [0.4, eye],
      [0.82, darken(eye, 0.18)],
      [1, darken(eye, 0.42)]
    ]);
    /* 腮红（略明显但柔和扩散） */
    G.cheek = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(skin.cheek, 0.55)], [0.55, rgba(skin.cheek, 0.3)], [1, rgba(skin.cheek, 0)]
    ]);
    /* 嘴内阴影（局部） */
    G.throat = mkRadial(ctx, 0, -1, 0.5, 0, 2, 16, [
      [0, rgba(darken(skin.mouth, 0.45), 0.85)],
      [0.55, rgba(skin.mouth, 0.25)],
      [1, rgba(skin.mouth, 0)]
    ]);
    /* 升级光环 */
    G.aura = mkRadial(ctx, 0, 46, 4, 0, 46, 82, [
      [0, rgba(skin.accent, 0.4)],
      [0.55, rgba(skin.accent, 0.16)],
      [1, rgba(skin.accent, 0)]
    ]);
    /* 柔和褶皱 / 接触阴影（单位空间） */
    G.crease = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(darken(bodyShade, 0.5), 0.13)],
      [0.5, rgba(darken(bodyShade, 0.5), 0.06)],
      [1, rgba(darken(bodyShade, 0.5), 0)]
    ]);
    G.contactSoft = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(darken(bodyShade, 0.35), 0.13)],
      [0.55, rgba(darken(bodyShade, 0.35), 0.06)],
      [1, rgba(darken(bodyShade, 0.35), 0)]
    ]);

    /* ==================================================================
     * v0.9.3 —— 3D 体积光 / 材质分层（主光 + 环境光 + 轮廓光 + AO）
     * 全部由该 skin 的颜色字段派生，因此 5 套配色自动具备受光/背光/AO 三层
     * ================================================================== */
    /* ==================================================================
     * v0.9.3 —— 软胶 / 毛绒手办质感的体积光（严格保持肤色饱和度）
     * 受光面 = 肤色亮部(bodyHi 亮黄)，暗面 = 暖橙棕(bodyShade / darken)，
     * 只有「顶部小柔光 + 肚皮椭圆柔光 + 右下细轮廓光 + 局部接触 AO」，
     * 不做全图白/灰蒙层，也不做横贯式高光条（避免廉价塑料感）。
     * ================================================================== */
    /* 底部接地 AO（只压身体最下缘，暖棕半透明） */
    G.bodyAO = mkLinear(ctx, 0, 62, 0, 76, [
      [0, rgba(bodyShade, 0)],
      [0.55, rgba(bodyShade, 0.16)],
      [1, rgba(darken(bodyShade, 0.1), 0.32)]
    ]);
    /* 头顶右侧的球体暗部（让「头」读成球体而不是平面） */
    G.headRound = mkRadial(ctx, 14.5, 15.5, 2, 11.0, 13.0, 15.0, [
      [0, rgba(bodyShade, 0.16)],
      [0.55, rgba(bodyShade, 0.06)],
      [1, rgba(bodyShade, 0)]
    ]);
    /* 头与身体交界处的柔和 AO（无脖子，用阴影暗示体积） */
    G.neckAO = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(bodyShade, 0.12)], [0.6, rgba(bodyShade, 0.05)], [1, rgba(bodyShade, 0)]
    ]);
    /* 右下方细轮廓光（暖奶油色，只出现在下右半边，宽度 ≈ h 的 2.5%） */
    G.rimStroke = mkLinear(ctx, -14, -6, 30, 74, [
      [0, rgba(lighten(bodyHi, 0.55), 0)],
      [0.50, rgba(lighten(bodyHi, 0.5), 0)],
      [0.78, rgba(lighten(bodyHi, 0.55), 0.40)],
      [1, rgba(lighten(bodyHi, 0.45), 0.16)]
    ]);
    /* 头顶左上：大范围极淡柔光 + 一个小而亮的高光（面积小，不罩住脸） */
    G.headHi = mkRadial(ctx, -6.0, 2.4, 0.5, -6.0, 2.4, 9.5, [
      [0, rgba(lighten(bodyHi, 0.55), 0.26)],
      [0.55, rgba(lighten(bodyHi, 0.5), 0.09)],
      [1, rgba(lighten(bodyHi, 0.5), 0)]
    ]);
    G.headSpec = mkRadial(ctx, -6.4, 2.0, 0.2, -6.4, 2.0, 3.4, [
      [0, 'rgba(255,255,255,0.5)'],
      [0.5, 'rgba(255,255,255,0.14)'],
      [1, 'rgba(255,255,255,0)']
    ]);
    /* 肚皮：柔和椭圆高光 + 上缘窄高光 + 内凹阴影 + 下缘 AO（全部暖色） */
    G.bellyHi = mkRadial(ctx, -4.8, 40.5, 0.5, -4.4, 41.5, 13.5, [
      [0, rgba(lighten(belly, 0.35), 0.34)],
      [0.5, rgba(lighten(belly, 0.3), 0.11)],
      [1, rgba(lighten(belly, 0.25), 0)]
    ]);
    G.bellyTopHi = mkLinear(ctx, 0, 31.2, 0, 37.0, [
      [0, rgba(lighten(belly, 0.55), 0.30)],
      [0.6, rgba(lighten(belly, 0.5), 0.07)],
      [1, rgba(lighten(belly, 0.5), 0)]
    ]);
    G.bellyInner = mkLinear(ctx, 0, 30.6, 0, 43, [
      [0, rgba(bodyShade, 0.16)],
      [0.30, rgba(bodyShade, 0.05)],
      [1, rgba(bodyShade, 0)]
    ]);
    G.bellyAO = mkLinear(ctx, 0, 60, 0, 71.5, [
      [0, rgba(bodyShade, 0)],
      [0.65, rgba(bodyShade, 0.10)],
      [1, rgba(darken(bodyShade, 0.08), 0.24)]
    ]);
    /* 手 / 脚：球体暗部（局部坐标，配合绘制时的 translate） */
    G.handAO = mkLinear(ctx, 0, -5, 0, 6.5, [
      [0, 'rgba(0,0,0,0)'],
      [0.5, rgba(limbShade, 0.10)],
      [1, rgba(limbShade, 0.46)]
    ]);
    G.footAO = mkLinear(ctx, 0, -6.5, 0, 8, [
      [0, 'rgba(0,0,0,0)'],
      [0.5, rgba(limbShade, 0.12)],
      [1, rgba(limbShade, 0.5)]
    ]);
    /* yaw 转向：远侧肢体用暖暗材质（被身体遮挡的深度感） */
    G.legFar = mkLinear(ctx, 0, 62, 0, 95, [
      [0, mix(body, bodyShade, 0.40)],
      [0.45, mix(body, bodyShade, 0.62)],
      [1, mix(bodyShade, darken(bodyShade, 0.1), 0.6)]
    ]);
    G.armFar = mkLinear(ctx, -26, 22, 22, 50, [
      [0, mix(body, bodyShade, 0.38)],
      [0.5, mix(body, bodyShade, 0.58)],
      [1, mix(bodyShade, darken(bodyShade, 0.1), 0.55)]
    ]);
    G.forearmFar = mkLinear(ctx, 0, 36, 0, 52, [
      [0, mix(body, bodyShade, 0.38)],
      [0.6, mix(body, bodyShade, 0.6)],
      [1, mix(bodyShade, darken(bodyShade, 0.1), 0.55)]
    ]);
    /* yaw 转向：身体远侧的侧向明暗（只在远侧边缘，暖色） */
    G.yawShadeL = mkLinear(ctx, -33, 34, -13, 44, [
      [0, rgba(bodyShade, 0.30)],
      [0.7, rgba(bodyShade, 0.09)],
      [1, rgba(bodyShade, 0)]
    ]);
    G.yawShadeR = mkLinear(ctx, 33, 34, 13, 44, [
      [0, rgba(bodyShade, 0.30)],
      [0.7, rgba(bodyShade, 0.09)],
      [1, rgba(bodyShade, 0)]
    ]);

    cache[key] = G;
    return G;
  }

  /* ======================================================================
   * 4. 表情预设（v0.9.2：脸整体上移，大嘴占满头部上半部）
   * ==================================================================== */
  var EXPR = {
    /* 待机 / 奔跑（v0.9.2 收尾）：参考图式「眯眼大笑」——闭眼弯月笑眼 + 大张嘴露牙露舌
       嘴宽 ≈ 头宽 46%（≈ 参考图 ref_laugh.png），小尺寸 h≈181px 下也能一眼读出 */
    smile: { eye: 'happyArc', eyeY: 8.0, eyeSpan: 3.6, eyeBow: 3.2, eyeLW: 2.0, mouth: 'grin', mouthY: 14.6, mouthScale: 0.68 },
    run: { eye: 'happyArc', eyeY: 8.0, eyeSpan: 3.5, eyeBow: 3.0, eyeLW: 2.0, mouth: 'grin', mouthY: 14.8, mouthScale: 0.66 },
    laugh: { eye: 'happyArc', eyeY: 8.2, mouth: 'laugh', mouthY: 12.6, mouthScale: 1.0 },
    happy: { eye: 'happyArc', eyeY: 8.4, mouth: 'grin', mouthY: 15.0, mouthScale: 0.82 },
    wow: { eye: 'wide', eyeY: 6.8, eyeR: [3.5, 3.9], mouth: 'o', mouthY: 16.0, mouthScale: 1.0 },
    dizzy: { eye: 'x', eyeY: 7.6, mouth: 'wavy', mouthY: 15.8, mouthScale: 0.95 },
    star: { eye: 'star', eyeY: 7.8, mouth: 'grin', mouthY: 15.6, mouthScale: 0.78 },
    jump: { eye: 'wide', eyeY: 6.4, eyeR: [3.4, 3.7], mouth: 'laugh', mouthY: 15.2, mouthScale: 0.62 },
    slide: { eye: 'focus', eyeY: 9.0, mouth: 'smile', mouthY: 16.6, mouthScale: 0.9 }
  };

  var FACE_BY_STATE = {
    idle: 'smile',
    run: 'run',
    laugh: 'laugh',
    hit: 'dizzy',
    happy: 'happy',
    levelup: 'star',
    jump: 'jump',
    slide: 'slide'
  };

  function autoBlink(t, seed) {
    var period = 4.1 + (seed || 0) * 0.37;
    var p = ((t % period) + period) % period;
    var dur = 0.15;
    if (p < dur) return Math.sin((p / dur) * Math.PI);
    return 0;
  }

  /* ======================================================================
   * 5. 动画参数
   * ==================================================================== */
  function stateAnim(state, t) {
    var s = Math.sin, a = Math.abs;
    var p = {
      bob: 0, jelly: 0,
      arm: 0, armSwing: 0, armPhase: 0, armPose: 'rest',
      legPose: 'rest', legLift: 0, legPhase: 14, legSwingX: 0, legSpread: 0,
      bellyWobble: 0, faceTilt: 0, faceY: 0,
      stretchY: 1, stretchX: 1,
      glow: 0, shake: 0
    };
    switch (state) {
      case 'run':
        p.bob = a(s(t * 10.6)) * 2.7;
        p.jelly = s(t * 21.2) * 0.014;
        p.armSwing = 0.4; p.armPhase = 10.6;
        p.legPhase = 10.6; p.legLift = 5.2; p.legSwingX = 1.2;
        p.bellyWobble = a(s(t * 10.6 + 0.8)) * 0.05;
        p.faceTilt = 0.02;
        break;
      case 'laugh':
        p.bob = a(s(t * 7.0)) * 3.4;
        p.jelly = s(t * 14.0) * 0.02;
        p.arm = 0.02; p.armSwing = 0.06; p.armPhase = 12.0;
        p.legLift = 1.4; p.legPhase = 7.0;
        p.bellyWobble = a(s(t * 14.0 + 0.4)) * 0.07;
        p.faceTilt = -0.05; p.faceY = -1.0;
        break;
      case 'hit':
        p.bob = -1.6;
        p.arm = 0.7; p.armSwing = 0.35; p.armPhase = 18;
        p.shake = 1;
        p.legSpread = 2.2;
        p.faceTilt = 0.1 * s(t * 9);
        p.jelly = s(t * 30) * 0.02;
        p.stretchX = 1.03;
        break;
      case 'happy':
        p.bob = a(s(t * 6.2)) * 4.4;
        p.arm = 0.3; p.armSwing = 0.45; p.armPhase = 6.2;
        p.legLift = 3.0; p.legPhase = 6.2;
        p.bellyWobble = a(s(t * 6.2 + 0.6)) * 0.05;
        p.jelly = s(t * 12.4) * 0.02;
        break;
      case 'levelup':
        p.bob = 1.6 + a(s(t * 4.6)) * 3.2;
        p.armPose = 'up'; p.arm = 0.1; p.armSwing = 0.14; p.armPhase = 9.0;
        p.legLift = 2.0; p.legPhase = 4.6;
        p.bellyWobble = a(s(t * 9 + 0.3)) * 0.05;
        p.glow = 0.85 + 0.15 * s(t * 5);
        p.faceTilt = -0.03;
        break;
      case 'jump':
        /* 收腿 / 手臂上扬 / 身体拉长 / 兴奋张嘴 */
        p.bob = 0.8 + s(t * 9) * 0.5;
        p.armPose = 'up'; p.arm = 0.12; p.armSwing = 0.1; p.armPhase = 9;
        p.legPose = 'tuck';
        p.stretchY = 1.06; p.stretchX = 0.97;
        p.bellyWobble = a(s(t * 11)) * 0.035;
        p.faceTilt = -0.05; p.faceY = -0.8;
        p.jelly = s(t * 12) * 0.012;
        break;
      case 'slide':
        /* 压低前倾 / 手臂后摆 / 眯眼专注 */
        p.bob = -0.6;
        p.armPose = 'back'; p.arm = 0.1; p.armSwing = 0.08; p.armPhase = 11;
        p.legPose = 'splay';
        p.stretchY = 0.9; p.stretchX = 1.06;
        p.bellyWobble = a(s(t * 13)) * 0.03;
        p.faceTilt = 0.07; p.faceY = 1.0;
        p.jelly = s(t * 13) * 0.01;
        break;
      default: /* idle */
        p.bob = 0.35 + s(t * 1.7) * 0.35;
        p.jelly = s(t * 1.7) * 0.008;
        p.armSwing = 0.05; p.armPhase = 1.7;
        p.bellyWobble = a(s(t * 1.7 + 0.5)) * 0.022;
        break;
    }
    return p;
  }

  /* ======================================================================
   * 6. 部件绘制
   * ==================================================================== */

  /* ---- 腿 + 脚（画在身体之前；yaw 时远侧腿更暗、更靠内、被身体遮挡更多） ---- */
  function drawLegs(ctx, skin, G, t, p, yaw) {
    var SH = sharedGrads(ctx);
    var yawAbs = Math.abs(yaw || 0);
    var yawK = clamp(yawAbs / 0.4, 0, 1);
    var farSide = yawAbs < 0.03 ? 0 : (yaw > 0 ? -1 : 1);
    var order = farSide === 1 ? [1, -1] : [-1, 1];
    var oi, side, isFar;

    for (oi = 0; oi < 2; oi++) {
      side = order[oi];
      isFar = (side === farSide);
      var ph = Math.sin(t * p.legPhase + (side < 0 ? 0 : Math.PI));
      var lift = Math.max(0, ph) * p.legLift;
      var dx = ph * p.legSwingX;
      var hipX, hipY, kneeX, kneeY, ankX, ankY, footRot, widths;

      if (p.legPose === 'tuck') {
        /* 跳跃收腿：膝盖外翻、脚掌收到身体下方并翘起 */
        hipX = side * (10.4 + p.legSpread * 0.5); hipY = 63.2;
        kneeX = side * 14.8; kneeY = 72.4;
        ankX = side * 15.4; ankY = 81.0;
        footRot = side * 0.42;
        widths = [17.0, 15.0, 11.0];
      } else if (p.legPose === 'splay') {
        /* 滑铲：双腿向两侧张开、脚掌外撇 */
        hipX = side * (11.0 + p.legSpread * 0.5); hipY = 63.0;
        kneeX = side * 15.8; kneeY = 76.4;
        ankX = side * 20.6; ankY = 90.2;
        footRot = side * 0.34;
        widths = [17.2, 15.0, 10.8];
      } else {
        hipX = side * (10.8 + p.legSpread * 0.5); hipY = 63.6;
        kneeX = side * 13.2 + dx * 0.5; kneeY = 78.2;
        ankX = side * 12.2 + dx; ankY = 92.5 - lift;
        footRot = side * 0.02 + ph * 0.08;
        widths = [17.2, 14.6, 11.2];
      }

      /* yaw：远侧腿向内收（被身体遮挡更多），近侧腿略向外 */
      var inward = isFar ? -side * 1.7 * yawK : side * 0.6 * yawK;
      hipX += inward; kneeX += inward; ankX += inward;

      var legPts = [[hipX, hipY], [kneeX, kneeY], [ankX, ankY]];
      strokeTaper(ctx, legPts, widths, isFar ? G.legFar : G.leg);

      /* 腿的圆柱高光（单条 path stroke → alpha 均匀，无接缝） */
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,' + (isFar ? 0.10 : 0.18) + ')';
      ctx.lineWidth = 3.0;
      smoothPath(ctx, offsetPts(legPts, -2.0, -1.2));
      ctx.stroke();
      ctx.restore();

      /* 脚（远侧脚略暗一点） */
      ctx.save();
      if (isFar) ctx.globalAlpha = ctx.globalAlpha * (1 - 0.10 * yawK);
      ctx.translate(ankX, ankY);
      ctx.rotate(footRot);
      fillBody(ctx, 'foot', FOOT_PTS, G.foot);
      /* 三个脚趾（脚掌前缘鼓起） */
      var toes = [[-4.8, 6.5, 2.9, 2.5], [0, 7.0, 3.1, 2.7], [4.8, 6.5, 2.9, 2.5]];
      for (var k = 0; k < toes.length; k++) {
        ctx.beginPath();
        ctx.ellipse(toes[k][0], toes[k][1], toes[k][2], toes[k][3], 0, 0, Math.PI * 2);
        ctx.fillStyle = G.foot;
        ctx.fill();
      }
      /* 脚趾缝 */
      ctx.strokeStyle = rgba(skin.limbShade, 0.45);
      ctx.lineWidth = 0.8;
      ctx.lineCap = 'round';
      for (var j = -1; j <= 1; j += 2) {
        ctx.beginPath();
        ctx.moveTo(j * 2.4, 8.8);
        ctx.quadraticCurveTo(j * 2.6, 6.5, j * 2.3, 4.7);
        ctx.stroke();
      }
      /* 脚部球体暗部（下半部 AO） */
      fillBody(ctx, 'foot', FOOT_PTS, G.footAO);
      ctx.save();
      ctx.translate(0, 4.4);
      ctx.scale(8.4, 3.2);
      ctx.fillStyle = G.footAO;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      /* 脚背高光 + 小 specular */
      ctx.save();
      ctx.translate(0, -3.0);
      ctx.scale(8.2, 3.4);
      ctx.fillStyle = G.footHi;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(-1.6, -4.2);
      ctx.scale(2.6, 1.4);
      ctx.fillStyle = SH.spec;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      /* 落地接触阴影（脚掌下方：宽软 + 窄深两层） */
      ctx.save();
      ctx.translate(0, 8.6);
      ctx.scale(10.2, 2.6);
      ctx.fillStyle = 'rgba(38,20,8,0.14)';
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(0, 7.8);
      ctx.scale(7.6, 1.7);
      ctx.fillStyle = 'rgba(38,20,8,0.28)';
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.restore();
    }
  }

  /* ---- 手臂点位：上臂（藏身后）、肘、手（贴肚皮） ---- */
  /* ---- 手臂点位：上臂（藏身后）、肘、手（贴肚皮）；xShift 用于 yaw 转向时整体贴向身体 ---- */
  function armPoints(side, a, pose, xShift) {
    var S, P, H;
    if (pose === 'up') {
      S = [12.4, 34.0]; P = [23.0, 30.4]; H = [25.4, 19.2];
    } else if (pose === 'back') {
      S = [12.4, 35.4]; P = [23.2, 42.4]; H = [26.6, 49.0];
    } else {
      S = [12.4, 34.2]; P = [24.6, 39.6]; H = [11.8, 47.6];
    }
    var sh = xShift || 0;
    S = [side * S[0] + sh, S[1]];
    P = [side * P[0] + sh, P[1]];
    H = [side * H[0] + sh, H[1]];
    /* 绕肩摆动：>0 = 向外 / 向上 */
    var rot = -side * a;
    var pv = rotVec(P[0] - S[0], P[1] - S[1], rot);
    var hv = rotVec(H[0] - S[0], H[1] - S[1], rot);
    return { S: S, P: [S[0] + pv[0], S[1] + pv[1]], H: [S[0] + hv[0], S[1] + hv[1]] };
  }

  function handAngle(P, H, side) {
    var dx = H[0] - P[0], dy = H[1] - P[1];
    var ang = side > 0 ? Math.atan2(dy, dx) : Math.atan2(-dy, dx);
    return ang - 2.5;   /* 手局部「手指」方向约 2.5 rad（朝内下方） */
  }

  function drawHand(ctx, skin, G, side, hx, hy, rot) {
    var SH = sharedGrads(ctx);
    ctx.save();
    ctx.translate(hx, hy);
    if (side < 0) ctx.scale(-1, 1);
    ctx.rotate(rot);

    ctx.fillStyle = G.hand;
    ctx.beginPath();
    ctx.ellipse(0.3, 0.4, 5.0, 5.1, 0.3, 0, Math.PI * 2);
    ctx.fill();
    /* 三根手指：沿内侧张开 */
    var fingers = [[-4.4, 0.6, 2.0, 1.6, 0.45],
    [-4.9, 2.6, 2.0, 1.55, 0.2],
    [-3.9, 4.5, 1.85, 1.5, -0.15]];
    for (var f = 0; f < fingers.length; f++) {
      ctx.beginPath();
      ctx.ellipse(fingers[f][0], fingers[f][1], fingers[f][2], fingers[f][3], fingers[f][4], 0, Math.PI * 2);
      ctx.fill();
    }
    /* 拇指 */
    ctx.beginPath();
    ctx.ellipse(-0.9, -4.1, 1.9, 1.5, -0.6, 0, Math.PI * 2);
    ctx.fill();
    /* 球体暗部（手掌下半部 AO，暗端） */
    ctx.save();
    ctx.fillStyle = G.handAO;
    ctx.beginPath();
    ctx.ellipse(0.3, 0.4, 5.0, 5.1, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0.6, 3.2, 4.5, 3.1, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    /* 指缝 */
    ctx.strokeStyle = rgba(skin.limbShade, 0.5);
    ctx.lineWidth = 0.65;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-3.4, 1.7); ctx.quadraticCurveTo(-2.4, 2.4, -1.8, 2.8);
    ctx.moveTo(-3.2, 3.6); ctx.quadraticCurveTo(-2.2, 4.2, -1.5, 4.5);
    ctx.stroke();
    /* 手背高光 */
    ctx.save();
    ctx.translate(0.9, -2.2);
    ctx.scale(3.0, 1.7);
    ctx.fillStyle = G.handHi;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    /* 小 specular（球体高光点） */
    ctx.save();
    ctx.translate(-0.2, -3.0);
    ctx.scale(1.8, 1.1);
    ctx.fillStyle = SH.spec;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  /* ---- yaw 辅助：判断是否在转向、远侧是哪边 ---- */
  function armYawInfo(yaw) {
    var yawAbs = Math.abs(yaw || 0);
    return {
      active: yawAbs > 0.03,
      yawK: clamp(yawAbs / 0.4, 0, 1),
      farSide: (yaw || 0) > 0 ? -1 : 1
    };
  }

  /* ---- 手臂后层：上臂（藏身后）；slide 时整条手臂都在身后；
          yaw 转向时只画「远侧」整条手臂（被身体遮挡），近侧改到前层整条绘制 ---- */
  function drawArmsBack(ctx, skin, G, t, p, yaw) {
    var info = armYawInfo(yaw);
    var i, side;
    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      var isFar = info.active && side === info.farSide;
      var phase = Math.sin(t * p.armPhase + (i === 0 ? 0 : Math.PI));
      var a = p.arm + p.armSwing * phase;
      var xShift = info.active ? (-side * (isFar ? 1.0 : 2.4) * info.yawK) : 0;
      var A = armPoints(side, a, p.armPose, xShift);

      /* 上臂：肩 → 肘（大部分被身体挡住，只在身体轮廓外露出小肩头） */
      var upPts = [A.S, [(A.S[0] + A.P[0]) / 2 + side * 0.6, (A.S[1] + A.P[1]) / 2 - 0.6], A.P];
      strokeTaper(ctx, upPts, [13.6, 12.2, 10.4], isFar ? G.armFar : G.arm);

      if (p.armPose === 'back' || isFar) {
        /* 滑铲 / yaw 远侧：前臂与手也画在身后，形成「手臂后摆 / 被身体遮挡」 */
        var faPts = [A.P, [(A.P[0] + A.H[0]) / 2, (A.P[1] + A.H[1]) / 2 + 0.4], A.H];
        strokeTaper(ctx, faPts, [10.4, 9.4, 8.2], isFar ? G.forearmFar : G.forearm);
        ctx.save();
        if (isFar) ctx.globalAlpha = ctx.globalAlpha * (1 - 0.14 * info.yawK);
        drawHand(ctx, skin, G, side, A.H[0], A.H[1], handAngle(A.P, A.H, side));
        ctx.restore();
      }
    }
  }

  /* ---- 手臂前层：前臂 + 手（自然搭在肚皮两侧；yaw 时远侧交给后层） ---- */
  function drawArmsFront(ctx, skin, G, t, p, yaw) {
    if (p.armPose === 'back') return;
    var info = armYawInfo(yaw);
    var i, side;
    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      if (info.active && side === info.farSide) continue;   /* 远侧手臂画在身体后面 */
      var phase = Math.sin(t * p.armPhase + (i === 0 ? 0 : Math.PI));
      var a = p.arm + p.armSwing * phase;
      var xShift = info.active ? (-side * 2.4 * info.yawK) : 0;
      var A = armPoints(side, a, p.armPose, xShift);
      var P = A.P, H = A.H;

      var faPts = [P, [(P[0] + H[0]) / 2, (P[1] + H[1]) / 2 + 0.5], H];

      /* 前臂在肚皮上的柔和投影：沿前臂法线偏向下侧，只从下缘露出一点 */
      var fdx = H[0] - P[0], fdy = H[1] - P[1];
      var flen = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
      var fnx = -fdy / flen, fny = fdx / flen;
      if (fny < 0) { fnx = -fnx; fny = -fny; }
      ctx.save();
      clipBody(ctx, 'body', BODY_PTS);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(88,50,20,0.13)';
      ctx.lineWidth = 7.2;
      smoothPath(ctx, offsetPts(faPts, fnx * 2.0, fny * 2.0));
      ctx.stroke();
      /* 手贴在肚皮上的接触阴影 */
      ctx.save();
      ctx.translate(H[0] + side * 0.6, H[1] + 2.6);
      ctx.scale(6.4, 4.2);
      ctx.fillStyle = G.contactSoft;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.restore();

      /* 前臂（圆润软管，上亮下暗的圆柱光 → 在奶油肚皮上有辨识度） */
      strokeTaper(ctx, faPts, [10.8, 9.6, 8.2], G.forearm);

      /* 上沿柔光 */
      ctx.save();
      ctx.strokeStyle = rgba(lighten(skin.bodyHi, 0.7), 0.3);
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.6;
      smoothPath(ctx, offsetPts(faPts, -side * 1.8, -2.2));
      ctx.stroke();
      ctx.restore();

      drawHand(ctx, skin, G, side, H[0], H[1], handAngle(P, H, side));
    }
  }

  /* ---- 身体 + 肚皮 + 光影（v0.9.3：亮黄受光 + 暖橙暗面 + 局部小高光/AO） ---- */
  function drawBody(ctx, skin, G, t, p, yaw) {
    var SH = sharedGrads(ctx);
    var yawK = clamp((yaw || 0) / 0.4, -1, 1);

    /* 主轮廓（基础球体渐变：亮黄 → 暖橙，已经是唯一的大面积明暗层） */
    fillBody(ctx, 'body', BODY_PTS, G.body);

    ctx.save();
    clipBody(ctx, 'body', BODY_PTS);

    /* 1) 球体暗部：头部右侧 + 头身交界 AO（让头读成球体） */
    ctx.save();
    ctx.translate(11.0, 13.0);
    ctx.scale(15.0, 15.0);
    ctx.fillStyle = G.headRound;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(0, 29.0);
    ctx.scale(14.5, 4.6);
    ctx.fillStyle = G.neckAO;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 2) 底部接地 AO（只压最下缘，暖棕） */
    ctx.fillStyle = G.bodyAO;
    ctx.fillRect(-33, 62, 66, 16);

    /* yaw 转向：只压远侧边缘（暖色，不罩整体） */
    if (Math.abs(yaw) > 0.02) {
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * Math.min(1, Math.abs(yawK)) * 0.95;
      ctx.fillStyle = yaw > 0 ? G.yawShadeL : G.yawShadeR;
      ctx.fillRect(-33, 0, 66, 78);
      ctx.restore();
    }

    /* ---- 奶油大肚皮：随 yaw 横向微移（透视下的肚皮中心偏移） ---- */
    var wob = 1 + p.bellyWobble;
    var bellyDX = (yaw || 0) * 2.2;
    ctx.save();
    ctx.translate(bellyDX, 0);
    ctx.save();
    ctx.translate(0, 50);
    ctx.scale(1 / wob, wob);
    ctx.translate(0, -50);
    fillBody(ctx, 'belly', BELLY_PTS, G.belly);

    /* 肚皮内部光影（裁剪在肚皮内） */
    ctx.save();
    clipBody(ctx, 'belly', BELLY_PTS);
    /* 内凹阴影（上缘内侧，暖色） */
    ctx.fillStyle = G.bellyInner;
    ctx.fillRect(-26, 29, 52, 16);
    /* 上缘窄高光（只在最上沿，不做横贯白条） */
    ctx.fillStyle = G.bellyTopHi;
    ctx.fillRect(-26, 30, 52, 8);
    /* 下缘 AO（奶油肚皮底部折进去） */
    ctx.fillStyle = G.bellyAO;
    ctx.fillRect(-26, 59, 52, 14);
    /* 主高光（肚皮前上方一个柔和椭圆） */
    ctx.save();
    ctx.translate(-4.8, 40.8);
    ctx.scale(12.0, 10.0);
    ctx.fillStyle = G.bellyHi;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    /* 左侧弧形高光（弱） */
    ctx.save();
    ctx.translate(-9.8, 45);
    ctx.scale(3.6, 9.5);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    /* 小 specular（一处很小的锐利高光点） */
    ctx.save();
    ctx.translate(-6.6, 38.4);
    ctx.scale(2.2, 1.35);
    ctx.globalAlpha = ctx.globalAlpha * 0.80;
    ctx.fillStyle = SH.spec;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.restore(); /* end belly clip */
    ctx.restore(); /* end wobble */
    ctx.restore(); /* end belly yaw shift */

    /* ---- 头顶左上：柔和小高光 + 一点 specular（不罩住脸） ---- */
    var hdx = (yaw || 0) * 1.6;
    ctx.save();
    ctx.translate(-6.0 + hdx, 2.4);
    ctx.scale(9.5, 9.5);
    ctx.fillStyle = G.headHi;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(-6.4 + hdx, 2.0);
    ctx.scale(3.4, 3.4);
    ctx.fillStyle = G.headSpec;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore(); /* end body clip */

    var P = getPaths();
    /* 极淡轮廓线，让边缘更干净 */
    ctx.save();
    ctx.strokeStyle = rgba(darken(skin.bodyShade, 0.35), 0.12);
    ctx.lineWidth = 0.7;
    if (P && P.body) ctx.stroke(P.body);
    else { ctx.beginPath(); traceCurve(ctx, BODY_PTS, true); ctx.stroke(); }
    ctx.restore();

    /* 右下方细轮廓光（暖奶油，只在身体下右边缘，宽 ≈ 2.5% h） */
    ctx.save();
    ctx.strokeStyle = G.rimStroke;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    if (P && P.body) ctx.stroke(P.body);
    else { ctx.beginPath(); traceCurve(ctx, BODY_PTS, true); ctx.stroke(); }
    ctx.restore();

    /* 腿根部的柔和阴影，遮住腿与身体的接缝 */
    for (var i = -1; i <= 1; i += 2) {
      ctx.save();
      ctx.translate(i * 10.6, 72.2);
      ctx.scale(8.8, 4.4);
      ctx.fillStyle = G.crease;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /* ---- 眼睛 ---- */
  function drawEyeStar(ctx, x, y, r, fill) {
    var i, ang, rad;
    ctx.beginPath();
    for (i = 0; i < 10; i++) {
      ang = -Math.PI / 2 + (i * Math.PI) / 5;
      rad = i % 2 === 0 ? r : r * 0.44;
      if (i === 0) ctx.moveTo(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
      else ctx.lineTo(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawEyes(ctx, skin, G, E, blink) {
    var i, side, ex = FACE.eyeX, ey = E.eyeY;
    var openScale = 1 - blink * 0.88;
    var eyeR = E.eyeR || [3.0, 3.3];

    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      var x = side * ex;

      if (E.eye === 'open' || E.eye === 'wide') {
        var rx = eyeR[0], ry = eyeR[1];
        ctx.save();
        ctx.translate(x, ey);
        ctx.scale(1, Math.max(0.12, openScale));
        ctx.fillStyle = G.eye;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        /* 上眼睑暗边 */
        ctx.strokeStyle = rgba(darken(skin.eye, 0.2), 0.45);
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, Math.PI * 1.05, Math.PI * 1.95);
        ctx.stroke();
        /* 高光 */
        ctx.fillStyle = skin.teeth;
        ctx.beginPath();
        ctx.arc(-rx * 0.36, -ry * 0.38, rx * 0.39, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(skin.teeth, 0.55);
        ctx.beginPath();
        ctx.arc(rx * 0.32, ry * 0.42, rx * 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        /* 眨眼完成时补一条闭眼线 */
        if (blink > 0.72) {
          ctx.strokeStyle = skin.eye;
          ctx.lineWidth = 1.0;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x - rx, ey + 0.6);
          ctx.quadraticCurveTo(x, ey + 2.0, x + rx, ey + 0.6);
          ctx.stroke();
        }
      } else if (E.eye === 'happyArc') {
        /* 弯月笑眼：短弧；blink 时弧变平（像挤了下眼睛），保留眨眼变化 */
        var span = E.eyeSpan == null ? 2.9 : E.eyeSpan;
        var bow = (E.eyeBow == null ? 2.2 : E.eyeBow) * (1 - blink * 0.55);
        var lw = (E.eyeLW || 1.6) + blink * 0.5;
        ctx.strokeStyle = skin.eye;
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - span, ey + 2.4);
        ctx.quadraticCurveTo(x, ey + 2.4 - bow, x + span, ey + 2.4);
        ctx.stroke();
      } else if (E.eye === 'focus') {
        /* 专注眯眼：细长眼 + 高光 */
        ctx.save();
        ctx.translate(x, ey);
        ctx.fillStyle = G.eye;
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.2, 1.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = skin.teeth;
        ctx.beginPath();
        ctx.arc(-0.8, -0.2, 0.75, 0, Math.PI * 2);
        ctx.fill();
        /* 上眼皮压线 */
        ctx.strokeStyle = rgba(darken(skin.eye, 0.1), 0.7);
        ctx.lineWidth = 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-3.3, -0.7);
        ctx.quadraticCurveTo(0, -1.9, 3.3, -0.7);
        ctx.stroke();
        ctx.restore();
      } else if (E.eye === 'x') {
        ctx.strokeStyle = skin.eye;
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 2.7, ey - 2.7); ctx.lineTo(x + 2.7, ey + 2.7);
        ctx.moveTo(x + 2.7, ey - 2.7); ctx.lineTo(x - 2.7, ey + 2.7);
        ctx.stroke();
      } else if (E.eye === 'star') {
        drawEyeStar(ctx, x, ey, 4.4, skin.eye);
        drawEyeStar(ctx, x, ey, 2.5, mix(skin.accent, '#FFFFFF', 0.35));
        ctx.strokeStyle = rgba(skin.teeth, 0.9);
        ctx.lineWidth = 0.7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 6.4, ey); ctx.lineTo(x - 5.0, ey);
        ctx.moveTo(x + 5.0, ey); ctx.lineTo(x + 6.4, ey);
        ctx.moveTo(x, ey - 6.6); ctx.lineTo(x, ey - 5.2);
        ctx.stroke();
      }
    }
  }

  /* ---- 嘴 ---- */
  function drawMouth(ctx, skin, G, E) {
    var ms = E.mouthScale || 1;
    var kind = E.mouth;

    ctx.save();
    ctx.translate(0, E.mouthY);

    if (kind === 'smile') {
      /* 闭口微笑：两端微翘 */
      ctx.save();
      ctx.scale(ms, ms);
      ctx.strokeStyle = skin.mouth;
      ctx.lineWidth = 1.7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-5.8, -1.2);
      ctx.quadraticCurveTo(-2.6, 3.0, 0, 3.2);
      ctx.quadraticCurveTo(2.6, 3.0, 5.8, -1.2);
      ctx.stroke();
      /* 嘴角小窝 */
      ctx.fillStyle = rgba(skin.mouth, 0.45);
      ctx.beginPath(); ctx.arc(-6.0, -1.6, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(6.0, -1.6, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.restore();
      return;
    }

    if (kind === 'wavy') {
      ctx.save();
      ctx.scale(ms, ms);
      ctx.strokeStyle = skin.mouth;
      ctx.lineWidth = 1.7;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-6.8, 1.2);
      ctx.quadraticCurveTo(-4.4, -2.4, -2.0, 0.4);
      ctx.quadraticCurveTo(0.2, 3.0, 2.6, 0.2);
      ctx.quadraticCurveTo(4.8, -2.2, 6.8, 1.0);
      ctx.stroke();
      ctx.restore();
      ctx.restore();
      return;
    }

    if (kind === 'o') {
      ctx.save();
      ctx.scale(ms, ms);
      fillMouth(ctx, 'o', 'o', skin.mouth);
      ctx.save();
      clipMouth(ctx, 'o', 'o');
      /* 舌 */
      ctx.fillStyle = mix(skin.cheek, skin.mouth, 0.32);
      ctx.beginPath();
      ctx.ellipse(0, 3.0, 2.2, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = G.throat;
      ctx.fillRect(-4, -5, 8, 9);
      ctx.restore();
      ctx.restore();
      ctx.restore();
      return;
    }

    /* laugh / grin：张嘴（同一嘴形，grin 缩小一圈） */
    var name = 'laugh';
    var mscale = (kind === 'grin' ? 0.64 : 1) * ms;
    ctx.scale(mscale, mscale);

    var i;
    fillMouth(ctx, name, 'laugh', skin.mouth);

    /* 口腔内部（裁剪） */
    ctx.save();
    clipMouth(ctx, name, 'laugh');

    /* 顶部深喉阴影 */
    ctx.fillStyle = G.throat;
    ctx.fillRect(-14, -9, 28, 19);

    /* 上牙：沿上唇的一排白牙 */
    var teethH = 3.6;
    var teethTop = -6.5;
    ctx.fillStyle = skin.teeth;
    ctx.beginPath();
    ctx.moveTo(-10.8, -3.0);
    ctx.bezierCurveTo(-6.8, -6.4, 6.8, -6.4, 10.8, -3.0);
    ctx.lineTo(9.8, -3.0 + teethH);
    ctx.bezierCurveTo(6.4, -5.2 + teethH, -6.4, -5.2 + teethH, -9.8, -3.0 + teethH);
    ctx.closePath();
    ctx.fill();
    /* 牙齿缝隙 */
    ctx.strokeStyle = rgba(skin.mouth, 0.22);
    ctx.lineWidth = 0.55;
    var xs = [-8.0, -5.3, -2.7, 0, 2.7, 5.3, 8.0];
    for (i = 0; i < xs.length; i++) {
      var tx = xs[i];
      var ty = teethTop + Math.abs(tx) * 0.22;
      ctx.beginPath();
      ctx.moveTo(tx, ty + 0.6);
      ctx.lineTo(tx * 0.94, ty + teethH + 1.5);
      ctx.stroke();
    }
    /* 牙齿底部湿润高光 */
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(-9.2, -3.0 + teethH + 0.7);
    ctx.bezierCurveTo(-5.8, -5.0 + teethH + 0.7, 5.8, -5.0 + teethH + 0.7, 9.2, -3.0 + teethH + 0.7);
    ctx.stroke();

    /* 舌头 */
    var tongue = mix(skin.cheek, skin.mouth, 0.3);
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.ellipse(0, 6.8, 5.6, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(darken(tongue, 0.18), 0.5);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-4.4, 6.0);
    ctx.quadraticCurveTo(0, 4.2, 4.4, 6.0);
    ctx.stroke();
    /* 舌头高光 */
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(-1.4, 7.6, 2.0, 1.0, -0.2, 0, Math.PI * 2);
    ctx.fill();

    /* 下颌暗影 */
    ctx.fillStyle = rgba(darken(skin.mouth, 0.25), 0.35);
    ctx.beginPath();
    ctx.ellipse(0, 10.0, 9.2, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore(); /* end mouth clip */

    /* 嘴唇描边（下唇略厚） */
    ctx.strokeStyle = rgba(darken(skin.mouth, 0.15), 0.85);
    ctx.lineWidth = 0.9;
    ctx.lineJoin = 'round';
    var P = getPaths();
    if (P && P.laugh) ctx.stroke(P.laugh);
    else { ctx.beginPath(); traceMouth(ctx, 'laugh'); ctx.stroke(); }

    /* 上唇高光 */
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-8.4, 0.2);
    ctx.quadraticCurveTo(0, 1.2, 8.4, 0.2);
    ctx.stroke();

    ctx.restore();
  }

  /* ---- 脸部整体 ---- */
  function drawFace(ctx, skin, G, face, blink, p, yaw) {
    var E = EXPR[face] || EXPR.smile;
    var i, side;
    var yawK = clamp((yaw || 0) / 0.4, -1, 1);

    ctx.save();
    /* 仰头 / 低头：以头部中心为轴 */
    ctx.translate(0, p.faceY);
    if (p.faceTilt) {
      ctx.translate(0, 12);
      ctx.rotate(p.faceTilt);
      ctx.translate(0, -12);
    }
    /* yaw 转向：五官横向偏移 + 轻微横向压缩（透视） */
    if (Math.abs(yaw || 0) > 0.001) {
      ctx.translate(yaw * 5.6, 0);
      ctx.scale(1 - 0.07 * Math.abs(yawK), 1);
    }

    /* 腮红（小、柔） */
    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      ctx.save();
      ctx.translate(side * FACE.cheekX, (E.mouthY || 16) + FACE.cheekDrop);
      ctx.scale(5.0, 3.2);
      ctx.fillStyle = G.cheek;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    drawEyes(ctx, skin, G, E, blink);
    drawMouth(ctx, skin, G, E);

    ctx.restore();
  }

  /* ---- 升级光环 ---- */
  function drawAura(ctx, skin, G, t, strength) {
    ctx.save();
    ctx.translate(0, 46);
    ctx.scale(80, 80);
    ctx.globalAlpha = ctx.globalAlpha * clamp(strength, 0, 1);
    ctx.fillStyle = G.aura;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 环绕小星星 */
    var n = 6, i;
    ctx.save();
    for (i = 0; i < n; i++) {
      var ang = t * 1.4 + (i * Math.PI * 2) / n;
      var rad = 52 + Math.sin(t * 3 + i) * 5;
      var x = Math.cos(ang) * rad * 0.85;
      var y = 44 + Math.sin(ang) * rad * 0.55;
      var tw = 0.55 + 0.45 * Math.sin(t * 7 + i * 1.7);
      ctx.globalAlpha = ctx.globalAlpha * tw * 0.9;
      drawEyeStar(ctx, x, y, 2.6 + tw * 1.6, i % 2 ? '#FFFFFF' : skin.accent);
    }
    ctx.restore();
  }

  /* ---- 跑动速度小尾迹 ---- */
  function drawRunTrails(ctx, skin, t) {
    ctx.save();
    ctx.lineCap = 'round';
    for (var i = 0; i < 3; i++) {
      var ph = (t * 2.2 + i * 0.37) % 1;
      var side = i % 2 === 0 ? -1 : 1;
      var x = side * (26 + ph * 9);
      var y = 52 + i * 7;
      ctx.globalAlpha = ctx.globalAlpha * (1 - ph) * 0.34;
      ctx.strokeStyle = lighten(skin.bodyHi, 0.3);
      ctx.lineWidth = 2.6 * (1 - ph) + 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + side * (5 + ph * 5), y + 1.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ======================================================================
   * 7. 对外 API
   * ==================================================================== */
  var SKIN_FALLBACK = {
    id: 'classic', body: '#FFC53D', bodyShade: '#F0A81F', bodyHi: '#FFE07A',
    belly: '#FFF3D1', bellyShade: '#F7E2AE', limb: '#6A4A32', limbShade: '#4E3523',
    mouth: '#5A2A1E', teeth: '#FFFDF5', cheek: '#FF9E7A', eye: '#3A2418', accent: '#FF7A45'
  };

  function drawCharacter(ctx, opts) {
    if (!ctx || !ctx.beginPath) return;
    opts = opts || {};
    var t = opts.t || 0;
    var h = (opts.h > 0) ? opts.h : 250;
    var state = opts.state || 'idle';
    var skin = opts.skin || SKIN_FALLBACK;
    var lean = opts.lean || 0;
    var yaw = clamp(opts.yaw || 0, -0.5, 0.5);   /* v0.9.3：换道转向（弧度，默认 0） */
    var alpha = (opts.alpha === undefined || opts.alpha === null) ? 1 : opts.alpha;
    var squash = clamp(opts.squash || 0, 0, 1);
    var face = opts.face || FACE_BY_STATE[state] || 'smile';
    var blink = opts.blink;
    if (blink === undefined || blink === null) blink = autoBlink(t, 0);
    blink = clamp(blink, 0, 1);
    if (alpha <= 0.003 || h <= 0.5) return;

    var p = stateAnim(state, t);
    var G = skinGrads(ctx, skin);

    var s = h / 100;
    /* 受击挤压 / 跳跃拉长 / 滑铲压低，都以脚底为基准 */
    var sy = (1 - 0.26 * squash) * (1 + p.jelly) * p.stretchY;
    var sx = (1 + 0.22 * squash) * (1 - p.jelly * 0.7) * p.stretchX;
    /* yaw 转向：整体横向透视压缩（±0.4rad → 约 0.83 倍宽） */
    var yawK = clamp(yaw / 0.4, -1, 1);
    var yawSquash = 1 - 0.17 * Math.min(1, Math.abs(yawK));

    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * alpha;
    ctx.translate(opts.x || 0, opts.y || 0);
    if (lean) ctx.rotate(lean);
    ctx.scale(s * sx * yawSquash, s * sy);
    ctx.translate(0, -100);            /* 设计空间 y: 0=头顶, 100=脚底 */
    if (p.shake) ctx.translate(Math.sin(t * 54) * 1.6, 0);

    if (state === 'levelup') drawAura(ctx, skin, G, t, p.glow);

    ctx.translate(0, -p.bob);

    drawLegs(ctx, skin, G, t, p, yaw);
    drawArmsBack(ctx, skin, G, t, p, yaw);
    drawBody(ctx, skin, G, t, p, yaw);
    drawArmsFront(ctx, skin, G, t, p, yaw);
    drawFace(ctx, skin, G, face, blink, p, yaw);

    ctx.restore();
  }

  /* 地面接触软阴影（v0.9.3：三层 + 可选跳起高度；向后兼容旧 4 参数调用） */
  function drawShadow(ctx, x, y, rx, alpha, jumpArg) {
    if (!ctx || !ctx.beginPath) return;
    rx = (rx > 0) ? rx : 40;
    alpha = (alpha === undefined || alpha === null) ? 1 : clamp(alpha, 0, 1);
    if (alpha <= 0.003) return;
    var jump = 0, yaw = 0;
    if (typeof jumpArg === 'number') jump = jumpArg;
    else if (jumpArg && typeof jumpArg === 'object') {
      jump = jumpArg.jump || jumpArg.height || 0;
      yaw = jumpArg.yaw || 0;
    }
    jump = clamp(jump, 0, 8);
    /* 跳起越高：接触阴影越小、越淡、越软（与 game.js 已做的缩放叠加仍自然） */
    var shrink = 1 / (1 + jump * 0.22);
    var fade = 1 / (1 + jump * 0.45);
    var r = rx * shrink;
    var a = alpha * fade;
    var SH = sharedGrads(ctx);

    ctx.save();
    ctx.translate((x || 0) - (yaw || 0) * rx * 0.04, (y || 0) + rx * 0.03);
    ctx.globalAlpha = ctx.globalAlpha * a;

    /* 1) 外层极软环境阴影 */
    ctx.save();
    ctx.translate(r * 0.05, 0);
    ctx.scale(r * 1.14, r * 0.40);
    ctx.fillStyle = SH.softShadow;
    ctx.beginPath(); ctx.arc(0, 0, 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 2) 中层 */
    ctx.save();
    ctx.scale(r * 0.78, r * 0.24);
    ctx.fillStyle = 'rgba(74,42,16,0.22)';
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 3) 接触核心（中心深、边缘透明） */
    ctx.save();
    ctx.scale(r * 0.55, r * 0.145);
    ctx.fillStyle = SH.coreDark;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  art.Character = {
    draw: drawCharacter,
    drawShadow: drawShadow,
    /* 便于调试 / 预览页使用 */
    STATES: ['idle', 'run', 'laugh', 'hit', 'happy', 'levelup', 'jump', 'slide'],
    FACES: ['laugh', 'smile', 'wow', 'dizzy', 'star', 'jump', 'slide']
  };
})(typeof window !== 'undefined' ? window : globalThis);
