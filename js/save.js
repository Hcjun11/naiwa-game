/* ==========================================================================
 * 《奶娃》本地存档 / 元数据（金币、最佳成绩、外观解锁、排行榜、设置）
 * 经典脚本：挂载到 window.NW.save，同时兼容 Node（globalThis.NW.save）
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG;
  var U = NW.util;
  var S = {};

  var DEFAULT_STATE = {
    v: 1,
    coins: 0,
    best: { endless: 0, sprint: 0 },
    bestDistance: { endless: 0, sprint: 0 },
    bestTile: 0,
    runs: 0,
    totalDistance: 0,
    totalMerges: 0,
    totalCoinsEarned: 0,
    ownedSkins: ['classic'],
    ownedThemes: ['day'],
    equip: { skin: 'classic', theme: 'day' },
    settings: { sfx: true, music: true, haptics: true },
    nickname: '奶娃玩家',
    tutorialSeen: false,
    firstRunAt: 0,
    lastRunAt: 0
  };

  var state = null;
  var dirty = false;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function normalize(raw) {
    // 注意：mergeDeep(target, fallbackSource) 的语义是「只填充 target 缺失的键」，
    // 因此 target 必须是读到的存档、source 才是默认值，否则会覆盖玩家数据（QA 回归点）。
    var s = U.mergeDeep(clone(raw || {}), DEFAULT_STATE);
    s.coins = Math.max(0, Math.floor(Number(s.coins) || 0));
    // 兼容旧版本/异常数据
    if (!Array.isArray(s.ownedSkins)) s.ownedSkins = ['classic'];
    if (!Array.isArray(s.ownedThemes)) s.ownedThemes = ['day'];
    if (s.ownedSkins.indexOf('classic') < 0) s.ownedSkins.unshift('classic');
    if (s.ownedThemes.indexOf('day') < 0) s.ownedThemes.unshift('day');
    if (!CFG.skin(s.equip.skin)) s.equip.skin = 'classic';
    if (!CFG.theme(s.equip.theme)) s.equip.theme = 'day';
    if (s.ownedSkins.indexOf(s.equip.skin) < 0) s.equip.skin = 'classic';
    if (s.ownedThemes.indexOf(s.equip.theme) < 0) s.equip.theme = 'day';
    s.best = s.best || { endless: 0, sprint: 0 };
    s.bestDistance = s.bestDistance || { endless: 0, sprint: 0 };
    return s;
  }

  /* ---------------- 基础读写 ---------------- */
  S.load = function () {
    var raw = U.storage.get(CFG.save.key, null);
    state = normalize(raw);
    dirty = false;
    return state;
  };

  S.save = function (force) {
    if (!state) return;
    if (!dirty && !force) return;
    if (U.storage.set(CFG.save.key, state)) dirty = false;
  };

  S.get = function () {
    if (!state) S.load();
    return state;
  };

  S.reset = function () {
    state = normalize(null);
    dirty = true;
    U.storage.remove(CFG.save.key);
    S.save(true);
    return state;
  };

  S.touch = function () { dirty = true; };

  /* ---------------- 金币 ---------------- */
  S.coins = function () { return S.get().coins; };

  S.addCoins = function (n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (!n) return S.get().coins;
    var st = S.get();
    st.coins += n;
    st.totalCoinsEarned += n;
    S.touch(); S.save(true);
    return st.coins;
  };

  S.spendCoins = function (n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    var st = S.get();
    if (st.coins < n) return false;
    st.coins -= n;
    S.touch(); S.save(true);
    return true;
  };

  /* ---------------- 外观解锁 / 装备 ---------------- */
  S.ownedSkin = function (id) { return S.get().ownedSkins.indexOf(id) >= 0; };
  S.ownedTheme = function (id) { return S.get().ownedThemes.indexOf(id) >= 0; };

  S.buySkin = function (id) {
    var def = CFG.skin(id), st = S.get();
    if (!def || def.id !== id) return { ok: false, reason: 'not-found' };
    if (st.ownedSkins.indexOf(id) >= 0) return { ok: false, reason: 'owned' };
    if (st.coins < def.price) return { ok: false, reason: 'coins', need: def.price - st.coins };
    st.coins -= def.price;
    st.ownedSkins.push(id);
    st.equip.skin = id;
    S.touch(); S.save(true);
    return { ok: true, coins: st.coins };
  };

  S.buyTheme = function (id) {
    var def = CFG.theme(id), st = S.get();
    if (!def || def.id !== id) return { ok: false, reason: 'not-found' };
    if (st.ownedThemes.indexOf(id) >= 0) return { ok: false, reason: 'owned' };
    if (st.coins < def.price) return { ok: false, reason: 'coins', need: def.price - st.coins };
    st.coins -= def.price;
    st.ownedThemes.push(id);
    st.equip.theme = id;
    S.touch(); S.save(true);
    return { ok: true, coins: st.coins };
  };

  S.equipSkin = function (id) {
    var st = S.get();
    if (st.ownedSkins.indexOf(id) < 0) return false;
    st.equip.skin = id;
    S.touch(); S.save(true);
    return true;
  };

  S.equipTheme = function (id) {
    var st = S.get();
    if (st.ownedThemes.indexOf(id) < 0) return false;
    st.equip.theme = id;
    S.touch(); S.save(true);
    return true;
  };

  S.skin = function () { return CFG.skin(S.get().equip.skin); };
  S.theme = function () { return CFG.theme(S.get().equip.theme); };

  /* ---------------- 设置 / 昵称 / 教学 ---------------- */
  S.setting = function (key) { return S.get().settings[key]; };
  S.setSetting = function (key, value) {
    S.get().settings[key] = value;
    S.touch(); S.save(true);
    return value;
  };
  S.nickname = function () { return S.get().nickname || '奶娃玩家'; };
  S.setNickname = function (name) {
    name = String(name || '').trim().slice(0, 12) || '奶娃玩家';
    S.get().nickname = name;
    S.touch(); S.save(true);
    return name;
  };
  S.tutorialSeen = function () { return !!S.get().tutorialSeen; };
  S.setTutorialSeen = function (v) {
    S.get().tutorialSeen = !!v;
    S.touch(); S.save(true);
  };

  /* ---------------- 成绩 ---------------- */
  S.best = function (mode) { return S.get().best[mode] || 0; };
  S.bestDistance = function (mode) { return S.get().bestDistance[mode] || 0; };
  S.bestTile = function () { return S.get().bestTile || 0; };
  S.runs = function () { return S.get().runs || 0; };

  /**
   * 记录一局结果
   * @param {{mode:string, score:number, distance:number, maxTile:number, merges:number, tiles:number, coins:number, duration:number}} result
   * @returns {{newRecord:boolean, prevBest:number, best:number, newDistance:boolean, newTile:boolean, mode:string}}
   */
  S.recordRun = function (result) {
    var st = S.get();
    var mode = result.mode === 'sprint' ? 'sprint' : 'endless';
    var score = Math.max(0, Math.floor(result.score || 0));
    var prevBest = st.best[mode] || 0;
    var newRecord = score > prevBest;
    var newDistance = (result.distance || 0) > (st.bestDistance[mode] || 0);
    var newTile = (result.maxTile || 0) > (st.bestTile || 0);
    if (newRecord) st.best[mode] = score;
    if (newDistance) st.bestDistance[mode] = Math.floor(result.distance || 0);
    if (newTile) st.bestTile = result.maxTile;
    st.runs += 1;
    st.totalDistance += Math.max(0, Math.floor(result.distance || 0));
    st.totalMerges += Math.max(0, Math.floor(result.merges || 0));
    if (!st.firstRunAt) st.firstRunAt = Date.now();
    st.lastRunAt = Date.now();
    S.touch(); S.save(true);
    return {
      mode: mode,
      newRecord: newRecord,
      prevBest: prevBest,
      best: st.best[mode],
      newDistance: newDistance,
      newTile: newTile
    };
  };

  /* ---------------- 排行榜（幽灵数据 + 玩家最佳） ---------------- */
  var GHOSTS = {
    endless: [
      ['奶黄包', 28600], ['布丁不甜', 24100], ['圆滚滚', 20800], ['芝士年糕', 17600],
      ['三分糖', 14300], ['小南瓜', 11200], ['咕噜噜', 8600], ['豆乳盒子', 6200],
      ['软糖怪', 3900], ['糯米团子', 1800]
    ],
    sprint: [
      ['跑得很快的猫', 31200], ['麻薯冲鸭', 26400], ['芋泥波波', 22100], ['小汤圆', 18500],
      ['奶油泡芙', 15200], ['冻柠茶', 11900], ['一口奶盖', 8800], ['黑糖珍珠', 6100],
      ['布丁布丁', 3800], ['棉花糖', 1500]
    ]
  };

  /**
   * 返回合并后的排行榜（倒序，含玩家最佳成绩）
   * @param {'endless'|'sprint'} mode
   * @returns {Array<{rank:number, name:string, score:number, self:boolean}>}
   */
  S.board = function (mode) {
    mode = mode === 'sprint' ? 'sprint' : 'endless';
    var st = S.get();
    var list = GHOSTS[mode].map(function (g) { return { name: g[0], score: g[1], self: false }; });
    var playerBest = st.best[mode] || 0;
    if (playerBest > 0) list.push({ name: st.nickname || '奶娃玩家', score: playerBest, self: true });
    list.sort(function (a, b) { return b.score - a.score; });
    // 只保留前 10，但若玩家不在前 10 也保留显示（追加到末尾并标注）
    var top = list.slice(0, 10);
    if (playerBest > 0 && !top.some(function (e) { return e.self; })) {
      var me = list.filter(function (e) { return e.self; })[0];
      me.rank = list.indexOf(me) + 1;
      top.push(me);
    }
    return top.map(function (e, i) {
      return { rank: e.rank || (i + 1), name: e.name, score: e.score, self: !!e.self };
    });
  };

  S.playerRank = function (mode) {
    var b = S.board(mode);
    for (var i = 0; i < b.length; i++) if (b[i].self) return b[i].rank;
    return 0;
  };

  /* ---------------- 便捷快照（UI 使用） ---------------- */
  S.snapshot = function () {
    var st = S.get();
    return {
      coins: st.coins,
      best: { endless: st.best.endless, sprint: st.best.sprint },
      bestDistance: { endless: st.bestDistance.endless, sprint: st.bestDistance.sprint },
      bestTile: st.bestTile,
      runs: st.runs,
      ownedSkins: st.ownedSkins.slice(),
      ownedThemes: st.ownedThemes.slice(),
      equip: { skin: st.equip.skin, theme: st.equip.theme },
      settings: { sfx: st.settings.sfx, music: st.settings.music, haptics: st.settings.haptics },
      nickname: st.nickname,
      tutorialSeen: st.tutorialSeen
    };
  };

  NW.save = S;
})(typeof window !== 'undefined' ? window : globalThis);
