/* ==========================================================================
 * 《奶娃》启动器：canvas 尺寸/DPR、主循环、输入分发、URL 调试参数、NW.debug
 * 负责人：Lead。对外 API：NW.debug（QA 依赖）
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG, U = NW.util, S = NW.save, G = NW.game;

  var canvas = null, lastT = 0, rafId = 0;
  var fps = 60, fpsAcc = 0, fpsFrames = 0;
  var errors = [];
  var booted = false;
  var audioUnlocked = false;
  var params = {};
  var pointer = null;

  /* ---------------- URL 参数 ---------------- */
  function parseQuery(search) {
    var out = {};
    var q = String(search || '').replace(/^\?/, '');
    if (!q) return out;
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var idx = parts[i].indexOf('=');
      var k = idx < 0 ? parts[i] : parts[i].slice(0, idx);
      var v = idx < 0 ? '' : parts[i].slice(idx + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    }
    return out;
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function has(key) { return Object.prototype.hasOwnProperty.call(params, key); }

  /* ---------------- 错误收集 ---------------- */
  function recordError(msg, at) {
    errors.push({ msg: String(msg && msg.stack ? msg.stack : msg), at: at || 'window', time: Date.now() });
    if (errors.length > 60) errors.shift();
    if (G && G.debug && G.debug.pushError) G.debug.pushError(msg);
  }
  function installErrorHook() {
    global.addEventListener('error', function (e) {
      recordError((e && e.message) || 'unknown error', 'window.onerror');
    });
    global.addEventListener('unhandledrejection', function (e) {
      recordError('unhandledrejection: ' + (e && e.reason ? (e.reason.stack || e.reason) : 'unknown'), 'promise');
    });
  }

  /* ---------------- canvas / 舞台 ---------------- */
  function resize() {
    if (!canvas) return;
    if (NW.ui && typeof NW.ui.onResize === 'function') {
      try { NW.ui.onResize(); } catch (e) { recordError(e, 'ui.onResize'); }
    }
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (G.setViewport) G.setViewport(w / CFG.W, h / CFG.H);
    try { if (G.draw) G.draw(); } catch (e) { }
  }

  /* ---------------- 主循环 ---------------- */
  function frame(now) {
    if (!lastT) lastT = now;
    var dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.25) dt = 0.25;
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0; fpsFrames = 0;
    }
    try { G.frame(dt); } catch (e) { recordError(e, 'game.frame'); }
    rafId = global.requestAnimationFrame(frame);
  }

  /* ---------------- 输入 ---------------- */
  function laneInput(dir) {
    if (!G.input) return;
    try { G.input(dir); } catch (e) { recordError(e, 'input'); }
  }
  function actionInput(kind) {
    if (!G.action) return;
    try { G.action(kind); } catch (e) { recordError(e, 'action'); }
  }
  function onPointerDown(ev) {
    unlockAudio();
    if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;
    pointer = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, fired: false, t: Date.now() };
    try { if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId); } catch (e) { }
  }
  function onPointerMove(ev) {
    if (!pointer || ev.pointerId !== pointer.id || pointer.fired) return;
    var rect = canvas.getBoundingClientRect();
    var thr = 24 * (rect.width / CFG.W || 1);
    var dx = ev.clientX - pointer.x;
    var dy = ev.clientY - pointer.y;
    if (Math.abs(dx) >= thr || Math.abs(dy) >= thr) {
      pointer.fired = true;
      if (Math.abs(dy) > Math.abs(dx)) {
        actionInput(dy > 0 ? 'slide' : 'jump');
      } else {
        laneInput(dx > 0 ? 1 : -1);
      }
    }
  }
  function onPointerUp(ev) {
    if (!pointer || ev.pointerId !== pointer.id) { pointer = null; return; }
    var rect = canvas.getBoundingClientRect();
    var thr = 24 * (rect.width / CFG.W || 1);
    var dx = ev.clientX - pointer.x;
    var dy = ev.clientY - pointer.y;
    if (!pointer.fired) {
      if ((Math.abs(dy) >= thr || Math.abs(dx) >= thr) && Math.abs(dy) > Math.abs(dx)) {
        actionInput(dy > 0 ? 'slide' : 'jump');
      } else if (Math.abs(dx) >= thr) {
        laneInput(dx > 0 ? 1 : -1);
      } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        // 桌面端点击左/右半屏也可换道（游戏内）
        var cx = ev.clientX - rect.left;
        laneInput(cx < rect.width / 2 ? -1 : 1);
      }
    }
    pointer = null;
  }
  function onKeyDown(ev) {
    unlockAudio();
    var k = ev.key;
    var playing = G.getStateName && G.getStateName() === 'playing';
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { laneInput(-1); ev.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { laneInput(1); ev.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'w' || k === 'W' || (k === ' ' && playing)) {
      actionInput('jump'); ev.preventDefault();
    }
    else if (k === 'ArrowDown' || k === 's' || k === 'S') { actionInput('slide'); ev.preventDefault(); }
    else if (k === 'Escape' || k === 'p' || k === 'P') {
      var st = G.getStateName ? G.getStateName() : '';
      if (st === 'playing') G.pause();
      else if (st === 'paused') G.resume();
    } else if ((k === 'Enter' || k === ' ') && G.getStateName && G.getStateName() === 'gameover') {
      if (k === ' ') ev.preventDefault();
      if (G.debug && G.debug.start) G.debug.start(G.debug.getState().modeId || 'endless', { skipTutorial: true });
    }
  }
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (!NW.audio) return;
    try { if (NW.audio.init) NW.audio.init(); } catch (e) { }
    try { if (NW.audio.unlock) NW.audio.unlock(); } catch (e) { }
    try {
      if (NW.audio.startMusic && S.setting('music')) NW.audio.startMusic(G.getStateName && G.getStateName() === 'playing' ? 'game' : 'menu');
    } catch (e) { }
  }

  /* ---------------- 演示存档 / URL 屏幕 ---------------- */
  function seedDemoSave() {
    var st = S.get();
    st.coins = 2680;
    st.best.endless = 15900;
    st.best.sprint = 16800;
    st.bestDistance.endless = 512;
    st.bestDistance.sprint = 438;
    st.bestTile = 128;
    st.runs = 27;
    st.ownedSkins = ['classic', 'mint', 'sakura'];
    st.ownedThemes = ['day', 'sunset'];
    st.equip.skin = 'classic';
    st.equip.theme = 'day';
    st.tutorialSeen = true;
    st.nickname = '奶娃玩家';
    S.save(true);
  }

  function applyUrlProfile() {
    if (has('demoSave')) seedDemoSave();
    var st = S.get();
    if (has('skin') && CFG.skin(params.skin)) {
      var sid = CFG.skin(params.skin).id;
      if (st.ownedSkins.indexOf(sid) < 0) st.ownedSkins.push(sid);
      st.equip.skin = sid;
    }
    if (has('theme') && CFG.theme(params.theme)) {
      var tid = CFG.theme(params.theme).id;
      if (st.ownedThemes.indexOf(tid) < 0) st.ownedThemes.push(tid);
      st.equip.theme = tid;
    }
    if (has('skin') || has('theme') || has('demoSave')) S.save(true);
  }

  function screenFromUrl() {
    var screen = params.screen || 'menu';
    var mode = params.mode === 'sprint' ? 'sprint' : 'endless';
    var seed = has('seed') ? num(params.seed, 12345) : 12345;
    var warmup = num(params.warmup, screen === 'over' ? 20 : 0);
    var doFreeze = params.freeze !== '0';
    try {
      if (screen === 'game' || screen === 'over') {
        G.debug.start(mode, { seed: seed, skipTutorial: true });
        if (warmup > 0) G.debug.warmup(warmup);
        if (has('auto')) G.debug.setAuto(params.auto !== '0');
        else G.debug.setAuto(true);
        if (screen === 'over') {
          // 让调试结算面板呈现真实的「心尽」状态（含复活按钮）
          try { G.debug.setHearts(0); } catch (e) { }
          G.debug.forceGameOver('hearts');
        }
        if (doFreeze) G.debug.freeze(true);
      } else if (screen === 'tutorial') {
        G.debug.showTutorial();
      } else if (screen === 'ad') {
        G.debug.showAd(params.ad || 'revive');
      } else if (screen === 'shop') {
        if (NW.ui) { NW.ui.showScreen('shop'); if (NW.ui.refreshShop) NW.ui.refreshShop(); }
      } else if (screen === 'leaderboard') {
        if (NW.ui) { NW.ui.showScreen('leaderboard'); if (NW.ui.refreshLeaderboard) NW.ui.refreshLeaderboard(params.mode === 'sprint' ? 'sprint' : 'endless'); }
      } else if (screen === 'settings') {
        if (NW.ui) { NW.ui.showScreen('settings'); if (NW.ui.refreshSettings) NW.ui.refreshSettings(); }
      } else if (screen === 'paused') {
        G.debug.start(mode, { seed: seed, skipTutorial: true });
        if (warmup > 0) G.debug.warmup(warmup);
        G.pause();
        if (doFreeze) G.debug.freeze(true);
      }
    } catch (e) {
      recordError(e, 'screenFromUrl');
    }
  }

  /* ---------------- 调试 API ---------------- */
  function makeDebug() {
    var D = {
      ready: false,
      version: CFG.version,
      start: function (mode, opts) { return G.debug.start(mode, opts); },
      showScreen: function (name) { return G.debug.showScreen(name); },
      warmup: function (s) { return G.debug.warmup(s); },
      autoPlay: function (on) { G.debug.setAuto(on); return true; },
      freeze: function (v) { G.debug.freeze(v); return true; },
      getState: function () {
        var st = G.debug.getState();
        st.fps = Math.round(fps * 10) / 10;
        st.errors = errors.slice();
        st.cfg = { W: CFG.W, H: CFG.H, version: CFG.version };
        return st;
      },
      giveCoins: function (n) { return G.debug.giveCoins(n); },
      giveTile: function (v) { return G.debug.giveTile(v); },
      action: function (kind) { if (G.action) { G.action(kind); return true; } return false; },
      setHearts: function (n) { return G.debug.setHearts(n); },
      forceGameOver: function (reason) { return G.debug.forceGameOver(reason); },
      hit: function () { return G.debug.hit(); },
      seedDemoSave: function () { seedDemoSave(); if (NW.ui) { NW.ui.setCoins(S.coins()); if (NW.ui.refreshShop) NW.ui.refreshShop(); } return true; },
      clearSave: function () { S.reset(); if (NW.ui) { NW.ui.setCoins(S.coins()); if (NW.ui.refreshShop) NW.ui.refreshShop(); } return true; },
      finishAd: function () { return G.debug.finishAd(); },
      finishTutorial: function () { return G.debug.finishTutorial ? G.debug.finishTutorial() : false; },
      // 规范：NW.debug.errors 是实时数组（QA 直接读取）
      errors: errors
    };
    return D;
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (booted) return;
    booted = true;
    params = parseQuery(global.location && global.location.search);
    installErrorHook();

    canvas = global.document.getElementById('game');
    if (!canvas) {
      recordError('找不到 canvas#game', 'boot');
      return;
    }
    canvas.style.touchAction = 'none';

    S.load();
    applyUrlProfile();

    if (!global.NW.core || !global.NW.core.Run || !global.NW.art) {
      // 允许其他模块暂未完成时的降级启动，但仍记录
      recordError('部分模块未加载（core/art），请检查 index.html 脚本顺序', 'boot.check');
    }

    G.init(canvas);
    NW.debug = makeDebug();
    NW.debug.ready = true;

    resize();
    global.addEventListener('resize', resize);
    global.addEventListener('orientationchange', function () { setTimeout(resize, 120); });
    if (global.ResizeObserver && global.document.getElementById('stage')) {
      try {
        var ro = new global.ResizeObserver(function () { resize(); });
        ro.observe(global.document.getElementById('stage'));
      } catch (e) { }
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', function () { pointer = null; });
    global.addEventListener('keydown', onKeyDown);
    global.addEventListener('pointerdown', unlockAudio, { once: true });

    screenFromUrl();

    lastT = 0;
    rafId = global.requestAnimationFrame(frame);
    canvas.style.opacity = '1';
  }

  NW.main = {
    boot: boot,
    resize: resize,
    getFps: function () { return fps; }
  };

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
