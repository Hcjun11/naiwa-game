/* ==========================================================================
 * 《奶娃》角色绘制 —— NW.art.Character
 * 负责人：character-art（队友 B）
 * --------------------------------------------------------------------------
 * 对外 API（SPEC 4.1）：
 *   NW.art.Character.draw(ctx, opts)
 *       opts: { x, y, h, state, t, skin, lean, alpha, blink, squash, face }
 *       x,y  角色脚底中心（逻辑坐标）      h    角色总高度 px（80~320）
 *       state 'idle'|'run'|'laugh'|'hit'|'happy'|'levelup'
 *       skin  CFG.skins 中的对象（5 套配色全支持）
 *       face  可选覆盖：'laugh'|'smile'|'wow'|'dizzy'|'star'
 *   NW.art.Character.drawShadow(ctx, x, y, rx, alpha)
 *
 * 设计说明：
 *   - 纯 Canvas 2D 程序化绘制，无图片 / 字体 / 其他模块依赖（NW.util 缺失时降级）。
 *   - 内部「设计空间」：角色高 = 100 单位，y 向下，脚底中心 (0,100)，头顶 (0,0)。
 *     绘制时 scale(h/100)，因此任意 h 都保持比例清晰。
 *   - Path2D 形状缓存 + 按 ctx 缓存的 CanvasGradient（坐标写死在设计空间），
 *     每帧 0 次 path/gradient 重建，250px 角色 60fps 无压力。
 *   - ctx.save()/restore() 严格成对，不污染外部状态。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = (global.NW = global.NW || {});
  var art = (NW.art = NW.art || {});
  var CFG = NW.CFG || {};
  var U = NW.util || null;

  /* ======================================================================
   * 0. 颜色工具（优先后用 NW.util，缺失时本地降级）
   * ==================================================================== */
  function parseHex(hex) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    if (U && U.rgba) return U.rgba(hex, a === undefined ? 1 : a);
    var p = parseHex(hex);
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + (a === undefined ? 1 : a) + ')';
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
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ======================================================================
   * 1. 设计空间几何常量（角色高 100，y 向下）
   * ==================================================================== */
  var BODY_HALF = [
    [0, 0],
    [6.6, 0.4], [12.4, 3.6], [15.0, 9.0],
    [15.9, 14.2], [15.3, 19.8], [15.7, 25.0],
    [17.6, 29.4], [20.8, 33.6], [24.2, 39.8],
    [26.6, 46.8], [27.6, 54.6], [26.8, 61.6],
    [24.2, 67.8], [18.6, 71.6], [12.0, 73.0],
    [6.0, 73.4], [0, 73.6]
  ];
  var BELLY_HALF = [
    [0, 30.0], [7.6, 30.4], [14.0, 34.2], [16.6, 40.6],
    [17.9, 47.8], [17.6, 55.6], [15.6, 62.6], [12.0, 68.0],
    [7.0, 70.3], [0, 70.7]
  ];
  var FOOT_HALF = [
    [0, -4.8], [4.8, -4.6], [7.8, -2.2], [9.2, 1.8],
    [8.8, 5.8], [5.0, 7.4], [0, 7.6]
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

  /* 面部定位（设计空间） */
  var FACE = {
    eyeX: 9.2, eyeY: 9.6,
    mouthX: 0, mouthY: 21.2,
    cheekX: 11.6, cheekY: 17.0
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

  /* 嘴形（局部坐标，嘴中心 0,0） */
  function traceMouth(c, kind) {
    if (kind === 'laugh') {
      c.moveTo(-11.4, -3.6);
      c.bezierCurveTo(-7.0, -6.9, 7.0, -6.9, 11.4, -3.6);
      c.bezierCurveTo(12.8, 1.6, 8.4, 8.4, 0, 8.4);
      c.bezierCurveTo(-8.4, 8.4, -12.8, 1.6, -11.4, -3.6);
      c.closePath();
    } else if (kind === 'o') {
      c.moveTo(0, -4.2);
      c.bezierCurveTo(2.9, -4.2, 3.6, -1.6, 3.6, 0.2);
      c.bezierCurveTo(3.6, 2.8, 1.8, 4.2, 0, 4.2);
      c.bezierCurveTo(-1.8, 4.2, -3.6, 2.8, -3.6, 0.2);
      c.bezierCurveTo(-3.6, -1.6, -2.9, -4.2, 0, -4.2);
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

  /* Catmull-Rom 均匀采样（用于手臂 / 腿这类弯曲的软管形体） */
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
   * 3. 渐变缓存（按 ctx + skin 缓存；坐标均写死在设计空间，可跨帧复用）
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
    G.blackFade = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, 'rgba(60,32,14,0.55)'], [0.6, 'rgba(60,32,14,0.2)'], [1, 'rgba(60,32,14,0)']
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

    /* 身体主光（左上高光 → 右下阴影，球体感） */
    G.body = mkRadial(ctx, -9, 2, 2, -5, 20, 84, [
      [0, lighten(bodyHi, 0.42)],
      [0.19, bodyHi],
      [0.4, lighten(body, 0.1)],
      [0.62, body],
      [0.8, mix(body, bodyShade, 0.45)],
      [0.9, bodyShade],
      [1, darken(bodyShade, 0.16)]
    ]);
    /* 身体底部压暗（接地阴影，保持很轻，避免肚皮下缘发灰） */
    G.bodyBottom = mkLinear(ctx, 0, 50, 0, 77, [
      [0, rgba(darken(bodyShade, 0.4), 0)],
      [0.6, rgba(darken(bodyShade, 0.35), 0.12)],
      [1, rgba(darken(bodyShade, 0.42), 0.26)]
    ]);
    /* 肚子（奶油）：中心亮 → 边缘柔化融入身体 */
    G.belly = mkRadial(ctx, -2.6, 42, 2, -0.5, 50, 28, [
      [0, lighten(belly, 0.34)],
      [0.38, belly],
      [0.72, bellyShade],
      [0.92, rgba(bellyShade, 0.92)],
      [1, rgba(bellyShade, 0.82)]
    ]);
    /* 肚子下缘的鼓起阴影 */
    G.bellyBottom = mkLinear(ctx, 0, 56, 0, 72, [
      [0, rgba(darken(bellyShade, 0.28), 0)],
      [1, rgba(darken(bellyShade, 0.36), 0.55)]
    ]);
    /* 左侧轮廓补光 */
    G.rim = mkLinear(ctx, -31, 20, -16, 25, [
      [0, rgba(lighten(bodyHi, 0.55), 0.5)],
      [0.6, rgba(lighten(bodyHi, 0.55), 0.14)],
      [1, rgba(lighten(bodyHi, 0.55), 0)]
    ]);
    /* 右侧暗边 */
    G.edge = mkLinear(ctx, 31, 24, 15, 30, [
      [0, rgba(darken(bodyShade, 0.3), 0.4)],
      [0.65, rgba(darken(bodyShade, 0.3), 0.12)],
      [1, rgba(darken(bodyShade, 0.3), 0)]
    ]);
    /* 头顶高光（柔和的一大片，不要硬高光斑） */
    G.headHi = mkRadial(ctx, -6.4, 4.6, 1, -6.0, 6.0, 21.0, [
      [0, 'rgba(255,255,255,0.34)'],
      [0.45, 'rgba(255,255,255,0.15)'],
      [1, 'rgba(255,255,255,0)']
    ]);
    /* 手臂：左上→右下 的斜面打光（双臂共用，能同时读出手臂体积） */
    G.arm = mkLinear(ctx, -26, 26, 22, 50, [
      [0, lighten(body, 0.16)],
      [0.3, body],
      [0.56, mix(body, bodyShade, 0.5)],
      [0.82, bodyShade],
      [1, darken(bodyShade, 0.14)]
    ]);
    /* 手臂下沿阴影 / 上沿高光 */
    G.armShade = mkLinear(ctx, 0, 0, 0, 1, [
      [0, 'rgba(0,0,0,0)'], [1, rgba(darken(bodyShade, 0.45), 0.3)]
    ]);
    G.armHi = mkLinear(ctx, 0, 0, 0, 1, [
      [0, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']
    ]);
    /* 腿 */
    G.leg = mkLinear(ctx, 0, 62, 0, 95, [
      [0, mix(body, bodyShade, 0.35)],
      [0.38, body],
      [0.78, mix(body, bodyShade, 0.55)],
      [1, darken(bodyShade, 0.14)]
    ]);
    G.legSideL = mkLinear(ctx, -21, 0, -3.5, 0, [
      [0, 'rgba(255,255,255,0.16)'],
      [0.4, 'rgba(255,255,255,0)'],
      [1, rgba(darken(bodyShade, 0.4), 0.3)]
    ]);
    G.legSideR = mkLinear(ctx, 3.5, 0, 21, 0, [
      [0, 'rgba(255,255,255,0.13)'],
      [0.42, 'rgba(255,255,255,0)'],
      [1, rgba(darken(bodyShade, 0.4), 0.32)]
    ]);
    /* 柔和褶皱 / 接触阴影（单位空间） */
    G.crease = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(darken(bodyShade, 0.5), 0.13)],
      [0.5, rgba(darken(bodyShade, 0.5), 0.06)],
      [1, rgba(darken(bodyShade, 0.5), 0)]
    ]);
    /* 手/手臂贴在奶油肚皮上的极淡接触阴影 */
    G.contactSoft = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(darken(bodyShade, 0.35), 0.13)],
      [0.55, rgba(darken(bodyShade, 0.35), 0.06)],
      [1, rgba(darken(bodyShade, 0.35), 0)]
    ]);
    /* 肚子高光 */
    G.bellyHi = mkRadial(ctx, -4.5, 41, 0.5, -4.0, 43, 15, [
      [0, 'rgba(255,255,255,0.5)'],
      [0.5, 'rgba(255,255,255,0.14)'],
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
    /* 腮红（柔和扩散） */
    G.cheek = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(skin.cheek, 0.4)], [0.55, rgba(skin.cheek, 0.2)], [1, rgba(skin.cheek, 0)]
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
    /* 身体接触阴影（脚下 / 手贴肚子） */
    G.contact = mkRadial(ctx, 0, 0, 0, 0, 0, 1, [
      [0, rgba(darken(bodyShade, 0.45), 0.5)], [1, rgba(darken(bodyShade, 0.45), 0)]
    ]);

    cache[key] = G;
    return G;
  }

  /* ======================================================================
   * 4. 动画参数
   * ==================================================================== */
  var FACE_BY_STATE = {
    idle: 'smile',
    run: 'run',
    laugh: 'laugh',
    hit: 'dizzy',
    happy: 'happy',
    levelup: 'star'
  };

  function autoBlink(t, seed) {
    var period = 4.1 + (seed || 0) * 0.37;
    var p = ((t % period) + period) % period;
    var dur = 0.15;
    if (p < dur) return Math.sin((p / dur) * Math.PI);
    return 0;
  }

  function stateAnim(state, t) {
    var s = Math.sin, a = Math.abs;
    var p = {
      bob: 0, jelly: 0, arm: 0, armSwing: 0, armPhase: 0,
      legLift: 0, legPhase: 0, legSpread: 0, legSwingX: 0,
      bellyWobble: 0, faceTilt: 0, faceY: 0, faceScale: 1,
      glow: 0, shake: 0, sparkle: 0
    };
    switch (state) {
      case 'run':
        p.bob = a(s(t * 10.6)) * 2.7;
        p.jelly = s(t * 21.2) * 0.014;
        p.armSwing = 0.4; p.armPhase = 10.6;
        p.legPhase = 10.6; p.legLift = 5.0; p.legSwingX = 1.2;
        p.bellyWobble = a(s(t * 10.6 + 0.8)) * 0.05;
        p.faceTilt = 0.02;
        break;
      case 'laugh':
        p.bob = a(s(t * 7.0)) * 3.4;
        p.jelly = s(t * 14.0) * 0.02;
        p.arm = 0.04; p.armSwing = 0.06; p.armPhase = 12.0;
        p.legLift = 1.4; p.legPhase = 7.0;
        p.bellyWobble = a(s(t * 14.0 + 0.4)) * 0.07;
        p.faceTilt = -0.055; p.faceY = -1.1;
        break;
      case 'hit':
        p.bob = -1.6;
        p.arm = 0.85; p.armSwing = 0.3; p.armPhase = 18;
        p.shake = 1;
        p.legSpread = 2.2;
        p.faceTilt = 0.1 * s(t * 9);
        p.jelly = s(t * 30) * 0.02;
        break;
      case 'happy':
        p.bob = a(s(t * 6.2)) * 4.4;
        p.arm = 0.95; p.armSwing = 0.28; p.armPhase = 6.2;
        p.legLift = 3.0; p.legPhase = 6.2;
        p.bellyWobble = a(s(t * 6.2 + 0.6)) * 0.05;
        p.jelly = s(t * 12.4) * 0.02;
        break;
      case 'levelup':
        p.bob = 1.6 + a(s(t * 4.6)) * 3.2;
        p.arm = 2.35; p.armSwing = 0.14; p.armPhase = 9.0;
        p.legLift = 2.0; p.legPhase = 4.6;
        p.bellyWobble = a(s(t * 9 + 0.3)) * 0.05;
        p.glow = 0.85 + 0.15 * s(t * 5);
        p.sparkle = t;
        p.faceTilt = -0.03;
        break;
      default: /* idle */
        p.bob = 0.35 + s(t * 1.7) * 0.35;
        p.jelly = s(t * 1.7) * 0.008;
        p.armSwing = 0.05; p.armPhase = 1.7;
        p.legLift = 0;
        p.bellyWobble = a(s(t * 1.7 + 0.5)) * 0.022;
        break;
    }
    return p;
  }

  /* ======================================================================
   * 5. 部件绘制
   * ==================================================================== */

  /* ---- 腿 + 脚（画在身体之前，被身体挡住根部） ---- */
  function drawLegs(ctx, skin, G, t, p) {
    var side, i;
    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      var ph = Math.sin(t * p.legPhase + (i === 0 ? 0 : Math.PI));
      var lift = Math.max(0, ph) * p.legLift;
      var dx = ph * p.legSwingX;
      var hipX = side * (10.8 + p.legSpread * 0.5);
      var hipY = 63.5;
      var ankX = side * 12.2 + dx;
      var ankY = 92.5 - lift;
      var kneeX = (hipX + ankX) * 0.5 + side * 1.4;
      var kneeY = (hipY + ankY) * 0.5;
      var legPts = [[hipX, hipY], [kneeX, kneeY], [ankX, ankY]];
      var legW = [17.2, 14.6, 11.2];

      /* 腿主体（胶囊链 + 纵向渐变） */
      strokeTaper(ctx, legPts, legW, G.leg);

      /* 脚 */
      ctx.save();
      ctx.translate(ankX, ankY);
      ctx.rotate(side * 0.02 + ph * 0.08);
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
        ctx.moveTo(j * 2.4, 8.6);
        ctx.quadraticCurveTo(j * 2.6, 6.4, j * 2.3, 4.6);
        ctx.stroke();
      }
      /* 脚背高光 */
      ctx.save();
      ctx.translate(0, -3.0);
      ctx.scale(8.2, 3.4);
      ctx.fillStyle = G.footHi;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      /* 脚底接触暗部 */
      ctx.save();
      ctx.translate(0, 7.4);
      ctx.scale(8.0, 1.8);
      ctx.fillStyle = 'rgba(38,20,8,0.28)';
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.restore();
    }
  }

  /* ---- 身体 + 肚皮 + 光影 ---- */
  function drawBody(ctx, skin, G, t, p) {
    var SH = sharedGrads(ctx);

    /* 主轮廓 */
    fillBody(ctx, 'body', BODY_PTS, G.body);

    ctx.save();
    clipBody(ctx, 'body', BODY_PTS);

    /* 底部接地压暗 */
    ctx.fillStyle = G.bodyBottom;
    ctx.fillRect(-32, 36, 64, 42);

    /* 左侧轮廓补光 + 右侧暗边（铺满裁剪区，避免硬边） */
    ctx.fillStyle = G.rim;
    ctx.fillRect(-32, 0, 22, 78);
    ctx.fillStyle = G.edge;
    ctx.fillRect(12, 0, 22, 78);

    /* 肚皮（奶油大肚） */
    var wob = 1 + p.bellyWobble;
    ctx.save();
    ctx.translate(0, 50);
    ctx.scale(1 / wob, wob);
    ctx.translate(0, -50);
    fillBody(ctx, 'belly', BELLY_PTS, G.belly);
    ctx.restore();

    /* 肚皮高光 */
    ctx.save();
    ctx.translate(-4.2, 41);
    ctx.scale(13.5, 11.5);
    ctx.fillStyle = G.bellyHi;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 肚皮左侧弧形高光 */
    ctx.save();
    ctx.translate(-9.6, 45);
    ctx.scale(4.0, 11.0);
    ctx.fillStyle = 'rgba(255,255,255,0.24)';
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 肚皮底部：极淡的奶油高光（不要深色晕斑） */
    ctx.save();
    ctx.translate(-1.0, 62.5);
    ctx.scale(13.0, 6.2);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 头顶高光 */
    ctx.save();
    ctx.translate(-6.2, 5.4);
    ctx.scale(19.0, 18.0);
    ctx.fillStyle = G.headHi;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore(); /* end clip */

    /* 极淡的轮廓线，让边缘更干净 */
    ctx.save();
    ctx.strokeStyle = rgba(darken(skin.bodyShade, 0.35), 0.16);
    ctx.lineWidth = 0.7;
    var P = getPaths();
    if (P && P.body) ctx.stroke(P.body);
    else { ctx.beginPath(); traceCurve(ctx, BODY_PTS, true); ctx.stroke(); }
    ctx.restore();

    /* 腿根部的柔和阴影，遮住腿与身体的接缝 */
    for (var i = -1; i <= 1; i += 2) {
      ctx.save();
      ctx.translate(i * 10.6, 71.8);
      ctx.scale(8.8, 4.4);
      ctx.fillStyle = G.crease;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /* ---- 手臂 + 手 ---- */
  function drawArms(ctx, skin, G, t, p) {
    var i, side;

    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      var phase = Math.sin(t * p.armPhase + (i === 0 ? 0 : Math.PI));
      var a = p.arm + p.armSwing * phase;   /* >0 = 手臂向外 / 向上张开 */
      var rot = -side * a;

      var S = [side * 16.4, 35.0];
      var Erel = rotVec(side * 2.2, 5.4, rot);
      var Hrel = rotVec(side * -2.6, 10.2, rot);
      var E = [S[0] + Erel[0], S[1] + Erel[1]];
      var H = [S[0] + Hrel[0], S[1] + Hrel[1]];

      /* 三点香蕉形曲线：肩 → 肘外弧 → 手，短手自然搭在肚皮两侧 */
      var armPts = [S, E, H];
      var armW = [13.6, 11.4, 8.6];

      /* 只保留手贴肚皮的极淡接触阴影（不做整条手臂描边，避免 U 形把手观感） */
      ctx.save();
      clipBody(ctx, 'body', BODY_PTS);
      ctx.save();
      ctx.translate(H[0] + side * 0.6, H[1] + 2.6);
      ctx.scale(6.2, 4.0);
      ctx.fillStyle = G.contactSoft;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.restore();

      /* 手臂主体（圆润软管，无描边 → 不会出现细线） */
      strokeTaper(ctx, armPts, armW, G.arm);

      /* 上沿柔光 */
      ctx.save();
      ctx.strokeStyle = rgba(lighten(skin.bodyHi, 0.7), 0.3);
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.8;
      smoothPath(ctx, offsetPts(armPts, -side * 2.4, -2.4));
      ctx.stroke();
      ctx.restore();

      /* 手（深棕小胖手，掌心贴住肚皮、手指朝内侧张开） */
      ctx.save();
      ctx.translate(H[0], H[1]);
      ctx.rotate(side * (0.55 + a * 0.3));
      if (side < 0) ctx.scale(-1, 1);

      ctx.fillStyle = G.hand;
      ctx.beginPath();
      ctx.ellipse(0.3, 0.4, 5.0, 5.1, 0.3, 0, Math.PI * 2);
      ctx.fill();

      /* 三根手指：沿内侧向下张开 */
      var fingers = [[-4.4, 0.6, 2.0, 1.6, 0.45],
      [-4.9, 2.6, 2.0, 1.55, 0.2],
      [-3.9, 4.5, 1.85, 1.5, -0.15]];
      for (var f = 0; f < fingers.length; f++) {
        ctx.beginPath();
        ctx.ellipse(fingers[f][0], fingers[f][1], fingers[f][2], fingers[f][3], fingers[f][4], 0, Math.PI * 2);
        ctx.fill();
      }
      /* 拇指（朝上内侧） */
      ctx.beginPath();
      ctx.ellipse(-0.9, -4.1, 1.9, 1.5, -0.6, 0, Math.PI * 2);
      ctx.fill();

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

  function drawEyes(ctx, skin, G, style, blink) {
    var i, side, ex = FACE.eyeX, ey = FACE.eyeY;
    var openScale = 1 - blink * 0.88;

    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      var x = side * ex;

      if (style === 'open' || style === 'wide') {
        var big = style === 'wide' ? 1.24 : 1;
        ctx.save();
        ctx.translate(x, ey);
        ctx.scale(1, Math.max(0.12, openScale));
        var g = G.eye;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.1 * big, 3.45 * big, 0, 0, Math.PI * 2);
        ctx.fill();
        /* 上眼睑暗边 */
        ctx.strokeStyle = rgba(darken(skin.eye, 0.2), 0.45);
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.1 * big, 3.45 * big, 0, Math.PI * 1.05, Math.PI * 1.95);
        ctx.stroke();
        /* 高光 */
        ctx.fillStyle = skin.teeth;
        ctx.beginPath();
        ctx.arc(-1.1 * big, -1.3 * big, 1.2 * big, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(skin.teeth, 0.55);
        ctx.beginPath();
        ctx.arc(1.0 * big, 1.35 * big, 0.58 * big, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        /* 眨眼完成时补一条闭眼线 */
        if (blink > 0.72) {
          ctx.strokeStyle = skin.eye;
          ctx.lineWidth = 1.0;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x - 3.0, ey + 0.6);
          ctx.quadraticCurveTo(x, ey + 2.0, x + 3.0, ey + 0.6);
          ctx.stroke();
        }
      } else if (style === 'happyArc') {
        /* 弯月笑眼：短弧、略低，配合大笑嘴 */
        ctx.strokeStyle = skin.eye;
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 2.9, ey + 2.4);
        ctx.quadraticCurveTo(x, ey + 0.2, x + 2.9, ey + 2.4);
        ctx.stroke();
      } else if (style === 'x') {
        ctx.strokeStyle = skin.eye;
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 2.7, ey - 2.7); ctx.lineTo(x + 2.7, ey + 2.7);
        ctx.moveTo(x + 2.7, ey - 2.7); ctx.lineTo(x - 2.7, ey + 2.7);
        ctx.stroke();
      } else if (style === 'star') {
        drawEyeStar(ctx, x, ey, 4.4, skin.eye);
        drawEyeStar(ctx, x, ey, 2.5, mix(skin.accent, '#FFFFFF', 0.35));
        /* 星芒 */
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
  function drawMouth(ctx, skin, G, kind, open) {
    var cx = FACE.mouthX, cy = FACE.mouthY;
    var s = open === undefined ? 1 : open;
    var i;

    ctx.save();
    ctx.translate(cx, cy);

    if (kind === 'smile') {
      ctx.strokeStyle = skin.mouth;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-5.6, -1.2);
      ctx.quadraticCurveTo(-2.6, 2.8, 0, 3.0);
      ctx.quadraticCurveTo(2.6, 2.8, 5.6, -1.2);
      ctx.stroke();
      /* 嘴角小窝 */
      ctx.fillStyle = rgba(skin.mouth, 0.5);
      ctx.beginPath(); ctx.arc(-5.8, -1.5, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(5.8, -1.5, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return;
    }

    if (kind === 'wavy') {
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
      return;
    }

    if (kind === 'o') {
      var pathName = 'o';
      fillMouth(ctx, pathName, 'o', skin.mouth);
      ctx.save();
      clipMouth(ctx, pathName, 'o');
      /* 舌 */
      ctx.fillStyle = mix(skin.cheek, skin.mouth, 0.32);
      ctx.beginPath();
      ctx.ellipse(0, 3.0, 2.2, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = G.throat;
      ctx.fillRect(-4, -5, 8, 9);
      ctx.restore();
      ctx.restore();
      return;
    }

    /* laugh / grin：张嘴（同一嘴形，grin 缩小一圈） */
    var name = 'laugh';
    var mscale = kind === 'grin' ? 0.64 : 1;
    ctx.scale(mscale, mscale);

    var P = getPaths();
    /* 口腔底色 */
    fillMouth(ctx, name, kind, skin.mouth);

    /* 口腔内部（裁剪） */
    ctx.save();
    clipMouth(ctx, name, kind);

    /* 顶部深喉阴影 */
    ctx.fillStyle = G.throat;
    ctx.fillRect(-14, -9, 28, 19);

    /* 上牙：沿上唇的一排白牙 */
    var teethH = 3.5;
    var teethTop = -6.6;
    ctx.fillStyle = skin.teeth;
    ctx.beginPath();
    ctx.moveTo(-11.0, -3.0);
    ctx.bezierCurveTo(-7.0, -6.4, 7.0, -6.4, 11.0, -3.0);
    ctx.lineTo(10.0, -3.0 + teethH);
    ctx.bezierCurveTo(6.6, -5.2 + teethH, -6.6, -5.2 + teethH, -10.0, -3.0 + teethH);
    ctx.closePath();
    ctx.fill();
    /* 牙齿缝隙 */
    ctx.strokeStyle = rgba(skin.mouth, 0.22);
    ctx.lineWidth = 0.55;
    var xs = [-8.2, -5.4, -2.7, 0, 2.7, 5.4, 8.2];
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
    ctx.moveTo(-9.4, -3.0 + teethH + 0.7);
    ctx.bezierCurveTo(-6.0, -5.0 + teethH + 0.7, 6.0, -5.0 + teethH + 0.7, 9.4, -3.0 + teethH + 0.7);
    ctx.stroke();

    /* 舌头 */
    var tongue = mix(skin.cheek, skin.mouth, 0.3);
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.ellipse(0, 6.6, 5.6, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(darken(tongue, 0.18), 0.5);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-4.4, 5.8);
    ctx.quadraticCurveTo(0, 4.0, 4.4, 5.8);
    ctx.stroke();
    /* 舌头高光 */
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(-1.4, 7.4, 2.0, 1.0, -0.2, 0, Math.PI * 2);
    ctx.fill();

    /* 下颌暗影 */
    ctx.fillStyle = rgba(darken(skin.mouth, 0.25), 0.35);
    ctx.beginPath();
    ctx.ellipse(0, 9.8, 9.0, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore(); /* end mouth clip */

    /* 嘴唇描边（下唇略厚） */
    ctx.strokeStyle = rgba(darken(skin.mouth, 0.15), 0.85);
    ctx.lineWidth = 0.9;
    ctx.lineJoin = 'round';
    var P2 = getPaths();
    if (P2 && P2[name]) ctx.stroke(P2[name]);
    else { ctx.beginPath(); traceMouth(ctx, kind); ctx.stroke(); }

    /* 上唇高光 */
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-8.6, 0.2);
    ctx.quadraticCurveTo(0, 1.2, 8.6, 0.2);
    ctx.stroke();

    ctx.restore();
  }

  /* ---- 脸部整体 ---- */
  function drawFace(ctx, skin, G, face, blink, p) {
    var SH = sharedGrads(ctx);
    var i, side;

    ctx.save();
    /* 仰头 / 摇头：以头部中心为轴 */
    ctx.translate(0, p.faceY);
    if (p.faceTilt) {
      ctx.translate(0, 14);
      ctx.rotate(p.faceTilt);
      ctx.translate(0, -14);
    }

    /* 腮红 */
    for (i = 0; i < 2; i++) {
      side = i === 0 ? -1 : 1;
      ctx.save();
      ctx.translate(side * FACE.cheekX, FACE.cheekY);
      ctx.scale(5.6, 3.9);
      ctx.fillStyle = G.cheek;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    var eyeStyle = 'open', mouthKind = 'smile', mouthOpen = 1;
    switch (face) {
      case 'laugh': eyeStyle = 'happyArc'; mouthKind = 'laugh'; break;
      case 'run': eyeStyle = 'open'; mouthKind = 'grin'; break;
      case 'happy': eyeStyle = 'happyArc'; mouthKind = 'grin'; break;
      case 'wow': eyeStyle = 'wide'; mouthKind = 'o'; break;
      case 'dizzy': eyeStyle = 'x'; mouthKind = 'wavy'; break;
      case 'star': eyeStyle = 'star'; mouthKind = 'grin'; break;
      default: eyeStyle = 'open'; mouthKind = 'smile'; break;
    }

    drawEyes(ctx, skin, G, eyeStyle, blink);
    drawMouth(ctx, skin, G, mouthKind, mouthOpen);

    ctx.restore();
  }

  /* ---- 升级光环 ---- */
  function drawAura(ctx, skin, G, t, strength) {
    var SH = sharedGrads(ctx);
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

  /* ---- 小装饰：跑动时的速度小尾迹 ---- */
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
   * 6. 对外 API
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
    /* 受击挤压 + 果冻拉伸，都以脚底为基准 */
    var sy = (1 - 0.26 * squash) * (1 + p.jelly);
    var sx = (1 + 0.22 * squash) * (1 - p.jelly * 0.7);

    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * alpha;
    ctx.translate(opts.x || 0, opts.y || 0);
    if (lean) ctx.rotate(lean);
    ctx.scale(s * sx, s * sy);
    ctx.translate(0, -100);            /* 设计空间 y: 0=头顶, 100=脚底 */
    if (p.shake) ctx.translate(Math.sin(t * 54) * 1.6, 0);

    if (state === 'levelup') drawAura(ctx, skin, G, t, p.glow);
    if (state === 'run') drawRunTrails(ctx, skin, t);

    ctx.translate(0, -p.bob);

    drawLegs(ctx, skin, G, t, p);
    drawBody(ctx, skin, G, t, p);
    drawArms(ctx, skin, G, t, p);
    drawFace(ctx, skin, G, face, blink, p);

    ctx.restore();
  }

  /* 地面软阴影 */
  function drawShadow(ctx, x, y, rx, alpha) {
    if (!ctx || !ctx.beginPath) return;
    rx = (rx > 0) ? rx : 40;
    alpha = (alpha === undefined || alpha === null) ? 1 : clamp(alpha, 0, 1);
    if (alpha <= 0.003) return;
    var SH = sharedGrads(ctx);

    ctx.save();
    ctx.translate(x || 0, y || 0);
    ctx.globalAlpha = ctx.globalAlpha * alpha;

    /* 外层柔和投影 */
    ctx.save();
    ctx.scale(rx, rx * 0.34);
    ctx.fillStyle = SH.softShadow;
    ctx.beginPath(); ctx.arc(0, 0, 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* 内层接地暗部 */
    ctx.save();
    ctx.scale(rx * 0.62, rx * 0.17);
    ctx.fillStyle = 'rgba(74,42,16,0.3)';
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  art.Character = {
    draw: drawCharacter,
    drawShadow: drawShadow,
    /* 便于调试 / 预览页使用 */
    STATES: ['idle', 'run', 'laugh', 'hit', 'happy', 'levelup'],
    FACES: ['laugh', 'smile', 'wow', 'dizzy', 'star']
  };
})(typeof window !== 'undefined' ? window : globalThis);
