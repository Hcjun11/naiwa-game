/* ==========================================================================
 * 《奶娃》核心系统 · Roguelike 强化引擎（v0.9.4）
 * 负责人：systems-sim（队友）
 *
 * 对外 API（挂载 NW.core.Upgrades，纯逻辑，无 DOM / localStorage 依赖，Node 可 require）：
 *   Upgrades.POOL                  // 14 条强化定义 {id,name,rarity,maxLevel,icon,tags,desc(level)}
 *   Upgrades.roll(rng, run, count) // 候选强化：稀有度加权、同批不重复、满级排除、池尽用 filler 补足
 *   Upgrades.apply(run, id)        // 等级 +1 并结算立即效果 -> {id, level, effects}
 *   Upgrades.stats(run)            // 等级聚合派生数值（纯函数、无副作用）
 *   Upgrades.describe(id, level)   // 文案（未知 id -> ''）
 *   Upgrades.list(run)             // 已获得强化列表（按 POOL 顺序）
 *
 * run 侧约定字段：run.upgrades（{id:level}，可缺省）、run.rng、run.distance、run.hearts、
 *   run.maxHearts、run.powerups、run.coins、run.reviveLeft、run.cleanseAt、run.shieldAt。
 *
 * 数值语义（冻结）：
 *   - roll 的稀有度加权为「两段式」：先按 CFG.upgrade.rarityWeights（62/30/8）在仍有可选条目的
 *     稀有度间抽档，再在该档内等概率抽条目 —— 大样本稀有度分布 ≈ 配置权重。count 非法（非有限数）
 *     时回退 CFG.upgrade.choices；count ≤ 0 返回 []。fillerId 与池内 id 冲突时回退内置 'coins'
 *     （金币袋，立即 +5 金币，maxLevel = Infinity 可无限叠加）。
 *   - stats 乘区（scoreMul / mergeMul / coinMul / jumpMul / slideMul / powerupMul）默认 1；
 *     加区（comboWindow / magnetRange / invulnBonus / luckChance / revive / cleanseEvery /
 *     cleanseInvuln / shieldEvery / shieldSec）默认 0。
 *   - comboWindow 为「相对 CFG.merge.comboWindow 的增量」，run 侧实际连击窗口应为
 *     CFG.merge.comboWindow + stats.comboWindow。
 *   - desc(level) / describe(id, level) 描述「达到该等级后」的效果；level 非法或 ≤0 时按 1 级预览。
 *
 * 健壮性：模块加载时 NW.CFG / CFG.upgrade / rarityWeights 缺失均可降级（默认权重与池子）；
 *   所有函数对非法入参（null、未知 id、run 缺字段、非法 rng/count）返回安全值且不抛错。
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG || (NW.CFG = {});
  var U = NW.util || (NW.util = {});
  var core = (NW.core = NW.core || {});

  /* ---------------- 默认配置（CFG.upgrade 缺失时降级） ---------------- */
  var DEFAULT_UPGRADE = {
    minValue: 8,
    choices: 3,
    rarityWeights: { common: 62, rare: 30, epic: 8 },
    fillerId: 'coins'
  };
  var RARITIES = ['common', 'rare', 'epic'];

  /* ---------------- 常量 ---------------- */
  var LUCK_MAX = 16;          // 幸运方块概率加成上限（百分点）
  var SHIELD_PICK_SEC = 10;   // 护盾生成：拾取时立即获得的护盾秒数
  var SHIELD_SEC = 6;         // 护盾生成：周期性护盾持续秒数
  var CLEANSE_EVERY = 400;    // 净化冲刺：触发间隔（米）
  var CLEANSE_INVULN = 1.2;   // 净化冲刺：无敌秒数
  var FILLER_COINS = 5;       // 保底强化（金币袋）：立即获得金币
  var FILLER_MAX_LEVEL = Infinity;  // 保底强化可无限叠加
  var MAX_ROLL = 64;          // roll 的防御性上限（避免异常 count 造成长循环）

  /* ---------------- 配置读取（每次调用读取，便于运行期降级/热改） ---------------- */
  function cfgObj() { return (CFG && CFG.upgrade) || DEFAULT_UPGRADE; }

  function cfgNum(obj, key, dflt) {
    var v = obj ? obj[key] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }
  function cfgStr(obj, key, dflt) {
    var v = obj ? obj[key] : undefined;
    return (typeof v === 'string' && v) ? v : dflt;
  }
  function choicesCount() { return cfgNum(cfgObj(), 'choices', DEFAULT_UPGRADE.choices); }
  /** 保底强化 id：与池内 id 冲突时回退内置金币袋（保证「可无限叠加」恒成立） */
  function fillerId() {
    var id = cfgStr(cfgObj(), 'fillerId', DEFAULT_UPGRADE.fillerId);
    if (BY_ID && has(BY_ID, id)) return DEFAULT_UPGRADE.fillerId;
    return id;
  }
  function luckMax() { return cfgNum(cfgObj(), 'luckMax', LUCK_MAX); }
  function baseHearts() { return cfgNum(CFG.run, 'hearts', 3); }

  /** 稀有度权重：逐键降级到默认表；全零时整体回退默认表 */
  function rarityWeights() {
    var src = cfgObj().rarityWeights || null;
    var out = {}, i, r, v, total = 0;
    for (i = 0; i < RARITIES.length; i++) {
      r = RARITIES[i];
      v = src ? Number(src[r]) : NaN;
      if (!isFinite(v) || v < 0) v = DEFAULT_UPGRADE.rarityWeights[r];
      out[r] = v;
      total += v;
    }
    if (!(total > 0)) {
      for (i = 0; i < RARITIES.length; i++) out[RARITIES[i]] = DEFAULT_UPGRADE.rarityWeights[RARITIES[i]];
    }
    return out;
  }

  /* ---------------- 通用小工具 ---------------- */
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function numOr(v, dflt) {
    v = Number(v);
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }
  function numLevel(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return 0;
    return Math.floor(v);
  }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }
  function fmtNum(v) {
    var s = (Math.round(v * 100) / 100).toFixed(2);
    return s.replace(/\.?0+$/, '');
  }
  function pct(v) { return Math.round(v * 100) + '%'; }
  function safeId(id) {
    if (typeof id === 'string') return id;
    if (id === null || id === undefined) return null;
    return String(id);
  }

  /* ---------------- 随机（rng 为函数则使用，保证可复现） ---------------- */
  function rand01(rng) {
    var v;
    if (typeof rng === 'function') v = rng();
    else if (typeof U.rand === 'function') v = U.rand();
    else v = Math.random();
    if (typeof v !== 'number' || !isFinite(v)) v = 0;
    if (v < 0) v = 0;
    if (v >= 1) v = 1 - 1e-9;   // 保证索引不越界（含返回 1 的自定义 rng）
    return v;
  }
  function randInt(rng, a, b) {
    if (typeof rng === 'function' && typeof U.randInt === 'function') {
      var v = U.randInt(rng, a, b);
      if (typeof v === 'number' && isFinite(v) && v >= a && v <= b) return v;
    }
    return a + Math.floor(rand01(rng) * (b - a + 1));
  }
  function weightedIndex(rng, weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    if (!(total > 0)) return -1;
    var r = rand01(rng) * total;
    for (i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * 按稀有度权重抽取一个候选下标（两段式）：
   *   1) 以 CFG.upgrade.rarityWeights（默认 62/30/8）在「仍有可选条目」的稀有度间加权抽档；
   *   2) 在该稀有度内等概率抽取具体条目。
   * 因此大样本下稀有度分布 ≈ 配置权重（而非被各档条目数量放大）。
   */
  function pickIndexByRarity(rng, avail) {
    var weights = rarityWeights();
    var buckets = {}, order = [], i;
    for (i = 0; i < avail.length; i++) {
      var r = avail[i].rarity;
      if (!has(buckets, r)) { buckets[r] = []; order.push(r); }
      buckets[r].push(i);
    }
    if (!order.length) return -1;
    var w = [], total = 0;
    for (i = 0; i < order.length; i++) {
      var wv = Number(weights[order[i]]);
      if (!isFinite(wv) || wv < 0) wv = 0;
      w.push(wv);
      total += wv;
    }
    if (!(total > 0)) return randInt(rng, 0, avail.length - 1);   // 权重全零 -> 等概率兜底
    var idx = weightedIndex(rng, w);
    if (idx < 0 || idx >= order.length) return randInt(rng, 0, avail.length - 1);
    var bucket = buckets[order[idx]];
    return bucket.length === 1 ? bucket[0] : bucket[randInt(rng, 0, bucket.length - 1)];
  }

  /* ==========================================================================
   * 强化池定义（14 条，id 冻结）
   *   mods    ：按等级线性叠加的 stats 键（每级增量）
   *   special ：需要立即效果 / 特殊派生逻辑的标记
   *   text(lv)：该等级的效果文案
   * ========================================================================== */
  var DEFS = [
    {
      id: 'score', name: '双倍得分', rarity: 'common', maxLevel: 3, icon: 'tile',
      tags: ['score'], mods: { scoreMul: 0.25 }, special: null,
      text: function (lv) { return '得分 +' + pct(0.25 * lv) + '（当前 ×' + fmtNum(1 + 0.25 * lv) + '）'; }
    },
    {
      id: 'mergeMaster', name: '合成大师', rarity: 'common', maxLevel: 3, icon: 'merge',
      tags: ['score', 'merge'], mods: { mergeMul: 0.30 }, special: null,
      text: function (lv) { return '合成得分 +' + pct(0.30 * lv) + '（当前 ×' + fmtNum(1 + 0.30 * lv) + '）'; }
    },
    {
      id: 'combo', name: '连击延长', rarity: 'common', maxLevel: 3, icon: 'combo',
      tags: ['score', 'combo'], mods: { comboWindow: 0.8 }, special: null,
      text: function (lv) { return '连击窗口 +' + fmtNum(0.8 * lv) + 's'; }
    },
    {
      id: 'coin', name: '金币猎人', rarity: 'common', maxLevel: 3, icon: 'coin',
      tags: ['economy'], mods: { coinMul: 0.30 }, special: 'coin',
      text: function (lv) {
        return '金币收益 +' + pct(0.30 * lv) + '（当前 ×' + fmtNum(1 + 0.30 * lv) + '），立即 +' + (5 * lv) + ' 金币';
      }
    },
    {
      id: 'magnet', name: '磁力手套', rarity: 'rare', maxLevel: 2, icon: 'magnet',
      tags: ['pickup'], mods: { magnetRange: 2.5 }, special: null,
      text: function (lv) { return '被动吸附范围 +' + fmtNum(2.5 * lv); }
    },
    {
      id: 'bounce', name: '弹跳强化', rarity: 'common', maxLevel: 3, icon: 'jump',
      tags: ['move'], mods: { jumpMul: 0.12 }, special: null,
      text: function (lv) { return '跳跃高度 ×' + fmtNum(1 + 0.12 * lv); }
    },
    {
      id: 'slidePro', name: '滑铲大师', rarity: 'common', maxLevel: 2, icon: 'slide',
      tags: ['move'], mods: { slideMul: 0.22 }, special: null,
      text: function (lv) { return '滑铲时长 ×' + fmtNum(1 + 0.22 * lv); }
    },
    {
      id: 'heart', name: '额外生命', rarity: 'rare', maxLevel: 2, icon: 'heart',
      tags: ['survive'], mods: {}, special: 'heart',
      text: function (lv) { return '生命上限 +' + lv + ' 并回满'; }
    },
    {
      id: 'shield', name: '护盾生成', rarity: 'rare', maxLevel: 2, icon: 'shield',
      tags: ['survive'], mods: {}, special: 'shield',
      text: function (lv) {
        return '立即 ' + SHIELD_PICK_SEC + 's 护盾；每 ' + (lv >= 2 ? 400 : 600) + 'm 生成 ' + SHIELD_SEC + 's 护盾';
      }
    },
    {
      id: 'invuln', name: '无敌延长', rarity: 'common', maxLevel: 2, icon: 'invuln',
      tags: ['survive'], mods: { invulnBonus: 0.6 }, special: null,
      text: function (lv) { return '受击无敌 +' + fmtNum(0.6 * lv) + 's'; }
    },
    {
      id: 'powerTime', name: '道具延时', rarity: 'common', maxLevel: 2, icon: 'power',
      tags: ['powerup'], mods: { powerupMul: 0.30 }, special: null,
      text: function (lv) { return '道具时长 ×' + fmtNum(1 + 0.30 * lv); }
    },
    {
      id: 'luck', name: '幸运方块', rarity: 'rare', maxLevel: 2, icon: 'luck',
      tags: ['pickup', 'luck'], mods: { luckChance: 0.12 }, special: null,
      text: function (lv) { return '幸运方块概率 +' + pct(0.12 * lv); }
    },
    {
      id: 'revive', name: '二次机会', rarity: 'epic', maxLevel: 1, icon: 'revive',
      tags: ['survive', 'epic'], mods: {}, special: 'revive',
      text: function () {
        return '死亡后复活 1 心 + ' + fmtNum(cfgNum(CFG.run, 'reviveInvuln', 3.0)) + 's 无敌';
      }
    },
    {
      id: 'cleanse', name: '净化冲刺', rarity: 'epic', maxLevel: 1, icon: 'cleanse',
      tags: ['survive', 'move', 'epic'], mods: {}, special: 'cleanse',
      text: function () { return '每 ' + CLEANSE_EVERY + 'm 净化冲刺（' + fmtNum(CLEANSE_INVULN) + 's 无敌）'; }
    }
  ];

  var BY_ID = {};
  (function () {
    for (var i = 0; i < DEFS.length; i++) BY_ID[DEFS[i].id] = DEFS[i];
  })();

  /** 公开池：只暴露冻结字段（机制细节留在 DEFS 内） */
  var POOL = (function () {
    var out = [], i, d;
    for (i = 0; i < DEFS.length; i++) {
      d = DEFS[i];
      out.push({
        id: d.id,
        name: d.name,
        rarity: d.rarity,
        maxLevel: d.maxLevel,
        icon: d.icon,
        tags: d.tags.slice(),
        desc: makeDescFn(d)
      });
    }
    return out;
  })();

  function makeDescFn(d) {
    return function (level) {
      return d.text(clampLevel(level, d.maxLevel));
    };
  }
  function clampLevel(level, maxLevel) {
    var lv = numLevel(level);
    if (lv <= 0) lv = 1;                       // 非法/0 级 -> 1 级预览
    if (lv > maxLevel) lv = maxLevel;
    return lv;
  }
  function defById(id) {
    if (typeof id !== 'string' || !id) return null;
    return has(BY_ID, id) ? BY_ID[id] : null;
  }

  /* ==========================================================================
   * roll：三选一候选
   * @param {function} [rng]   随机源（默认 run.rng，其次 Math.random）
   * @param {object}   [run]   局内状态（读取 run.upgrades / run.rng）
   * @param {number}   [count] 候选数量（默认 CFG.upgrade.choices）
   * @returns {Array<{id,name,desc,rarity,icon,level,nextLevel,maxLevel}>}
   * ========================================================================== */
  function roll(rng, run, count) {
    var out = [];
    var n = (typeof count === 'number' && isFinite(count)) ? Math.floor(count) : choicesCount();
    if (!(n > 0)) return out;
    if (n > MAX_ROLL) n = MAX_ROLL;

    var r = (typeof rng === 'function') ? rng
      : (run && typeof run === 'object' && typeof run.rng === 'function') ? run.rng
        : null;

    var levels = (run && typeof run === 'object' && run.upgrades &&
      typeof run.upgrades === 'object' && !Array.isArray(run.upgrades)) ? run.upgrades : {};

    /* 1) 可选池：跳过已满级 */
    var avail = [], i;
    for (i = 0; i < DEFS.length; i++) {
      if (numLevel(levels[DEFS[i].id]) < DEFS[i].maxLevel) avail.push(DEFS[i]);
    }

    /* 2) 稀有度加权（先抽档、再档内等概率）、不放回抽取 */
    var picked = [];
    while (picked.length < n && avail.length > 0) {
      var idx = pickIndexByRarity(r, avail);
      if (idx < 0 || idx >= avail.length) idx = randInt(r, 0, avail.length - 1);
      picked.push(avail.splice(idx, 1)[0]);
    }

    /* 3) 组装候选（desc 描述「拿到之后」的等级） */
    for (i = 0; i < picked.length; i++) {
      var d = picked[i];
      var cur = numLevel(levels[d.id]);
      out.push({
        id: d.id,
        name: d.name,
        desc: describe(d.id, cur + 1),
        rarity: d.rarity,
        icon: d.icon,
        level: cur,
        nextLevel: cur + 1,
        maxLevel: d.maxLevel
      });
    }

    /* 4) 池尽：用 filler 补足（可无限叠加） */
    var fid = fillerId();
    var fcur = numLevel(levels[fid]);
    while (out.length < n) {
      out.push(makeFiller(fid, fcur));
      fcur += 1;
    }
    return out;
  }

  function makeFiller(fid, level) {
    var lv = numLevel(level);
    return {
      id: fid,
      name: '金币袋',
      desc: '立即 +' + FILLER_COINS + ' 金币',
      rarity: 'common',
      icon: 'coin',
      level: lv,
      nextLevel: lv + 1,
      maxLevel: FILLER_MAX_LEVEL
    };
  }

  /* ==========================================================================
   * apply：等级 +1 并结算立即效果
   * @returns {{id:string|null, level:number, effects:object}}
   * ========================================================================== */
  function apply(run, id) {
    var res = { id: safeId(id), level: 0, effects: {} };
    if (!run || typeof run !== 'object') return res;
    if (typeof id !== 'string' || !id) return res;

    var def = defById(id);
    var fid = fillerId();
    var isFiller = !def && id === fid;
    if (!def && !isFiller) return res;

    var levels = ensureUpgrades(run);
    var cur = numLevel(levels[id]);
    var maxLevel = def ? def.maxLevel : FILLER_MAX_LEVEL;
    if (cur >= maxLevel) { res.level = maxLevel; return res; }   // 已满级：不提升、无效果

    var lv = cur + 1;
    levels[id] = lv;
    res.level = lv;
    var eff = res.effects, k;

    /* 0) 保底强化（金币袋）：立即金币 */
    if (!def) {
      run.coins = numOr(run.coins, 0) + FILLER_COINS;
      eff.coins = FILLER_COINS;
      return res;
    }

    /* 1) 被动数值（每级线性叠加，供 run 侧读取） */
    for (k in def.mods) {
      if (!has(def.mods, k)) continue;
      eff[k] = round6(def.mods[k] * lv);
    }

    /* 2) 立即效果 */
    switch (def.special) {
      case 'heart': {
        var maxH = numOr(run.maxHearts, baseHearts()) + 1;
        run.maxHearts = maxH;
        run.hearts = maxH;              // 回满
        eff.maxHearts = maxH;
        eff.hearts = maxH;
        eff.heal = true;
        break;
      }
      case 'shield': {
        var st = stats(run);
        run.shieldAt = numOr(run.distance, 0) + st.shieldEvery;
        eff.shieldSec = SHIELD_PICK_SEC;      // 拾取立即获得 10s 护盾
        eff.shieldEvery = st.shieldEvery;     // 之后每 600m / 400m 生成一次
        eff.shieldAt = run.shieldAt;
        break;
      }
      case 'coin': {
        var gain = 5 * lv;                    // 立即 +5×等级 金币
        run.coins = numOr(run.coins, 0) + gain;
        eff.coins = gain;
        break;
      }
      case 'revive': {
        run.reviveLeft = 1;
        eff.revive = 1;
        eff.reviveInvuln = cfgNum(CFG.run, 'reviveInvuln', 3.0);
        break;
      }
      case 'cleanse': {
        run.cleanseAt = numOr(run.distance, 0) + CLEANSE_EVERY;
        eff.cleanseEvery = CLEANSE_EVERY;
        eff.cleanseInvuln = CLEANSE_INVULN;
        eff.cleanseAt = run.cleanseAt;
        break;
      }
      default:
        break;
    }
    return res;
  }

  function ensureUpgrades(run) {
    if (!run.upgrades || typeof run.upgrades !== 'object' || Array.isArray(run.upgrades)) {
      run.upgrades = {};
    }
    return run.upgrades;
  }

  /* ==========================================================================
   * stats：等级聚合（纯函数、无副作用）
   * ========================================================================== */
  var BASE_STATS = {
    scoreMul: 1,
    mergeMul: 1,
    coinMul: 1,
    comboWindow: 0,
    magnetRange: 0,
    jumpMul: 1,
    slideMul: 1,
    powerupMul: 1,
    invulnBonus: 0,
    luckChance: 0,
    revive: 0,
    cleanseEvery: 0,
    cleanseInvuln: 0,
    shieldEvery: 0,
    shieldSec: 0
  };

  function stats(run) {
    var out = {}, k;
    for (k in BASE_STATS) {
      if (has(BASE_STATS, k)) out[k] = BASE_STATS[k];
    }
    var levels = (run && typeof run === 'object' && run.upgrades &&
      typeof run.upgrades === 'object' && !Array.isArray(run.upgrades)) ? run.upgrades : null;
    if (!levels) return out;

    for (var i = 0; i < DEFS.length; i++) {
      var d = DEFS[i];
      var lv = numLevel(levels[d.id]);
      if (lv <= 0) continue;
      if (lv > d.maxLevel) lv = d.maxLevel;

      for (k in d.mods) {
        if (!has(d.mods, k)) continue;
        out[k] = round6(out[k] + d.mods[k] * lv);
      }
      if (d.special === 'shield') {
        out.shieldEvery = lv >= 2 ? 400 : 600;   // 600m -> 400m
        out.shieldSec = SHIELD_SEC;
      } else if (d.special === 'revive') {
        out.revive = 1;
      } else if (d.special === 'cleanse') {
        out.cleanseEvery = CLEANSE_EVERY;
        out.cleanseInvuln = CLEANSE_INVULN;
      }
    }

    var lm = luckMax();
    if (out.luckChance > lm) out.luckChance = lm;   // 幸运加成上限（默认 16）
    return out;
  }

  /* ==========================================================================
   * describe / list
   * ========================================================================== */
  function describe(id, level) {
    var def = defById(id);
    if (def) return def.text(clampLevel(level, def.maxLevel));
    if (typeof id === 'string' && id && id === fillerId()) return '立即 +' + FILLER_COINS + ' 金币';
    return '';
  }

  function list(run) {
    var out = [];
    if (!run || typeof run !== 'object') return out;
    var levels = (run.upgrades && typeof run.upgrades === 'object' && !Array.isArray(run.upgrades))
      ? run.upgrades : null;
    if (!levels) return out;

    for (var i = 0; i < POOL.length; i++) {
      var d = POOL[i];
      var lv = numLevel(levels[d.id]);
      if (lv <= 0) continue;
      if (lv > d.maxLevel) lv = d.maxLevel;
      out.push({
        id: d.id,
        name: d.name,
        icon: d.icon,
        level: lv,
        maxLevel: d.maxLevel,
        rarity: d.rarity,
        desc: describe(d.id, lv)
      });
    }

    /* 保底强化（若已获得且不是池内 id） */
    var fid = fillerId();
    if (!defById(fid)) {
      var flv = numLevel(levels[fid]);
      if (flv > 0) {
        out.push({
          id: fid,
          name: '金币袋',
          icon: 'coin',
          level: flv,
          maxLevel: FILLER_MAX_LEVEL,
          rarity: 'common',
          desc: '立即 +' + FILLER_COINS + ' 金币'
        });
      }
    }
    return out;
  }

  /* ---------------- 导出（冻结 API：6 个成员） ---------------- */
  core.Upgrades = {
    POOL: POOL,
    roll: roll,
    apply: apply,
    stats: stats,
    describe: describe,
    list: list
  };
})(typeof window !== 'undefined' ? window : globalThis);
