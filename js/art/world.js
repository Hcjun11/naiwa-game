/* ==========================================================================
 * 《奶娃》跑酷 × 2048 合成 —— 场景渲染模块 NW.art.World
 * 负责人：队友 C（world-art）
 *
 * 对外 API（严格按 docs/SPEC.md 4.3）：
 *   NW.art.World.drawBackground(ctx, scene)   天空/日月星云/远景视差/地面/雾化
 *   NW.art.World.drawRoad(ctx, scene)         伪 3D 跑道：分段亮暗滚动/车道虚线/边线/路肩/路杆
 *   NW.art.World.drawProps(ctx, scene)        两侧主题装饰（树/椰树/水晶/棒棒糖）+ 地面细节
 *   NW.art.World.drawEntities(ctx, scene)     数字方块/障碍/金币/道具（按 z 由远及近）
 *   NW.art.World.draw(ctx, scene)             便捷绘制（菜单静态背景用）
 *
 * 约定：逻辑坐标 540×960；世界 -> 屏幕使用 NW.util.project(x, y, z, camX)；
 *       玩家固定 z=0，实体从 z=88 逼近；所有公开函数自带 save/restore，不污染外部 ctx。
 * 依赖：NW.CFG / NW.util（未加载时内置最小降级实现，preview 可独立运行）。
 * 美术：全部程序化绘制，无外部图片/字体。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = global.NW || (global.NW = {});
  var CFG = NW.CFG || {};
  var W = CFG.W || 540;
  var H = CFG.H || 960;
  var CAM = CFG.cam || {
    f: 820, camY: 2.55, camZ: -6.5, horizonY: 340, followX: 0.32, laneCurve: 2.2
  };
  var WORLD = CFG.world || {
    lanes: 3, laneW: 1.35, roadHalf: 2.45, shoulder: 0.55, playerHeight: 2.05, spawnZ: 88, cullZ: -8
  };
  var U = NW.util || makeFallbackUtil();
  var TAU = Math.PI * 2;
  var FONT_NUM = (CFG.fonts && CFG.fonts.num) || '"Arial Black", "Microsoft YaHei", sans-serif';
  var FONT_UI = (CFG.fonts && CFG.fonts.ui) || '"Microsoft YaHei", "PingFang SC", sans-serif';

  /* ======================================================================
   * 一、纯视觉常量（SPEC 允许渲染层自定；可调参数仍全部优先读取 NW.CFG）
   * ==================================================================== */
  var V = {
    /* 跑道纵向范围（世界米）。近端取 -6 保证近裁剪时跑道仍铺满屏幕底部 */
    roadNearZ: -6,
    roadFarZ: WORLD.spawnZ || 88,
    bandLen: 5.5,           // 跑道亮暗分段长度（米），滚动周期 = 2×bandLen
    dashPeriod: 6,          // 车道虚线周期（米）
    dashLen: 2.6,           // 虚线段长（米）
    dashWidth: 0.13,        // 虚线宽（世界单位）
    edgeWidth: 0.12,        // 边线宽（世界单位）
    shoulderBlock: 6,       // 路肩色块周期（米）
    postPeriod: 11,         // 路边导向杆间距（米）
    postHeight: 0.42,       // 导向杆高度（世界单位）
    propPeriod: 6.5,        // 两侧装饰间距（米）
    fogStart: 52,           // 装饰/实体开始被雾化的距离
    entityFar: WORLD.spawnZ || 88,
    entityNear: 0.3,        // 更靠近相机（z<0.3，含已越过玩家的）不再绘制
    nearFadeZ: 2.5,         // z<2.5 的实体淡出，收集/撞击瞬间更自然
    tileWorld: (CFG.tileSize && CFG.tileSize.world) || 0.95,
    tileY: (CFG.tileSize && CFG.tileSize.y) || 0.55,
    coinY: 0.86,
    powerY: 1.1,
    coinR: 0.3,
    powerR: 0.46,
    obstacleW: 1.05,
    obstacleH: 1.3
  };

  var COL = {
    shadow: '#2A1A10',
    coinRim: '#C88A1A', coin: '#FFD54F', coinHi: '#FFE082',
    crateWood: '#C98B4B', crateFace: '#D9A05C', crateFrame: '#8A5426', crateBrace: '#A9713B',
    caution: '#F7C948', cautionDark: '#4A3A22',
    rock: '#8E93A6', rockHi: '#B9BFD0', rockDark: '#646A7C', rockCrack: '#565C6E',
    barrel: '#C98B4B', barrelFace: '#D9A05C', barrelBand: '#6B4A2A', barrelRed: '#F24822',
    seaTop: '#FFEAC8', seaMid: '#FFD79E', seaBottom: '#E9A87C',
    seaGlint: '#FFF6E0', danger: '#FF5252',
    nightGlint: '#CFE4FF'
  };

  /* 主题缺字段时的兜底（正常情况下始终来自 CFG.themes） */
  var FALLBACK_THEME = {
    id: 'day', name: '晴日草原', skyTop: '#79C7FF', skyMid: '#BFE9FF', skyBottom: '#EAF9FF',
    sun: { color: '#FFF3B0', glow: '#FFE066', x: 0.78, y: 0.16, r: 46 },
    cloud: '#FFFFFF', groundFar: '#A6E06B', groundNear: '#79C94F',
    roadLight: '#F7C97F', roadDark: '#EFB35E', laneLine: '#FFF6E0', edge: '#E39A4A',
    fog: '#EAF9FF', props: 'tree',
    prop: { trunk: '#9A6234', leaf: '#5FBF52', leaf2: '#7ED968', accent: '#FFE066' },
    ambient: 'day', star: false
  };

  /* ======================================================================
   * 二、降级工具（仅当 NW.util 未加载时启用，保证本模块独立可跑）
   * ==================================================================== */
  function makeFallbackUtil() {
    var F = {};
    F.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
    F.lerp = function (a, b, t) { return a + (b - a) * t; };
    F.mix = function (a, b, t) { return a; };
    F.rgba = function (c, a) { return 'rgba(0,0,0,' + (a === undefined ? 1 : a) + ')'; };
    F.lighten = function (c) { return c; };
    F.darken = function (c) { return c; };
    F.roundRectPath = function (ctx, x, y, w, h, r) {
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
    F.fillRoundRect = function (ctx, x, y, w, h, r, fill) {
      F.roundRectPath(ctx, x, y, w, h, r);
      if (fill) ctx.fillStyle = fill;
      ctx.fill();
    };
    F.strokeRoundRect = function (ctx, x, y, w, h, r, stroke, lw) {
      F.roundRectPath(ctx, x, y, w, h, r);
      if (stroke) ctx.strokeStyle = stroke;
      if (lw) ctx.lineWidth = lw;
      ctx.stroke();
    };
    F.fillEllipse = function (ctx, cx, cy, rx, ry, fill) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU);
      if (fill) ctx.fillStyle = fill;
      ctx.fill();
    };
    F.fillCircle = function (ctx, cx, cy, r, fill) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.1, r), 0, TAU);
      if (fill) ctx.fillStyle = fill;
      ctx.fill();
    };
    F.fillStar = function (ctx, cx, cy, outer, inner, points, rotation, fill) {
      var n = points || 5, i;
      ctx.beginPath();
      for (i = 0; i < n * 2; i++) {
        var ang = (i * Math.PI) / n + (rotation || 0);
        var rad = i % 2 === 0 ? outer : inner;
        var px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      if (fill) ctx.fillStyle = fill;
      ctx.fill();
    };
    F.projectScale = function (z) {
      var dz = z - CAM.camZ;
      if (dz < 0.35) dz = 0.35;
      return CAM.f / dz;
    };
    F.project = function (x, y, z, camX) {
      var scale = F.projectScale(z);
      return { x: W / 2 + (x - (camX || 0)) * scale, y: CAM.horizonY + (CAM.camY - (y || 0)) * scale, scale: scale };
    };
    return F;
  }

  var warned = {};
  var lastErr = null;
  function warnOnce(key, err) {
    lastErr = { key: key, err: err };
    if (warned[key]) return;
    warned[key] = 1;
    try { if (global.console && global.console.warn) global.console.warn('[NW.art.World] ' + key, err); } catch (e) { }
  }

  /* ======================================================================
   * 三、通用小工具：颜色 / 数学 / 确定性随机
   * ==================================================================== */
  function mod(n, m) { return ((n % m) + m) % m; }
  function hash01(n) {
    var x = Math.sin(n) * 43758.5453123;
    return x - Math.floor(x);
  }
  function hashStr(str) {
    var h = 2166136261, i;
    str = String(str);
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rngFor(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 颜色解析（兼容 #hex / rgb() / rgba()，避免 util.mix 链式调用时格式不匹配） */
  function parseColor(c) {
    if (typeof c !== 'string') return [0, 0, 0];
    var s = c.replace(/\s+/g, '');
    if (s.charAt(0) === '#') {
      s = s.slice(1);
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var num = parseInt(s, 16);
      if (isNaN(num)) return [0, 0, 0];
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    }
    var m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var parts = m[1].split(',');
      return [parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, parseInt(parts[2], 10) || 0];
    }
    return [0, 0, 0];
  }
  function colorA(color, alpha) {
    var p = parseColor(color);
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + (alpha === undefined ? 1 : alpha) + ')';
  }
  function mixColor(a, b, t) {
    var pa = parseColor(a), pb = parseColor(b);
    var r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    var g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    var bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function lighten(color, t) { return mixColor(color, '#FFFFFF', t); }
  function darken(color, t) { return mixColor(color, '#000000', t); }

  function laneXOf(lane) {
    if (typeof CFG.laneX === 'function') return CFG.laneX(lane);
    return (lane - (WORLD.lanes - 1) / 2) * WORLD.laneW;
  }
  function tileColorOf(value) {
    if (typeof CFG.tileColor === 'function') return CFG.tileColor(value);
    var map = CFG.tileColors || {};
    return map[value] || map.other || { a: '#FFFFFF', b: '#B9B9C9', text: '#333344' };
  }
  function powerInfo(power) {
    if (CFG.powerups && CFG.powerups[power]) return CFG.powerups[power];
    return { id: power, name: power, color: '#FFD54F', color2: '#F9A825' };
  }

  /* ======================================================================
   * 四、场景数据归一化（对缺失字段全部容错）
   * ==================================================================== */
  var EMPTY_LIST = [];
  var themeResolveSrc = null, themeResolveOut = null;
  function resolveTheme(src) {
    if (src === themeResolveSrc && themeResolveOut) return themeResolveOut;
    var t = src;
    var themes = CFG.themes || EMPTY_LIST;
    if (typeof t === 'string') {
      for (var i = 0; i < themes.length; i++) {
        if (themes[i] && themes[i].id === t) { t = themes[i]; break; }
      }
    }
    var base = themes[0] || FALLBACK_THEME;
    if (!t || typeof t !== 'object') t = base;
    if (t !== base) {
      /* 合并兜底字段（自定义/残缺主题也能画） */
      var out = {};
      var k;
      for (k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k]; }
      for (k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) out[k] = t[k]; }
      t = out;
    }
    themeResolveSrc = src;
    themeResolveOut = t;
    return t;
  }
  function sceneState(scene) {
    var s = scene || {};
    var theme = resolveTheme(s.theme);
    var speed = (typeof s.speed === 'number' && isFinite(s.speed)) ? s.speed : 6.2;
    var t = (typeof s.t === 'number' && isFinite(s.t)) ? s.t : 0;
    var menu = !!s.menu;
    var distance = (typeof s.distance === 'number' && isFinite(s.distance))
      ? s.distance : t * speed * (menu ? 0.35 : 1);
    var player = s.player || {};
    var camX = 0;
    if (typeof s.camX === 'number' && isFinite(s.camX)) camX = s.camX;
    else if (typeof player.x === 'number' && isFinite(player.x)) camX = player.x * (CAM.followX || 0.32);
    var ents = (s.entities && s.entities.length) ? s.entities : EMPTY_LIST;
    return {
      t: t, speed: speed, distance: distance, theme: theme, camX: camX,
      entities: ents, player: player, menu: menu,
      mode: s.mode || null, powerups: s.powerups || {}
    };
  }

  /* ======================================================================
   * 五、缓存：渐变 / 发光贴图 / 天空装饰点
   * ==================================================================== */
  var gradCtx = null, gradThemeId = null, gradStore = null;
  function gradsFor(ctx, theme) {
    if (gradCtx !== ctx || gradThemeId !== theme.id) {
      gradCtx = ctx;
      gradThemeId = theme.id;
      gradStore = buildGrads(ctx, theme);
    }
    return gradStore;
  }
  function buildGrads(ctx, th) {
    var g = {};
    var horizon = CAM.horizonY;
    var amb = th.ambient || 'day';
    var sun = th.sun || {};
    var sx = (typeof sun.x === 'number' ? sun.x : 0.78) * W;
    var sy = (typeof sun.y === 'number' ? sun.y : 0.16) * H;
    var sr = sun.r || 46;
    var glowColor = sun.glow || '#FFE066';

    var sky = ctx.createLinearGradient(0, 0, 0, horizon + 60);
    sky.addColorStop(0, th.skyTop || '#79C7FF');
    sky.addColorStop(0.62, th.skyMid || '#BFE9FF');
    sky.addColorStop(1, th.skyBottom || '#EAF9FF');
    g.sky = sky;

    var ground = ctx.createLinearGradient(0, horizon, 0, H);
    ground.addColorStop(0, th.groundFar || '#A6E06B');
    ground.addColorStop(1, th.groundNear || '#79C94F');
    g.ground = ground;

    /* 跑道分段配色：在 CFG 主题色基础上按主题微调对比，保证亮暗滚动可见 */
    var edgeCol = th.edge || '#E39A4A';
    g.bandLight = amb === 'night'
      ? lighten(th.roadLight || '#5B4A8A', 0.1)
      : lighten(th.roadLight || '#F7C97F', amb === 'candy' ? 0.05 : 0.02);
    g.bandDark = amb === 'night'
      ? mixColor(th.roadDark || '#4A3A75', '#221C4A', 0.5)
      : (amb === 'candy'
        ? mixColor(th.roadDark || '#FFDCF0', edgeCol, 0.32)
        : mixColor(th.roadDark || '#EFB35E', edgeCol, amb === 'sunset' ? 0.3 : 0.16));
    g.roadMid = mixColor(th.roadLight || '#F7C97F', th.roadDark || '#EFB35E', 0.55);

    if (amb === 'night') {
      var mg = ctx.createRadialGradient(sx, sy, sr * 0.3, sx, sy, sr * 7);
      mg.addColorStop(0, colorA('#EAF0FF', 0.5));
      mg.addColorStop(0.25, colorA(glowColor, 0.26));
      mg.addColorStop(0.6, colorA(glowColor, 0.07));
      mg.addColorStop(1, colorA(glowColor, 0));
      g.moonGlow = mg;
    } else {
      var sg = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * (amb === 'sunset' ? 5.4 : 4));
      sg.addColorStop(0, colorA(glowColor, 0.85));
      sg.addColorStop(0.3, colorA(glowColor, amb === 'sunset' ? 0.48 : 0.3));
      sg.addColorStop(0.65, colorA(glowColor, 0.1));
      sg.addColorStop(1, colorA(glowColor, 0));
      g.sunGlow = sg;
    }

    var fogA = amb === 'night' ? 0.55 : (amb === 'sunset' ? 0.4 : 0.58);
    var fog = ctx.createLinearGradient(0, horizon - 8, 0, horizon + 104);
    fog.addColorStop(0, colorA(th.fog || '#EAF9FF', fogA));
    fog.addColorStop(0.42, colorA(th.fog || '#EAF9FF', fogA * 0.4));
    fog.addColorStop(1, colorA(th.fog || '#EAF9FF', 0));
    g.fog = fog;

    var hg = ctx.createLinearGradient(0, horizon - 70, 0, horizon + 34);
    hg.addColorStop(0, colorA(glowColor, 0));
    hg.addColorStop(0.72, colorA(glowColor, amb === 'night' ? 0.05 : 0.13));
    hg.addColorStop(1, colorA(glowColor, 0));
    g.horizonSheen = hg;

    var rs = ctx.createLinearGradient(0, horizon + 130, 0, H);
    rs.addColorStop(0, 'rgba(0,0,0,0)');
    rs.addColorStop(1, 'rgba(0,0,0,0.13)');
    g.roadShade = rs;

    var gv = ctx.createLinearGradient(0, horizon + 70, 0, H);
    gv.addColorStop(0, 'rgba(0,0,0,0)');
    gv.addColorStop(1, 'rgba(0,0,0,0.07)');
    g.groundVignette = gv;

    /* 黄昏海面 */
    if (amb === 'sunset') {
      var sea = ctx.createLinearGradient(0, horizon - 2, 0, horizon + 34);
      sea.addColorStop(0, '#FFD9A0');
      sea.addColorStop(0.3, '#F0A070');
      sea.addColorStop(0.68, '#D4775E');
      sea.addColorStop(1, '#A9544A');
      g.sea = sea;
    }
    /* 夜晚地平线月光雾（提升远景层次） */
    if (amb === 'night') {
      var ng = ctx.createLinearGradient(0, horizon - 30, 0, horizon + 150);
      ng.addColorStop(0, colorA('#8FA2FF', 0));
      ng.addColorStop(0.35, colorA('#8FA2FF', 0.12));
      ng.addColorStop(1, colorA('#8FA2FF', 0));
      g.nightHaze = ng;
    }
    return g;
  }

  var glowCache = {};
  function createCanvas(w, h) {
    if (global.document && global.document.createElement) {
      var c = global.document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    return null;
  }
  function glowSprite(color) {
    var key = String(color);
    if (glowCache[key]) return glowCache[key];
    var c = createCanvas(96, 96);
    if (!c) return null;
    var g = c.getContext ? c.getContext('2d') : null;
    if (!g) return null;
    var grd = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    grd.addColorStop(0, colorA('#FFFFFF', 0.92));
    grd.addColorStop(0.22, colorA(color, 0.78));
    grd.addColorStop(0.55, colorA(color, 0.26));
    grd.addColorStop(1, colorA(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, 96, 96);
    glowCache[key] = c;
    return c;
  }
  function drawGlow(ctx, color, cx, cy, r, alpha) {
    var sp = glowSprite(color);
    if (!sp) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(sp, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  /* 棒棒糖糖头预渲染贴图（螺旋线只画一次，每帧 drawImage） */
  var lolliCache = {};
  function lolliSprite(color) {
    var key = String(color);
    if (lolliCache[key] !== undefined) return lolliCache[key];
    var c = createCanvas(128, 128);
    if (!c) { lolliCache[key] = null; return null; }
    var g2 = c.getContext ? c.getContext('2d') : null;
    if (!g2) { lolliCache[key] = null; return null; }
    var cx = 64, cy = 64, rr0 = 60;
    g2.fillStyle = color;
    g2.beginPath(); g2.arc(cx, cy, rr0, 0, TAU); g2.fill();
    g2.strokeStyle = colorA('#FFFFFF', 0.92);
    g2.lineWidth = 4.6;
    g2.lineCap = 'round';
    g2.beginPath();
    var turns2 = Math.PI * 4.4;
    for (var a2 = 0; a2 <= turns2; a2 += 0.28) {
      var r2 = rr0 * (a2 / turns2) * 0.86;
      var px2 = cx + Math.cos(a2) * r2;
      var py2 = cy + Math.sin(a2) * r2;
      if (a2 === 0) g2.moveTo(px2, py2); else g2.lineTo(px2, py2);
    }
    g2.stroke();
    g2.fillStyle = colorA('#FFFFFF', 0.75);
    g2.beginPath(); g2.ellipse(cx - rr0 * 0.34, cy - rr0 * 0.4, rr0 * 0.24, rr0 * 0.13, 0, 0, TAU); g2.fill();
    lolliCache[key] = c;
    return c;
  }

  /* 主题静态装饰（固定坐标 + 视差滚动）只生成一次 */
  var staticCache = {};
  function staticFor(theme) {
    var id = theme.id || 'default';
    if (staticCache[id]) return staticCache[id];
    var rng = rngFor(hashStr(id + '|nw-world'));
    var st = { stars: [], clouds: [], sparkles: [] };
    var horizon = CAM.horizonY;
    var i;
    for (i = 0; i < 72; i++) {
      st.stars.push({
        x: rng() * W,
        y: 8 + rng() * (horizon - 44),
        r: 0.5 + rng() * 1.5,
        a: 0.35 + rng() * 0.65,
        ph: rng() * TAU,
        sp: 0.5 + rng() * 2.2,
        big: rng() > 0.9
      });
    }
    for (i = 0; i < 7; i++) {
      st.clouds.push({
        x: rng() * W,
        y: 30 + rng() * (horizon - 150),
        s: 34 + rng() * 56,
        sp: 0.55 + rng() * 0.9,
        a: 0.6 + rng() * 0.4
      });
    }
    for (i = 0; i < 22; i++) {
      st.sparkles.push({
        x: rng() * W,
        y: 16 + rng() * (horizon - 80),
        r: 1.2 + rng() * 2.2,
        ph: rng() * TAU,
        sp: 1.2 + rng() * 2.4
      });
    }
    staticCache[id] = st;
    return st;
  }

  /* 夜空静态星点离屏图（按主题缓存，避免每帧画几十个点） */
  var starFieldCache = {};
  function starFieldSprite(theme, st, horizon) {
    var key = theme.id || 'night';
    if (starFieldCache[key] !== undefined) return starFieldCache[key];
    var c = createCanvas(W, Math.max(1, horizon - 20));
    if (!c) { starFieldCache[key] = null; return null; }
    var g2 = c.getContext ? c.getContext('2d') : null;
    if (!g2) { starFieldCache[key] = null; return null; }
    for (var i = 0; i < st.stars.length; i++) {
      var s = st.stars[i];
      if (s.big) continue;
      g2.globalAlpha = s.a;
      g2.fillStyle = '#FFFFFF';
      var ss = s.r * 1.8;
      g2.fillRect(s.x - ss / 2, s.y - ss / 2, ss, ss);
    }
    starFieldCache[key] = c;
    return c;
  }

  /* ======================================================================
   * 六、背景：天空 / 日月 / 星云 / 云 / 远景视差 / 地面 / 海 / 雾
   * ==================================================================== */
  function yAt(z) {
    return CAM.horizonY + CAM.camY * U.projectScale(z);
  }

  function drawSkyDecor(ctx, S, g) {
    var th = S.theme;
    var st = staticFor(th);
    var amb = th.ambient || 'day';
    var horizon = CAM.horizonY;
    var i;
    if (th.star || amb === 'night') {
      /* 银河（低透明度椭圆带，静态） */
      ctx.save();
      ctx.translate(W * 0.44, horizon * 0.52);
      ctx.rotate(-0.44);
      ctx.fillStyle = colorA('#B8A8FF', 0.055);
      ctx.beginPath(); ctx.ellipse(0, 0, W * 0.66, 76, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = colorA('#D9CCFF', 0.04);
      ctx.beginPath(); ctx.ellipse(40, -12, W * 0.44, 38, 0.12, 0, TAU); ctx.fill();
      ctx.restore();
      /* 静态星点预渲染成离屏图，每帧只 blit 一次；亮星/少数星星实时闪烁 */
      var starField = starFieldSprite(th, st, horizon);
      if (starField) {
        ctx.drawImage(starField, 0, 0);
        for (i = 0; i < st.stars.length; i++) {
          var star = st.stars[i];
          if (!star.big && (i % 6) !== 0) continue;
          var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(S.t * star.sp + star.ph));
          ctx.globalAlpha = star.a * tw;
          if (star.big) {
            U.fillStar(ctx, star.x, star.y, star.r * 2.6, star.r * 0.9, 4, Math.PI / 4, '#FFF7D6');
          } else {
            var ss = star.r * 2.0;
            ctx.fillRect(star.x - ss / 2, star.y - ss / 2, ss, ss);
          }
        }
      } else {
        for (i = 0; i < st.stars.length; i++) {
          var star2 = st.stars[i];
          var tw2 = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(S.t * star2.sp + star2.ph));
          ctx.globalAlpha = star2.a * tw2;
          ctx.fillStyle = star2.big ? '#FFF7D6' : '#FFFFFF';
          if (star2.big) {
            U.fillStar(ctx, star2.x, star2.y, star2.r * 2.6, star2.r * 0.9, 4, Math.PI / 4, '#FFF7D6');
          } else {
            var ss2 = star2.r * 1.8;
            ctx.fillRect(star2.x - ss2 / 2, star2.y - ss2 / 2, ss2, ss2);
          }
        }
      }
      ctx.globalAlpha = 1;
      /* 偶尔划过的流星 */
      var cyc = (S.t % 7) / 7;
      if (cyc < 0.055 && !S.menu) {
        var k = cyc / 0.055;
        var mx = W * (0.16 + 0.5 * k), my = horizon * (0.1 + 0.22 * k);
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx - 64, my + 26); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    if (amb === 'candy') {
      for (i = 0; i < st.sparkles.length; i += 1) {
        var sp = st.sparkles[i];
        var twk = 0.5 + 0.5 * Math.sin(S.t * sp.sp + sp.ph);
        if (twk < 0.5) continue;
        ctx.globalAlpha = 0.25 + 0.55 * twk;
        var sCol = i % 3 === 0 ? '#FFFFFF' : (i % 3 === 1 ? '#FFF0A8' : '#7EE8FF');
        ctx.fillStyle = sCol;
        var sps = sp.r * 1.3;
        ctx.fillRect(sp.x - sps / 2, sp.y - sps / 2, sps, sps);
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawCelestial(ctx, S, g) {
    var th = S.theme;
    var sun = th.sun || {};
    var amb = th.ambient || 'day';
    var sx = (typeof sun.x === 'number' ? sun.x : 0.78) * W;
    var sy = (typeof sun.y === 'number' ? sun.y : 0.16) * H;
    var r = sun.r || 46;
    /* 换道时远景轻微侧移（CFG.cam.laneCurve） */
    var tilt = (S.player && typeof S.player.tilt === 'number') ? S.player.tilt : 0;
    var roll = tilt * (CAM.laneCurve || 2.2) * 1.6;
    sx += roll;
    var horizon = CAM.horizonY;

    if (amb === 'night') {
      ctx.fillStyle = g.moonGlow;
      ctx.fillRect(0, 0, W, horizon + 4);
      /* 月亮 */
      U.fillCircle(ctx, sx, sy, r, '#FFF7D6');
      U.fillCircle(ctx, sx, sy, r * 0.93, '#FFF9E4');
      U.fillCircle(ctx, sx - r * 0.34, sy - r * 0.22, r * 0.16, colorA('#E4DCB8', 0.75));
      U.fillCircle(ctx, sx + r * 0.28, sy + r * 0.08, r * 0.12, colorA('#E4DCB8', 0.6));
      U.fillCircle(ctx, sx - r * 0.06, sy + r * 0.42, r * 0.1, colorA('#E4DCB8', 0.45));
      ctx.strokeStyle = colorA('#FFFFFF', 0.24);
      ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.beginPath(); ctx.arc(sx, sy, r * 1.14, 0, TAU); ctx.stroke();
    } else if (amb === 'sunset') {
      ctx.fillStyle = g.sunGlow;
      ctx.fillRect(0, 0, W, horizon + 4);
      U.fillEllipse(ctx, sx, sy, r * 1.14, r, sun.color || '#FFE0A0');
      U.fillEllipse(ctx, sx, sy + r * 0.5, r * 1.3, r * 0.5, colorA('#FFD08A', 0.35));
      U.fillEllipse(ctx, sx - r * 0.28, sy - r * 0.28, r * 0.52, r * 0.36, colorA('#FFFFFF', 0.45));
      /* 横贯落日的云带 */
      var bands = [[0.1, 2.4, 0.9], [0.42, 2.9, 0.75], [0.7, 2.2, 0.65]];
      for (var bi = 0; bi < bands.length; bi++) {
        var b = bands[bi];
        var by = sy + r * b[0];
        var bw = r * b[1];
        U.fillRoundRect(ctx, sx - bw / 2, by, bw, Math.max(2, r * 0.13), r * 0.07,
          colorA(th.cloud || '#FFE9D6', b[2] * 0.85));
      }
    } else if (amb === 'candy') {
      ctx.fillStyle = g.sunGlow;
      ctx.fillRect(0, 0, W, horizon + 4);
      U.fillCircle(ctx, sx, sy, r * 1.08, colorA('#FFD1EC', 0.32));
      U.fillCircle(ctx, sx, sy, r, sun.color || '#FFF0A8');
      U.fillCircle(ctx, sx - r * 0.26, sy - r * 0.28, r * 0.42, colorA('#FFFFFF', 0.55));
      ctx.strokeStyle = colorA('#FFFFFF', 0.75);
      ctx.lineWidth = Math.max(2, r * 0.09);
      ctx.beginPath(); ctx.arc(sx, sy, r * 1.24, 0, TAU); ctx.stroke();
      for (var ci = 0; ci < 5; ci++) {
        var ca = S.t * 0.5 + ci * (TAU / 5);
        var cx2 = sx + Math.cos(ca) * r * 1.62;
        var cy2 = sy + Math.sin(ca) * r * 1.62;
        U.fillStar(ctx, cx2, cy2, r * 0.16, r * 0.055, 4, ca, colorA('#FFFFFF', 0.8));
      }
    } else {
      ctx.fillStyle = g.sunGlow;
      ctx.fillRect(0, 0, W, horizon + 4);
      /* 阳光短射线 */
      ctx.save();
      ctx.strokeStyle = colorA('#FFF3B0', 0.2);
      ctx.lineWidth = Math.max(2, r * 0.08);
      ctx.lineCap = 'round';
      for (var ri = 0; ri < 10; ri++) {
        var ra = ri * (TAU / 10) + 0.18;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(ra) * r * 1.36, sy + Math.sin(ra) * r * 1.36);
        ctx.lineTo(sx + Math.cos(ra) * r * 1.62, sy + Math.sin(ra) * r * 1.62);
        ctx.stroke();
      }
      ctx.restore();
      U.fillCircle(ctx, sx, sy, r, sun.color || '#FFF3B0');
      U.fillCircle(ctx, sx - r * 0.24, sy - r * 0.26, r * 0.5, colorA('#FFFFFF', 0.5));
    }
  }

  function drawCloud(ctx, x, y, s, color, alpha) {
    if (alpha <= 0.02) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, s * 0.5, 0, TAU);
    ctx.arc(x - s * 0.56, y + s * 0.14, s * 0.36, 0, TAU);
    ctx.arc(x + s * 0.56, y + s * 0.12, s * 0.38, 0, TAU);
    ctx.arc(x - s * 0.2, y - s * 0.2, s * 0.34, 0, TAU);
    ctx.arc(x + s * 0.24, y - s * 0.16, s * 0.3, 0, TAU);
    ctx.fill();
    /* 底部阴影与顶部高光 */
    U.fillEllipse(ctx, x, y + s * 0.34, s * 0.98, s * 0.2, colorA(darken(color, 0.1), 0.5));
    U.fillEllipse(ctx, x - s * 0.2, y - s * 0.22, s * 0.3, s * 0.18, colorA('#FFFFFF', 0.3));
    ctx.restore();
  }

  function drawClouds(ctx, S) {
    var th = S.theme;
    var st = staticFor(th);
    var amb = th.ambient || 'day';
    var col = th.cloud || '#FFFFFF';
    var drift = S.distance;
    for (var i = 0; i < st.clouds.length; i++) {
      var c = st.clouds[i];
      if (amb === 'night' && (i % 2) === 1) continue;
      var x = mod(c.x - drift * c.sp, W + 340) - 170;
      var alpha = c.a * (amb === 'night' ? 0.34 : (amb === 'sunset' ? 0.72 : 0.92));
      drawCloud(ctx, x, c.y, c.s, col, alpha);
    }
  }

  /* 远山 / 波浪山 / 糖丘剪影（视差） */
  function waveY(x, phase, baseY, amp, freq) {
    return baseY - amp * (0.55 + 0.45 * Math.sin((x + phase) * freq) + 0.18 * Math.sin((x + phase * 1.7) * freq * 2.3 + 1.3));
  }
  function drawHillLayer(ctx, phase, baseY, amp, freq, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-80, CAM.horizonY + 30);
    for (var x = -80; x <= W + 80; x += 22) {
      ctx.lineTo(x, waveY(x, phase, baseY, amp, freq));
    }
    ctx.lineTo(W + 80, CAM.horizonY + 30);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  function drawRidgeTrees(ctx, phase, baseY, amp, freq, color, count) {
    ctx.save();
    ctx.fillStyle = color;
    for (var k = 0; k < count; k++) {
      var x = mod(k * 73 - phase * 0.55, W + 160) - 80;
      var y = waveY(x, phase, baseY, amp, freq) + 2;
      var th = 12 + hash01(k * 3.7) * 10;
      ctx.fillRect(x - 1.2, y - th * 0.4, 2.4, th * 0.4);
      ctx.beginPath();
      ctx.arc(x, y - th * 0.62, th * 0.34, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDayFar(ctx, S) {
    var th = S.theme;
    var phase = S.distance * 5.2;
    var horizon = CAM.horizonY;
    drawHillLayer(ctx, phase * 0.62, horizon + 6, 54, 0.0082,
      mixColor(th.groundFar || '#A6E06B', th.skyBottom || '#EAF9FF', 0.52), 0.95);
    drawRidgeTrees(ctx, phase * 0.62, horizon + 6, 54, 0.0082,
      mixColor(th.groundFar || '#A6E06B', '#2E6B2A', 0.45), 11);
    drawHillLayer(ctx, phase, horizon + 10, 34, 0.0126,
      mixColor(th.groundFar || '#A6E06B', th.groundNear || '#79C94F', 0.28), 1);
  }

  function drawSunsetFar(ctx, S) {
    var th = S.theme;
    var phase = S.distance * 2.6;
    var horizon = CAM.horizonY;
    /* 远处暖色云堤（视差）+ 海天线之前的暖光带 */
    ctx.save();
    ctx.fillStyle = colorA(th.cloud || '#FFE9D6', 0.4);
    for (var i = 0; i < 4; i++) {
      var cx = mod(i * 173 - phase * 0.8, W + 260) - 130;
      var cw = 90 + hash01(i * 5.7) * 70;
      U.fillEllipse(ctx, cx, horizon - 26 - hash01(i * 3.1) * 14, cw, 9 + hash01(i * 7.7) * 5,
        colorA(th.cloud || '#FFE9D6', 0.34));
    }
    ctx.fillStyle = colorA('#FFD8A0', 0.28);
    ctx.fillRect(0, horizon - 3, W, 3);
    ctx.restore();
  }

  function drawNightFar(ctx, S) {
    var th = S.theme;
    var phase = S.distance * 3.4;
    var horizon = CAM.horizonY;
    var back = mixColor(th.skyMid || '#26306B', '#0B1030', 0.55);
    var front = mixColor(th.skyMid || '#26306B', '#0B1030', 0.75);
    drawHillLayer(ctx, phase * 0.5, horizon + 4, 66, 0.0072, back, 0.95);
    drawHillLayer(ctx, phase, horizon + 8, 42, 0.011, front, 1);
    /* 山顶积雪微光 */
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#C9D6FF';
    ctx.lineWidth = 1.5;
    for (var k = 0; k < 6; k++) {
      var x = mod(k * 97 - phase * 0.5 * 0.55, W + 160) - 80;
      var y = waveY(x, phase * 0.5, horizon + 4, 66, 0.0072);
      ctx.beginPath();
      ctx.moveTo(x - 8, y + 4);
      ctx.lineTo(x, y);
      ctx.lineTo(x + 8, y + 5);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCandyFar(ctx, S) {
    var th = S.theme;
    var horizon = CAM.horizonY;
    var baseY = horizon + 16;
    var backCol = mixColor(th.groundFar || '#FFD1EC', '#FFFFFF', 0.42);
    var frontCol = mixColor(th.groundFar || '#FFD1EC', th.edge || '#FF8DC7', 0.24);
    var off = mod(S.distance * 4.8, 176);
    ctx.fillStyle = backCol;
    for (var i = -1; i <= Math.ceil(W / 176) + 1; i++) {
      var cx = i * 176 - off + 40;
      var h = hash01(i * 3.7 + 1.3);
      var rr = 40 + h * 48;
      ctx.beginPath();
      ctx.arc(cx, baseY, rr, Math.PI, TAU);
      ctx.fill();
    }
    var off2 = mod(S.distance * 6.6, 132);
    ctx.fillStyle = frontCol;
    for (var j = -1; j <= Math.ceil(W / 132) + 1; j++) {
      var cx2 = j * 132 - off2 + 20;
      var h2 = hash01(j * 5.9 + 2.6);
      var rr2 = 24 + h2 * 30;
      ctx.beginPath();
      ctx.arc(cx2, baseY + 7, rr2, Math.PI, TAU);
      ctx.fill();
    }
    /* 糖霜与彩针 */
    ctx.save();
    ctx.strokeStyle = colorA('#FFFFFF', 0.8);
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    for (var k = 0; k < 10; k++) {
      var wx = mod(k * 58 - off2 * 1.2, W + 160) - 80;
      var wy = horizon - 8 - (k % 3) * 8;
      ctx.beginPath();
      ctx.moveTo(wx - 12, wy);
      ctx.quadraticCurveTo(wx, wy - 11, wx + 12, wy);
      ctx.stroke();
    }
    var sprinkleCols = ['#FF6FAB', '#7EE8FF', '#FFE066', '#FFFFFF'];
    for (var s = 0; s < 16; s++) {
      var sxp = mod(s * 37 + 11 - off2 * 0.9, W + 80) - 40;
      var syp = horizon - 6 - hash01(s * 7.1) * 30;
      ctx.save();
      ctx.translate(sxp, syp);
      ctx.rotate(hash01(s * 3.3) * TAU);
      ctx.fillStyle = sprinkleCols[s % sprinkleCols.length];
      ctx.fillRect(-1.6, -3.2, 2.8, 6.4);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawFarLayers(ctx, S) {
    var amb = S.theme.ambient || 'day';
    if (amb === 'sunset') drawSunsetFar(ctx, S);
    else if (amb === 'night') drawNightFar(ctx, S);
    else if (amb === 'candy') drawCandyFar(ctx, S);
    else drawDayFar(ctx, S);
  }

  /* 黄昏海面（细长条，紧贴地平线：远岛 + 落日倒影 + 波光 + 浪花） */
  function drawSea(ctx, S, g) {
    var th = S.theme;
    var horizon = CAM.horizonY;
    var top = horizon - 1, bottom = horizon + 34;
    /* 海平线上的小岛剪影（画在雾之后，保证清晰可辨） */
    var isl = [
      [0.14, 78, 22], [0.32, 46, 14], [0.55, 54, 12], [0.82, 66, 18], [0.95, 40, 11]
    ];
    ctx.fillStyle = mixColor(th.groundFar || '#F2D9A8', '#6E3A2C', 0.5);
    for (var ii = 0; ii < isl.length; ii++) {
      var ix = isl[ii][0] * W;
      var iw = isl[ii][1];
      var ih = isl[ii][2];
      ctx.beginPath();
      ctx.moveTo(ix - iw, horizon + 1);
      ctx.quadraticCurveTo(ix - iw * 0.45, horizon - ih, ix, horizon - ih * 0.75);
      ctx.quadraticCurveTo(ix + iw * 0.5, horizon - ih * 0.35, ix + iw, horizon + 1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = g.sea;
    ctx.fillRect(0, top, W, bottom - top);
    /* 海天分界线：远处亮、近处深 */
    ctx.fillStyle = colorA('#FFF2D6', 0.85);
    ctx.fillRect(0, horizon - 1, W, 2);
    /* 近岸湿沙过渡（代替生硬的深色横线） */
    ctx.fillStyle = colorA('#C98A62', 0.38);
    ctx.fillRect(0, bottom - 4, W, 4);
    /* 落日倒影 */
    var sun = th.sun || {};
    var sx = (typeof sun.x === 'number' ? sun.x : 0.74) * W;
    for (var i = 0; i < 11; i++) {
      var ry = horizon + 1.5 + i * 2.9;
      var rw = 10 + i * 8 + Math.sin(S.t * 1.6 + i) * 4.5;
      U.fillEllipse(ctx, sx + Math.sin(S.t * 1.2 + i * 1.7) * 3.5, ry, rw, 1.5,
        colorA('#FFE9B8', 0.6 * (1 - i / 13)));
    }
    /* 波光 */
    ctx.strokeStyle = colorA('#FFF3D0', 0.45);
    ctx.lineWidth = 1.3;
    for (var k = 0; k < 12; k++) {
      var wx = mod(k * 58 - S.distance * 3.2, W + 100) - 50;
      var wy = horizon + 5 + (k % 5) * 5.5;
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx + 14, wy);
      ctx.stroke();
    }
    /* 海岸浪花 */
    for (var f = 0; f < 15; f++) {
      var fx = mod(f * 47 - S.distance * 4.8, W + 120) - 60;
      U.fillEllipse(ctx, fx, bottom - 1.5 + (f % 2) * 1.5, 14, 1.8, colorA('#FFF6E4', 0.66));
    }
  }

  function drawBackground(ctx, scene) {
    if (!ctx || typeof ctx.save !== 'function') return;
    var S;
    ctx.save();
    try {
      S = sceneState(scene);
      var th = S.theme;
      var amb = th.ambient || 'day';
      var g = gradsFor(ctx, th);
      var horizon = CAM.horizonY;
      ctx.fillStyle = g.sky;
      ctx.fillRect(0, 0, W, horizon + 4);
      drawSkyDecor(ctx, S, g);
      drawCelestial(ctx, S, g);
      drawClouds(ctx, S);
      drawFarLayers(ctx, S);
      /* 地面 */
      /* 地面只画到路肩可覆盖全屏宽度的高度，下面由跑道覆盖（省全屏填充） */
      ctx.fillStyle = g.ground;
      ctx.fillRect(0, horizon, W, 300);
      /* 地平线光晕 */
      ctx.fillStyle = g.horizonSheen;
      ctx.fillRect(0, horizon - 70, W, 104);
      /* 雾化 */
      ctx.fillStyle = g.fog;
      ctx.fillRect(0, horizon - 12, W, 96);
      if (amb === 'sunset') {
        /* 海面画在雾之后，保证远处也能看到海 */
        drawSea(ctx, S, g);
      }
      if (amb === 'night') {
        ctx.fillStyle = g.nightHaze;
        ctx.fillRect(0, horizon - 30, W, 180);
        drawGlow(ctx, '#9FB8FF', W * 0.5, H * 0.94, W * 0.55, 0.07);
      }
    } catch (e) {
      warnOnce('background', e);
    } finally {
      ctx.restore();
    }
  }

  /* ======================================================================
   * 七、跑道：分段亮暗滚动 / 边线 / 车道虚线 / 路肩 / 导向杆 / 速度气流
   * ==================================================================== */
  function roadQuad(ctx, zNear, zFar, xL, xR, camX) {
    var a = U.project(xL, 0, zFar, camX);
    var b = U.project(xR, 0, zFar, camX);
    var c = U.project(xR, 0, zNear, camX);
    var d = U.project(xL, 0, zNear, camX);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  function drawShoulders(ctx, S, camX, near, far) {
    var th = S.theme;
    var sh0 = WORLD.roadHalf - 0.02;
    var sh1 = WORLD.roadHalf + WORLD.shoulder;
    var edgeCol = th.edge || '#E39A4A';
    var baseCol = mixColor(edgeCol, th.groundFar || '#A6E06B', 0.35);
    var lightCol = mixColor(edgeCol, '#FFFFFF', 0.28);
    var darkCol = mixColor(edgeCol, '#000000', 0.16);
    ctx.fillStyle = baseCol;
    roadQuad(ctx, near, far, -sh1, -sh0, camX); ctx.fill();
    roadQuad(ctx, near, far, sh0, sh1, camX); ctx.fill();
    /* 路肩石色块（滚动） */
    var BP = V.shoulderBlock;
    var off = mod(S.distance, BP);
    var nMin = Math.floor((near + off) / BP) - 1;
    var nMax = Math.ceil((far + off) / BP) + 1;
    for (var n = nMax; n >= nMin; n--) {
      var z0 = n * BP - off, z1 = z0 + BP;
      if (z1 < near || z0 > far || z0 > 52) continue;
      var zn = Math.max(z0, near) - 0.25;
      var zf = Math.min(z1, far) + 0.25;
      if (yAt(Math.min(z1, far) - 0.4) > H + 80) continue;
      ctx.fillStyle = mod(n, 2) === 0 ? lightCol : darkCol;
      roadQuad(ctx, zn, zf, sh0 + 0.02, sh1 - 0.02, camX); ctx.fill();
      roadQuad(ctx, zn, zf, -(sh1 - 0.02), -(sh0 + 0.02), camX); ctx.fill();
    }
    /* 外沿描边 */
    ctx.fillStyle = mixColor(edgeCol, '#000000', 0.28);
    roadQuad(ctx, near, far, sh1, sh1 + 0.05, camX); ctx.fill();
    roadQuad(ctx, near, far, -sh1 - 0.05, -sh1, camX); ctx.fill();
  }

  function drawRoadBase(ctx, S, g, camX, near, far) {
    var L = V.bandLen;
    var off = mod(S.distance, L * 2);
    var nMin = Math.floor((near + off) / L) - 1;
    var nMax = Math.ceil((far + off) / L) + 1;
    for (var n = nMax; n >= nMin; n--) {
      var z0 = n * L - off, z1 = z0 + L;
      if (z1 < near || z0 > far) continue;
      var zf = Math.min(z1, far);
      if (yAt(zf - 0.4) > H + 80) continue;
      var zn = Math.max(z0, near);
      ctx.fillStyle = mod(n, 2) === 0 ? g.bandLight : g.bandDark;
      roadQuad(ctx, zn - 0.35, zf + 0.35, -WORLD.roadHalf, WORLD.roadHalf, camX);
      ctx.fill();
    }
  }

  /* 路面细节：边缘内阴影 + 车辙 + 滚动的小石子/糖针（增强近景层次与速度感） */
  function drawRoadTexture(ctx, S, camX, near, far) {
    var amb = S.theme.ambient || 'day';
    /* 靠近路肩的内侧阴影，给近景一个「路面凹陷」的立体感 */
    var shadeCol = amb === 'night' ? colorA('#0B0820', 0.24) : colorA('#5A3A12', 0.09);
    ctx.fillStyle = shadeCol;
    roadQuad(ctx, near, far, -WORLD.roadHalf, -WORLD.roadHalf + 0.3, camX); ctx.fill();
    roadQuad(ctx, near, far, WORLD.roadHalf - 0.3, WORLD.roadHalf, camX); ctx.fill();
    var trackCol = amb === 'night' ? colorA('#0B0820', 0.18) : colorA('#5A3A12', 0.06);
    var lane, cx;
    for (lane = 0; lane < 3; lane++) {
      cx = laneXOf(lane);
      ctx.fillStyle = trackCol;
      roadQuad(ctx, near, far, cx - 0.38, cx - 0.24, camX); ctx.fill();
      roadQuad(ctx, near, far, cx + 0.24, cx + 0.38, camX); ctx.fill();
    }
    var spacing = 4.0;
    var kMax = Math.floor((S.distance + far) / spacing);
    var kMin = Math.floor((S.distance + 0.8) / spacing);
    for (var k = kMax; k >= kMin; k--) {
      var z = k * spacing - S.distance;
      if (z < 0.9 || z > far || z > 48) continue;
      var h1 = hash01(k * 7.31 + 0.7);
      var h2 = hash01(k * 3.77 + 2.9);
      var x = (h1 * 2 - 1) * (WORLD.roadHalf - 0.18);
      var p = U.project(x, 0, z, camX);
      if (p.y > H + 40) continue;
      var sz = (0.03 + h2 * 0.055) * p.scale;
      if (sz < 0.55) continue;
      var a = (1 - 0.8 * U.clamp((z - V.fogStart) / 36, 0, 1)) * 0.34;
      var col;
      if (amb === 'night') col = colorA('#C9D6FF', a * 0.9);
      else if (amb === 'candy') col = colorA(['#FF9EC4', '#7EE8FF', '#FFE066'][k % 3], a * 1.5);
      else if (amb === 'sunset') col = colorA('#B97C4C', a);
      else col = colorA('#B4762F', a);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, sz, sz * 0.55, 0, 0, TAU);
      ctx.fill();
    }
    /* 横向铺装缝：近景也有滚动细节，强化速度感 */
    var seamPeriod = 2.4;
    var soff = mod(S.distance, seamPeriod);
    ctx.fillStyle = amb === 'night' ? colorA('#0B0820', 0.2) : colorA('#6B4418', 0.1);
    var snMin = Math.floor((near + soff) / seamPeriod) - 1;
    var snMax = Math.ceil((far + soff) / seamPeriod) + 1;
    for (var sn = snMax; sn >= snMin; sn--) {
      var sz0 = sn * seamPeriod - soff;
      if (sz0 < near || sz0 > far || sz0 > 34) continue;
      if (yAt(sz0) > H + 40) continue;
      roadQuad(ctx, sz0 - 0.03, sz0 + 0.03, -WORLD.roadHalf, WORLD.roadHalf, camX);
      ctx.fill();
    }
  }

  function drawLaneDashes(ctx, S, camX, near, far) {
    var th = S.theme;
    var P = V.dashPeriod;
    var off = mod(S.distance, P);
    var lx = WORLD.laneW / 2;
    var hw = V.dashWidth / 2;
    ctx.fillStyle = colorA(th.laneLine || '#FFF6E0', 0.92);
    var nMin = Math.floor((near + off) / P) - 1;
    var nMax = Math.ceil((far + off) / P) + 1;
    for (var n = nMax; n >= nMin; n--) {
      var z0 = n * P - off, z1 = z0 + V.dashLen;
      if (z1 < near || z0 > far) continue;
      var zn = Math.max(z0, near), zf = Math.min(z1, far);
      if (yAt(zn) > H + 120 || zn > 52) continue;
      roadQuad(ctx, zn, zf, lx - hw, lx + hw, camX); ctx.fill();
      roadQuad(ctx, zn, zf, -lx - hw, -lx + hw, camX); ctx.fill();
    }
  }

  function drawPost(ctx, x, y, s, th) {
    var wpx = Math.max(1.2, 0.09 * s);
    var hpx = V.postHeight * s;
    if (hpx < 2) return;
    U.fillRoundRect(ctx, x - wpx / 2, y - hpx, wpx, hpx, wpx * 0.45, th.laneLine || '#FFF6E0');
    U.fillRoundRect(ctx, x - wpx * 0.8, y - hpx - wpx * 0.62, wpx * 1.6, wpx * 0.9, wpx * 0.4, th.edge || '#E39A4A');
    if ((th.ambient || 'day') === 'night') {
      drawGlow(ctx, '#7EF0E0', x, y - hpx - wpx * 0.3, wpx * 3.2, 0.45);
    }
  }

  function drawPosts(ctx, S, camX, near, far) {
    var th = S.theme;
    var P = V.postPeriod;
    var off = mod(S.distance, P);
    var px = WORLD.roadHalf + WORLD.shoulder - 0.02;
    var nMin = Math.floor((near + off) / P) - 1;
    var nMax = Math.ceil((far + off) / P) + 1;
    for (var n = nMax; n >= nMin; n--) {
      var z = n * P - off;
      if (z < 0.9 || z > 50) continue;
      if (yAt(z) > H + 40) continue;
      var pl = U.project(-px, 0, z, camX);
      var pr = U.project(px, 0, z, camX);
      if (pl.x > -80 && pl.x < W + 80) drawPost(ctx, pl.x, pl.y, pl.scale, th);
      if (pr.x > -80 && pr.x < W + 80) drawPost(ctx, pr.x, pr.y, pr.scale, th);
    }
  }

  /* 速度越快，屏幕边缘的风线与路面流光越明显 */
  function drawSpeedFx(ctx, S) {
    var lvl = U.clamp((S.speed - 8) / 9, 0, 1);
    if (lvl <= 0.02 || S.menu) return;
    ctx.save();
    ctx.lineCap = 'round';
    /* 屏幕两侧风线（向灭点收束） */
    for (var i = 0; i < 10; i++) {
      var side = (i % 2 === 0) ? -1 : 1;
      var h1 = hash01(i * 7.13 + 3.7);
      var h2 = hash01(i * 3.71 + 11.2);
      var y0 = 380 + h1 * 560;
      var x0 = side < 0 ? 2 + h2 * 116 : W - 2 - h2 * 116;
      var x1 = x0 + (W / 2 - x0) * 0.24;
      var y1 = y0 + (CAM.horizonY - y0) * 0.24;
      ctx.globalAlpha = (0.05 + 0.13 * lvl) * (0.55 + 0.45 * h2);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.4 + 2.6 * lvl;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    /* 路面流光 */
    ctx.globalAlpha = 0.05 + 0.1 * lvl;
    ctx.fillStyle = '#FFFFFF';
    for (var j = 0; j < 7; j++) {
      var z = 3 + mod(hash01(j * 5.3) * 16 - S.distance * 2.6, 16);
      var xx = (hash01(j * 9.1) * 2 - 1) * 1.9;
      roadQuad(ctx, z, z + 2.2, xx - 0.05, xx + 0.05, S.camX);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRoad(ctx, scene) {
    if (!ctx || typeof ctx.save !== 'function') return;
    var S;
    ctx.save();
    try {
      S = sceneState(scene);
      var th = S.theme;
      var g = gradsFor(ctx, th);
      var camX = S.camX;
      var horizon = CAM.horizonY;
      var near = V.roadNearZ, far = V.roadFarZ;
      drawRoadBase(ctx, S, g, camX, near, far);
      drawRoadTexture(ctx, S, camX, near, far);
      drawShoulders(ctx, S, camX, near, far);
      /* 边线 */
      var ew = V.edgeWidth;
      ctx.fillStyle = th.laneLine || '#FFF6E0';
      roadQuad(ctx, near, far, -WORLD.roadHalf + 0.02, -WORLD.roadHalf + 0.02 + ew, camX); ctx.fill();
      roadQuad(ctx, near, far, WORLD.roadHalf - 0.02 - ew, WORLD.roadHalf - 0.02, camX); ctx.fill();
      drawLaneDashes(ctx, S, camX, near, far);
      drawPosts(ctx, S, camX, near, far);
      /* 远处雾化：黄昏主题裁切到跑道/路肩，避免把海面一起糊掉；其余主题直接铺满 */
      ctx.fillStyle = g.fog;
      if ((th.ambient || 'day') === 'sunset') {
        ctx.save();
        roadQuad(ctx, near, far, -(WORLD.roadHalf + WORLD.shoulder + 0.12), WORLD.roadHalf + WORLD.shoulder + 0.12, camX);
        ctx.clip();
        ctx.fillRect(0, horizon - 14, W, 96);
        ctx.restore();
      } else {
        ctx.fillRect(0, horizon - 14, W, 96);
      }
      /* 高速气流（放在雾之后，近处更清晰） */
      drawSpeedFx(ctx, S);
    } catch (e) {
      warnOnce('road', e);
    } finally {
      ctx.restore();
    }
  }

  /* ======================================================================
   * 八、两侧装饰 + 地面细节
   * ==================================================================== */
  function drawGroundDecor(ctx, S, z, side, xOff, h1, h2, th) {
    if (z < 0.8 || z > V.roadFarZ) return;
    var p = U.project(xOff, 0, z, S.camX);
    if (p.x < -60 || p.x > W + 60) return;
    if (p.y > H + 100) return;
    var s = p.scale;
    var alpha = 1 - 0.8 * U.clamp((z - V.fogStart) / 36, 0, 1);
    if (alpha <= 0.03) return;
    var amb = th.ambient || 'day';
    ctx.save();
    ctx.globalAlpha = alpha;
    if (amb === 'day') {
      if (h1 > 0.5) {
        ctx.strokeStyle = mixColor(th.prop && th.prop.leaf || '#5FBF52', '#2E6B2A', 0.3);
        ctx.lineWidth = Math.max(1, 0.028 * s);
        ctx.lineCap = 'round';
        for (var i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.quadraticCurveTo(p.x + (i - 1) * 0.1 * s, p.y - 0.12 * s, p.x + (i - 1) * 0.2 * s, p.y - 0.2 * s);
          ctx.stroke();
        }
      } else {
        U.fillCircle(ctx, p.x, p.y - 0.08 * s, 0.05 * s, h2 > 0.5 ? '#FFFFFF' : (th.prop && th.prop.accent || '#FFE066'));
        U.fillCircle(ctx, p.x, p.y - 0.08 * s, 0.02 * s, '#FFB020');
      }
    } else if (amb === 'sunset') {
      ctx.strokeStyle = h1 > 0.5 ? '#FFF3D6' : (th.prop && th.prop.leaf || '#5FBF52');
      ctx.lineWidth = Math.max(1, 0.03 * s);
      ctx.lineCap = 'round';
      for (var j = 0; j < 2; j++) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(p.x + (j ? 0.14 : -0.1) * s, p.y - 0.16 * s, p.x + (j ? 0.2 : -0.18) * s, p.y - 0.26 * s);
        ctx.stroke();
      }
      U.fillEllipse(ctx, p.x + 0.12 * s, p.y - 0.02 * s, 0.09 * s, 0.05 * s, colorA('#FFF6E0', 0.8));
    } else if (amb === 'night') {
      drawGlow(ctx, '#7EF0E0', p.x, p.y - 0.08 * s, 0.24 * s, 0.55);
      U.fillCircle(ctx, p.x, p.y - 0.06 * s, 0.045 * s, colorA('#CFF7FF', 0.9));
    } else {
      ctx.save();
      ctx.translate(p.x, p.y - 0.02 * s);
      ctx.rotate(h1 * TAU);
      ctx.fillStyle = ['#FF6FAB', '#7EE8FF', '#FFE066'][Math.floor(h2 * 3) % 3];
      ctx.fillRect(-0.04 * s, -0.1 * s, 0.08 * s, 0.2 * s);
      ctx.restore();
    }
    ctx.restore();
  }

  function propTree(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var trunkW = Math.max(1, 0.16 * s);
    var trunkH = 0.9 * s;
    U.fillRoundRect(ctx, x - trunkW / 2, y - trunkH, trunkW, trunkH, trunkW * 0.35, pc.trunk || '#9A6234');
    ctx.fillStyle = colorA('#000000', 0.1);
    ctx.fillRect(x + trunkW * 0.08, y - trunkH, trunkW * 0.34, trunkH);
    var leaf = pc.leaf || '#5FBF52', leaf2 = pc.leaf2 || '#7ED968';
    U.fillCircle(ctx, x, y - trunkH - 0.42 * s, 0.46 * s, leaf);
    U.fillCircle(ctx, x - 0.34 * s, y - trunkH - 0.18 * s, 0.3 * s, leaf);
    U.fillCircle(ctx, x + 0.34 * s, y - trunkH - 0.24 * s, 0.32 * s, leaf);
    U.fillCircle(ctx, x - 0.14 * s, y - trunkH - 0.52 * s, 0.26 * s, leaf2);
    U.fillCircle(ctx, x + 0.18 * s, y - trunkH - 0.4 * s, 0.22 * s, leaf2);
    if (h > 0.55) {
      U.fillCircle(ctx, x - 0.22 * s, y - trunkH - 0.3 * s, 0.085 * s, pc.accent || '#FFE066');
      U.fillCircle(ctx, x + 0.26 * s, y - trunkH - 0.52 * s, 0.075 * s, pc.accent || '#FFE066');
    }
  }

  function propBush(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var leaf = pc.leaf || '#5FBF52', leaf2 = pc.leaf2 || '#7ED968';
    U.fillEllipse(ctx, x, y - 0.28 * s, 0.32 * s, 0.2 * s, colorA('#000000', 0.07));
    U.fillCircle(ctx, x, y - 0.34 * s, 0.34 * s, leaf);
    U.fillCircle(ctx, x - 0.3 * s, y - 0.22 * s, 0.24 * s, leaf);
    U.fillCircle(ctx, x + 0.3 * s, y - 0.24 * s, 0.25 * s, leaf);
    U.fillCircle(ctx, x - 0.06 * s, y - 0.5 * s, 0.2 * s, leaf2);
    if (h > 0.4) {
      U.fillCircle(ctx, x + 0.12 * s, y - 0.3 * s, 0.07 * s, pc.accent || '#FFE066');
      U.fillCircle(ctx, x - 0.24 * s, y - 0.36 * s, 0.06 * s, '#FFFFFF');
    }
  }

  function propFlower(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var cols = [pc.accent || '#FFE066', '#FF9EC4', '#FFFFFF'];
    for (var i = 0; i < 3; i++) {
      var ox = (i - 1) * 0.22 * s + (hash01(i * 3.3 + h * 9) - 0.5) * 0.1 * s;
      var hh = (0.34 + hash01(i * 7.7 + h * 3) * 0.2) * s;
      ctx.strokeStyle = mixColor(pc.leaf || '#5FBF52', '#2E6B2A', 0.2);
      ctx.lineWidth = Math.max(1, 0.03 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + ox, y);
      ctx.quadraticCurveTo(x + ox * 1.3, y - hh * 0.6, x + ox * 1.1, y - hh);
      ctx.stroke();
      U.fillCircle(ctx, x + ox * 1.1, y - hh, 0.09 * s, cols[i % cols.length]);
      U.fillCircle(ctx, x + ox * 1.1, y - hh, 0.04 * s, '#FFB020');
    }
  }

  function propPalm(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var lean = (h - 0.5) * 0.55 * s;
    var topX = x + lean;
    var topY = y - 1.72 * s;
    ctx.strokeStyle = pc.trunk || '#B97A3E';
    ctx.lineWidth = Math.max(1.5, 0.17 * s);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + lean * 0.32, y - 0.95 * s, topX, topY);
    ctx.stroke();
    /* 树干环纹 */
    ctx.strokeStyle = colorA('#000000', 0.12);
    ctx.lineWidth = Math.max(1, 0.035 * s);
    for (var r = 1; r <= 4; r++) {
      var t = r / 5;
      var qx = (1 - t) * (1 - t) * x + 2 * (1 - t) * t * (x + lean * 0.32) + t * t * topX;
      var qy = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * (y - 0.95 * s) + t * t * topY;
      ctx.beginPath();
      ctx.moveTo(qx - 0.07 * s, qy);
      ctx.lineTo(qx + 0.07 * s, qy);
      ctx.stroke();
    }
    var leaf = pc.leaf || '#5FBF52', leaf2 = pc.leaf2 || '#8FCF5E';
    for (var i = 0; i < 7; i++) {
      var ang = -Math.PI + (i / 6) * Math.PI * 1.12 + 0.06;
      var len = (0.75 + hash01(i * 3.3 + h * 7.7) * 0.42) * s;
      ctx.save();
      ctx.translate(topX, topY);
      ctx.rotate(ang);
      ctx.fillStyle = i % 2 ? leaf2 : leaf;
      ctx.beginPath();
      ctx.ellipse(len * 0.5, 0, len * 0.52, 0.1 * s, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    U.fillCircle(ctx, topX - 0.1 * s, topY + 0.08 * s, 0.1 * s, '#8A5A2E');
    U.fillCircle(ctx, topX + 0.09 * s, topY + 0.1 * s, 0.09 * s, '#7A4E26');
  }

  function propBeachGrass(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    ctx.strokeStyle = pc.leaf || '#5FBF52';
    ctx.lineWidth = Math.max(1, 0.05 * s);
    ctx.lineCap = 'round';
    for (var i = 0; i < 5; i++) {
      var lean = (hash01(i * 5.1 + h * 3.7) - 0.5) * 0.5;
      ctx.beginPath();
      ctx.moveTo(x + (i - 2) * 0.06 * s, y);
      ctx.quadraticCurveTo(x + lean * 0.2 * s, y - 0.34 * s, x + lean * 0.5 * s, y - (0.55 + hash01(i * 2.7) * 0.3) * s);
      ctx.stroke();
    }
    U.fillEllipse(ctx, x, y, 0.3 * s, 0.07 * s, colorA(COL.shadow, 0.1));
  }

  function propCrystal(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var c1 = pc.leaf2 || '#B7A9FF', c2 = pc.leaf || '#8F7BFF', accent = pc.accent || '#7EF0E0';
    if (s > 7) drawGlow(ctx, c1, x, y - 0.6 * s, 1.0 * s, 0.4);
    var hgt = (1.1 + h * 0.5) * s;
    var wid = (0.18 + h * 0.05) * s;
    /* 主晶体 */
    ctx.fillStyle = c2;
    ctx.beginPath();
    ctx.moveTo(x, y - hgt);
    ctx.lineTo(x + wid, y - hgt * 0.42);
    ctx.lineTo(x + wid * 0.6, y);
    ctx.lineTo(x - wid * 0.6, y);
    ctx.lineTo(x - wid, y - hgt * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colorA('#FFFFFF', 0.32);
    ctx.beginPath();
    ctx.moveTo(x, y - hgt);
    ctx.lineTo(x + wid, y - hgt * 0.42);
    ctx.lineTo(x, y - hgt * 0.26);
    ctx.lineTo(x - wid, y - hgt * 0.42);
    ctx.closePath();
    ctx.fill();
    /* 小晶体 */
    var sx2 = x + 0.3 * s, sh = 0.5 * s;
    ctx.fillStyle = c1;
    ctx.beginPath();
    ctx.moveTo(sx2, y - sh * 1.6);
    ctx.lineTo(sx2 + 0.12 * s, y - sh * 0.6);
    ctx.lineTo(sx2, y);
    ctx.lineTo(sx2 - 0.12 * s, y - sh * 0.6);
    ctx.closePath();
    ctx.fill();
    /* 基座 */
    U.fillEllipse(ctx, x, y, 0.34 * s, 0.1 * s, colorA('#2A2450', 0.85));
    U.fillStar(ctx, x, y - hgt - 0.06 * s, 0.14 * s, 0.05 * s, 4, Math.PI / 4, accent);
  }

  function propMushroom(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var capCol = pc.leaf || '#8F7BFF';
    var spots = ['#FFFFFF', pc.accent || '#7EF0E0'];
    var defs = [[-0.18, 0.55, 0.32], [0.24, 0.82, 0.24]];
    for (var i = 0; i < defs.length; i++) {
      var ox = defs[i][0] * s, hh = defs[i][1] * s, rr = defs[i][2] * s;
      if (s > 7) drawGlow(ctx, capCol, x + ox, y - hh, rr * 1.5, 0.25);
      U.fillRoundRect(ctx, x + ox - rr * 0.26, y - hh, rr * 0.52, hh, rr * 0.16, '#FFF3D1');
      ctx.fillStyle = capCol;
      ctx.beginPath();
      ctx.ellipse(x + ox, y - hh, rr, rr * 0.62, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x + ox, y - hh, rr, rr * 0.16, 0, 0, TAU);
      ctx.fill();
      for (var k = 0; k < 3; k++) {
        U.fillCircle(ctx, x + ox + (hash01(i * 7 + k * 3.1) - 0.5) * rr * 1.2,
          y - hh - rr * (0.18 + hash01(k * 5.3 + i) * 0.22), rr * 0.11, spots[k % spots.length]);
      }
    }
  }

  function propLolli(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var stickW = Math.max(1, 0.08 * s);
    var hgt = (1.2 + h * 0.35) * s;
    var headR = 0.42 * s;
    var cy = y - hgt - headR * 0.55;
    U.fillRoundRect(ctx, x - stickW / 2, y - hgt, stickW, hgt, stickW / 2, pc.trunk || '#FFFFFF');
    if (s > 7) drawGlow(ctx, pc.leaf || '#FF6FAB', x, cy, headR * 1.7, 0.28);
    var lolli = lolliSprite(pc.leaf || '#FF6FAB');
    if (lolli) {
      ctx.drawImage(lolli, x - headR, cy - headR, headR * 2, headR * 2);
    } else {
      U.fillCircle(ctx, x, cy, headR, pc.leaf || '#FF6FAB');
    }
  }

  function propCandyCane(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var hgt = (1.2 + h * 0.3) * s;
    var wpx = Math.max(1.4, 0.15 * s);
    var topY = y - hgt;
    var hookR = 0.26 * s;
    var path = function () {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, topY + hookR);
      ctx.arc(x + hookR, topY + hookR, hookR, Math.PI, 0, false);
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = wpx;
    path(); ctx.stroke();
    ctx.strokeStyle = pc.leaf || '#FF6FAB';
    ctx.lineWidth = wpx * 0.92;
    ctx.setLineDash([0.18 * s, 0.18 * s]);
    path(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    U.fillEllipse(ctx, x, y, 0.2 * s, 0.05 * s, colorA(COL.shadow, 0.12));
  }

  function propGumdrop(ctx, x, y, s, th, h) {
    var pc = th.prop || {};
    var r = (0.3 + h * 0.18) * s;
    var col = pc.leaf2 || '#FFB3D6';
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.bezierCurveTo(x - r * 1.02, y - r * 1.55, x + r * 1.02, y - r * 1.55, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colorA('#FFFFFF', 0.28);
    ctx.beginPath();
    ctx.ellipse(x - r * 0.25, y - r * 0.75, r * 0.28, r * 0.2, -0.5, 0, TAU);
    ctx.fill();
    for (var k = 0; k < 6; k++) {
      U.fillCircle(ctx, x + (hash01(k * 3.3 + h * 5) - 0.5) * r * 1.5,
        y - r * (0.2 + hash01(k * 7.1 + h) * 0.85), r * 0.065, colorA('#FFFFFF', 0.75));
    }
  }

  function drawPropAt(ctx, S, x, z, h1, h2, h3, side, th) {
    var p = U.project(x, 0, z, S.camX);
    var s = p.scale;
    /* 完全在屏幕左右外的不画 */
    if (p.x < -2.2 * s - 40 || p.x > W + 2.2 * s + 40) return;
    if (p.y > H + 420) return;
    var alpha = 1 - 0.82 * U.clamp((z - V.fogStart) / 36, 0, 1);
    if (alpha <= 0.03) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    var sc = s * (0.85 + h2 * 0.45);
    /* 影子 */
    U.fillEllipse(ctx, p.x, p.y, 0.5 * sc, 0.14 * sc, colorA(COL.shadow, 0.16));
    var props = th.props || 'tree';
    var type;
    if (props === 'palm') {
      type = h1 < 0.62 ? 'palm' : 'grass';
    } else if (props === 'crystal') {
      type = h1 < 0.66 ? 'crystal' : 'mushroom';
    } else if (props === 'lolli') {
      type = h1 < 0.58 ? 'lolli' : (h1 < 0.82 ? 'cane' : 'gumdrop');
    } else {
      type = h1 < 0.58 ? 'tree' : (h1 < 0.82 ? 'bush' : 'flower');
    }
    if (type === 'tree') propTree(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'bush') propBush(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'flower') propFlower(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'palm') propPalm(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'grass') propBeachGrass(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'crystal') propCrystal(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'mushroom') propMushroom(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'lolli') propLolli(ctx, p.x, p.y, sc, th, h3);
    else if (type === 'cane') propCandyCane(ctx, p.x, p.y, sc, th, h3);
    else propGumdrop(ctx, p.x, p.y, sc, th, h3);
    ctx.restore();
  }

  function drawProps(ctx, scene) {
    if (!ctx || typeof ctx.save !== 'function') return;
    var S;
    ctx.save();
    try {
      S = sceneState(scene);
      var th = S.theme;
      var period = V.propPeriod;
      var d = S.distance;
      var kMax = Math.floor((d + V.roadFarZ) / period);
      var kMin = Math.floor((d + 1.2) / period);
      var guard = 0;
      for (var k = kMax; k >= kMin && guard < 60; k--, guard++) {
        for (var si = 0; si < 2; si++) {
          var side = si === 0 ? -1 : 1;
          var h1 = hash01(k * 12.9898 + si * 78.233 + 3.17);
          var h2 = hash01(k * 39.3467 + si * 11.135 + 8.7);
          var h3 = hash01(k * 7.7531 + si * 41.77 + 1.3);
          var z = k * period - d + (h3 - 0.5) * 2.4;
          if (z < 1.0 || z > V.roadFarZ) continue;
          var x = side * (WORLD.roadHalf + WORLD.shoulder + 0.55 + h2 * 1.6);
          /* 地面小细节（比装饰更靠远一点绘制，保证层次） */
          drawGroundDecor(ctx, S, z + period * 0.42, side,
            side * (WORLD.roadHalf + WORLD.shoulder + 0.25 + h1 * 0.9), h1, h2, th);
          drawGroundDecor(ctx, S, z + period * 0.78, side,
            side * (WORLD.roadHalf + WORLD.shoulder + 0.35 + h3 * 1.1), h3, h1, th);
          drawPropAt(ctx, S, x, z, h1, h2, h3, side, th);
        }
      }
    } catch (e) {
      warnOnce('props', e);
    } finally {
      ctx.restore();
    }
  }

  /* ======================================================================
   * 九、实体：数字方块 / 障碍 / 金币 / 道具
   * ==================================================================== */
  function entitySeed(e) {
    var id = e.id;
    if (typeof id === 'number' && isFinite(id)) return hash01(id * 0.731 + 5.3);
    if (typeof id === 'string') return (hashStr(id) % 10000) / 10000;
    return hash01((Number(e.z) || 0) * 3.3 + (Number(e.lane) || 0));
  }
  function entityAlpha(z) {
    var fadeIn = U.clamp((V.entityFar - z) / 5, 0, 1);
    var far = U.clamp((z - V.fogStart) / (V.entityFar - V.fogStart), 0, 1);
    /* 近处淡出：避免 z→0 的方块/金币突然变得巨大压在角色头顶 */
    var near = U.clamp(z / V.nearFadeZ, 0, 1);
    return fadeIn * (1 - 0.42 * far) * near;
  }

  /* 单个数字方块卡片（屏幕坐标，wpx 为边长）；实体绘制与调试特写共用 */
  function drawTileCard(ctx, value, x, y, wpx) {
    var col = tileColorOf(value);
    var x0 = x - wpx / 2, y0 = y - wpx / 2;
    var r = wpx * 0.26;
    /* 自身软阴影，让方块从路面浮起来 */
    ctx.fillStyle = colorA('#3A2410', 0.1);
    U.fillRoundRect(ctx, x0 + wpx * 0.03, y0 + wpx * 0.06, wpx, wpx, r);
    ctx.fill();
    /* 立体：暗底 + 亮面 */
    U.fillRoundRect(ctx, x0, y0, wpx, wpx, r, col.b || '#EFB35E');
    var pad = wpx * 0.07;
    U.fillRoundRect(ctx, x0 + pad, y0 + pad, wpx - pad * 2, wpx - pad * 2, r * 0.82, col.a || '#FFF4C8');
    ctx.strokeStyle = colorA('#FFFFFF', 0.32);
    ctx.lineWidth = Math.max(1, wpx * 0.018);
    U.strokeRoundRect(ctx, x0 + pad, y0 + pad, wpx - pad * 2, wpx - pad * 2, r * 0.82);
    /* 顶部高光带（压低高度/透明度，把视觉中心留给数字） */
    var fw = wpx - pad * 2;
    U.fillRoundRect(ctx, x0 + pad, y0 + pad, fw, fw * 0.3, Math.min(r * 0.82, fw * 0.15), colorA('#FFFFFF', 0.24));
    U.fillEllipse(ctx, x - wpx * 0.16, y - wpx * 0.28, wpx * 0.18, wpx * 0.08, colorA('#FFFFFF', 0.32));
    /* 数字：字号约为方块边长的 36%~46%（字面高度），按宽度自适应压缩，4 位数也不溢出 */
    var str = String(value);
    var digits = str.length;
    var fs = wpx * (digits <= 2 ? 0.64 : (digits === 3 ? 0.56 : 0.5));
    if (fs >= 7) {
      var maxTextW = wpx * 0.84;
      ctx.font = '900 ' + fs.toFixed(1) + 'px ' + FONT_NUM;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var textW = 0;
      try { textW = ctx.measureText(str).width; } catch (err) { textW = fs * str.length * 0.8; }
      var squeeze = textW > maxTextW && textW > 0 ? maxTextW / textW : 1;
      var ty = y + wpx * 0.045;
      ctx.save();
      ctx.translate(x, ty);
      if (squeeze < 1) ctx.scale(squeeze, 1);
      /* 柔和投影 */
      ctx.fillStyle = colorA('#000000', 0.18);
      ctx.fillText(str, 0, fs * 0.06);
      var isLightText = (col.text === '#FFFFFF');
      if (isLightText) {
        /* 白字：用方块深色描边打底，远处也清晰 */
        ctx.strokeStyle = colorA(col.b || '#D62E3C', 0.85);
        ctx.lineWidth = Math.max(1.5, fs * 0.12);
        ctx.lineJoin = 'round';
        ctx.strokeText(str, 0, 0);
        ctx.fillStyle = '#FFFFFF';
      } else {
        ctx.strokeStyle = colorA('#FFFFFF', 0.4);
        ctx.lineWidth = Math.max(1, fs * 0.06);
        ctx.lineJoin = 'round';
        ctx.strokeText(str, 0, 0);
        ctx.fillStyle = col.text || '#5C3A00';
      }
      ctx.fillText(str, 0, 0);
      ctx.restore();
    }
  }

  function drawTileEntity(ctx, S, pGround, pCenter, s, e, seed) {
    var value = (typeof e.value === 'number' && isFinite(e.value) && e.value > 0) ? e.value : 2;
    var w = V.tileWorld * s;
    if (w < 2.2) return;
    var wpx = Math.min(w, 420);
    /* 地面影子 */
    U.fillEllipse(ctx, pGround.x, pGround.y, wpx * 0.46, wpx * 0.14, colorA(COL.shadow, 0.16));
    drawTileCard(ctx, value, pCenter.x, pCenter.y, wpx);
  }

  function drawObstacleEntity(ctx, S, pGround, s, e, seed, alpha) {
    var w = (typeof e.w === 'number' && e.w > 0 ? e.w : V.obstacleW) * s;
    var h = (typeof e.h === 'number' && e.h > 0 ? e.h : V.obstacleH) * s;
    if (w < 2.5 || h < 3) return;
    var x = pGround.x - w / 2, y = pGround.y - h;
    var variant = ((e.variant | 0) % 4 + 4) % 4 % 3;
    /* 影子 */
    U.fillEllipse(ctx, pGround.x, pGround.y, w * 0.55, w * 0.16, colorA(COL.shadow, 0.22));
    /* 危险光晕（呼吸）；远处小物体跳过，省一次 drawImage */
    if (w > 14) {
      ctx.save();
      ctx.globalAlpha = 0.16 * alpha * (0.7 + 0.3 * Math.sin(S.t * 3.4 + seed * TAU));
      var dsp = glowSprite(COL.danger);
      if (dsp) ctx.drawImage(dsp, pGround.x - w * 0.95, pGround.y - w * 0.32, w * 1.9, w * 0.64);
      ctx.restore();
    }

    if (w < 14) {
      /* 远处障碍：细节看不清，用简化造型（省大量小形状） */
      U.fillRoundRect(ctx, x + w * 0.04, y + h * 0.04, w * 0.92, h * 0.96, w * 0.12,
        variant === 1 ? COL.rock : (variant === 2 ? COL.barrel : COL.crateFace));
      ctx.fillStyle = variant === 1 ? COL.rockHi : (variant === 2 ? COL.barrelBand : COL.caution);
      ctx.fillRect(x + w * 0.1, y + h * 0.1, w * 0.8, Math.max(1, h * 0.16));
      ctx.fillStyle = colorA('#000000', 0.16);
      ctx.fillRect(x + w * 0.08, y + h * 0.84, w * 0.84, Math.max(1, h * 0.08));
      return;
    }

    if (variant === 1) {
      /* 岩石 */
      ctx.fillStyle = COL.rock;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w * 0.04, y + h * 0.42);
      ctx.lineTo(x + w * 0.24, y + h * 0.08);
      ctx.lineTo(x + w * 0.56, y);
      ctx.lineTo(x + w * 0.86, y + h * 0.26);
      ctx.lineTo(x + w * 0.98, y + h * 0.66);
      ctx.lineTo(x + w * 0.92, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = COL.rockHi;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.24, y + h * 0.1);
      ctx.lineTo(x + w * 0.56, y);
      ctx.lineTo(x + w * 0.56, y + h * 0.44);
      ctx.lineTo(x + w * 0.28, y + h * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = colorA(COL.rockDark, 0.85);
      ctx.beginPath();
      ctx.moveTo(x + w * 0.56, y + h * 0.44);
      ctx.lineTo(x + w * 0.86, y + h * 0.26);
      ctx.lineTo(x + w * 0.98, y + h * 0.66);
      ctx.lineTo(x + w * 0.92, y + h);
      ctx.lineTo(x + w * 0.5, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = COL.rockCrack;
      ctx.lineWidth = Math.max(1, w * 0.035);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.62, y + h * 0.42);
      ctx.lineTo(x + w * 0.5, y + h * 0.6);
      ctx.lineTo(x + w * 0.6, y + h * 0.82);
      ctx.moveTo(x + w * 0.3, y + h * 0.62);
      ctx.lineTo(x + w * 0.4, y + h * 0.72);
      ctx.stroke();
      U.fillEllipse(ctx, x + w * 0.18, y + h * 0.97, w * 0.14, h * 0.05, COL.rockDark);
      U.fillEllipse(ctx, x + w * 0.9, y + h * 0.97, w * 0.1, h * 0.04, COL.rockDark);
    } else if (variant === 2) {
      /* 木桶 */
      var barrel = function () {
        ctx.beginPath();
        ctx.moveTo(x + w * 0.17, y + h * 0.06);
        ctx.quadraticCurveTo(x + w * 0.02, y + h * 0.5, x + w * 0.17, y + h * 0.94);
        ctx.lineTo(x + w * 0.83, y + h * 0.94);
        ctx.quadraticCurveTo(x + w * 0.98, y + h * 0.5, x + w * 0.83, y + h * 0.06);
        ctx.closePath();
      };
      ctx.fillStyle = COL.barrel;
      barrel();
      ctx.fill();
      ctx.save();
      barrel();
      ctx.clip();
      ctx.fillStyle = colorA(COL.barrelFace, 0.55);
      ctx.fillRect(x, y, w, h);
      /* 竖木条 */
      ctx.strokeStyle = colorA('#7A4E26', 0.5);
      ctx.lineWidth = Math.max(1, w * 0.03);
      for (var st = 1; st <= 3; st++) {
        ctx.beginPath();
        ctx.moveTo(x + w * st / 4, y);
        ctx.lineTo(x + w * st / 4, y + h);
        ctx.stroke();
      }
      /* 铁箍 */
      ctx.fillStyle = COL.barrelBand;
      ctx.fillRect(x, y + h * 0.2, w, h * 0.07);
      ctx.fillRect(x, y + h * 0.72, w, h * 0.07);
      /* 警示红带 */
      ctx.fillStyle = colorA(COL.barrelRed, 0.92);
      ctx.fillRect(x, y + h * 0.44, w, h * 0.15);
      ctx.fillStyle = colorA('#FFFFFF', 0.85);
      var chw = w * 0.12;
      for (var ch = 0; ch < 4; ch++) {
        var cx0 = x + ch * chw * 2 + w * 0.04;
        ctx.beginPath();
        ctx.moveTo(cx0, y + h * 0.59);
        ctx.lineTo(cx0 + chw, y + h * 0.44);
        ctx.lineTo(cx0 + chw * 1.6, y + h * 0.44);
        ctx.lineTo(cx0 + chw * 0.6, y + h * 0.59);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      /* 桶盖 */
      U.fillEllipse(ctx, pGround.x, y + h * 0.07, w * 0.33, h * 0.05, COL.barrelFace);
      U.fillEllipse(ctx, pGround.x, y + h * 0.07, w * 0.26, h * 0.035, colorA('#8A5426', 0.75));
    } else {
      /* 木箱 + 警示条纹 */
      U.fillRoundRect(ctx, x, y, w, h, w * 0.09, COL.crateWood);
      U.fillRoundRect(ctx, x + w * 0.06, y + h * 0.08, w * 0.88, h * 0.84, w * 0.06, COL.crateFace);
      ctx.fillStyle = colorA(COL.crateFrame, 0.45);
      ctx.fillRect(x + w * 0.06, y + h * 0.32, w * 0.88, Math.max(1, h * 0.035));
      ctx.fillRect(x + w * 0.06, y + h * 0.58, w * 0.88, Math.max(1, h * 0.035));
      U.strokeRoundRect(ctx, x, y, w, h, w * 0.09, COL.crateFrame, Math.max(1, w * 0.045));
      /* 交叉木条 */
      ctx.strokeStyle = colorA(COL.crateBrace, 0.9);
      ctx.lineWidth = Math.max(1, w * 0.07);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.14, y + h * 0.18);
      ctx.lineTo(x + w * 0.86, y + h * 0.82);
      ctx.moveTo(x + w * 0.86, y + h * 0.18);
      ctx.lineTo(x + w * 0.14, y + h * 0.82);
      ctx.stroke();
      /* 顶部警示条 */
      var by = y + h * 0.015, bh = h * 0.13;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, by, w, bh);
      ctx.clip();
      ctx.fillStyle = COL.caution;
      ctx.fillRect(x, by, w, bh);
      ctx.fillStyle = COL.cautionDark;
      var sw = Math.max(2, w * 0.1);
      for (var cs = -1; cs < Math.ceil(w / sw) + 1; cs++) {
        ctx.beginPath();
        ctx.moveTo(x + cs * sw * 2, by + bh);
        ctx.lineTo(x + cs * sw * 2 + sw, by + bh);
        ctx.lineTo(x + cs * sw * 2 + sw + bh, by);
        ctx.lineTo(x + cs * sw * 2 + bh, by);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      /* 钉子 */
      var nailR = Math.max(1, w * 0.024);
      U.fillCircle(ctx, x + w * 0.1, y + h * 0.1, nailR, colorA('#5A3A22', 0.8));
      U.fillCircle(ctx, x + w * 0.9, y + h * 0.1, nailR, colorA('#5A3A22', 0.8));
      U.fillCircle(ctx, x + w * 0.1, y + h * 0.9, nailR, colorA('#5A3A22', 0.8));
      U.fillCircle(ctx, x + w * 0.9, y + h * 0.9, nailR, colorA('#5A3A22', 0.8));
    }
  }

  function drawCoinEntity(ctx, S, pGround, pCenter, s, seed) {
    var r = V.coinR * s;
    if (r < 1.4) return;
    var spin = Math.abs(Math.cos(S.t * 3.2 + seed * TAU));
    var rx = r * (0.16 + 0.84 * spin);
    var x = pCenter.x, y = pCenter.y;
    U.fillEllipse(ctx, pGround.x, pGround.y, r * 0.42, r * 0.14, colorA(COL.shadow, 0.12));
    if (r > 5) drawGlow(ctx, COL.coin, x, y, r * 1.55, 0.26);
    if (r < 5.5) {
      U.fillEllipse(ctx, x, y, rx * 1.06, r * 1.06, COL.coinRim);
      U.fillEllipse(ctx, x, y, rx, r, COL.coin);
      return;
    }
    /* 硬币：暗金外圈 + 金色盘面 + 内圈 + 星形反光 */
    U.fillEllipse(ctx, x, y, rx * 1.12, r * 1.12, '#B97A12');
    U.fillEllipse(ctx, x, y, rx * 1.03, r * 1.03, COL.coin);
    U.fillEllipse(ctx, x, y, rx * 0.78, r * 0.78, COL.coinHi);
    if (spin > 0.3) {
      U.fillStar(ctx, x, y, r * 0.4, r * 0.14, 5, Math.PI / 2, colorA('#FFB020', 0.55));
      U.fillEllipse(ctx, x - rx * 0.3, y - r * 0.35, rx * 0.2, r * 0.16, colorA('#FFFFFF', 0.85));
    } else {
      ctx.strokeStyle = COL.coinHi;
      ctx.lineWidth = Math.max(1, r * 0.3);
      ctx.beginPath();
      ctx.moveTo(x, y - r * 0.76);
      ctx.lineTo(x, y + r * 0.76);
      ctx.stroke();
    }
    if (spin > 0.72) {
      U.fillStar(ctx, x + r * 0.82, y - r * 0.78, r * 0.32, r * 0.11, 4, S.t * 2, colorA('#FFFFFF', 0.92));
    }
  }

  function drawPowerIcon(ctx, power, cx, cy, r, info) {
    ctx.save();
    if (power === 'shield') {
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.95);
      ctx.bezierCurveTo(r * 0.56, -r * 0.74, r * 0.84, -r * 0.5, r * 0.84, -r * 0.04);
      ctx.bezierCurveTo(r * 0.84, r * 0.46, r * 0.36, r * 0.8, 0, r);
      ctx.bezierCurveTo(-r * 0.36, r * 0.8, -r * 0.84, r * 0.46, -r * 0.84, -r * 0.04);
      ctx.bezierCurveTo(-r * 0.84, -r * 0.5, -r * 0.56, -r * 0.74, 0, -r * 0.95);
      ctx.closePath();
      ctx.fillStyle = info.color || '#4FC3F7';
      ctx.fill();
      ctx.strokeStyle = colorA('#FFFFFF', 0.95);
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.stroke();
      ctx.fillStyle = colorA('#FFFFFF', 0.32);
      ctx.beginPath();
      ctx.ellipse(-r * 0.2, -r * 0.34, r * 0.26, r * 0.16, -0.3, 0, TAU);
      ctx.fill();
      U.fillStar(ctx, 0, r * 0.02, r * 0.26, r * 0.1, 4, Math.PI / 4, colorA('#FFFFFF', 0.92));
    } else if (power === 'slow') {
      U.fillCircle(ctx, cx, cy, r * 0.92, colorA('#FFFFFF', 0.92));
      ctx.strokeStyle = info.color || '#B388FF';
      ctx.lineWidth = Math.max(1.5, r * 0.15);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.92, 0, TAU);
      ctx.stroke();
      /* 刻度 */
      ctx.strokeStyle = colorA(info.color2 || '#5E35B1', 0.6);
      ctx.lineWidth = Math.max(1, r * 0.07);
      for (var i = 0; i < 8; i++) {
        var a = (i / 8) * TAU;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 0.68, cy + Math.sin(a) * r * 0.68);
        ctx.lineTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82);
        ctx.stroke();
      }
      ctx.strokeStyle = info.color2 || '#5E35B1';
      ctx.lineWidth = Math.max(1.5, r * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - r * 0.52);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + r * 0.38, cy + r * 0.16);
      ctx.stroke();
      U.fillCircle(ctx, cx, cy, r * 0.1, info.color2 || '#5E35B1');
    } else if (power === 'magnet') {
      ctx.translate(cx, cy);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = info.color || '#FF6B6B';
      ctx.lineWidth = r * 0.42;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, r * 0.78);
      ctx.lineTo(-r * 0.5, r * 0.02);
      ctx.arc(0, r * 0.02, r * 0.5, Math.PI, 0, false);
      ctx.lineTo(r * 0.5, r * 0.78);
      ctx.stroke();
      ctx.fillStyle = colorA('#FFFFFF', 0.95);
      ctx.fillRect(-r * 0.71, r * 0.55, r * 0.42, r * 0.26);
      ctx.fillRect(r * 0.29, r * 0.55, r * 0.42, r * 0.26);
      ctx.strokeStyle = colorA('#FFFFFF', 0.4);
      ctx.lineWidth = r * 0.1;
      ctx.beginPath();
      ctx.arc(0, r * 0.02, r * 0.34, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      /* 双倍：×2 */
      ctx.font = '900 ' + (r * 1.5).toFixed(1) + 'px ' + FONT_NUM;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = info.color2 || '#F9A825';
      ctx.lineWidth = Math.max(2, r * 0.24);
      ctx.lineJoin = 'round';
      ctx.strokeText('×2', cx, cy + r * 0.06);
      ctx.fillStyle = colorA('#FFFFFF', 0.98);
      ctx.fillText('×2', cx, cy + r * 0.06);
      U.fillCircle(ctx, cx - r * 0.62, cy - r * 0.62, r * 0.1, colorA('#FFFFFF', 0.8));
      U.fillCircle(ctx, cx + r * 0.66, cy + r * 0.36, r * 0.07, colorA('#FFFFFF', 0.65));
    }
    ctx.restore();
  }

  function drawPowerEntity(ctx, S, pGround, pCenter, s, e, seed) {
    var pow = e.power || 'shield';
    var info = powerInfo(pow);
    var r = V.powerR * s;
    if (r < 2) return;
    var x = pCenter.x, y = pCenter.y;
    U.fillEllipse(ctx, pGround.x, pGround.y, r * 0.5, r * 0.16, colorA(COL.shadow, 0.1));
    if (r > 6) drawGlow(ctx, info.color || '#FFD54F', x, y, r * 2.3, 0.5);
    if (r < 6) {
      U.fillCircle(ctx, x, y, r, colorA(info.color || '#FFD54F', 0.42));
      U.fillCircle(ctx, x, y, r * 0.55, colorA(info.color || '#FFD54F', 0.95));
      return;
    }
    /* 光环 */
    ctx.strokeStyle = colorA(info.color || '#FFD54F', 0.45);
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.beginPath();
    ctx.arc(x, y, r * 1.18, 0, TAU);
    ctx.stroke();
    /* 泡泡 */
    U.fillCircle(ctx, x, y, r, colorA(info.color || '#FFD54F', 0.28));
    U.fillCircle(ctx, x - r * 0.28, y - r * 0.3, r * 0.5, colorA('#FFFFFF', 0.26));
    ctx.strokeStyle = colorA(info.color || '#FFD54F', 0.95);
    ctx.lineWidth = Math.max(1.2, r * 0.09);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = colorA('#FFFFFF', 0.35);
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.82, Math.PI * 1.05, Math.PI * 1.75);
    ctx.stroke();
    drawPowerIcon(ctx, pow, x, y, r * 0.78, info);
    /* 环绕闪光 */
    for (var k = 0; k < 2; k++) {
      var ang = S.t * 1.7 + k * Math.PI + seed * TAU;
      var sxp = x + Math.cos(ang) * r * 1.3;
      var syp = y + Math.sin(ang) * r * 1.05;
      U.fillStar(ctx, sxp, syp, r * 0.16, r * 0.055, 4, ang, colorA('#FFFFFF', 0.85));
    }
  }

  function drawEntities(ctx, scene) {
    if (!ctx || typeof ctx.save !== 'function') return;
    var list;
    ctx.save();
    try {
      var S = sceneState(scene);
      list = S.entities;
      if (!list || !list.length) return;
      var near = V.entityNear, far = V.entityFar;
      var i, e, z;
      /* 收集可见实体并按 z 从远到近排序（复用数组，避免每帧大量分配） */
      entityScratch.length = 0;
      for (i = 0; i < list.length; i++) {
        e = list[i];
        if (!e) continue;
        z = (typeof e.z === 'number') ? e.z : Number(e.z);
        if (!isFinite(z)) continue;
        if (z > far || z < near) continue;
        var kind = e.kind;
        if (kind !== 'tile' && kind !== 'obstacle' && kind !== 'coin' && kind !== 'power') continue;
        entityScratch.push(e);
      }
      if (!entityScratch.length) return;
      entityScratch.sort(function (a, b) { return b.z - a.z; });
      for (i = 0; i < entityScratch.length; i++) {
        e = entityScratch[i];
        z = e.z;
        var kind2 = e.kind;
        var lane = (typeof e.lane === 'number') ? e.lane : 1;
        var x = (typeof e.x === 'number' && isFinite(e.x)) ? e.x : laneXOf(lane);
        var seed = entitySeed(e);
        var alpha = entityAlpha(z);
        if (alpha <= 0.025) continue;
        /* 悬浮起伏 */
        var bob = 0;
        if (kind2 === 'tile') bob = Math.sin(S.t * 2.2 + seed * TAU) * 0.05;
        else if (kind2 === 'coin') bob = Math.sin(S.t * 2.8 + seed * TAU) * 0.05;
        else if (kind2 === 'power') bob = Math.sin(S.t * 2.4 + seed * TAU) * 0.09;
        var yWorld;
        if (kind2 === 'tile') yWorld = (typeof e.y === 'number' && isFinite(e.y) ? e.y : V.tileY) + bob;
        else if (kind2 === 'coin') yWorld = (typeof e.y === 'number' && isFinite(e.y) ? e.y : V.coinY) + bob;
        else if (kind2 === 'power') yWorld = (typeof e.y === 'number' && isFinite(e.y) ? e.y : V.powerY) + bob;
        else yWorld = 0;
        var pGround = U.project(x, 0, z, S.camX);
        var pCenter = U.project(x, yWorld, z, S.camX);
        var s = pCenter.scale;
        /* 只设置 globalAlpha，不逐个实体 save/restore（实体绘制内部按需 save） */
        ctx.globalAlpha = alpha;
        if (kind2 === 'tile') drawTileEntity(ctx, S, pGround, pCenter, s, e, seed);
        else if (kind2 === 'obstacle') drawObstacleEntity(ctx, S, pGround, s, e, seed, alpha);
        else if (kind2 === 'coin') drawCoinEntity(ctx, S, pGround, pCenter, s, seed);
        else drawPowerEntity(ctx, S, pGround, pCenter, s, e, seed);
      }
      ctx.globalAlpha = 1;
    } catch (e) {
      warnOnce('entities', e);
    } finally {
      ctx.restore();
    }
  }

  var entityScratch = [];

  /* ======================================================================
   * 十、对外 API
   * ==================================================================== */
  function drawAll(ctx, scene) {
    NW.art.World.drawBackground(ctx, scene);
    NW.art.World.drawRoad(ctx, scene);
    NW.art.World.drawProps(ctx, scene);
    NW.art.World.drawEntities(ctx, scene);
  }

  var art = NW.art || (NW.art = {});
  art.World = {
    version: '1.2.0',
    drawBackground: drawBackground,
    drawRoad: drawRoad,
    drawProps: drawProps,
    drawEntities: drawEntities,
    draw: drawAll,
    /* 调试辅助（不影响正式接口）：按世界坐标投影，便于其它模块校准 */
    project: function (x, y, z, camX) { return U.project(x, y, z, camX); },
    /* 调试辅助：在屏幕坐标画一个数字方块（preview 的数字特写用） */
    debugDrawTile: function (ctx, value, x, y, size) {
      if (!ctx || !ctx.save) return;
      ctx.save();
      try {
        drawTileCard(ctx, value, x, y, Math.max(8, size || 96));
      } finally {
        ctx.restore();
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
