/* ==========================================================================
 * 《奶娃》粒子 / 光环 / 上浮文字特效 —— NW.art.FX
 * 负责人：character-art（队友 B）
 * --------------------------------------------------------------------------
 * 对外 API（SPEC 4.2）：
 *   var fx = new NW.art.FX();
 *   fx.reset();
 *   fx.update(dt);
 *   fx.draw(ctx);
 *   fx.burst(x, y, opts);      // opts {color, color2, count=12, speed=180,
 *                              //       size=6, life=0.6, gravity=600,
 *                              //       shape:'star'|'circle'|'square', angle, spread, glow}
 *   fx.hit(x, y);              // 撞击：星星 + 红色碎片 + 白闪 + 冲击环
 *   fx.coin(x, y);             // 金币闪光 + 金色小环
 *   fx.power(x, y, color);     // 道具光爆（范围环 + 星屑）
 *   fx.ring(x, y, color, radius);
 *   fx.text(x, y, text, opts); // opts {color, size, life, vy, shadow}
 *   fx.count();                // 当前存活粒子数（调试 / 性能自检）
 *   fx.sparkle(x, y, color);   // 轻量单颗星屑（可选便捷接口）
 * --------------------------------------------------------------------------
 * 实现：固定对象池 + 游标复用，粒子上限 220，运行时 0 次 new；
 *       ctx.save()/restore() 成对，不污染外部状态；无图片 / 字体依赖。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = (global.NW = global.NW || {});
  var art = (NW.art = NW.art || {});
  var CFG = NW.CFG || {};
  var U = NW.util || null;

  var MAX_PARTICLES = 220;
  var MAX_RINGS = 18;
  var MAX_TEXTS = 24;

  /* 形状编号 */
  var SH_CIRCLE = 0;
  var SH_STAR = 1;
  var SH_SQUARE = 2;
  var SH_SPARK = 3;   /* 四角星芒 */
  var SH_FLASH = 4;   /* 柔光爆闪 */
  var SH_TRI = 5;     /* 三角碎片 */

  var SHAPE_ID = { circle: SH_CIRCLE, star: SH_STAR, square: SH_SQUARE, spark: SH_SPARK, flash: SH_FLASH, tri: SH_TRI };

  function rgba(hex, a) {
    if (U && U.rgba) return U.rgba(hex, a === undefined ? 1 : a);
    var h = String(hex || '#FFFFFF').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0xFFFFFF;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (a === undefined ? 1 : a) + ')';
  }
  function lighten(hex, t) { return (U && U.lighten) ? U.lighten(hex, t) : rgba(hex, 1); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function makeParticle() {
    return {
      on: false, x: 0, y: 0, vx: 0, vy: 0, g: 0, drag: 0,
      life: 0, max: 1, size: 6, rot: 0, vr: 0,
      shape: SH_CIRCLE, c: '#FFFFFF', glow: false, fade: 1, shrink: 1, alpha: 1, add: false
    };
  }
  function makeRing() {
    return { on: false, x: 0, y: 0, r0: 0, r1: 40, w: 4, life: 0, max: 1, c: '#FFFFFF', alpha: 1, ease: 2 };
  }
  function makeText() {
    return { on: false, x: 0, y: 0, vy: 0, life: 0, max: 1, size: 26, c: '#FFFFFF', str: '', shadow: true, pop: 0 };
  }

  function FX() {
    this.particles = [];
    for (var i = 0; i < MAX_PARTICLES; i++) this.particles.push(makeParticle());
    this.pc = 0;
    this.rings = [];
    for (i = 0; i < MAX_RINGS; i++) this.rings.push(makeRing());
    this.rc = 0;
    this.texts = [];
    for (i = 0; i < MAX_TEXTS; i++) this.texts.push(makeText());
    this.tc = 0;
    this.active = 0;
  }

  /* ---------------- 对象池分配 ---------------- */
  FX.prototype._particle = function () {
    var list = this.particles, n = list.length, i, idx;
    for (i = 0; i < n; i++) {
      idx = (this.pc + i) % n;
      if (!list[idx].on) { this.pc = (idx + 1) % n; return list[idx]; }
    }
    /* 全满：覆盖游标处（最旧） */
    var p = list[this.pc];
    this.pc = (this.pc + 1) % n;
    return p;
  };
  FX.prototype._ring = function () {
    var list = this.rings, n = list.length, i, idx;
    for (i = 0; i < n; i++) {
      idx = (this.rc + i) % n;
      if (!list[idx].on) { this.rc = (idx + 1) % n; return list[idx]; }
    }
    var r = list[this.rc]; this.rc = (this.rc + 1) % n; return r;
  };
  FX.prototype._text = function () {
    var list = this.texts, n = list.length, i, idx;
    for (i = 0; i < n; i++) {
      idx = (this.tc + i) % n;
      if (!list[idx].on) { this.tc = (idx + 1) % n; return list[idx]; }
    }
    var t = list[this.tc]; this.tc = (this.tc + 1) % n; return t;
  };

  /* ---------------- 生命周期 ---------------- */
  FX.prototype.reset = function () {
    var i;
    for (i = 0; i < this.particles.length; i++) this.particles[i].on = false;
    for (i = 0; i < this.rings.length; i++) this.rings[i].on = false;
    for (i = 0; i < this.texts.length; i++) this.texts[i].on = false;
    this.pc = this.rc = this.tc = 0;
    this.active = 0;
  };

  FX.prototype.count = function () {
    var n = 0, i, p = this.particles;
    for (i = 0; i < p.length; i++) if (p[i].on) n++;
    return n;
  };

  FX.prototype.update = function (dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;   /* 卡帧保护 */
    var i, p, n = 0;

    for (i = 0; i < this.particles.length; i++) {
      p = this.particles[i];
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) { p.on = false; continue; }
      p.vy += p.g * dt;
      if (p.drag) {
        var d = Math.max(0, 1 - p.drag * dt);
        p.vx *= d; p.vy *= d;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      n++;
    }
    this.active = n;

    for (i = 0; i < this.rings.length; i++) {
      var r = this.rings[i];
      if (!r.on) continue;
      r.life -= dt;
      if (r.life <= 0) r.on = false;
    }
    for (i = 0; i < this.texts.length; i++) {
      var t = this.texts[i];
      if (!t.on) continue;
      t.life -= dt;
      if (t.life <= 0) { t.on = false; continue; }
      t.y += t.vy * dt;
      t.vy *= Math.max(0, 1 - 2.4 * dt);
      t.pop = Math.min(1, t.pop + dt * 7);
    }
  };

  /* ---------------- 生成 ---------------- */
  FX.prototype._spawn = function (x, y, cfg) {
    var p = this._particle();
    p.on = true;
    p.x = x; p.y = y;
    p.vx = cfg.vx; p.vy = cfg.vy;
    p.g = cfg.g || 0;
    p.drag = cfg.drag || 0;
    p.max = p.life = cfg.life;
    p.size = cfg.size;
    p.rot = cfg.rot || 0;
    p.vr = cfg.vr || 0;
    p.shape = cfg.shape;
    p.c = cfg.c;
    p.glow = !!cfg.glow;
    p.fade = cfg.fade === undefined ? 1 : cfg.fade;
    p.shrink = cfg.shrink === undefined ? 1 : cfg.shrink;
    p.alpha = cfg.alpha === undefined ? 1 : cfg.alpha;
    p.add = cfg.add === undefined ? !!cfg.glow : !!cfg.add;
    return p;
  };

  FX.prototype.burst = function (x, y, opts) {
    opts = opts || {};
    var count = opts.count === undefined ? 12 : Math.max(1, Math.min(80, opts.count | 0));
    var speed = opts.speed === undefined ? 180 : opts.speed;
    var size = opts.size === undefined ? 6 : opts.size;
    var life = opts.life === undefined ? 0.6 : opts.life;
    var gravity = opts.gravity === undefined ? 600 : opts.gravity;
    var shape = SHAPE_ID[opts.shape] === undefined ? SH_STAR : SHAPE_ID[opts.shape];
    var c1 = opts.color || '#FFD75E';
    var c2 = opts.color2 || c1;
    var angle = (opts.angle === undefined) ? null : opts.angle;
    var spread = opts.spread === undefined ? Math.PI * 2 : opts.spread;
    var glow = opts.glow === undefined ? true : !!opts.glow;
    var drag = opts.drag === undefined ? 1.4 : opts.drag;

    for (var i = 0; i < count; i++) {
      var a = (angle === null) ? Math.random() * Math.PI * 2
        : angle + (Math.random() - 0.5) * spread;
      var sp = speed * rnd(0.35, 1);
      this._spawn(x, y, {
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        g: gravity,
        drag: drag,
        life: life * rnd(0.7, 1.25),
        size: size * rnd(0.55, 1.25),
        rot: Math.random() * Math.PI * 2,
        vr: rnd(-8, 8),
        shape: shape,
        c: (i % 2 === 1) ? c2 : c1,
        glow: glow,
        alpha: 1
      });
    }
  };

  FX.prototype.hit = function (x, y) {
    var i, a, sp;
    /* 白闪 */
    this._spawn(x, y, {
      vx: 0, vy: 0, g: 0, life: 0.22, max: 0.22, size: 54, shape: SH_FLASH,
      c: '#FFFFFF', glow: false, fade: 1.6, alpha: 0.95
    });
    /* 红色碎片 */
    for (i = 0; i < 14; i++) {
      a = Math.random() * Math.PI * 2;
      sp = rnd(110, 330);
      this._spawn(x, y, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        g: 820, drag: 0.9, life: rnd(0.4, 0.78),
        size: rnd(5, 10), rot: Math.random() * 6.28, vr: rnd(-12, 12),
        shape: (i % 3 === 0) ? SH_TRI : SH_SQUARE,
        c: (i % 3 === 0) ? '#FF5252' : (i % 3 === 1 ? '#FF7A45' : '#D32F2F'),
        glow: false
      });
    }
    /* 星星火花 */
    for (i = 0; i < 11; i++) {
      a = -Math.PI / 2 + rnd(-1.5, 1.5);
      sp = rnd(140, 360);
      this._spawn(x, y, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: 460, drag: 1.2, life: rnd(0.34, 0.72),
        size: rnd(6, 11), rot: Math.random() * 6.28, vr: rnd(-6, 6),
        shape: SH_STAR,
        c: i % 2 ? '#FFD54F' : '#FFF3C4',
        glow: true
      });
    }
    this.ring(x, y, '#FF8A65', 78);
  };

  FX.prototype.coin = function (x, y) {
    var i, a, sp;
    for (i = 0; i < 10; i++) {
      a = Math.random() * Math.PI * 2;
      sp = rnd(50, 190);
      this._spawn(x, y, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        g: 320, drag: 1.6, life: rnd(0.35, 0.68),
        size: rnd(3, 6.5), rot: Math.random() * 6.28, vr: rnd(-9, 9),
        shape: i % 3 === 0 ? SH_STAR : SH_CIRCLE,
        c: i % 3 === 0 ? '#FFF8C9' : '#FFC93D',
        glow: true
      });
    }
    this.ring(x, y, '#FFD75E', 34);
  };

  FX.prototype.power = function (x, y, color) {
    color = color || '#7EE8FF';
    var i, a, sp;
    this._spawn(x, y, {
      vx: 0, vy: 0, g: 0, life: 0.32, size: 64, shape: SH_FLASH,
      c: lighten(color, 0.5), glow: false, fade: 1.5, alpha: 0.9
    });
    for (i = 0; i < 16; i++) {
      a = Math.random() * Math.PI * 2;
      sp = rnd(80, 260);
      this._spawn(x, y, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        g: 160, drag: 2.2, life: rnd(0.4, 0.8),
        size: rnd(4, 9), rot: Math.random() * 6.28, vr: rnd(-7, 7),
        shape: i % 2 ? SH_SPARK : SH_STAR,
        c: i % 3 === 0 ? '#FFFFFF' : color,
        glow: true
      });
    }
    this.ring(x, y, color, 86);
    this.ring(x, y, lighten(color, 0.4), 52);
  };

  FX.prototype.ring = function (x, y, color, radius) {
    var r = this._ring();
    r.on = true;
    r.x = x; r.y = y;
    r.r0 = Math.max(2, (radius || 40) * 0.12);
    r.r1 = Math.max(6, radius || 40);
    r.w = Math.max(1.5, r.r1 * 0.09);
    r.max = r.life = 0.45;
    r.c = color || '#FFFFFF';
    r.alpha = 1;
    return r;
  };

  FX.prototype.sparkle = function (x, y, color) {
    this._spawn(x, y, {
      vx: rnd(-30, 30), vy: rnd(-70, -20), g: 120, drag: 1,
      life: rnd(0.3, 0.55), size: rnd(3, 6),
      rot: Math.random() * 6.28, vr: rnd(-5, 5),
      shape: SH_SPARK, c: color || '#FFFFFF', glow: true
    });
  };

  FX.prototype.text = function (x, y, str, opts) {
    opts = opts || {};
    var t = this._text();
    t.on = true;
    t.x = x; t.y = y;
    t.vy = opts.vy === undefined ? -64 : opts.vy;
    t.max = t.life = opts.life === undefined ? 0.92 : opts.life;
    t.size = opts.size === undefined ? 28 : opts.size;
    t.c = opts.color || '#FFFFFF';
    t.str = str === undefined || str === null ? '' : String(str);
    t.shadow = opts.shadow === undefined ? true : !!opts.shadow;
    t.pop = 0;
    return t;
  };

  /* ---------------- 绘制 ---------------- */
  function drawStar(ctx, r) {
    var i, ang, rad;
    ctx.beginPath();
    for (i = 0; i < 10; i++) {
      ang = -Math.PI / 2 + (i * Math.PI) / 5;
      rad = i % 2 === 0 ? r : r * 0.46;
      if (i === 0) ctx.moveTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
      else ctx.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
    }
    ctx.closePath();
  }
  function drawSpark(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.16, -r * 0.16, r, 0);
    ctx.quadraticCurveTo(r * 0.16, r * 0.16, 0, r);
    ctx.quadraticCurveTo(-r * 0.16, r * 0.16, -r, 0);
    ctx.quadraticCurveTo(-r * 0.16, -r * 0.16, 0, -r);
    ctx.closePath();
  }
  function drawTri(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.92, r * 0.7);
    ctx.lineTo(-r * 0.92, r * 0.7);
    ctx.closePath();
  }

  FX.prototype.draw = function (ctx) {
    if (!ctx || !ctx.beginPath) return;
    var i, p, r, t, k, a;

    ctx.save();

    /* 1) 冲击环 */
    for (i = 0; i < this.rings.length; i++) {
      r = this.rings[i];
      if (!r.on) continue;
      k = 1 - r.life / r.max;
      var rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3));
      a = (1 - k) * (1 - k) * r.alpha;
      ctx.globalAlpha = a;
      ctx.strokeStyle = r.c;
      ctx.lineWidth = Math.max(0.6, r.w * (1 - k * 0.65));
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* 2) 普通混合粒子 */
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    for (i = 0; i < this.particles.length; i++) {
      p = this.particles[i];
      if (!p.on || p.add) continue;
      k = p.life / p.max;
      a = Math.pow(Math.max(0, k), p.fade) * p.alpha;
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      var sz = p.size * (p.shrink < 1 ? (p.shrink + (1 - p.shrink) * Math.max(0, k)) : 1);

      if (p.shape === SH_FLASH) {
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz * (0.55 + 0.45 * (1 - k)), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a * 0.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz * (1.25 + (1 - k)), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      if (p.shape === SH_CIRCLE) {
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        if (p.shape === SH_SQUARE) {
          var s2 = sz * 0.9;
          ctx.fillRect(-s2 * 0.5, -s2 * 0.5, s2, s2);
        } else if (p.shape === SH_TRI) {
          drawTri(ctx, sz);
          ctx.fill();
        } else if (p.shape === SH_SPARK) {
          drawSpark(ctx, sz);
          ctx.fill();
        } else {
          drawStar(ctx, sz);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    /* 3) 发光粒子（加法混合，让火花更闪） */
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < this.particles.length; i++) {
      p = this.particles[i];
      if (!p.on || !p.add) continue;
      k = p.life / p.max;
      a = Math.pow(Math.max(0, k), p.fade) * p.alpha;
      if (a <= 0.004) continue;
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = p.c;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      drawSpark(ctx, p.size * (0.6 + 0.4 * k) * 1.5);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';

    /* 4) 上浮文字 */
    for (i = 0; i < this.texts.length; i++) {
      t = this.texts[i];
      if (!t.on) continue;
      k = t.life / t.max;
      a = k < 0.22 ? k / 0.22 : Math.min(1, (1 - k) / 0.18 + 0.55);
      if (a <= 0.01) continue;
      var pop = t.pop >= 1 ? 1 : (0.55 + 0.45 * t.pop + 0.28 * Math.sin(t.pop * Math.PI));
      var size = Math.max(8, t.size * pop);
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.font = '700 ' + size.toFixed(1) + 'px ' + ((CFG.fonts && CFG.fonts.ui) || '"Microsoft YaHei", sans-serif');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (t.shadow) {
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(90,58,34,0.85)';
        ctx.lineWidth = Math.max(2, size * 0.16);
        ctx.strokeText(t.str, t.x, t.y);
      }
      ctx.fillStyle = t.c;
      ctx.fillText(t.str, t.x, t.y);
    }

    ctx.restore();
  };

  art.FX = FX;
})(typeof window !== 'undefined' ? window : globalThis);
