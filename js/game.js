/* ==========================================================================
 * 《奶娃》游戏主控层：状态机 / 输入 / 相机 / 渲染编排 / 事件反馈 / 结算与复活
 * 负责人：Lead。对外 API：NW.game
 * 依赖：CFG, util, save, core.Run, art.Character, art.World, art.FX, ui, audio
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG, U = NW.util, S = NW.save;
  var G = (NW.game = {});

  var FIXED = 1 / 60;
  var canvas = null, ctx = null;
  var viewport = { sx: 1, sy: 1 };
  var state = 'menu';            // menu | playing | paused | upgrade | gameover
  var modeId = 'endless';
  var run = null;
  var fx = null;
  var auto = false;
  var frozen = false;
  var accum = 0;
  var menuTime = 0;
  var menuScroll = 0;
  var gameTime = 0;
  var camX = 0;
  var trauma = 0, traumaT = 0;
  var hitFlash = 0;
  var lastSpeedMark = 0;
  var prevJumping = false;
  var prevRolling = false;
  var chainT = 0;                // v0.9.4：滑铲被跳跃取消后的姿态融合剩余时间
  var upgradeMeta = { value: 0, index: 0, total: 0 };   // v0.9.4：强化三选一展示信息
  var goTimer = 0;
  var lastCountdown = null;
  var pending = null;            // 结算前的暂存
  var ad = { reviveUsed: false, doubleUsed: false };
  var pendingStartMode = null;
  var lastView = null;
  var hudTick = 0;
  var errs = [];

  /* ================= 小工具 ================= */
  function safe(fn) {
    try { return fn(); } catch (e) {
      errs.push({ msg: String(e && e.stack || e), at: 'game' });
      if (global.console && console.error) console.error('[奶娃]', e);
    }
  }
  function ui(name) {
    if (!NW.ui || typeof NW.ui[name] !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 1);
    return safe(function () { return NW.ui[name].apply(NW.ui, args); });
  }
  function sfx(name, opts) {
    if (!NW.audio || !S.setting('sfx')) return;
    if (typeof NW.audio.play === 'function') safe(function () { NW.audio.play(name, opts); });
  }
  function music(kind) {
    if (!NW.audio || !S.setting('music') || typeof NW.audio.startMusic !== 'function') return;
    safe(function () { NW.audio.startMusic(kind); });
  }
  function haptic(ms) {
    if (!S.setting('haptics')) return;
    U.vibrate(ms);
  }
  function prj(x, y, z) { return U.project(x, y, z, camX); }
  function playerScreen() {
    var v = lastView;
    var px = v ? v.player.x : 0;
    var py = v ? (v.player.y || 0) : 0;
    var scale = U.projectScale(0);
    var p = prj(px, 0, 0);
    var groundY = p.y + (CFG.run.playerOffsetY || 0);
    var h = CFG.world.playerHeight * scale * (CFG.run.playerScale || 1);
    if (v && v.player.rolling) h *= (CFG.run.slide && CFG.run.slide.heightScale) || 0.55;
    return { x: p.x, y: groundY - py * scale, groundY: groundY, h: h, top: groundY - py * scale - h, scale: scale };
  }

  /* ================= 初始化 ================= */
  G.init = function (canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    if (NW.art && NW.art.FX) fx = new NW.art.FX();

    var handlers = {
      onStart: function (mode) {
        if (!S.tutorialSeen()) {
          pendingStartMode = CFG.mode(mode).id;
          ui('showTutorial');
          return;
        }
        G.startGame(mode, {});
      },
      onPause: G.pause,
      onResume: G.resume,
      onRestart: function () {
        settlePending(false);
        G.startGame(modeId, {});
      },
      onQuit: function () { settlePending(false); G.goMenu(); },
      onHome: function () { settlePending(false); G.goMenu(); },
      onRevive: function () { reviveFlow(); },
      onAdDouble: function () { doubleFlow(); },
      onBuy: function (kind, id) {
        var r = kind === 'theme' ? S.buyTheme(id) : S.buySkin(id);
        if (r && r.ok) {
          ui('setCoins', S.coins());
          ui('refreshShop');
          sfx('buy');
        } else if (r && r.reason === 'coins') {
          sfx('error');
          ui('toast', '金币不够啦，再跑一局吧');
        }
        return r;
      },
      onEquip: function (kind, id) {
        var ok = kind === 'theme' ? S.equipTheme(id) : S.equipSkin(id);
        if (ok) {
          ui('setCoins', S.coins());
          ui('refreshShop');
          sfx('equip');
        }
        return { ok: ok };
      },
      onSettingChange: function (key, val) {
        S.setSetting(key, val);
        if (key === 'sfx') { sfx('tap'); }
        if (key === 'music') {
          if (typeof NW.audio !== 'undefined' && NW.audio) {
            safe(function () { NW.audio.setMusic(val); });
            if (val) music(state === 'playing' ? 'game' : 'menu');
            else safe(function () { NW.audio.stopMusic(); });
          }
        }
      },
      onNicknameChange: function (name) {
        S.setNickname(name);
        ui('refreshLeaderboard');
      },
      onTutorialDone: function () {
        S.setTutorialSeen(true);
        ui('hideTutorial');
        if (pendingStartMode) {
          var m = pendingStartMode;
          pendingStartMode = null;
          G.startGame(m, {});
        }
      },
      onLeaderboardMode: function (mode) { ui('refreshLeaderboard', mode); },
      onGoShop: function () { ui('showScreen', 'shop'); ui('refreshShop'); },
      onGoLeaderboard: function () { ui('showScreen', 'leaderboard'); ui('refreshLeaderboard', 'endless'); },
      onGoSettings: function () { ui('showScreen', 'settings'); ui('refreshSettings'); },
      onGoHome: function () { G.goMenu(); },
      onUpgradePick: function (id) { return G.pickUpgrade(id); }
    };

    ui('init', handlers);
    ui('setCoins', S.coins());
    ui('showScreen', 'menu');
    music('menu');
    // 预热在线排行榜（不阻塞启动，失败静默）
    if (NW.online && NW.online.prefetch) safe(function () { NW.online.prefetch(); });
    G.draw();
  };

  G.setViewport = function (sx, sy) {
    viewport.sx = sx || 1;
    viewport.sy = sy || 1;
  };

  /* ================= 生命周期 ================= */
  G.startGame = function (mode, opts) {
    opts = opts || {};
    modeId = CFG.mode(mode).id;
    settlePending(false);
    run = new NW.core.Run({ mode: modeId, seed: opts.seed, bestTile: S.bestTile() });
    ad = { reviveUsed: false, doubleUsed: false };
    pending = null;
    state = 'playing';
    frozen = false;
    accum = 0;
    gameTime = 0;
    camX = 0;
    trauma = 0;
    hitFlash = 0;
    goTimer = 0;
    lastCountdown = null;
    prevJumping = false;
    prevRolling = false;
    chainT = 0;
    upgradeMeta = { value: 0, index: 0, total: 0 };
    var step0 = CFG.run.speedMilestone || 2;
    lastSpeedMark = Math.floor((CFG.mode(modeId).speed.start || 6.2) / step0) * step0;
    if (fx) fx.reset();
    ui('showScreen', 'playing');
    ui('updateUpgradeHud', []);
    ui('hideUpgrade');
    ui('setCoins', S.coins());
    ui('showCountdown', '3');
    ui('updateHUD', run.view(), []);
    music('game');
    lastView = run.view();
    G.draw();
  };

  G.pause = function () {
    if (state !== 'playing') return;
    state = 'paused';
    ui('showScreen', 'paused');
  };

  G.resume = function () {
    if (state !== 'paused') return;
    state = 'playing';
    ui('showScreen', 'playing');
  };

  G.goMenu = function () {
    state = 'menu';
    run = null;
    pending = null;
    lastView = null;
    frozen = false;
    menuTime = 0;
    camX = 0;
    trauma = 0;
    if (fx) fx.reset();
    ui('showScreen', 'menu');
    ui('hideUpgrade');
    ui('setCoins', S.coins());
    music('menu');
  };

  G.isPlaying = function () { return state === 'playing'; };
  G.getStateName = function () { return state; };
  G.getRun = function () { return run; };

  /* ================= 结算流程 ================= */
  function settlePending(double) {
    if (!pending || pending.settled) return null;
    pending.settled = true;
    var r = pending.result;
    var coins = Math.round(r.totalCoins * (double ? 2 : 1));
    S.addCoins(coins);
    var rec = S.recordRun({
      mode: pending.mode,
      score: r.score,
      distance: r.distance,
      maxTile: r.maxTile,
      merges: r.merges,
      tiles: r.tiles,
      coins: coins,
      duration: r.duration
    });
    ui('setCoins', S.coins());
    if (double) r.totalCoins = coins;
    r.best = rec.best;
    r.isNewRecord = rec.newRecord;
    r.adDoubleUsed = double;
    r.canRevive = false;
    // 上报在线排行榜（失败静默降级为本地榜）
    if (NW.online && NW.online.enabled && NW.online.submit) {
      safe(function () { NW.online.submit(pending.mode, r.score); });
    }
    return r;
  }

  function endRun(reason) {
    if (!run || state === 'gameover') return;
    var v = run.view();
    state = 'gameover';
    var mode = CFG.mode(v.mode.id);
    // 局内金币已由 Run 应用 mode.coinMul；结算奖励金币同样按模式金币倍率计算
    var bonus = Math.floor((v.score / 150) * mode.coinMul);
    var totalCoins = Math.round(v.coins + bonus);
    var prevBest = S.best(mode.id);
    var why = reason || 'hearts';
    var result = {
      mode: mode.id,
      modeName: mode.name,
      score: Math.round(v.score),
      distance: Math.round(v.distance),
      maxTile: v.maxTile,
      bestTile: S.bestTile(),
      coins: Math.round(v.coins),
      bonusCoins: bonus,
      totalCoins: totalCoins,
      best: Math.max(prevBest, Math.round(v.score)),
      isNewRecord: v.score > prevBest,
      // 「时间到」结算不允许复活（run.revive() 只支持 hearts 结算）
      canRevive: !ad.reviveUsed && why !== 'time' && v.hearts <= 0,
      adDoubleUsed: ad.doubleUsed,
      reason: why,
      merges: v.stats.merges,
      tiles: v.stats.tiles,
      hits: v.stats.hits,
      duration: v.t,
      rank: 0
    };
    pending = { result: result, mode: mode.id, settled: false };
    if (goTimer > 0) { goTimer = 0; ui('showCountdown', null); }
    trauma = Math.min(1, trauma + 0.55);
    sfx('gameover');
    safe(function () { if (NW.audio && NW.audio.stopMusic) NW.audio.stopMusic(); });
    ui('showScreen', 'gameover');
    ui('showGameOver', result);
    ui('setCoins', S.coins());
  }

  function reviveFlow() {
    if (!pending || pending.settled || ad.reviveUsed || !run) return;
    if (pending.result && !pending.result.canRevive) return;
    ad.reviveUsed = true;
    ui('showAd', 'revive', function () {
      var revived = false;
      safe(function () { revived = run.revive(); });
      if (revived) {
        pending = null;
        state = 'playing';
        frozen = false;
        accum = 0;
        trauma = 0;
        hitFlash = 0;
        lastCountdown = null;
        if (fx) fx.reset();
        ui('showScreen', 'playing');
        ui('showCountdown', null);
        ui('updateHUD', run.view(), []);
        ui('showBanner', '复活成功！', '还有 1 颗心，继续冲', { tone: 'mint', icon: 'heart' });
        sfx('revive');
        music('game');
        lastView = run.view();
      } else {
        ui('toast', '复活失败');
      }
    });
  }

  function doubleFlow() {
    if (!pending || pending.settled || ad.doubleUsed) return;
    ad.doubleUsed = true;
    ui('showAd', 'double', function () {
      var r = settlePending(true);
      if (r) {
        ui('showGameOver', r);
        ui('toast', '金币翻倍到账！');
        sfx('record');
      }
    });
  }

  /* ================= 事件 → 反馈 ================= */
  function processEvents(events, silent) {
    if (!events || !events.length) return;
    var ps = playerScreen();
    var bodyX = ps.x, bodyY = ps.y - ps.h * 0.55;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      switch (e.t) {
        case 'introEnd':
          if (!silent) {
            ui('showCountdown', 'GO');
            sfx('go');
            goTimer = 0.55;
          }
          break;
        case 'tileCollect':
          if (!silent) {
            sfx('collect', { value: e.value });
            if (fx) fx.burst(bodyX, bodyY, { color: CFG.tileColor(e.value).a, color2: CFG.tileColor(e.value).b, count: 6, speed: 90, size: 4, life: 0.4, gravity: 120, shape: 'circle' });
          }
          break;
        case 'merge':
          if (!silent) {
            sfx(e.value >= 32 ? 'mergeBig' : 'merge', { value: e.value });
            var tc = CFG.tileColor(e.value);
            if (fx) {
              fx.burst(bodyX, bodyY - 10, { color: tc.a, color2: tc.b, count: 10, speed: 140, size: 5, life: 0.5, gravity: 100, shape: 'star' });
              fx.text(bodyX + U.rand(null, -18, 18), bodyY - 34, '+' + U.formatScore(e.score), { color: '#FFE066', size: 22 });
              if (e.mult >= 2) fx.text(bodyX, bodyY - 62, '×' + e.mult.toFixed(1), { color: '#FF8A5C', size: 18 });
            }
            if (e.value >= 16) trauma = Math.min(1, trauma + 0.08);
          }
          break;
        case 'overflow':
          if (!silent) {
            sfx('tap');
            if (fx) fx.text(bodyX, bodyY - 30, '槽满替换', { color: '#FFB3A7', size: 15 });
          }
          break;
        case 'drop':
          if (!silent && fx) fx.text(bodyX, bodyY - 22, '掉了 ' + e.value, { color: '#FF6B6B', size: 18 });
          break;
        case 'coin':
          if (!silent) {
            sfx('coin');
            if (fx) fx.coin(ps.x, ps.y - ps.h * 0.7);
          }
          break;
        case 'powerup':
          if (!silent) {
            var pd = CFG.powerups[e.power] || { name: '道具', color: '#FFD54F' };
            sfx('powerup');
            if (fx) {
              fx.power(bodyX, bodyY, pd.color);
              fx.text(bodyX, bodyY - 50, pd.name + '！', { color: pd.color, size: 20 });
            }
            ui('showBanner', pd.name, pd.desc || '', { tone: 'blue', icon: 'power', duration: 900 });
          }
          break;
        case 'powerupEnd':
          break;
        case 'hit':
          if (!silent) {
            sfx('hit');
            haptic(30);
            trauma = Math.min(1, trauma + 0.75);
            hitFlash = 0.22;
            if (fx) fx.hit(ps.x, ps.y - ps.h * 0.5);
          }
          break;
        case 'shieldBlock':
          if (!silent) {
            sfx('shield');
            trauma = Math.min(1, trauma + 0.3);
            if (fx) fx.ring(ps.x, ps.y - ps.h * 0.5, '#4FC3F7', ps.h * 0.6);
            ui('showBanner', '护盾抵挡！', '', { tone: 'blue', icon: 'power', duration: 800 });
          }
          break;
        case 'newMax':
          if (!silent) {
            sfx('record');
            haptic(20);
            trauma = Math.min(1, trauma + 0.12);
            if (fx) fx.burst(ps.x, ps.y - ps.h * 0.7, { color: '#FFE066', color2: '#FFB020', count: 22, speed: 260, size: 6, life: 0.9, gravity: 260, shape: 'star' });
            var banner = (CFG.merge.milestoneBanner && CFG.merge.milestoneBanner[e.value]) || ('合成 ' + e.value + '！');
            ui('showBanner', banner, '奶娃进化 +' + e.coins + ' 金币', { tone: 'gold', icon: 'tile', duration: 1500, value: e.value });
          }
          break;
        case 'combo':
          break;
        case 'tileSkip':
          if (!silent) {
            if (fx) fx.text(bodyX + U.rand(null, -14, 14), bodyY - 26, '跳过 ' + e.value, { color: '#C9BBA6', size: 15 });
          }
          break;
        case 'upgradeOffer':
          if (!silent) openUpgrade();
          break;
        case 'upgradeTaken':
          if (!silent) {
            var ud = null;
            if (NW.core && NW.core.Upgrades && NW.core.Upgrades.describe) ud = NW.core.Upgrades.describe(e.id, e.level);
            ui('toast', '获得强化：' + (ud || e.id) + ' Lv.' + e.level);
          }
          break;
        case 'cleanse':
          if (!silent) {
            sfx('go');
            if (fx) {
              fx.ring(ps.x, ps.groundY, '#9BE7FF', ps.h * 0.7);
              fx.text(bodyX, bodyY - 40, '净化冲刺！', { color: '#9BE7FF', size: 20 });
            }
          }
          break;
        case 'shield':
          if (!silent) {
            sfx('shield');
            if (fx) fx.ring(ps.x, ps.y - ps.h * 0.5, '#4FC3F7', ps.h * 0.55);
            ui('showBanner', '护盾生成', '', { tone: 'blue', icon: 'power', duration: 800 });
          }
          break;
        case 'gameover':
          if (!silent) endRun(e.reason);
          break;
        case 'revive':
          if (!silent) {
            sfx('record');
            haptic(30);
            trauma = 0;
            hitFlash = 0;
            if (fx) fx.ring(ps.x, ps.groundY, '#FFE066', ps.h * 0.9);
            ui('showBanner', '二次机会！', '复活并短暂无敌', { tone: 'gold', icon: 'heart', duration: 1200 });
          }
          break;
      }
    }
  }

  /* ================= 输入 ================= */
  function inputLane(dir) {
    if (state !== 'playing' || !run) return;
    if (dir !== -1 && dir !== 1) return;
    run.input(dir);
  }
  G.input = inputLane;
  function inputAction(kind) {
    if (state !== 'playing' || !run) return;
    if (kind !== 'jump' && kind !== 'slide') return;
    if (typeof run.action === 'function') run.action(kind);
  }
  G.action = inputAction;

  /* ================= Roguelike 强化三选一（v0.9.4） ================= */
  function upgradeTakenCount() {
    var n = 0, ups = run && run.upgrades;
    if (ups) { for (var k in ups) { if (Object.prototype.hasOwnProperty.call(ups, k)) n += ups[k]; } }
    return n;
  }
  function openUpgrade() {
    if (!run || !run.pendingUpgrade) return false;
    var pu = run.pendingUpgrade;
    if (!pu.offers || !pu.offers.length) { run.pendingUpgrade = null; return false; }
    state = 'upgrade';
    upgradeMeta = { value: pu.value, index: upgradeTakenCount() + 1, total: 0 };
    ui('showUpgrade', pu.offers, upgradeMeta);
    sfx('powerup');
    return true;
  }
  G.pickUpgrade = function (id) {
    if (state !== 'upgrade' || !run || !run.chooseUpgrade) return false;
    var ok = false;
    try { ok = run.chooseUpgrade(id); } catch (e) { errs.push({ msg: String(e && e.stack || e), at: 'pickUpgrade' }); return false; }
    if (!ok) { sfx('error'); return false; }
    sfx('buy');
    if (run.pendingUpgrade) {
      openUpgrade();
    } else {
      ui('hideUpgrade');
      state = 'playing';
      /* 注意：这里不再调用 ui('showScreen','playing')——它会把 HUD 强化图标行重置掉；
       * 强化遮罩只是覆盖层，playing 屏幕一直保持激活。 */
    }
    if (run.upgradeList) ui('updateUpgradeHud', run.upgradeList());
    return true;
  };
  G.isUpgradeOpen = function () { return state === 'upgrade'; };
  G.getUpgradeState = function () {
    return {
      open: state === 'upgrade',
      meta: { value: upgradeMeta.value, index: upgradeMeta.index, total: upgradeMeta.total },
      offers: (run && run.pendingUpgrade && run.pendingUpgrade.offers) ? run.pendingUpgrade.offers : null,
      taken: upgradeTakenCount(),
      list: (run && run.upgradeList) ? run.upgradeList() : []
    };
  };

  function updateCountdown(v) {
    var label = null;
    if (v && v.mode && v.mode.phase === 'intro' && v.introLeft > 0) {
      label = v.introLeft > 1.6 ? '3' : (v.introLeft > 0.8 ? '2' : '1');
    }
    if (label !== lastCountdown) {
      lastCountdown = label;
      ui('showCountdown', label);
      if (label) sfx('countdown', { n: label });
    }
  }

  /* ================= 自动试玩（调试/QA 用） ================= */
  function nearestObstacle(ents, lane, range) {
    var best = null;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.kind !== 'obstacle' || e.lane !== lane || e.z < 0.2 || e.z > range) continue;
      if (!best || e.z < best.z) best = e;
    }
    return best;
  }
  function hazardAhead(ents, lane, range) {
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.kind === 'obstacle' && e.lane === lane && e.z > -0.8 && e.z < range) return true;
    }
    return false;
  }
  function nearestInLane(ents, lane, kind, range) {
    var best = 1e9;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.lane !== lane || e.z < 0.5 || e.z > range) continue;
      if (kind && e.kind !== kind) continue;
      if (e.z < best) best = e.z;
    }
    return best;
  }
  function autoStep() {
    if (!run) return;
    var v = run.view();
    var p = v.player;
    var ents = v.entities;
    // 地铁跑酷式：优先用跳跃/滑铲处理当前车道动作障碍
    var ob = nearestObstacle(ents, p.lane, 30);
    if (ob && ob.avoid) {
      if (ob.avoid === 'jump') {
        if (p.y <= 0 && !p.rolling && ob.z <= Math.max(2.6, v.speed * 0.30)) run.action('jump');
        return;
      }
      if (ob.avoid === 'slide') {
        if (p.y <= 0 && !p.rolling && ob.z <= Math.max(2.2, v.speed * 0.22)) run.action('slide');
        return;
      }
    }
    if (hazardAhead(ents, p.lane, 16)) {
      var opts = [];
      for (var l = 0; l < 3; l++) {
        if (l === p.lane || hazardAhead(ents, l, 18)) continue;
        var sc = 0;
        if (nearestInLane(ents, l, 'tile', 24) < 1e9) sc += 2;
        if (nearestInLane(ents, l, 'power', 24) < 1e9) sc += 3;
        if (nearestInLane(ents, l, 'coin', 24) < 1e9) sc += 0.5;
        sc -= Math.abs(l - 1) * 0.3;
        opts.push([l, sc]);
      }
      if (opts.length) {
        opts.sort(function (a, b) { return b[1] - a[1]; });
        var target = opts[0][0];
        if (p.moving === 0) run.input(target > p.lane ? 1 : -1);
      }
      return;
    }
    var rackCount = {};
    if (v.rack) for (var r = 0; r < v.rack.length; r++) {
      var t = v.rack[r];
      if (t) rackCount[t.value] = (rackCount[t.value] || 0) + 1;
    }
    var want = p.lane, wantScore = -1e9;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.z < 1 || e.z > 30) continue;
      if (e.kind !== 'tile' && e.kind !== 'power' && e.kind !== 'coin') continue;
      if (hazardAhead(ents, e.lane, 12)) continue;
      var s = e.kind === 'tile' ? (rackCount[e.value] ? 4 : 1) : (e.kind === 'power' ? 3 : 0.3);
      if (e.kind === 'tile' && e.value >= 16) s += 0.5;
      s -= Math.abs(e.lane - p.lane) * 0.6;
      s -= e.z * 0.02;
      if (s > wantScore) { wantScore = s; want = e.lane; }
    }
    if (want !== p.lane && p.moving === 0 && !hazardAhead(ents, want, 13)) {
      run.input(want > p.lane ? 1 : -1);
    }
  }

  /* ================= 帧更新 ================= */
  G.frame = function (dtReal) {
    var dt = Math.min(Math.max(dtReal || 0, 0), 0.1);
    menuTime += dt;
    menuScroll += 2.2 * dt;

    if (state === 'playing' && !frozen && run) {
      accum += dt;
      var steps = 0;
      var events = [];
      while (accum >= FIXED && steps < 6) {
        if (auto) autoStep();
        run.update(FIXED);
        var ev = run.drainEvents();
        if (ev && ev.length) for (var k = 0; k < ev.length; k++) events.push(ev[k]);
        accum -= FIXED;
        steps++;
        if (run.isOver) { accum = 0; break; }
      }
      if (steps >= 6) accum = 0;
      if (events.length) processEvents(events, false);
      if (state === 'playing' && run && run.pendingUpgrade) openUpgrade();   // v0.9.4：新数字 → 强化三选一
      if (run && state === 'playing') {
        lastView = run.view();
        updateCountdown(lastView);
        // 随时间加速：每跨过一档速度阈值给出提示
        var stepSpd = CFG.run.speedMilestone || 2;
        var mark = Math.floor((lastView.speed || 0) / stepSpd) * stepSpd;
        if (mark > lastSpeedMark) {
          lastSpeedMark = mark;
          sfx('go');
          ui('showBanner', '加速！', '速度提升至 ' + mark.toFixed(1) + ' m/s', { tone: 'gold', duration: 850, icon: 'power' });
        }
        var p = lastView.player;
        camX = U.damp(camX, p.x * CFG.cam.followX, 9, dt);
        // 跳跃 / 滑铲起手反馈
        var psx = playerScreen();
        if (!prevJumping && p.jumping) {
          sfx('tap');
          if (fx) fx.ring(psx.x, psx.groundY, '#FFE066', 26);
          if (prevRolling) chainT = CFG.run.chainBlend || 0.14;   // v0.9.4：滑铲→跳跃姿态无缝融合
        }
        if (!prevRolling && p.rolling) {
          sfx('tap');
          if (fx) fx.burst(psx.x, psx.y - 6, { color: '#E8C48A', color2: '#FFFFFF', count: 8, speed: 110, size: 5, life: 0.32, gravity: 140, shape: 'circle' });
        }
        prevJumping = !!p.jumping;
        prevRolling = !!p.rolling;
        hudTick++;
        if (hudTick % 1 === 0) ui('updateHUD', lastView, events);
      }
      gameTime += dt;
    } else if (state === 'menu') {
      camX = U.damp(camX, 0, 6, dt);
    }

    /* v0.9.4：自动试玩时自动选择强化，避免卡在三选一 */
    if (auto && state === 'upgrade' && run && run.pendingUpgrade && run.pendingUpgrade.offers && run.pendingUpgrade.offers.length) {
      G.pickUpgrade(run.pendingUpgrade.offers[0].id);
    }
    if (chainT > 0) chainT = Math.max(0, chainT - dt);

    if (goTimer > 0) {
      goTimer -= dt;
      if (goTimer <= 0) { goTimer = 0; ui('showCountdown', null); }
    }
    traumaT += dt;
    trauma = Math.max(0, trauma - dt * 1.6);
    hitFlash = Math.max(0, hitFlash - dt * 3);
    if (fx) fx.update(dt);
    G.draw();
  };

  /* ================= 渲染 ================= */
  function currentView() {
    if (run) return lastView && state !== 'playing' ? lastView : run.view();
    return null;
  }

  function drawMenu() {
    var theme = S.theme();
    var scene = {
      t: menuTime, dt: 0, distance: menuScroll, speed: 2.2,
      theme: theme, skin: S.skin(),
      player: { lane: 1, x: 0, tilt: 0, invuln: 0, hurt: 0, moving: 1 },
      entities: [],
      mode: { id: 'menu', name: '菜单', duration: 0, timeLeft: 0, phase: 'run' },
      powerups: { shield: 0, slow: 0, magnet: 0, double: 0 },
      camX: camX, menu: true
    };
    // 装饰性数字方块：远处漂浮
    if (CFG.merge && CFG.merge.mergeDemo !== false) {
      var vals = [2, 4, 8, 16];
      var t = menuTime;
      for (var i = 0; i < 4; i++) {
        scene.entities.push({
          id: 'menu-tile-' + i, kind: 'tile', lane: 0,
          x: (i % 2 === 0 ? -1 : 1) * (1.35 + 0.1 * i),
          y: 1.0 + 0.15 * Math.sin(t * 1.2 + i),
          z: 5.5 + i * 2.2, value: vals[i], variant: 0
        });
      }
    }
    if (NW.art && NW.art.World) {
      if (NW.art.World.drawBackground) NW.art.World.drawBackground(ctx, scene);
      if (NW.art.World.drawRoad) NW.art.World.drawRoad(ctx, scene);
      if (NW.art.World.drawProps) NW.art.World.drawProps(ctx, scene);
      if (NW.art.World.drawEntities) NW.art.World.drawEntities(ctx, scene);
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, CFG.H);
      g.addColorStop(0, theme.skyTop); g.addColorStop(1, theme.skyBottom);
      ctx.fillStyle = g; ctx.fillRect(0, 0, CFG.W, CFG.H);
    }
  }

  function drawWorld(v) {
    var theme = S.theme();
    var skin = S.skin();
    var ents = v.entities || [];
    var ahead = [], behind = [];
    for (var i = 0; i < ents.length; i++) {
      if (ents[i].z >= -0.35) ahead.push(ents[i]); else behind.push(ents[i]);
    }
    var scene = {
      t: gameTime, dt: 0, distance: v.distance, speed: v.speed,
      theme: theme, skin: skin, player: v.player, entities: ents,
      mode: v.mode, powerups: v.powerups, camX: camX, menu: false
    };
    if (!NW.art || !NW.art.World) return;
    if (NW.art.World.drawBackground) NW.art.World.drawBackground(ctx, scene);
    if (NW.art.World.drawRoad) NW.art.World.drawRoad(ctx, scene);
    if (NW.art.World.drawProps) NW.art.World.drawProps(ctx, scene);
    var sceneAhead = {
      t: scene.t, dt: 0, distance: scene.distance, speed: scene.speed, theme: theme, skin: skin,
      player: v.player, entities: ahead, mode: v.mode, powerups: v.powerups, camX: camX
    };
    if (NW.art.World.drawEntities) NW.art.World.drawEntities(ctx, sceneAhead);

    // 玩家角色（缩小 + 下移，避免遮挡前方数字；受击不再闪烁）
    var ps = playerScreen();
    var alpha = 1;
    var jumpY = (v.player.y || 0);
    if (NW.art.Character) {
      var shadowScale = Math.max(0.45, 1 - jumpY * 0.55);
      if (NW.art.Character.drawShadow) NW.art.Character.drawShadow(ctx, ps.x, ps.groundY, ps.h * 0.32 * shadowScale, 0.22 * shadowScale, jumpY);
      var chState = 'run';
      if (v.player.hurt > 0.05) chState = 'hit';
      else if (v.player.rolling) chState = 'slide';
      else if (v.player.jumping) chState = 'jump';
      else if (v.combo >= 3) chState = 'happy';
      var chYaw = U.clamp((v.player.tilt || 0) * (CFG.run.playerYaw || 1.7), -0.4, 0.4);
      var chainK = (chState === 'jump' && chainT > 0) ? Math.min(1, chainT / (CFG.run.chainBlend || 0.14)) : 0;
      var chOpts = {
        x: ps.x, y: ps.y, h: ps.h, state: chState, t: gameTime,
        skin: skin, lean: v.player.tilt || 0, yaw: chYaw, alpha: alpha,
        chain: chainK, diving: !!v.player.diving,
        squash: v.player.hurt > 0 ? Math.min(0.5, v.player.hurt) : 0
      };
      if (chState === 'run' && v.mode.phase === 'intro') chOpts.state = 'idle';
      NW.art.Character.draw(ctx, chOpts);
      // 护盾效果：脚下光环 + 身体两侧弧线，不遮挡前方视野
      if (v.powerups && v.powerups.shield > 0) {
        var pulse = 0.5 + 0.5 * Math.sin(gameTime * 5);
        ctx.save();
        ctx.lineCap = 'round';
        // 脚下光环（椭圆，贴地）
        ctx.globalAlpha = 0.35 + pulse * 0.2;
        ctx.strokeStyle = '#8FE5FF';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(ps.x, ps.y - ps.h * 0.02, ps.h * 0.28, ps.h * 0.075, 0, 0, Math.PI * 2);
        ctx.stroke();
        // 身体两侧短弧（只在角色两侧，不覆盖正前方）
        ctx.globalAlpha = 0.45 + pulse * 0.2;
        ctx.strokeStyle = '#B3E9FF';
        ctx.lineWidth = 4;
        var cy = ps.y - ps.h * 0.5;
        var rr = ps.h * 0.34;
        ctx.beginPath();
        ctx.arc(ps.x, cy, rr, Math.PI * 0.78, Math.PI * 1.22);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ps.x, cy, rr, Math.PI * 1.78, Math.PI * 0.22);
        ctx.stroke();
        // 头顶小盾牌标记（很小，不挡视野）
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#E8FBFF';
        var ix = ps.x, iy = ps.y - ps.h * 1.06;
        ctx.beginPath();
        ctx.moveTo(ix, iy - 7);
        ctx.lineTo(ix + 6, iy - 3);
        ctx.lineTo(ix + 5, iy + 3);
        ctx.lineTo(ix, iy + 7);
        ctx.lineTo(ix - 5, iy + 3);
        ctx.lineTo(ix - 6, iy - 3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    var sceneBehind = {
      t: scene.t, dt: 0, distance: scene.distance, speed: scene.speed, theme: theme, skin: skin,
      player: v.player, entities: behind, mode: v.mode, powerups: v.powerups, camX: camX
    };
    if (behind.length && NW.art.World.drawEntities) NW.art.World.drawEntities(ctx, sceneBehind);
  }

  G.draw = function () {
    if (!ctx) return;
    var sx = viewport.sx, sy = viewport.sy;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, CFG.W, CFG.H);
    ctx.save();
    // 屏幕震动
    if (trauma > 0) {
      var mag = trauma * trauma * 16;
      var ox = Math.sin(traumaT * 61) * mag;
      var oy = Math.cos(traumaT * 47) * mag * 0.7;
      ctx.translate(ox, oy);
    }
    if (state === 'menu' || !run) {
      drawMenu();
    } else {
      var v = lastView || run.view();
      drawWorld(v);
    }
    if (fx && state !== 'menu') fx.draw(ctx);
    ctx.restore();

    // 受击红屏（弱化：只做轻微边缘红晕，不阻挡视线）
    if (hitFlash > 0) {
      var a = Math.min(0.22, hitFlash * 0.55);
      var vg = ctx.createRadialGradient(CFG.W / 2, CFG.H / 2, CFG.H * 0.28, CFG.W / 2, CFG.H / 2, CFG.H * 0.72);
      vg.addColorStop(0, 'rgba(255,60,60,0)');
      vg.addColorStop(1, 'rgba(255,40,40,' + a + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, CFG.W, CFG.H);
    }
  };

  /* ================= 调试接口 ================= */
  G.debug = {
    start: function (mode, opts) { G.startGame(mode || 'endless', opts || { skipTutorial: true }); return true; },
    warmup: function (seconds) {
      if (!run) return false;
      var wasAuto = auto;
      auto = true;
      var n = Math.max(0, Math.round((seconds || 0) * 60));
      var lastEvents = [];
      for (var i = 0; i < n; i++) {
        if (run.isOver) break;
        autoStep();
        run.update(FIXED);
        var ev = run.drainEvents();
        if (ev && ev.length) { lastEvents = ev; processEvents(ev, true); }
      }
      auto = wasAuto;
      lastView = run.view();
      if (run.isOver && state === 'playing') {
        // warmup 期间死亡：补一次正式的结束流程，让结算面板展示
        processEvents([{ t: 'gameover', reason: run.overReason || 'hearts' }], false);
      } else {
        ui('showScreen', 'playing');
        // 截图/调试场景：warmup 后不把历史事件交给 HUD，避免残留飘字影响截图
        ui('updateHUD', lastView, []);
        ui('showCountdown', null);
        lastCountdown = null;
      }
      G.draw();
      return true;
    },
    freeze: function (v) { frozen = v !== false; },
    setAuto: function (v) { auto = !!v; },
    isAuto: function () { return auto; },
    forceGameOver: function (reason) {
      if (!run) return false;
      run.forceOver(reason || 'hearts');
      var ev = run.drainEvents();
      processEvents(ev, false);
      lastView = run.view();
      G.draw();
      return true;
    },
    hit: function () {
      if (!run) return false;
      var v = run.view();
      var ent = null;
      for (var i = 0; i < v.entities.length; i++) {
        if (v.entities[i].kind === 'obstacle' && v.entities[i].lane === v.player.lane && v.entities[i].z > 1) { ent = v.entities[i]; break; }
      }
      if (ent) ent.z = 0.2;
      return true;
    },
    getState: function () {
      return {
        state: state, modeId: modeId, auto: auto, frozen: frozen,
        view: run ? run.view() : null,
        pending: pending && pending.result ? pending.result : null,
        save: S.snapshot(),
        errors: errs.slice(0, 20)
      };
    },
    giveCoins: function (n) { S.addCoins(n); ui('setCoins', S.coins()); return S.coins(); },
    setHearts: function (n) {
      if (!run) return false;
      if (!run.debugSetHearts) return false;
      run.debugSetHearts(n);
      lastView = run.view();
      ui('updateHUD', lastView, []);
      return true;
    },
    giveTile: function (value) {
      if (!run) return false;
      if (run.debugInsertTile) { run.debugInsertTile(value); }
      else return false;
      processEvents(run.drainEvents(), true);
      lastView = run.view();
      ui('updateHUD', lastView, []);
      return true;
    },
    showScreen: function (name) { ui('showScreen', name); },
    showTutorial: function () { ui('showTutorial', true); },
    showAd: function (kind) { ui('showAd', kind || 'double', function () {}); },
    finishAd: function () { if (NW.ui && NW.ui.finishAd) safe(function () { NW.ui.finishAd(); }); },
    finishTutorial: function () {
      S.setTutorialSeen(true);
      ui('hideTutorial');
      if (pendingStartMode) {
        var m = pendingStartMode;
        pendingStartMode = null;
        G.startGame(m, {});
      }
      return true;
    },
    errors: function () { return errs.slice(); },
    pushError: function (msg) { errs.push({ msg: String(msg), at: 'window' }); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
