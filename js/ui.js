/* ==========================================================================
 * 《奶娃》跑酷 × 2048 合成 —— UI 层（NW.ui）
 * 负责人：ui-shell
 * 职责：屏幕切换 / HUD 每帧增量更新（分数·距离·金币·心·道具·连击·最高方块·5 格合成槽）
 *       结算 / 商店 / 排行榜 / 设置 / 教程 / 模拟广告 / 横幅 / 倒计时 / Toast / 舞台缩放
 * 对外 API（SPEC 5.2）：
 *   NW.ui.init(handlers)  showScreen(name)  updateHUD(view, events)  showCountdown(label)
 *   showBanner(title, sub, opts)  showGameOver(result)  showAd(kind, onDone)  toast(text)
 *   setCoins(n)  setPaused(bool)  refreshShop()  refreshLeaderboard(mode)  refreshSettings()
 *   setNicknameInput(name)  showTutorial(force)  hideTutorial()  onResize()  isOverlayOpen()  finishAd()
 * 约定：UI 只读 NW.save；所有写操作通过 handlers 交给 game.js（handler 缺失时有只读/回退保护）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG || {};
  var U = NW.util || {};
  var S = NW.save || null;

  var UI = (NW.ui = {});
  var W = CFG.W || 540;
  var H = CFG.H || 960;

  var DOC = global.document;

  /* ======================== 小工具 ======================== */
  function $(id) {
    return DOC ? DOC.getElementById(id) : null;
  }
  function qsa(sel, root) {
    if (!DOC) return [];
    try { return Array.prototype.slice.call((root || DOC).querySelectorAll(sel)); } catch (e) { return []; }
  }
  function setText(node, text) {
    if (!node) return;
    var t = String(text);
    if (node.textContent !== t) node.textContent = t;
  }
  function setHtml(node, html) {
    if (node && node.innerHTML !== html) node.innerHTML = html;
  }
  function show(node, visible) {
    if (!node) return;
    if (visible) node.hidden = false; else node.hidden = true;
  }
  function toggleClass(node, cls, on) {
    if (!node) return;
    if (on) node.classList.add(cls); else node.classList.remove(cls);
  }
  function esc(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(n) {
    if (U.formatScore) return U.formatScore(n || 0);
    return String(Math.max(0, Math.round(n || 0)));
  }
  function clamp(v, a, b) {
    if (U.clamp) return U.clamp(v, a, b);
    return v < a ? a : (v > b ? b : v);
  }
  function nowMs() {
    return U.now ? U.now() : Date.now();
  }
  function raf(fn) {
    if (global.requestAnimationFrame) return global.requestAnimationFrame(fn);
    return global.setTimeout(fn, 16);
  }
  function animClass(node, cls, ms) {
    if (!node) return;
    node.classList.remove(cls);
    /* 强制回流以重启动画 */
    void node.offsetWidth;
    node.classList.add(cls);
    if (node.__animTimer) { clearTimeout(node.__animTimer); }
    node.__animTimer = setTimeout(function () {
      node.classList.remove(cls);
    }, ms || 460);
  }
  function warn(tag, err) {
    try { if (global.console && console.warn) console.warn('[NW.ui] ' + tag, err); } catch (e) { }
  }
  function sfx(name) {
    try {
      if (NW.audio && typeof NW.audio.play === 'function') NW.audio.play(name);
    } catch (e) { }
  }

  /* ---------------- handlers 调用（全部 try/catch） ---------------- */
  var handlers = {};
  function hasHandler(name) {
    return typeof handlers[name] === 'function';
  }
  function invoke(name, a, b, c) {
    if (!hasHandler(name)) return undefined;
    try {
      return handlers[name].call(null, a, b, c);
    } catch (err) {
      warn('handler ' + name + ' 抛错', err);
      return undefined;
    }
  }
  function handleResult(res, onOk, onFail) {
    if (res && typeof res.then === 'function') {
      res.then(function (r) {
        if (r && r.ok === false) onFail(r); else onOk(r);
      }).catch(function (e) {
        warn('handler promise 失败', e);
        onFail({ reason: 'error' });
      });
      return;
    }
    if (res && res.ok === false) onFail(res); else onOk(res);
  }

  /* ======================== 元素缓存 / 状态 ======================== */
  var el = {};
  var state = {
    screen: 'boot',
    inited: false,
    tutorialOpen: false,
    paused: false,
    wallet: 0,
    shopTab: 'skin',
    boardMode: 'endless',
    autoTutorial: false,
    firstMenuShown: false
  };

  var hudEls = {
    hearts: [],
    powerRows: {},
    slots: [],
    tiles: []
  };

  /* HUD diff 缓存（-1 / '' 表示「需要重绘」） */
  var hudCache = {
    score: -1, best: -1, distance: -1, wallet: -1, runCoins: -1,
    hearts: -1, maxHearts: 0, maxTile: -1, combo: -1, comboMult: -1,
    mode: '', bestMode: '', timeLeft: -1, timeUrgent: null,
    rackSig: '', powers: { shield: -1, slow: -1, magnet: -1, double: -1 }
  };

  var lastView = null;
  var pending = { comboPop: false, heartHit: false, badgePop: false, badgeNew: false };
  var lastCountdown = null;
  var bannerTimer = 0;
  var adState = { active: false, done: false, kind: 'revive', onDone: null, start: 0, delay: 2200, raf: 0, finishTimer: 0 };
  var resetConfirmTimer = 0;

  var POWER_ICON = { shield: '盾', slow: '缓', magnet: '磁', double: '双' };

  /* 合成槽布局常量（必须与 css/style.css 中 .hud-rack / .rack-slot 保持一致） */
  var RACK = { left: 16, slotW: 92, gap: 12, slotH: 96, bottom: 16, headH: 28 };

  /* ======================== 元素缓存 ======================== */
  function cacheEls() {
    el.stage = $('stage');
    el.hud = $('hud');
    el.scoreEl = $('hud-score');
    el.scoreCard = $('hud-score-card');
    el.heartsBox = $('hud-hearts');
    el.hudBest = $('hud-best');
    el.modeName = $('hud-mode-name');
    el.distance = $('hud-distance');
    el.timer = $('hud-timer');
    el.timerNum = $('hud-timer-num');
    el.timerFill = $('hud-timer-fill');
    el.pauseBtn = $('hud-pause');
    el.coinsEl = $('hud-coins');
    el.maxBadge = $('hud-max-badge');
    el.maxTile = $('hud-max-tile');
    el.powerups = $('hud-powerups');
    el.combo = $('hud-combo');
    el.comboX = $('hud-combo-x');
    el.hudFx = $('hud-fx');
    el.rack = $('hud-rack');
    el.runCoins = $('hud-runcoins');

    el.menuCoins = $('menu-coins');
    el.menuBest = $('menu-best');
    el.menuArt = $('menu-art');
    el.menuArtImg = $('menu-keyart-img');
    el.bootVersion = $('boot-version');

    el.pauseScore = $('pause-score');
    el.pauseDistance = $('pause-distance');
    el.pauseMode = $('pause-mode');

    el.goBadge = $('go-badge');
    el.goTitle = $('go-title');
    el.goRecord = $('go-record');
    el.goBurst = $('go-burst');
    el.goScore = $('go-score');
    el.goDistance = $('go-distance');
    el.goMaxtile = $('go-maxtile');
    el.goBest = $('go-best');
    el.goMerges = $('go-merges');
    el.goCoins = $('go-coins');
    el.goCoinsBonus = $('go-coins-bonus');
    el.btnRevive = $('btn-revive');
    el.btnDouble = $('btn-ad-double');
    el.btnDoubleMain = el.btnDouble ? el.btnDouble.querySelector('.btn-main') : null;
    el.btnDoubleSub = el.btnDouble ? el.btnDouble.querySelector('.btn-sub') : null;
    el.goAdRow = el.btnRevive ? el.btnRevive.parentNode : null;

    el.shopTabs = $('shop-tabs');
    el.shopTabGlider = $('shop-tab-glider');
    el.shopGrid = $('shop-grid');
    el.shopCoins = $('shop-coins');
    el.shopScroll = el.shopGrid ? el.shopGrid.parentNode : null;

    el.lbTabs = $('lb-tabs');
    el.lbTabGlider = $('lb-tab-glider');
    el.lbList = $('lb-list');
    el.lbSelf = $('lb-self');
    el.lbBest = $('lb-best');

    el.settingsCoins = $('settings-coins');
    el.nickInput = $('nickname-input');
    el.resetConfirm = $('reset-confirm');
    el.setVersion = $('set-version');

    el.tutorial = $('overlay-tutorial');
    el.iconAd = $('overlay-ad');
    el.adTitle = $('ad-title');
    el.adFill = $('ad-progress-fill');
    el.adTimer = $('ad-timer');
    el.adClaim = $('btn-ad-claim');
    el.adClaimText = $('ad-claim-text');

    el.countdownLayer = $('countdown-layer');
    el.bannerLayer = $('banner-layer');
    el.toastLayer = $('toast-layer');

    el.screens = qsa('.screen', el.stage);
    el.screenMap = {};
    for (var i = 0; i < el.screens.length; i++) {
      var name = el.screens[i].getAttribute('data-screen');
      if (name) el.screenMap[name] = el.screens[i];
    }
  }

  /* ======================== 舞台缩放 ======================== */
  function applyScale() {
    if (!el.stage) cacheEls();
    if (!el.stage) return;
    var vw = (global.innerWidth || W);
    var vh = (global.innerHeight || H);
    var s = Math.min(vw / W, vh / H);
    if (!isFinite(s) || s <= 0) s = 1;
    s = Math.max(0.2, s);
    s = Math.round(s * 10000) / 10000;
    el.stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
    el.stage.style.setProperty('--stage-scale', String(s));
  }

  UI.onResize = function () {
    try { applyScale(); } catch (e) { warn('onResize', e); }
  };

  /* ======================== 屏幕切换 ======================== */
  function setActiveScreen(name) {
    for (var i = 0; i < el.screens.length; i++) {
      var sec = el.screens[i];
      var is = sec.getAttribute('data-screen') === name;
      sec.classList.toggle('is-active', is);
      sec.setAttribute('aria-hidden', is ? 'false' : 'true');
    }
  }

  UI.showScreen = function (name) {
    try {
      if (!el.stage) cacheEls();
      name = String(name || 'menu');

      if (name === 'playing') {
        var fromPaused = state.screen === 'paused';
        state.screen = 'playing';
        state.paused = false;
        setActiveScreen(null);
        el.stage.classList.add('is-playing');
        el.stage.classList.remove('is-paused');
        UI.hideTutorial();
        clearCountdown();
        if (!fromPaused) resetHudDirty();
        return;
      }

      if (name === 'paused') {
        state.screen = 'paused';
        state.paused = true;
        setActiveScreen('paused');
        el.stage.classList.add('is-playing');
        el.stage.classList.add('is-paused');
        fillPauseStats();
        return;
      }

      state.screen = name;
      state.paused = false;
      el.stage.classList.remove('is-playing');
      el.stage.classList.remove('is-paused');
      setActiveScreen(name);

      if (name === 'menu') {
        refreshMenu();
        clearHudFx();
        clearCountdown();
        maybeAutoTutorial();
      } else if (name === 'shop') {
        UI.refreshShop();
      } else if (name === 'leaderboard') {
        UI.refreshLeaderboard(state.boardMode);
      } else if (name === 'settings') {
        UI.refreshSettings();
      }
    } catch (e) {
      warn('showScreen', e);
    }
  };

  function maybeAutoTutorial() {
    if (state.autoTutorial) return;
    state.autoTutorial = true;
    var hasUrlScreen = false;
    try { hasUrlScreen = /[?&]screen=/.test(String(global.location && global.location.search || '')); } catch (e) { }
    if (hasUrlScreen) return;
    if (S && S.tutorialSeen && S.tutorialSeen()) return;
    setTimeout(function () {
      if (state.screen === 'menu') UI.showTutorial(false);
    }, 420);
  }

  /* ======================== 主菜单 ======================== */
  function refreshMenu() {
    updateCoinDisplays();
    var best = 0;
    try {
      if (S && S.best) best = Math.max(S.best('endless') || 0, S.best('sprint') || 0);
    } catch (e) { }
    setText(el.menuBest, fmt(best));
  }

  function updateCoinDisplays() {
    var n = 0;
    try { n = S && S.coins ? S.coins() : state.wallet; } catch (e) { n = state.wallet; }
    state.wallet = n;
    var txt = fmt(n);
    setText(el.menuCoins, txt);
    setText(el.shopCoins, txt);
    setText(el.settingsCoins, txt);
    setText(el.coinsEl, txt);
  }

  UI.setCoins = function (n) {
    state.wallet = Math.max(0, Math.round(Number(n) || 0));
    var txt = fmt(state.wallet);
    setText(el.menuCoins, txt);
    setText(el.shopCoins, txt);
    setText(el.settingsCoins, txt);
    setText(el.coinsEl, txt);
  };

  function bindMenuArt() {
    var art = el.menuArtImg;
    if (!art || !el.menuArt) return;
    function ready() {
      if (art && art.naturalWidth > 0) el.menuArt.classList.add('is-ready');
    }
    art.addEventListener('load', ready);
    art.addEventListener('error', function () {
      art.style.display = 'none';
    });
    if (art.complete) ready();
  }

  /* ======================== HUD 构建 ======================== */
  function buildHearts(max) {
    if (!el.heartsBox) return;
    el.heartsBox.innerHTML = '';
    hudEls.hearts = [];
    var n = Math.max(1, Math.min(8, max || 3));
    for (var i = 0; i < n; i++) {
      var h = DOC.createElement('span');
      h.className = 'heart';
      el.heartsBox.appendChild(h);
      hudEls.hearts.push(h);
    }
    hudCache.maxHearts = n;
    hudCache.hearts = -1;
  }

  function buildPowerups() {
    if (!el.powerups) return;
    el.powerups.innerHTML = '';
    hudEls.powerRows = {};
    var order = (CFG.powerups && CFG.powerups.order) || ['shield', 'slow', 'magnet', 'double'];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var def = (CFG.powerups && CFG.powerups[key]) || {};
      var row = DOC.createElement('div');
      row.className = 'pw-row';
      row.setAttribute('data-power', key);
      row.hidden = true;
      var ico = DOC.createElement('span');
      ico.className = 'pw-ico';
      ico.textContent = POWER_ICON[key] || '?';
      ico.style.setProperty('--c1', def.color || '#4FC3F7');
      ico.style.setProperty('--c2', def.color2 || '#0277BD');
      var bar = DOC.createElement('span');
      bar.className = 'pw-bar';
      var fill = DOC.createElement('i');
      bar.appendChild(fill);
      var sec = DOC.createElement('span');
      sec.className = 'pw-sec';
      sec.textContent = '';
      row.appendChild(ico); row.appendChild(bar); row.appendChild(sec);
      el.powerups.appendChild(row);
      hudEls.powerRows[key] = { row: row, fill: fill, sec: sec, duration: def.duration || 1 };
      hudCache.powers[key] = -1;
    }
  }

  function buildRack(n) {
    if (!el.rack) return;
    el.rack.innerHTML = '';
    hudEls.slots = [];
    hudEls.tiles = [];
    for (var i = 0; i < n; i++) {
      var slot = DOC.createElement('div');
      slot.className = 'rack-slot';
      var tile = DOC.createElement('div');
      tile.className = 'tile';
      tile.hidden = true;
      slot.appendChild(tile);
      el.rack.appendChild(slot);
      hudEls.slots.push(slot);
      hudEls.tiles.push(tile);
    }
    hudCache.rackSig = '';
  }

  function resetHudDirty() {
    hudCache.score = -1;
    hudCache.best = -1;
    hudCache.distance = -1;
    hudCache.wallet = -1;
    hudCache.runCoins = -1;
    hudCache.hearts = -1;
    hudCache.maxTile = -1;
    hudCache.combo = -1;
    hudCache.comboMult = -1;
    hudCache.mode = '';
    hudCache.bestMode = '';
    hudCache.timeLeft = -1;
    hudCache.timeUrgent = null;
    hudCache.rackSig = '';
    for (var k in hudCache.powers) hudCache.powers[k] = -1;
    if (el.rack) {
      for (var i = 0; i < hudEls.tiles.length; i++) {
        hudEls.tiles[i].hidden = true;
        hudEls.tiles[i].textContent = '';
        hudEls.slots[i].classList.remove('has-tile');
      }
    }
    pending.comboPop = false; pending.heartHit = false; pending.badgePop = false; pending.badgeNew = false;
    clearHudFx();
    lastView = null;
  }

  function clearHudFx() {
    if (el.hudFx) el.hudFx.innerHTML = '';
  }

  /* ======================== HUD 事件特效 ======================== */
  function slotCenter(idx) {
    return {
      x: RACK.left + idx * (RACK.slotW + RACK.gap) + RACK.slotW / 2,
      y: H - RACK.bottom - RACK.slotH / 2 - 4
    };
  }

  function floatHud(text, x, y, cls) {
    if (!el.hudFx || !text) return;
    if (el.hudFx.children.length > 14) el.hudFx.removeChild(el.hudFx.firstChild);
    var node = DOC.createElement('div');
    node.className = 'fx-float ' + (cls || '');
    node.textContent = text;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    el.hudFx.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 820);
  }

  function handleHudEvents(events, animMap) {
    if (!events || !events.length) return;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e || !e.t) continue;
      switch (e.t) {
        case 'merge': {
          var cs = slotCenter(e.slot || 0);
          animMap[e.slot] = 'is-merge';
          if (typeof e.score === 'number' && e.score > 0) {
            floatHud('+' + fmt(e.score), cs.x, cs.y - 58, e.value >= 128 ? 'fx-float--gold' : 'fx-float--score');
          }
          break;
        }
        case 'overflow': {
          var os = slotCenter(e.slot || 0);
          animMap[e.slot] = 'is-overflow';
          floatHud('溢出 -' + fmt(e.replacedValue || 0), os.x, os.y - 58, 'fx-float--warn');
          break;
        }
        case 'drop': {
          var ds = slotCenter(e.slot || 0);
          animMap[e.slot] = 'is-drop';
          floatHud('掉落 -' + fmt(e.value || 0), ds.x, ds.y - 58, 'fx-float--warn');
          break;
        }
        case 'combo':
          pending.comboPop = true;
          break;
        case 'hit':
          pending.heartHit = true;
          break;
        case 'newMax':
          pending.badgePop = true;
          pending.badgeNew = true;
          break;
        case 'coin': {
          var cx = W - 82;
          floatHud('+' + fmt(e.amount || 1), cx, 116, 'fx-float--gold');
          break;
        }
        case 'powerup': {
          var cs2 = slotCenter(0);
          floatHud('道具！', cs2.x, cs2.y - 58, 'fx-float--mint');
          break;
        }
        default:
          break;
      }
    }
  }

  /* ======================== HUD 每帧更新 ======================== */
  function tileLenClass(value) {
    var len = String(value).length;
    if (len <= 1) return '';
    if (len === 2) return 'tile--len2';
    if (len === 3) return 'tile--len3';
    if (len === 4) return 'tile--len4';
    if (len === 5) return 'tile--len5';
    return 'tile--len6';
  }

  function applyTileStyle(node, value) {
    var tc = (CFG.tileColor ? CFG.tileColor(value) : (CFG.tileColors && CFG.tileColors.other)) || { a: '#FFF4C8', b: '#FFE08A', text: '#7A4E00' };
    node.style.setProperty('--a1', tc.a);
    node.style.setProperty('--a2', tc.b);
    node.style.setProperty('--tc', tc.text);
  }

  function updateRack(view, animMap) {
    if (!el.rack) return;
    var rack = view.rack;
    var n = (rack && rack.length) ? rack.length : ((CFG.merge && CFG.merge.slots) || 5);
    if (hudEls.slots.length !== n) buildRack(n);

    var sig = '';
    var i, t;
    for (i = 0; i < n; i++) {
      t = rack && rack[i];
      sig += (t ? (t.id + ':' + t.value) : '-') + '|';
    }
    if (sig === hudCache.rackSig) return;
    hudCache.rackSig = sig;

    for (i = 0; i < n; i++) {
      t = rack && rack[i];
      var slotEl = hudEls.slots[i];
      var tileEl = hudEls.tiles[i];
      if (!slotEl || !tileEl) continue;

      if (!t) {
        tileEl.hidden = true;
        tileEl.textContent = '';
        tileEl.className = 'tile';
        slotEl.classList.remove('has-tile');
      } else {
        tileEl.hidden = false;
        slotEl.classList.add('has-tile');
        setText(tileEl, String(t.value));
        applyTileStyle(tileEl, t.value);
        tileEl.className = 'tile ' + tileLenClass(t.value);
      }

      var anim = animMap[i];
      if (anim === 'is-merge') {
        animClass(tileEl, 'is-merge', 460);
        animClass(slotEl, 'is-merge', 480);
      } else if (anim === 'is-drop') {
        animClass(slotEl, 'is-drop', 420);
      } else if (anim === 'is-overflow') {
        animClass(slotEl, 'is-overflow', 420);
        animClass(tileEl, 'is-pop', 400);
      } else if (t) {
        /* 新方块弹入（包括收集/连锁插入） */
        animClass(tileEl, 'is-pop', 380);
      }
    }
  }

  UI.updateHUD = function (view, events) {
    try {
      if (!view) return;
      lastView = view;
      if (!el.stage) return;

      var animMap = {};
      if (events && events.length) handleHudEvents(events, animMap);

      var mode = view.mode || {};
      var modeId = mode.id || 'endless';
      var modeName = mode.name || (modeId === 'sprint' ? '限时冲刺' : '无尽模式');

      /* ---- 分数 ---- */
      var score = Math.max(0, Math.round(view.score || 0));
      if (score !== hudCache.score) {
        hudCache.score = score;
        var scoreTxt = fmt(score);
        setText(el.scoreEl, scoreTxt);
        if (el.scoreEl) {
          /* 分数变长时自动缩小字号，540 宽下永不溢出 */
          var fs = scoreTxt.length > 9 ? 23 : scoreTxt.length > 7 ? 27 : scoreTxt.length > 6 ? 32 : 38;
          el.scoreEl.style.fontSize = fs + 'px';
        }
        animClass(el.scoreEl, 'is-bump', 180);
      }

      /* ---- 最佳分（读存档，不写存档） ---- */
      if (hudCache.bestMode !== modeId) {
        hudCache.bestMode = modeId;
        hudCache.best = -1;
      }
      var best = 0;
      try { best = (S && S.best) ? (S.best(modeId) || 0) : 0; } catch (e2) { best = 0; }
      if (best !== hudCache.best) {
        hudCache.best = best;
        setText(el.hudBest, '最佳 ' + fmt(best) + ' · ' + (modeId === 'sprint' ? '冲刺' : '无尽'));
      }

      /* ---- 模式 / 距离 ---- */
      if (hudCache.mode !== modeName) {
        hudCache.mode = modeName;
        setText(el.modeName, modeName);
      }
      var dist = Math.max(0, Math.floor(view.distance || 0));
      if (dist !== hudCache.distance) {
        hudCache.distance = dist;
        setText(el.distance, dist + ' m');
      }

      /* ---- 金币（钱包 = 存档；本局 = view.coins） ---- */
      var wallet = 0;
      try { wallet = (S && S.coins) ? S.coins() : state.wallet; } catch (e3) { wallet = state.wallet; }
      state.wallet = wallet;
      if (wallet !== hudCache.wallet) {
        hudCache.wallet = wallet;
        setText(el.coinsEl, fmt(wallet));
      }
      var runCoins = Math.max(0, Math.floor(view.coins || 0));
      if (runCoins !== hudCache.runCoins) {
        hudCache.runCoins = runCoins;
        setText(el.runCoins, '本局 +' + fmt(runCoins));
      }

      /* ---- 心 ---- */
      var maxHearts = Math.max(1, Math.round(view.maxHearts || (CFG.run && CFG.run.hearts) || 3));
      if (hudCache.maxHearts !== maxHearts || !hudEls.hearts.length) buildHearts(maxHearts);
      var hearts = clamp(Math.round(view.hearts === undefined ? maxHearts : view.hearts), 0, maxHearts);
      if (hearts !== hudCache.hearts) {
        hudCache.hearts = hearts;
        for (var i = 0; i < hudEls.hearts.length; i++) {
          hudEls.hearts[i].classList.toggle('is-lost', i >= hearts);
        }
      }

      /* ---- 道具剩余时间 ---- */
      var pw = view.powerups || {};
      var order = (CFG.powerups && CFG.powerups.order) || ['shield', 'slow', 'magnet', 'double'];
      for (var p = 0; p < order.length; p++) {
        var key = order[p];
        var info = hudEls.powerRows[key];
        if (!info) continue;
        var sec = Math.max(0, Math.round((Number(pw[key]) || 0) * 10) / 10);
        if (hudCache.powers[key] !== sec) {
          hudCache.powers[key] = sec;
          if (sec > 0) {
            info.row.hidden = false;
            var pct = clamp(sec / (info.duration || 1), 0, 1) * 100;
            info.fill.style.width = pct.toFixed(1) + '%';
            info.sec.textContent = (sec >= 10 ? Math.ceil(sec) : sec.toFixed(1)) + 's';
          } else {
            info.row.hidden = true;
          }
        }
      }

      /* ---- 连击 ---- */
      var combo = Math.max(0, Math.round(view.combo || 0));
      var mult = Number(view.comboMult || (combo > 1 ? 1 + 0.5 * (combo - 1) : 1)) || 1;
      var showCombo = combo >= 2;
      if (el.combo) {
        if (showCombo) {
          if (el.combo.hidden) el.combo.hidden = false;
          if (combo !== hudCache.combo || mult !== hudCache.comboMult) {
            hudCache.combo = combo;
            hudCache.comboMult = mult;
            var mstr = (Math.round(mult * 10) / 10);
            setText(el.comboX, '×' + (mstr % 1 === 0 ? mstr : mstr.toFixed(1)));
          }
        } else if (!el.combo.hidden) {
          el.combo.hidden = true;
          hudCache.combo = -1;
          hudCache.comboMult = -1;
        }
      }

      /* ---- 本局最高方块 ---- */
      var maxTile = Math.max(0, Math.round(view.maxTile || 0));
      if (maxTile !== hudCache.maxTile) {
        hudCache.maxTile = maxTile;
        if (maxTile >= 2) {
          if (el.maxBadge) el.maxBadge.hidden = false;
          setText(el.maxTile, String(maxTile));
          if (el.maxTile) applyTileStyle(el.maxTile, maxTile);
        } else if (el.maxBadge) {
          el.maxBadge.hidden = true;
        }
      }

      /* ---- 冲刺倒计时 ---- */
      if (el.timer) {
        if (modeId === 'sprint') {
          if (el.timer.hidden) el.timer.hidden = false;
          var tl = (mode.timeLeft !== undefined && mode.timeLeft !== null) ? mode.timeLeft : (mode.duration || 60);
          tl = Math.max(0, Number(tl) || 0);
          var dec = Math.round(tl * 10) / 10;
          if (dec !== hudCache.timeLeft) {
            hudCache.timeLeft = dec;
            setText(el.timerNum, String(Math.ceil(tl)));
            var total = (mode.duration || (CFG.modes && CFG.modes.sprint && CFG.modes.sprint.duration) || 60) || 60;
            if (el.timerFill) el.timerFill.style.width = clamp(tl / total, 0, 1) * 100 + '%';
          }
          var urgent = tl <= 10;
          if (urgent !== hudCache.timeUrgent) {
            hudCache.timeUrgent = urgent;
            el.timer.classList.toggle('is-urgent', urgent);
          }
        } else if (!el.timer.hidden) {
          el.timer.hidden = true;
          hudCache.timeLeft = -1;
          hudCache.timeUrgent = null;
        }
      }

      /* ---- 合成槽 ---- */
      updateRack(view, animMap);

      /* ---- 待触发的动画 ---- */
      if (pending.comboPop && el.combo && !el.combo.hidden) {
        animClass(el.combo, 'is-pop', 320);
      }
      pending.comboPop = false;

      if (pending.heartHit) {
        animClass(el.heartsBox, 'is-hit', 360);
      }
      pending.heartHit = false;

      if (pending.badgePop && el.maxBadge && !el.maxBadge.hidden) {
        animClass(el.maxBadge, 'is-pop', 380);
        if (pending.badgeNew) {
          el.maxBadge.classList.add('is-new');
          setTimeout(function () {
            if (el.maxBadge) el.maxBadge.classList.remove('is-new');
          }, 1600);
        }
      }
      pending.badgePop = false;
      pending.badgeNew = false;
    } catch (err) {
      warn('updateHUD', err);
    }
  };

  function fillPauseStats() {
    var v = lastView || {};
    var mode = (v.mode && v.mode.id) || 'endless';
    setText(el.pauseScore, fmt(Math.round(v.score || 0)));
    setText(el.pauseDistance, Math.floor(v.distance || 0) + ' m');
    setText(el.pauseMode, mode === 'sprint' ? '限时冲刺' : '无尽模式');
  }

  /* ======================== 倒计时 / 横幅 / Toast ======================== */
  UI.showCountdown = function (label) {
    try {
      var v = (label === null || label === undefined || label === '') ? null : String(label);
      if (v === lastCountdown) return;
      lastCountdown = v;
      if (!el.countdownLayer) return;
      if (!v) {
        el.countdownLayer.classList.remove('is-active');
        el.countdownLayer.innerHTML = '';
        return;
      }
      var upper = v.toUpperCase();
      var node = DOC.createElement('div');
      node.className = 'countdown-num' + (upper === 'GO' ? ' is-go' : ' is-count');
      node.textContent = upper === 'GO' ? 'GO!' : v;
      el.countdownLayer.innerHTML = '';
      el.countdownLayer.appendChild(node);
      el.countdownLayer.classList.add('is-active');
    } catch (e) { warn('showCountdown', e); }
  };

  function clearCountdown() {
    lastCountdown = null;
    if (el.countdownLayer) {
      el.countdownLayer.classList.remove('is-active');
      el.countdownLayer.innerHTML = '';
    }
  }

  /* 横幅图标：支持数字方块 / game.js 传入的语义 token（tile/power/heart/coin/star） */
  function tileBannerIcon(value, fallbackGlyph) {
    if (typeof value === 'number' && isFinite(value) && value >= 2) {
      var tc = (CFG.tileColor ? CFG.tileColor(value) : null) || { a: '#FFF4C8', b: '#FFE08A', text: '#7A4E00' };
      return '<span class="banner-ico" style="background:linear-gradient(180deg,' + tc.a + ',' + tc.b + ');color:' + tc.text + '">' + esc(value) + '</span>';
    }
    return '<span class="banner-ico">' + (fallbackGlyph || '★') + '</span>';
  }

  function bannerIconHtml(opts, tone) {
    var icon = opts.icon;
    if (icon === undefined || icon === null) {
      var glyph = tone === 'mint' ? '✓' : tone === 'pink' ? '♥' : tone === 'blue' ? '✦' : '★';
      return '<span class="banner-ico">' + glyph + '</span>';
    }
    if (typeof icon === 'number') return tileBannerIcon(icon, '★');
    var token = String(icon);
    if (token === 'tile') return tileBannerIcon(opts.value, '★');
    if (token === 'heart') return '<span class="banner-ico banner-ico--heart">♥</span>';
    if (token === 'power') return '<span class="banner-ico banner-ico--power">✦</span>';
    if (token === 'coin') return '<span class="banner-ico"><span class="ico-coin"></span></span>';
    if (token === 'star' || token === 'record') return '<span class="banner-ico">★</span>';
    return '<span class="banner-ico">' + esc(token) + '</span>';
  }

  UI.showBanner = function (title, sub, opts) {
    try {
      if (!el.bannerLayer) return;
      opts = opts || {};
      var tone = opts.tone || 'gold';
      if (['gold', 'mint', 'pink', 'blue'].indexOf(tone) < 0) tone = 'gold';

      /* duration 兼容两种写法：秒（<=100）或毫秒（>100），game.js 传的是毫秒 */
      var rawDur = Number(opts.duration);
      if (!isFinite(rawDur) || rawDur <= 0) rawDur = 1.7;
      if (rawDur > 100) rawDur = rawDur / 1000;
      var duration = Math.max(0.35, rawDur) * 1000;

      var iconHtml = bannerIconHtml(opts, tone);

      var node = DOC.createElement('div');
      node.className = 'banner banner--' + tone;
      node.innerHTML = iconHtml +
        '<div class="banner-text"><div class="banner-title">' + esc(title || '') + '</div>' +
        (sub ? '<div class="banner-sub">' + esc(sub) + '</div>' : '') + '</div>';

      el.bannerLayer.innerHTML = '';
      el.bannerLayer.appendChild(node);
      el.bannerLayer.classList.add('is-active');

      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
      bannerTimer = setTimeout(function () {
        node.classList.add('is-out');
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
          if (el.bannerLayer && !el.bannerLayer.children.length) el.bannerLayer.classList.remove('is-active');
        }, 240);
      }, duration);
    } catch (e) { warn('showBanner', e); }
  };

  UI.toast = function (text) {
    try {
      if (!el.toastLayer || text === undefined || text === null || text === '') return;
      var node = DOC.createElement('div');
      node.className = 'toast';
      node.textContent = String(text);
      el.toastLayer.appendChild(node);
      el.toastLayer.classList.add('is-active');
      while (el.toastLayer.children.length > 3) el.toastLayer.removeChild(el.toastLayer.firstChild);
      setTimeout(function () {
        node.classList.add('is-out');
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
          if (el.toastLayer && !el.toastLayer.children.length) el.toastLayer.classList.remove('is-active');
        }, 240);
      }, 1700);
    } catch (e) { warn('toast', e); }
  };

  /* ======================== 暂停 ======================== */
  UI.setPaused = function (b) {
    try {
      b = !!b;
      state.paused = b;
      if (!el.stage) return;
      el.stage.classList.toggle('is-paused', b);
      if (b && state.screen === 'playing') {
        UI.showScreen('paused');
      } else if (!b && state.screen === 'paused') {
        UI.showScreen('playing');
      }
    } catch (e) { warn('setPaused', e); }
  };

  /* ======================== 结算 ======================== */
  UI.showGameOver = function (result) {
    try {
      result = result || {};
      var mode = result.mode === 'sprint' ? 'sprint' : 'endless';
      var score = Math.max(0, Math.round(result.score || 0));
      var isRecord = !!result.isNewRecord;

      setText(el.goBadge, isRecord ? '新纪录' : '本局结束');
      setText(el.goTitle, isRecord ? '太厉害了！' : (mode === 'sprint' ? '时间到！' : '跑完啦！'));
      if (el.goTitle) el.goTitle.classList.toggle('is-record', isRecord);
      show(el.goRecord, isRecord);
      show(el.goBurst, isRecord);
      setText(el.goScore, fmt(score));
      if (el.goScore) {
        var goTxt = fmt(score);
        el.goScore.style.fontSize = (goTxt.length > 10 ? 40 : goTxt.length > 8 ? 48 : 62) + 'px';
      }
      setText(el.goDistance, Math.floor(result.distance || 0) + ' m');
      setText(el.goBest, fmt(Math.max(0, Math.round(result.best || 0))));
      setText(el.goMerges, fmt(result.merges || 0));

      var mt = Math.max(0, Math.round(result.maxTile || 0));
      if (el.goMaxtile) {
        if (mt >= 2) {
          var tc = (CFG.tileColor ? CFG.tileColor(mt) : null) || { a: '#FFF4C8', b: '#FFE08A', text: '#7A4E00' };
          el.goMaxtile.innerHTML = '<span class="tile-mini" style="--a1:' + tc.a + ';--a2:' + tc.b + ';--tc:' + tc.text + '">' + mt + '</span>';
        } else {
          el.goMaxtile.textContent = '—';
        }
      }

      var coins = Math.max(0, Math.round(result.coins || 0));
      var bonus = Math.max(0, Math.round(result.bonusCoins || 0));
      /* totalCoins 由 game.js 提供（含结算奖励；领取双倍后为翻倍值），优先使用 */
      var totalCoins = (typeof result.totalCoins === 'number')
        ? Math.max(0, Math.round(result.totalCoins))
        : (coins + bonus);
      var doubled = !!result.adDoubleUsed;
      setText(el.goCoins, '+' + fmt(totalCoins));
      /* 橙色标签只在「已经领取双倍」时出现，避免文案歧义 */
      show(el.goCoinsBonus, doubled);
      if (el.goCoinsBonus) setText(el.goCoinsBonus, '已双倍 ×2');

      /* 双倍广告按钮状态 */
      if (el.btnDouble) {
        el.btnDouble.disabled = doubled;
        setText(el.btnDoubleMain, doubled ? '已双倍' : '金币 ×2');
        setText(el.btnDoubleSub, doubled ? '奖励已领取' : '看广告');
        el.btnDouble.classList.toggle('is-loading', false);
      }

      /* 复活按钮（每局仅一次；广告流程由 game.js 控制） */
      var canRevive = !!result.canRevive && !doubled;
      show(el.btnRevive, canRevive);
      if (el.goAdRow) {
        var visibleAds = (canRevive ? 1 : 0) + (doubled ? 0 : 1);
        el.goAdRow.hidden = visibleAds === 0;
        el.goAdRow.classList.toggle('is-single', visibleAds === 1);
      }

      UI.showScreen('gameover');
    } catch (e) { warn('showGameOver', e); }
  };

  /* ======================== 模拟广告 ======================== */
  function setAdClaimState(enabled, text) {
    if (el.adClaim) el.adClaim.disabled = !enabled;
    setText(el.adClaimText, text || (enabled ? '领取奖励' : '奖励准备中…'));
  }

  function adTick() {
    if (!adState.active) return;
    var t = nowMs() - adState.start;
    var p = clamp(t / adState.delay, 0, 1);
    if (el.adFill) el.adFill.style.width = (p * 100).toFixed(1) + '%';
    var remain = Math.max(0, (adState.delay - t) / 1000);
    setText(el.adTimer, p >= 1 ? '广告播放完成' : remain.toFixed(1) + 's');
    if (p >= 1 && !adState.done) {
      adState.done = true;
      setAdClaimState(true, '领取奖励');
      adState.finishTimer = setTimeout(function () { adFinish(); }, 420);
      return;
    }
    if (!adState.done) adState.raf = raf(adTick);
  }

  function adFinish() {
    if (!adState.active) return;
    adState.active = false;
    adState.done = false;
    if (adState.raf && global.cancelAnimationFrame) { try { global.cancelAnimationFrame(adState.raf); } catch (e) { } }
    adState.raf = 0;
    if (adState.finishTimer) { clearTimeout(adState.finishTimer); adState.finishTimer = 0; }
    if (el.iconAd) {
      el.iconAd.classList.remove('is-open');
      el.iconAd.setAttribute('aria-hidden', 'true');
    }
    var cb = adState.onDone;
    adState.onDone = null;
    if (typeof cb === 'function') {
      try { cb(); } catch (e) { warn('showAd onDone', e); }
    }
  }

  UI.showAd = function (kind, onDone) {
    try {
      kind = kind === 'double' ? 'double' : 'revive';
      var delay = 2.2;
      try {
        if (CFG.ads && CFG.ads[kind] && CFG.ads[kind].delay) delay = Number(CFG.ads[kind].delay) || 2.2;
      } catch (e) { }
      adState = {
        active: true,
        done: false,
        kind: kind,
        onDone: (typeof onDone === 'function' ? onDone : null),
        start: nowMs(),
        delay: Math.max(300, delay * 1000),
        raf: 0,
        finishTimer: 0
      };
      setText(el.adTitle, kind === 'double' ? '金币翻倍奖励' : '复活继续');
      setAdClaimState(false, '奖励准备中…');
      if (el.adFill) el.adFill.style.width = '0%';
      setText(el.adTimer, (adState.delay / 1000).toFixed(1) + 's');
      if (el.iconAd) {
        el.iconAd.classList.add('is-open');
        el.iconAd.setAttribute('aria-hidden', 'false');
      }
      adTick();
    } catch (e) { warn('showAd', e); }
  };

  UI.finishAd = function () {
    try {
      if (adState.active) adFinish();
    } catch (e) { warn('finishAd', e); }
  };

  /* ======================== 教程 ======================== */
  UI.showTutorial = function (force) {
    try {
      if (!el.tutorial) return;
      if (force === false && S && S.tutorialSeen && S.tutorialSeen()) return;
      state.tutorialOpen = true;
      el.tutorial.classList.add('is-open');
      el.tutorial.setAttribute('aria-hidden', 'false');
      sfx('tap');
    } catch (e) { warn('showTutorial', e); }
  };

  UI.hideTutorial = function () {
    try {
      state.tutorialOpen = false;
      if (el.tutorial) {
        el.tutorial.classList.remove('is-open');
        el.tutorial.setAttribute('aria-hidden', 'true');
      }
    } catch (e) { warn('hideTutorial', e); }
  };

  UI.isOverlayOpen = function () {
    try {
      return !!(state.tutorialOpen || adState.active);
    } catch (e) { return false; }
  };

  /* ======================== 商店 ======================== */
  var DOLL_INNER =
    '<span class="doll-arm doll-arm--l"></span>' +
    '<span class="doll-arm doll-arm--r"></span>' +
    '<span class="doll-leg doll-leg--l"></span>' +
    '<span class="doll-leg doll-leg--r"></span>' +
    '<span class="doll-body">' +
    '<span class="doll-belly"></span>' +
    '<span class="doll-eye doll-eye--l"></span>' +
    '<span class="doll-eye doll-eye--r"></span>' +
    '<span class="doll-cheek doll-cheek--l"></span>' +
    '<span class="doll-cheek doll-cheek--r"></span>' +
    '<span class="doll-mouth"></span>' +
    '</span>';

  function skinDollHtml(skin) {
    return '<div class="shop-doll-wrap"><div class="nw-doll" style="--s:0.64;' +
      '--hi:' + skin.bodyHi + ';--body:' + skin.body + ';--body2:' + skin.bodyShade + ';' +
      '--belly:' + skin.belly + ';--belly2:' + skin.bellyShade + ';' +
      '--limb:' + skin.limb + ';--cheek:' + skin.cheek + ';--eye:' + skin.eye + ';--mouth:' + skin.mouth + ';">' +
      DOLL_INNER + '</div></div>';
  }

  function themeSwatchHtml(theme) {
    return '<div class="theme-swatch" style="--sky1:' + theme.skyTop + ';--sky2:' + theme.skyBottom +
      ';--sun:' + theme.sun.color + ';--ground:' + theme.groundFar + ';--ground2:' + theme.groundNear +
      ';--road:' + theme.roadLight + ';--road2:' + theme.roadDark + ';--line:' + theme.laneLine + ';">' +
      '<span class="ts-sun"></span><span class="ts-hill"></span><span class="ts-hill2"></span>' +
      '<span class="ts-ground"></span><span class="ts-road"></span><span class="ts-line"></span>' +
      '</div>';
  }

  function syncTabs(tabsEl, gliderEl, activeIndex) {
    if (!tabsEl) return;
    tabsEl.setAttribute('data-active', String(activeIndex));
    var tabs = qsa('.tab', tabsEl);
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', i === activeIndex);
    if (gliderEl) gliderEl.style.transform = 'translateX(' + (activeIndex * 100) + '%)';
  }

  UI.refreshShop = function () {
    try {
      if (!el.shopGrid) return;
      var snap = { coins: 0, ownedSkins: ['classic'], ownedThemes: ['day'], equip: { skin: 'classic', theme: 'day' } };
      try { if (S && S.snapshot) snap = S.snapshot(); } catch (e) { }
      var kind = state.shopTab;
      var items = kind === 'skin' ? (CFG.skins || []) : (CFG.themes || []);
      var owned = kind === 'skin' ? (snap.ownedSkins || []) : (snap.ownedThemes || []);
      var equippedId = kind === 'skin' ? (snap.equip && snap.equip.skin) : (snap.equip && snap.equip.theme);
      var coins = Math.max(0, Math.round(snap.coins || 0));
      var html = '';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var isOwned = owned.indexOf(it.id) >= 0;
        var isEquipped = equippedId === it.id;
        var preview = kind === 'skin' ? skinDollHtml(it) : themeSwatchHtml(it);
        var priceLine;
        if (isOwned) {
          priceLine = '<div class="shop-price">' + (isEquipped ? '已装备' : '已拥有') + '</div>';
        } else {
          priceLine = '<div class="shop-price' + (coins < it.price ? ' is-short' : '') + '">' +
            '<span class="ico-coin"></span>' + fmt(it.price) + '</div>';
        }
        var btn;
        if (isEquipped) {
          btn = '<button class="btn btn--sm btn--mint" type="button" disabled>使用中</button>';
        } else if (isOwned) {
          btn = '<button class="btn btn--sm btn--primary" type="button" data-act="equip" data-kind="' + kind + '" data-id="' + it.id + '">装备</button>';
        } else {
          btn = '<button class="btn btn--sm ' + (coins < it.price ? 'btn--cream' : 'btn--primary') + '" type="button" data-act="buy" data-kind="' + kind + '" data-id="' + it.id + '">购买</button>';
        }
        html += '<article class="shop-card' + (isEquipped ? ' is-equipped' : '') + '">' +
          (isEquipped ? '<span class="equip-ribbon">使用中</span>' : '') +
          '<div class="shop-preview">' + (it.tag ? '<span class="shop-tag">' + esc(it.tag) + '</span>' : '') + preview + '</div>' +
          '<div class="shop-name">' + esc(it.name) + '</div>' +
          priceLine +
          btn +
          '</article>';
      }
      setHtml(el.shopGrid, html);
      setText(el.shopCoins, fmt(coins));
      syncTabs(el.shopTabs, el.shopTabGlider, kind === 'skin' ? 0 : 1);
    } catch (e) { warn('refreshShop', e); }
  };

  function switchShopTab(tab) {
    if (tab !== 'skin' && tab !== 'theme') return;
    if (state.shopTab === tab) return;
    state.shopTab = tab;
    sfx('tap');
    UI.refreshShop();
  }

  function fallbackBuyEquip(kind, id, act) {
    /* 仅当 game.js 未提供 handler 时的兜底（正常流程绝不走这里） */
    if (!S) return { ok: false, reason: 'unavailable' };
    try {
      if (act === 'buy') {
        if (kind === 'skin') return S.buySkin(id);
        return S.buyTheme(id);
      }
      var ok = kind === 'skin' ? S.equipSkin(id) : S.equipTheme(id);
      return ok ? { ok: true } : { ok: false, reason: 'not-owned' };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  }

  function onShopAction(btn) {
    if (!btn || btn.disabled) return;
    var kind = btn.getAttribute('data-kind') || state.shopTab;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act') === 'equip' ? 'equip' : 'buy';
    var handlerName = act === 'buy' ? 'onBuy' : 'onEquip';
    var res;
    if (hasHandler(handlerName)) {
      res = invoke(handlerName, kind, id);
    } else {
      res = fallbackBuyEquip(kind, id, act);
    }
    btn.disabled = true;

    handleResult(res, function (r) {
      sfx(act === 'buy' ? 'buy' : 'equip');
      UI.refreshShop();
      refreshMenu();
      updateCoinDisplays();
      UI.toast(act === 'buy' ? '购买成功！' : '已装备');
    }, function (r) {
      sfx('error');
      btn.disabled = false;
      if (r && r.reason === 'coins') {
        UI.toast('金币不足，还差 ' + fmt(r.need || 0) + ' 金币');
      } else if (r && r.reason === 'owned') {
        UI.refreshShop();
      } else if (r && r.reason === 'not-found') {
        UI.toast('找不到该商品');
      } else {
        UI.toast('操作失败，请稍后再试');
      }
    });
  }

  /* ======================== 排行榜 ======================== */
  UI.refreshLeaderboard = function (mode) {
    try {
      if (mode === 'endless' || mode === 'sprint') state.boardMode = mode;
      var m = state.boardMode;
      var rows = [];
      try { rows = (S && S.board) ? S.board(m) : []; } catch (e) { rows = []; }
      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i] || {};
        var rank = r.rank || (i + 1);
        var rankCls = rank <= 3 ? ' medal-' + rank : '';
        html += '<div class="lb-row' + (r.self ? ' is-self' : '') + '">' +
          '<span class="lb-rank' + rankCls + '">' + rank + '</span>' +
          '<span class="lb-name">' + esc(r.name || '奶娃玩家') + (r.self ? '<span class="lb-me-tag">我</span>' : '') + '</span>' +
          '<span class="lb-score">' + fmt(r.score || 0) + '</span>' +
          '</div>';
      }
      setHtml(el.lbList, html);

      var myRank = 0, myBest = 0;
      try {
        myRank = (S && S.playerRank) ? (S.playerRank(m) || 0) : 0;
        myBest = (S && S.best) ? (S.best(m) || 0) : 0;
      } catch (e2) { }
      if (el.lbSelf) {
        if (myRank > 0) {
          el.lbSelf.innerHTML = '<div><div class="lb-self-label">我的排名</div>' +
            '<div style="font-size:12px;font-weight:800;color:#a5764a;margin-top:2px;">最佳 ' + fmt(myBest) + ' 分</div></div>' +
            '<div class="lb-self-rank">第 ' + myRank + ' 名</div>';
        } else {
          el.lbSelf.innerHTML = '<div class="lb-self-empty">还没有成绩，快跑一局登上榜单吧！</div>';
        }
      }
      setText(el.lbBest, fmt(myBest));
      syncTabs(el.lbTabs, el.lbTabGlider, m === 'sprint' ? 1 : 0);
    } catch (e) { warn('refreshLeaderboard', e); }
  };

  function switchBoardMode(mode) {
    if (mode !== 'endless' && mode !== 'sprint') return;
    if (state.boardMode === mode) return;
    sfx('tap');
    if (hasHandler('onLeaderboardMode')) {
      invoke('onLeaderboardMode', mode);
    }
    state.boardMode = mode;
    UI.refreshLeaderboard(mode);
  }

  /* ======================== 设置 ======================== */
  UI.refreshSettings = function () {
    try {
      var snap = { settings: { sfx: true, music: true, haptics: true }, nickname: '' };
      try { if (S && S.snapshot) snap = S.snapshot(); } catch (e) { }
      var settings = snap.settings || {};
      var switches = qsa('.switch', $('screen-settings') || DOC);
      for (var i = 0; i < switches.length; i++) {
        var key = switches[i].getAttribute('data-setting');
        var on = settings[key] !== false;
        switches[i].classList.toggle('is-on', on);
        switches[i].setAttribute('aria-checked', on ? 'true' : 'false');
      }
      if (el.nickInput && DOC.activeElement !== el.nickInput) {
        el.nickInput.value = snap.nickname || '奶娃玩家';
      }
      setText(el.settingsCoins, fmt(snap.coins || 0));
      if (el.setVersion) {
        setText(el.setVersion, '《奶娃》 v' + (CFG.version || '0.9.0-demo') + ' · 本地离线存档');
      }
      updateCoinDisplays();
    } catch (e) { warn('refreshSettings', e); }
  };

  UI.setNicknameInput = function (name) {
    try {
      if (el.nickInput) el.nickInput.value = String(name || '');
    } catch (e) { warn('setNicknameInput', e); }
  };

  function toggleSetting(btn) {
    if (!btn) return;
    var key = btn.getAttribute('data-setting');
    var on = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    sfx('tap');
    try {
      if (NW.audio) {
        if (key === 'sfx' && NW.audio.setSfx) NW.audio.setSfx(on);
        if (key === 'music' && NW.audio.setMusic) NW.audio.setMusic(on);
      }
    } catch (e) { }
    if (hasHandler('onSettingChange')) {
      invoke('onSettingChange', key, on);
    } else if (S && S.setSetting) {
      try { S.setSetting(key, on); } catch (e) { }
    }
  }

  function saveNickname() {
    if (!el.nickInput) return;
    var name = String(el.nickInput.value || '').trim().slice(0, 12);
    if (!name) {
      sfx('error');
      UI.toast('昵称不能为空');
      el.nickInput.focus();
      return;
    }
    el.nickInput.value = name;
    sfx('tap');
    try {
      if (hasHandler('onNicknameChange')) {
        invoke('onNicknameChange', name);
        if (S && S.nickname) el.nickInput.value = S.nickname();
      } else if (S && S.setNickname) {
        el.nickInput.value = S.setNickname(name);
      }
    } catch (e) { warn('saveNickname', e); }
    UI.toast('昵称已保存');
    UI.refreshSettings();
  }

  function armReset() {
    if (!el.resetConfirm) return;
    sfx('tap');
    el.resetConfirm.hidden = false;
    if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
    resetConfirmTimer = setTimeout(function () {
      if (el.resetConfirm) el.resetConfirm.hidden = true;
      resetConfirmTimer = 0;
    }, 10000);
  }

  function doReset() {
    try {
      if (hasHandler('onResetSave')) {
        invoke('onResetSave');
      } else if (S && S.reset) {
        S.reset();
      }
      if (el.resetConfirm) el.resetConfirm.hidden = true;
      if (resetConfirmTimer) { clearTimeout(resetConfirmTimer); resetConfirmTimer = 0; }
      sfx('equip');
      UI.toast('存档已重置');
      UI.setCoins(0);
      refreshMenu();
      UI.refreshShop();
      UI.refreshLeaderboard(state.boardMode);
      UI.refreshSettings();
    } catch (e) { warn('doReset', e); }
  }

  /* ======================== 屏幕按钮点击分发 ======================== */
  function goHome() {
    sfx('tap');
    if (hasHandler('onHome')) invoke('onHome');
    else UI.showScreen('menu');
  }

  var ID_HANDLERS = {
    'hud-pause': function () {
      sfx('tap');
      if (hasHandler('onPause')) invoke('onPause');
      else UI.setPaused(true);
    },
    'btn-resume': function () {
      sfx('tap');
      if (hasHandler('onResume')) invoke('onResume');
      else UI.showScreen('playing');
    },
    'btn-pause-restart': function () {
      sfx('tap');
      if (hasHandler('onRestart')) invoke('onRestart');
      else UI.showScreen('playing');
    },
    'btn-pause-quit': function () {
      sfx('tap');
      if (hasHandler('onQuit')) invoke('onQuit');
      else if (hasHandler('onHome')) invoke('onHome');
      else UI.showScreen('menu');
    },
    'btn-revive': function () {
      sfx('tap');
      if (hasHandler('onRevive')) invoke('onRevive');
      else UI.toast('暂时无法复活');
    },
    'btn-ad-double': function () {
      sfx('tap');
      if (hasHandler('onAdDouble')) invoke('onAdDouble');
      else UI.toast('暂时无法领取');
    },
    'btn-restart': function () {
      sfx('tap');
      if (hasHandler('onRestart')) invoke('onRestart');
      else UI.showScreen('playing');
    },
    'btn-home': goHome,
    'btn-shop-back': goHome,
    'btn-lb-back': goHome,
    'btn-settings-back': goHome,
    'btn-nick-save': saveNickname,
    'btn-howto': function () {
      sfx('tap');
      UI.showTutorial(true);
    },
    'btn-reset': armReset,
    'btn-reset-cancel': function () {
      if (el.resetConfirm) el.resetConfirm.hidden = true;
    },
    'btn-reset-ok': doReset,
    'btn-tut-ok': function () {
      sfx('tap');
      UI.hideTutorial();
      if (hasHandler('onTutorialDone')) invoke('onTutorialDone');
    },
    'btn-tut-close': function () {
      sfx('tap');
      UI.hideTutorial();
      if (hasHandler('onTutorialDone')) invoke('onTutorialDone');
    },
    'btn-ad-claim': function () {
      if (adState.active) {
        sfx('tap');
        UI.finishAd();
      }
    }
  };

  var ACTIONS = {
    'start-endless': function () {
      sfx('tap');
      if (hasHandler('onStart')) invoke('onStart', 'endless');
      else UI.toast('游戏逻辑尚未加载');
    },
    'start-sprint': function () {
      sfx('tap');
      if (hasHandler('onStart')) invoke('onStart', 'sprint');
      else UI.toast('游戏逻辑尚未加载');
    },
    'shop': function () {
      sfx('tap');
      if (hasHandler('onGoShop')) invoke('onGoShop');
      else UI.showScreen('shop');
    },
    'leaderboard': function () {
      sfx('tap');
      if (hasHandler('onGoLeaderboard')) invoke('onGoLeaderboard');
      else UI.showScreen('leaderboard');
    },
    'settings': function () {
      sfx('tap');
      if (hasHandler('onGoSettings')) invoke('onGoSettings');
      else UI.showScreen('settings');
    },
    'home': goHome
  };

  function hasAttr(node, name) {
    return !!(node && node.getAttribute && node.hasAttribute && node.hasAttribute(name));
  }

  /* 元素是否真正可见：隐藏屏幕（display:none）里的按钮不响应程序化 click，
   * 避免脚本/QA 用文本选择器误点到主菜单的「限时冲刺」等隐藏按钮 */
  function isVisibleEl(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hidden) return false;
    try {
      if (node.getClientRects) return node.getClientRects().length > 0;
    } catch (e) { return false; }
    return true;
  }

  function onStageClick(e) {
    try {
      var node = e.target;
      if (!isVisibleEl(node)) return;
      while (node && node !== el.stage && node.nodeType === 1) {
        if (node.id && ID_HANDLERS[node.id]) {
          ID_HANDLERS[node.id](node, e);
          return;
        }
        if (hasAttr(node, 'data-action')) {
          var act = node.getAttribute('data-action');
          if (ACTIONS[act]) { ACTIONS[act](node, e); return; }
        }
        if (hasAttr(node, 'data-tab')) { switchShopTab(node.getAttribute('data-tab')); return; }
        if (hasAttr(node, 'data-mode')) { switchBoardMode(node.getAttribute('data-mode')); return; }
        if (hasAttr(node, 'data-setting')) { toggleSetting(node); return; }
        if (hasAttr(node, 'data-act')) { onShopAction(node); return; }
        if (node.tagName === 'BUTTON' || node.tagName === 'INPUT') {
          /* 未绑定具体事件的按钮：只给点击音效 */
          if (node.tagName === 'BUTTON' && !node.disabled) sfx('tap');
          return;
        }
        node = node.parentNode;
      }
    } catch (err) {
      warn('onStageClick', err);
    }
  }

  /* ======================== 初始化 ======================== */
  function bindEvents() {
    if (!el.stage) return;
    el.stage.addEventListener('click', onStageClick);

    if (el.nickInput) {
      el.nickInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveNickname();
        }
      });
      el.nickInput.addEventListener('input', function () {
        if (el.nickInput.value.length > 12) {
          el.nickInput.value = el.nickInput.value.slice(0, 12);
        }
      });
    }

    global.addEventListener('resize', applyScale);
    global.addEventListener('orientationchange', function () {
      setTimeout(applyScale, 150);
    });
    try {
      if (global.visualViewport) global.visualViewport.addEventListener('resize', applyScale);
    } catch (e) { }
  }

  UI.init = function (h) {
    try {
      if (typeof h === 'object' && h) handlers = h;
      else handlers = handlers || {};
      if (state.inited) return;
      cacheEls();
      buildPowerups();
      buildHearts((CFG.run && CFG.run.hearts) || 3);
      buildRack((CFG.merge && CFG.merge.slots) || 5);
      bindEvents();
      bindMenuArt();
      applyScale();
      refreshMenu();
      UI.refreshShop();
      UI.refreshLeaderboard('endless');
      UI.refreshSettings();
      setText(el.bootVersion, 'v' + (CFG.version || '0.9.0-demo'));
      state.inited = true;
      if (S && S.load) { try { S.load(); } catch (e) { } }
      renderSplashTiles();
    } catch (e) {
      warn('init', e);
    }
  };

  /* 菜单漂浮方块：把 CFG 里的数值颜色同步到 DOM（数值/配色不在 HTML 硬编码） */
  function renderSplashTiles() {
    try {
      var tiles = qsa('.float-tile', el.stage || DOC);
      for (var i = 0; i < tiles.length; i++) {
        var v = parseInt(tiles[i].textContent, 10);
        if (!v || !CFG.tileColor) continue;
        var tc = CFG.tileColor(v);
        tiles[i].style.setProperty('--a1', tc.a);
        tiles[i].style.setProperty('--a2', tc.b);
        tiles[i].style.setProperty('--tc', tc.text);
      }
      /* 教程里的示例方块同理 */
      var minis = qsa('.mini-tile', el.stage || DOC);
      for (var j = 0; j < minis.length; j++) {
        var mv = parseInt(minis[j].textContent, 10);
        if (!mv || !CFG.tileColor) continue;
        var mtc = CFG.tileColor(mv);
        minis[j].style.setProperty('--a1', mtc.a);
        minis[j].style.setProperty('--a2', mtc.b);
        minis[j].style.setProperty('--tc', mtc.text);
      }
    } catch (e) { warn('renderSplashTiles', e); }
  }

  /* ======================== 调试辅助（preview / QA 可用，不影响契约） ======================== */
  UI._debug = {
    state: state,
    hudCache: hudCache,
    refreshMenu: refreshMenu,
    clearCountdown: clearCountdown,
    adState: function () { return adState; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
