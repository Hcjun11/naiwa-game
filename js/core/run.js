/* ==========================================================================
 * 《奶娃》核心模拟 · 单局 Run（玩家/跑道/生成/碰撞/合成/道具/计时/结算）
 * 负责人：core-sim（队友 A）
 *
 * 对外 API（NW.core.Run，纯逻辑，无 DOM / localStorage 依赖，Node 可 require）：
 *   var run = new NW.core.Run({ mode:'endless'|'sprint', seed:number, bestTile:number });
 *   run.reset()                 // 重置（替换内部 rng / 实体 / 成绩），同 seed 可复现
 *   run.input(dir)              // -1 左 / +1 右；越界忽略；缓冲到下一 update
 *   run.action('jump'|'slide')  // v0.9.2 地铁跑酷式动作：跳跃 / 滑铲；返回是否触发
 *                               // v0.9.4：空中下落/低空按跳缓冲到落地自动再跳；空中按滑 → diving 落地接滑
 *   run.update(dt)              // 秒；内部 clamp 到 ≤0.05
 *   run.view()                  // 只读快照（SPEC 3.3，渲染层/UI 唯一数据源）
 *   run.drainEvents()           // 取出上次调用后新增的事件（SPEC 3.4）
 *   run.isOver / run.overReason // bool / 'hearts'|'time'|null
 *   run.revive()                // 复活（每局 1 次，仅 hearts 结算可用），返回 bool
 *   run.forceOver(reason)       // debug：立即结算
 *   run.debugSetHearts(n)       // debug：设置心数（夹紧 [0,maxHearts]）
 *   run.debugInsertTile(value)  // debug：直接向合成槽插入数值，走正常合并/计分/事件，返回 insert 报告
 *   run.chooseUpgrade(id)       // v0.9.4：选择强化（校验 pendingUpgrade.offers）；未知 id 返回 false
 *   run.upgradeList()           // v0.9.4：已获得强化列表（NW.core.Upgrades.list；模块缺失返回 []）
 *
 * 玩法要点（SPEC 1.x / 3.x）：
 *   - 3 车道、0.13s 换道缓动、3-2-1-GO 倒计时（倒计时不移动/不生成）；
 *   - 收集数字方块自动合成、连击倍率、双倍道具、本局新高奖励金币；
 *   - 3 心、受击无敌、掉方块、0.55s 减速；护盾抵挡一次撞击；
 *   - 磁铁吸附方块/金币；冲刺 60s 计时（intro 结束后才开始）；
 *   - 受击清空 + 复活（清除前方 35m 障碍、3s 无敌）；
 *   - v0.9.2：跳跃 / 滑铲（动作不中断换道）；动作障碍 avoid='jump' 需 y≥clearY、
 *     avoid='slide' 需滑铲中才能通过，普通障碍行为不变（只能换道躲避）；
 *   - v0.9.3：滑铲中按跳跃立即取消滑铲并起跳（同帧 rolling=false、jumping=true），
 *     修复「滑铲后按跳跃需点两下」；
 *   - v0.9.4：滑铲↔跳跃无缝衔接（落地缓冲 / 空中下滑 dive）；跳跃可跳过数字（y>pickupMaxY
 *     不拾取、发 tileSkip）；接入 NW.core.Upgrades（强化倍率 / 净化冲刺 / 护盾生成 / 二次机会）。
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG || (NW.CFG = {});
  var U = NW.util || (NW.util = {});
  var core = (NW.core = NW.core || {});

  /* 道具固定顺序（view.powerups 四个键） */
  var POWER_KEYS = ['shield', 'slow', 'magnet', 'double'];

  /* v0.9.4：空中动作缓冲的"保留到落地"哨兵值（远大于任何滞空时间） */
  var HOLD_BUFFER = 5;

  /* ---------------- CFG 可选键读取（缺省用 SPEC 默认 / 内部表现常量） ---------------- */
  function cfgNum(obj, key, fallback) {
    if (!obj) return fallback;
    var v = obj[key];
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }
  function tiltAmount() { return cfgNum(CFG.run, 'tiltAmount', 0.22); }
  function inputBuffer() { return cfgNum(CFG.run, 'inputBuffer', 2); }
  function magnetPull() { return cfgNum(CFG.run, 'magnetPull', 8); }
  function reviveClearZ() { return cfgNum(CFG.run, 'reviveClearZ', 35); }

  /* 本局新高奖励金币：查表；超出配置表时按数值倍数外推（如 8192 = 4096 表值 ×2） */
  function newMaxCoinTable(value) {
    var table = (CFG.merge && CFG.merge.newMaxCoins) || {};
    if (isFinite(table[value])) return table[value];
    var bestKey = 0, bestCoins = 0;
    for (var k in table) {
      if (!Object.prototype.hasOwnProperty.call(table, k)) continue;
      var kv = Number(k);
      if (isFinite(kv) && kv <= value && kv > bestKey) { bestKey = kv; bestCoins = table[k]; }
    }
    if (!bestKey) return 0;
    return Math.round(bestCoins * (value / bestKey));
  }

  /* -------------- Roguelike 强化（v0.9.4）：Upgrades 缺失时的全 1/0 默认倍率 -------------- */
  var UP_STAT_KEYS = [
    'scoreMul', 'mergeMul', 'coinMul', 'comboWindow', 'magnetRange',
    'jumpMul', 'slideMul', 'powerupMul', 'invulnBonus', 'luckChance',
    'revive', 'cleanseEvery', 'cleanseInvuln', 'shieldEvery', 'shieldSec'
  ];
  function defaultUpStats() {
    return {
      scoreMul: 1, mergeMul: 1, coinMul: 1, comboWindow: 0, magnetRange: 0,
      jumpMul: 1, slideMul: 1, powerupMul: 1, invulnBonus: 0, luckChance: 0,
      revive: 0, cleanseEvery: 0, cleanseInvuln: 0, shieldEvery: 0, shieldSec: 0
    };
  }
  function upgradesApi() { return core.Upgrades; }

  /* ------------------------------ Run ------------------------------ */

  /**
   * @param {{mode?:string, seed?:number, bestTile?:number}} [opts]
   * seed 省略时自动生成本局随机种子（正式游玩每局不同）；显式 seed 时同 seed 可复现。
   */
  function Run(opts) {
    opts = opts || {};
    this.modeId = (opts.mode === 'sprint') ? 'sprint' : 'endless';
    var rawSeed = opts.seed;
    if (rawSeed === undefined || rawSeed === null || rawSeed === '') {
      /* 正式游玩：每局随机赛道；URL/debug 显式 seed 则保证可复现 */
      this.seed = (Math.floor(Math.random() * 4294967296) >>> 0) || 1;
    } else {
      var seed = Number(rawSeed);
      this.seed = (isFinite(seed) && seed !== 0) ? (seed >>> 0) : 1;
    }
    this.bestTile = Math.max(0, Math.floor(Number(opts.bestTile) || 0));
    this.rack = new core.MergeRack();
    this.reset();
  }

  Run.prototype.reset = function () {
    var mode = CFG.mode(this.modeId);
    this.modeId = mode.id;
    this.mode = mode;
    this.rng = U.mulberry32(this.seed);
    this.spawner = new core.Spawner({ rng: this.rng, mode: mode });

    this.rack.reset();
    this.entities = [];
    this._events = [];
    this._pending = [];

    /* 时间 / 位移 / 分数 */
    this.t = 0;              // 总时间（含倒计时）
    this.runTime = 0;        // 有效跑动时间（intro 结束起算）
    this.distance = 0;
    this.baseSpeed = mode.speed.start;
    this.speed = mode.speed.start;
    this.score = 0;          // 内部浮点；view 取整数
    this.maxTile = 0;
    this.coins = 0;          // 整数（冲刺 coinMul 已在拾取时四舍五入）
    this.bestTile = this.bestTile || 0;

    /* 心 / 连击 / 统计 */
    this.maxHearts = CFG.run.hearts;
    this.hearts = CFG.run.hearts;
    this.combo = 0;
    this.comboMult = 1;
    this.comboTimer = 0;
    this.stats = { tiles: 0, merges: 0, hits: 0 };

    /* 道具剩余秒 */
    this.powerups = { shield: 0, slow: 0, magnet: 0, double: 0 };

    /* 相位 / 结算 */
    this.phase = 'intro';
    this.introLeft = CFG.run.introTime;
    this.timeLeft = mode.duration > 0 ? mode.duration : 0;   // 仅冲刺有效
    this.isOver = false;
    this.overReason = null;
    this._revived = false;

    /* 玩家（内部字段视图不暴露；y/jumping/rolling 等为 v0.9.2 动作状态；
     * v0.9.4 新增 buffer/bufferT/diving 用于滑铲↔跳跃无缝衔接） */
    this.player = {
      lane: 1, x: 0, tilt: 0, invuln: 0, hurt: 0, moving: 0,
      y: 0, vy: 0, jumping: false, jumpT: 0,
      rolling: false, rollT: 0,
      buffer: null, bufferT: 0, diving: false,
      switching: false, switchT: 0, fromX: 0, toX: 0, dir: 0
    };

    /* Roguelike 强化（v0.9.4；Upgrades 缺失时以下字段保持默认、玩法不受影响） */
    this.upgrades = {};
    this.upgradeQueue = [];
    this.pendingUpgrade = null;
    this._tiersSeen = {};
    this.reviveLeft = 0;
    this.cleanseAt = Infinity;
    this.shieldAt = Infinity;
    this.upStats = defaultUpStats();

    /* 生成器节奏 */
    this._spawnAcc = 0;
    this._nextRowGap = this.spawner.rowGap(this.speed);
    this._nextPowerAt = Infinity;
    this._hurtSlowTimer = 0;
    this._refreshUpStats();
    return this;
  };

  /* ------------------------------ 输入 ------------------------------ */

  /**
   * 请求换道。缓冲到下一 update 生效（同一 update 最多消费 1 个方向）。
   * @param {number} dir -1 左 / +1 右
   */
  Run.prototype.input = function (dir) {
    if (this.isOver || this.phase !== 'run') return;
    if (dir !== -1 && dir !== 1) return;      // 非法方向忽略
    var target = this.player.lane;
    for (var i = 0; i < this._pending.length; i++) target += this._pending[i];
    target += dir;
    if (target < 0 || target >= CFG.world.lanes) return;   // 越界忽略
    var cap = inputBuffer();
    if (this._pending.length >= cap) this._pending.shift(); // 缓冲上限：丢最旧
    this._pending.push(dir);
  };

  /**
   * 地铁跑酷式动作（SPEC v0.9.2 §2.1 + v0.9.3 修复 + v0.9.4 无缝衔接）：
   * - 'jump'  跳跃：
   *     · 地面：若正在滑铲 → 同帧取消滑铲并起跳（v0.9.3，不需点两下）；否则正常起跳；
   *     · 空中：正在下落（vy<=0）或低空（y<=clearY*1.2）→ 缓冲下一跳，落地瞬间自动再起跳；
   *       下落期按下的缓冲保留到落地（v0.9.4 手感：无缝连跳），上升期按下只保留 bufferTime 窗口；
   *       否则忽略；
   * - 'slide' 滑铲：
   *     · 地面且未滑铲：开始滑铲，时长 = duration × upStats.slideMul；
   *     · 空中：diving=true、vy=min(vy,-diveSpeed)，缓冲落地立即滑铲；返回 true；
   *     · 滑铲中：忽略。
   * 动作不中断换道（动作期间仍可 input，跳跃/滑铲中也可换道）。
   * @param {'jump'|'slide'} kind
   * @returns {boolean} 是否真正触发（含缓冲成功）
   */
  Run.prototype.action = function (kind) {
    if (this.isOver || this.phase !== 'run') return false;
    if (kind !== 'jump' && kind !== 'slide') return false;
    var p = this.player;
    var J = CFG.run.jump;
    var S = CFG.run.slide;

    if (kind === 'jump') {
      if (!J) return false;
      if (p.jumping || p.y > 1e-9) {
        /* 空中：下落中或低空时缓冲下一跳，落地自动衔接。
         * v0.9.4 手感：下落期按下 → 缓冲保留到落地（不因窗口过期而丢失，做到无缝连跳）；
         * 上升期按下 → 仅保留 bufferTime 窗口（避免过早输入变成"自动跳"）。 */
        if (p.vy <= 0 || p.y <= J.clearY * 1.2) {
          p.buffer = 'jump';
          p.bufferT = (p.vy <= 0) ? HOLD_BUFFER : cfgNum(J, 'bufferTime', 0.2);
          return true;
        }
        return false;
      }
      if (p.rolling) {                    // v0.9.3：滑铲中跳跃 → 立即取消滑铲并起跳
        p.rolling = false;
        p.rollT = 0;
      }
      this._startJump();
      return true;
    }

    if (!S) return false;
    if (p.rolling) return false;          // 滑铲中重复滑铲忽略
    if (p.jumping || p.y > 1e-9) {        // v0.9.4：空中下滑 → 加速下坠 + 落地立即滑铲
      p.diving = true;
      p.vy = Math.min(p.vy, -cfgNum(S, 'diveSpeed', 9.5));
      p.buffer = 'slide';
      p.bufferT = HOLD_BUFFER;            // 下坠很快落地，缓冲保留到落地即滑铲
      return true;
    }
    this._startSlide();
    return true;
  };

  /** 起跳（v0.9.4：初速 = CFG.run.jump.velocity × upStats.jumpMul；clearY 判定不变） */
  Run.prototype._startJump = function () {
    var p = this.player, J = CFG.run.jump;
    var mul = (this.upStats && isFinite(this.upStats.jumpMul) && this.upStats.jumpMul > 0) ? this.upStats.jumpMul : 1;
    p.jumping = true;
    p.diving = false;
    p.y = 0;
    p.vy = J.velocity * mul;
    p.jumpT = 0;
    p.buffer = null;
    p.bufferT = 0;
  };

  /** 开始滑铲（v0.9.4：时长 = CFG.run.slide.duration × upStats.slideMul） */
  Run.prototype._startSlide = function () {
    var p = this.player, S = CFG.run.slide;
    var mul = (this.upStats && isFinite(this.upStats.slideMul) && this.upStats.slideMul > 0) ? this.upStats.slideMul : 1;
    p.rolling = true;
    p.rollT = S.duration * mul;
    p.buffer = null;
    p.bufferT = 0;
  };

  /** 复位全部动作状态（复活 / 二次机会 / 落地清理用） */
  Run.prototype._resetActionState = function () {
    var p = this.player;
    p.y = 0;
    p.vy = 0;
    p.jumping = false;
    p.jumpT = 0;
    p.rolling = false;
    p.rollT = 0;
    p.diving = false;
    p.buffer = null;
    p.bufferT = 0;
  };

  Run.prototype._applyPendingInput = function () {
    if (!this._pending.length) return;
    var dir = this._pending.shift();
    var p = this.player;
    var lane = p.lane + dir;
    if (lane < 0 || lane >= CFG.world.lanes) return;
    p.lane = lane;
    p.fromX = p.x;
    p.toX = CFG.laneX(lane);
    p.switchT = 0;
    p.switching = true;
    p.dir = dir;
    p.moving = dir;
  };

  Run.prototype._updatePlayer = function (dt) {
    var p = this.player;
    var J = CFG.run.jump;

    /* 输入缓冲倒计时（v0.9.4）：bufferT 归零即清缓冲 */
    if (p.buffer) {
      p.bufferT -= dt;
      if (p.bufferT <= 0) {
        p.bufferT = 0;
        p.buffer = null;
      }
    }

    /* 跳跃物理（SPEC v0.9.2 §2.2）：y += v*dt; v -= g*dt；落地 clamp 0 */
    if (p.jumping) {
      var mul = (this.upStats && isFinite(this.upStats.jumpMul) && this.upStats.jumpMul > 0) ? this.upStats.jumpMul : 1;
      var airTime = (2 * J.velocity * mul) / J.gravity;   // jumpT 进度基准（受弹跳强化影响）
      if (!(airTime > 0)) airTime = dt;
      p.y += p.vy * dt;
      p.vy -= J.gravity * dt;
      p.jumpT = Math.min(1, p.jumpT + dt / airTime);
      if (p.y <= 0 && p.vy < 0) {           // 落地：clamp 0，并消费缓冲衔接下一动作
        p.y = 0;
        p.vy = 0;
        p.jumping = false;
        p.jumpT = 0;
        p.diving = false;
        var buffered = p.buffer;
        p.buffer = null;
        p.bufferT = 0;
        if (buffered === 'jump') this._startJump();        // 落地瞬间自动衔接下一跳
        else if (buffered === 'slide') this._startSlide(); // 落地立即滑铲
      }
    }

    /* 滑铲计时（SPEC v0.9.2 §2.2）：rollT 归零即恢复 */
    if (p.rolling) {
      p.rollT -= dt;
      if (p.rollT <= 0) {
        p.rollT = 0;
        p.rolling = false;
      }
    }

    if (p.switching) {
      p.switchT += dt;
      var k = p.switchT / CFG.run.laneSwitch;
      if (k > 1) k = 1;
      var e = U.easeOutCubic(k);
      p.x = p.fromX + (p.toX - p.fromX) * e;
      p.tilt = -p.dir * tiltAmount() * Math.sin(Math.PI * k);   // 中段最大，到站归零
      if (k >= 1) {
        p.switching = false;
        p.x = p.toX;
        p.tilt = 0;
        p.moving = 0;
      }
    }
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    if (p.hurt > 0) p.hurt = Math.max(0, p.hurt - dt);
  };

  /* --------------------------- 道具计时 / 连击 --------------------------- */

  Run.prototype._updateTimers = function (dt) {
    for (var i = 0; i < POWER_KEYS.length; i++) {
      var key = POWER_KEYS[i];
      if (this.powerups[key] <= 0) continue;
      this.powerups[key] -= dt;
      if (this.powerups[key] <= 0) {
        this.powerups[key] = 0;
        this._emit({ t: 'powerupEnd', power: key });
      }
    }
    if (this._hurtSlowTimer > 0) this._hurtSlowTimer = Math.max(0, this._hurtSlowTimer - dt);
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.comboTimer = 0;
        this.combo = 0;
        this.comboMult = 1;
      }
    }
  };

  Run.prototype._computeSpeed = function (dt) {
    var sp = this.mode.speed;
    this.baseSpeed = Math.min(sp.max, this.baseSpeed + sp.accel * dt);
    var mul = 1;
    if (this.powerups.slow > 0) mul *= CFG.powerups.slow.factor;
    if (this._hurtSlowTimer > 0) mul *= CFG.run.hurtSlowMul;
    this.speed = this.baseSpeed * mul;
    return this.speed;
  };

  /* ------------------------------ 主循环 ------------------------------ */

  Run.prototype.update = function (dt) {
    dt = Number(dt);
    if (!isFinite(dt) || dt <= 0) return;
    if (dt > 0.05) dt = 0.05;        // SPEC 3.2：内部 clamp 0.05
    if (this.isOver) return;

    this.t += dt;

    /* --- 倒计时：不移动、不生成 --- */
    if (this.phase === 'intro') {
      this.introLeft -= dt;
      if (this.introLeft <= 0) {
        this.introLeft = 0;
        this.phase = 'run';
        this._beginRun();
        this._emit({ t: 'introEnd' });
      }
      return;
    }

    /* --- 跑动 --- */
    this.runTime += dt;
    this._refreshUpStats();            // v0.9.4：每帧刷新强化派生的 upStats
    this._updateTimers(dt);
    this._applyPendingInput();
    this._updatePlayer(dt);

    var moved = this._computeSpeed(dt) * dt;
    this.distance += moved;
    this.score += moved * CFG.run.distanceScore * this.mode.scoreMul * this.upStats.scoreMul;

    this._updateEntities(dt, moved);
    if (this.isOver) return;

    this._updateUpgradeTriggers();     // v0.9.4：净化冲刺 / 护盾生成
    this._updateSpawner(moved);

    /* --- 冲刺限时 --- */
    if (this.mode.duration > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this._gameOver('time');
      }
    }
  };

  /** intro 结束的瞬间：预填充视距内的行，启动道具计时 */
  Run.prototype._beginRun = function () {
    var ents = this.spawner.prefill(this.speed);
    for (var i = 0; i < ents.length; i++) this.entities.push(ents[i]);
    this._spawnAcc = 0;
    this._nextRowGap = this.spawner.rowGap(this.speed);
    this._nextPowerAt = this.runTime + U.rand(this.rng, CFG.spawn.powerupInterval.min, CFG.spawn.powerupInterval.max);
  };

  /** 距离驱动的行生成（行距随速度 clamp） */
  Run.prototype._updateSpawner = function (moved) {
    this._spawnAcc += moved;
    var guard = 0;
    while (this._spawnAcc >= this._nextRowGap && guard < 8) {
      guard += 1;
      this._spawnAcc -= this._nextRowGap;
      var powerDue = this.runTime >= this._nextPowerAt;
      var res = this.spawner.spawnRow(this.distance + CFG.world.spawnZ, CFG.world.spawnZ, {
        power: powerDue,
        luck: this.upStats.luckChance          // v0.9.4：幸运方块（spawner 内概率翻倍，上限 16）
      });
      for (var i = 0; i < res.entities.length; i++) this.entities.push(res.entities[i]);
      if (res.powerSpawned) {
        this._nextPowerAt = this.runTime + U.rand(this.rng, CFG.spawn.powerupInterval.min, CFG.spawn.powerupInterval.max);
      }
      this._nextRowGap = this.spawner.rowGap(this.speed);
    }
    if (guard >= 8) this._spawnAcc = 0;   // 保险：异常 dt 下不补帧爆发
  };

  /* ---------------------- Roguelike 强化系统（v0.9.4） ---------------------- */

  /**
   * 刷新本帧强化派生数值（Upgrades 缺失/异常时回退全 1/0 默认值，保证降级可跑）。
   */
  Run.prototype._refreshUpStats = function () {
    var out = defaultUpStats();
    var up = upgradesApi();
    if (up && typeof up.stats === 'function') {
      var got = null;
      try { got = up.stats(this); } catch (e) { got = null; }
      if (got && typeof got === 'object') {
        for (var i = 0; i < UP_STAT_KEYS.length; i++) {
          var k = UP_STAT_KEYS[i];
          var v = got[k];
          if (typeof v === 'number' && isFinite(v)) out[k] = v;
        }
      }
    }
    this.upStats = out;
    return out;
  };

  Run.prototype._hasUpgradeSystem = function () {
    var up = upgradesApi();
    return !!(up && typeof up.roll === 'function' && typeof up.apply === 'function');
  };

  /**
   * 合成出新数字（≥ CFG.upgrade.minValue 且本局未见过该档）→ 入强化队列。
   */
  Run.prototype._queueUpgradeTier = function (value) {
    if (!isFinite(value)) return;
    var minValue = cfgNum(CFG.upgrade, 'minValue', 8);
    if (value < minValue) return;
    if (this._tiersSeen[value]) return;
    if (!this._hasUpgradeSystem()) return;   // 降级：无强化引擎时不入队
    this._tiersSeen[value] = true;
    this.upgradeQueue.push({ value: value });
  };

  /** 无 pendingUpgrade 时取出队首 → 生成三选一候选并发 upgradeOffer 事件 */
  Run.prototype._pumpUpgradeQueue = function () {
    if (this.pendingUpgrade || !this.upgradeQueue.length) return false;
    var up = upgradesApi();
    if (!up || typeof up.roll !== 'function') {   // 降级：无强化引擎则清空队列
      this.upgradeQueue.length = 0;
      return false;
    }
    var count = cfgNum(CFG.upgrade, 'choices', 3);
    while (!this.pendingUpgrade && this.upgradeQueue.length) {
      var item = this.upgradeQueue.shift();
      var offers = [];
      try { offers = up.roll(this.rng, this, count) || []; } catch (e) { offers = []; }
      if (!Array.isArray(offers) || !offers.length) continue;   // roll 异常/空 → 跳过该档
      this.pendingUpgrade = { value: item.value, offers: offers };
      this._emit({ t: 'upgradeOffer', value: item.value, offers: offers });
      return true;
    }
    return false;
  };

  /**
   * 选择强化：校验 id 属于当前 pendingUpgrade.offers；Upgrades.apply 结算立即效果，
   * 护盾生成的立即秒数（effects.shieldSec）由 Run 侧写入 powerups（避免与 apply 双计）。
   * @param {string} id
   * @returns {boolean} 是否成功
   */
  Run.prototype.chooseUpgrade = function (id) {
    var pu = this.pendingUpgrade;
    if (!pu) return false;
    var offers = pu.offers || [];
    var found = null;
    for (var i = 0; i < offers.length; i++) {
      if (offers[i] && offers[i].id === id) { found = offers[i]; break; }
    }
    if (!found) return false;                    // 未知/非法 id：状态不变
    var up = upgradesApi();
    if (!up || typeof up.apply !== 'function') return false;
    var res = null;
    try { res = up.apply(this, id); } catch (e) { res = null; }
    if (!res || !res.level) return false;        // 满级/失败：状态不变

    var eff = (res.effects && typeof res.effects === 'object') ? res.effects : {};
    if (typeof eff.shieldSec === 'number' && isFinite(eff.shieldSec) && eff.shieldSec > 0) {
      this.powerups.shield = Math.max(this.powerups.shield, eff.shieldSec);
      this._emit({ t: 'shield' });
    }
    this._refreshUpStats();

    var triggerValue = pu.value;
    this._emit({ t: 'upgradeTaken', id: id, level: res.level, value: triggerValue });
    this.pendingUpgrade = null;
    this._pumpUpgradeQueue();                    // 队列下一个或清空
    return true;
  };

  /** 已获得强化列表（Upgrades 缺失返回 []） */
  Run.prototype.upgradeList = function () {
    var up = upgradesApi();
    if (!up || typeof up.list !== 'function') return [];
    try {
      var out = up.list(this);
      return Array.isArray(out) ? out : [];
    } catch (e) {
      return [];
    }
  };

  /** 每帧强化触发：净化冲刺（清障碍+无敌）/ 护盾生成 */
  Run.prototype._updateUpgradeTriggers = function () {
    var st = this.upStats || defaultUpStats();
    var i, e, arr, w, guard;

    /* --- 净化冲刺：distance 达到 cleanseAt → 清除 z∈[0,26] 障碍 + 无敌 + cleanse 事件 --- */
    if (isFinite(this.cleanseAt) && this.distance >= this.cleanseAt) {
      guard = 0;
      while (isFinite(this.cleanseAt) && this.distance >= this.cleanseAt && guard < 8) {
        guard += 1;
        var inv = st.cleanseInvuln > 0 ? st.cleanseInvuln : cfgNum(CFG.run, 'cleanseInvuln', 1.2);
        this.player.invuln = Math.max(this.player.invuln, inv);
        arr = this.entities;
        w = 0;
        for (i = 0; i < arr.length; i++) {
          e = arr[i];
          if (e.kind === 'obstacle' && e.z >= 0 && e.z <= 26) continue;   // 净化前方障碍
          arr[w++] = e;
        }
        arr.length = w;
        this._emit({ t: 'cleanse' });
        if (!(st.cleanseEvery > 0)) { this.cleanseAt = Infinity; break; }
        this.cleanseAt += st.cleanseEvery;
      }
    }

    /* --- 护盾生成：distance 达到 shieldAt → powerups.shield 抬到 shieldSec + shield 事件 --- */
    if (isFinite(this.shieldAt) && this.distance >= this.shieldAt) {
      var sec = st.shieldSec > 0 ? st.shieldSec : cfgNum(CFG.run, 'shieldSec', 6);
      guard = 0;
      while (isFinite(this.shieldAt) && this.distance >= this.shieldAt && guard < 8) {
        guard += 1;
        this.powerups.shield = Math.max(this.powerups.shield, sec);
        this._emit({ t: 'shield' });
        if (!(st.shieldEvery > 0)) { this.shieldAt = Infinity; break; }
        this.shieldAt += st.shieldEvery;
      }
    }
  };

  /* ------------------------------ 实体更新 ------------------------------ */

  Run.prototype._updateEntities = function (dt, moved) {
    var arr = this.entities, n = arr.length, w = 0;
    var player = this.player;
    /* v0.9.4：有效吸附范围 = 磁铁道具范围（未激活为 0）+ 强化被动 magRange */
    var magnetRange = (this.powerups.magnet > 0 ? CFG.powerups.magnet.range : 0) + this.upStats.magnetRange;
    var magnetActive = magnetRange > 0;
    var collideZ = CFG.run.collideZ;
    var collideX = CFG.run.collideX;
    var cullZ = CFG.world.cullZ;
    var pull = magnetPull();
    var pickupMaxY = cfgNum(CFG.run, 'pickupMaxY', 0.3);

    for (var i = 0; i < n; i++) {
      var e = arr[i];
      e.z -= moved;

      if (e.z < cullZ) continue;   // 跑出视野：移除

      /* 磁铁：范围内方块/金币横向吸向玩家 */
      if (magnetActive && (e.kind === 'tile' || e.kind === 'coin') && e.z <= magnetRange && e.z > -1) {
        e.x = U.damp(e.x, player.x, pull, dt);
      }

      /* 碰撞窗口 */
      if (e.z < -collideZ || e.z > collideZ) { arr[w++] = e; continue; }
      if (Math.abs(e.x - player.x) > collideX) { arr[w++] = e; continue; }

      if (e.kind === 'obstacle') {
        if (player.invuln > 0) { arr[w++] = e; continue; }   // 无敌期间穿过
        if (this._passesActionObstacle(e)) continue;         // 跳过低栏 / 滑过横杆：成功通过，实体移除
        this._hitObstacle();
        if (this.isOver) {                                   // 本条碰撞导致结算：保留剩余实体后结束
          for (var j = i + 1; j < n; j++) arr[w++] = arr[j];
          break;
        }
        continue;                                            // 撞击后障碍移除
      }
      if (e.kind === 'tile') {
        /* v0.9.4：跳跃离地超过 pickupMaxY 时主动跳过数字（不拾取，实体保留，仅报一次 tileSkip） */
        if (e._skipped) { arr[w++] = e; continue; }
        if (player.y > pickupMaxY) {
          e._skipped = true;
          this._emit({ t: 'tileSkip', value: e.value, entityId: e.id });
          arr[w++] = e;
          continue;
        }
        this._collectTile(e); continue;
      }
      if (e.kind === 'coin') { this._collectCoin(e); continue; }
      if (e.kind === 'power') { this._collectPower(e); continue; }
      arr[w++] = e;                                          // 未知类型：保留
    }
    arr.length = w;
  };

  /* ------------------------------ 拾取 / 受击 ------------------------------ */

  /**
   * 动作障碍（SPEC v0.9.2 §2.3）是否被正确规避：
   * - avoid='jump'  → 当前离地高度 y >= e.clearY（默认 CFG.run.jump.clearY）；
   * - avoid='slide' → 正在滑铲（rolling）；
   * - 普通障碍（avoid 为 undefined/null）→ false，行为不变（只能换道躲避）。
   * 注意：规避成功即通过（实体移除），护盾/无敌优先于本判定，判定失败按普通撞击处理。
   */
  Run.prototype._passesActionObstacle = function (e) {
    if (e.avoid === 'jump') {
      var J = CFG.run.jump;
      var clearY = (typeof e.clearY === 'number' && isFinite(e.clearY)) ? e.clearY : (J ? J.clearY : 0);
      return this.player.y >= clearY - 1e-9;
    }
    if (e.avoid === 'slide') return this.player.rolling === true;
    return false;
  };

  /** 收集数字方块：插入合成槽并结算（正常流程） */
  Run.prototype._collectTile = function (e) {
    this.stats.tiles += 1;
    this._emit({ t: 'tileCollect', value: e.value, entityId: e.id });
    this._applyInsert(e.value);
  };

  /**
   * 把数值放入合成槽并结算合并/溢出/新高/强化触发（不产生 tileCollect 事件）。
   * @returns {object} MergeRack.insert 报告
   */
  Run.prototype._applyInsert = function (value) {
    var res = this.rack.insert(value);
    if (!res.tile) return res;

    if (res.replaced) {
      this._emit({ t: 'overflow', replacedValue: res.replaced.value, value: res.tile.value, slot: res.replaced.slot });
    }
    for (var i = 0; i < res.merges.length; i++) this._scoreMerge(res.merges[i]);
    if (res.maxValue > this.maxTile) this.maxTile = res.maxValue;

    if (res.newMax) {
      var base = newMaxCoinTable(res.newMax.value);
      var coins = Math.round(base * this.mode.coinMul);   // 冲刺金币 ×1.5 四舍五入（Lead 确认，game 层不再乘）
      this.coins += coins;
      this._emit({ t: 'newMax', value: res.newMax.value, coins: coins });
    }

    /* v0.9.4：合成出新的数字档（≥ CFG.upgrade.minValue）→ 强化三选一 */
    for (var m = 0; m < res.merges.length; m++) this._queueUpgradeTier(res.merges[m].value);
    if (res.newMax) this._queueUpgradeTier(res.newMax.value);
    this._pumpUpgradeQueue();
    return res;
  };

  Run.prototype._scoreMerge = function (m) {
    this.combo = (this.comboTimer > 0 && this.combo > 0) ? this.combo + 1 : 1;
    this.comboTimer = CFG.merge.comboWindow + (this.upStats ? this.upStats.comboWindow : 0);
    this.comboMult = Math.min(1 + CFG.merge.comboStep * (this.combo - 1), CFG.merge.comboMax);

    var dbl = this.powerups.double > 0 ? CFG.score.doubleMul : 1;
    var mergeMul = (this.upStats && isFinite(this.upStats.mergeMul)) ? this.upStats.mergeMul : 1;
    var scoreMul = (this.upStats && isFinite(this.upStats.scoreMul)) ? this.upStats.scoreMul : 1;
    var mult = this.comboMult * this.mode.scoreMul * dbl * mergeMul * scoreMul;
    var gain = m.value * CFG.merge.scorePerValue * mult;
    this.score += gain;
    this.stats.merges += 1;

    this._emit({ t: 'merge', value: m.value, ids: m.ids, slot: m.slot, score: gain, mult: mult });
    this._emit({ t: 'combo', combo: this.combo, mult: this.comboMult });
  };

  Run.prototype._collectCoin = function (e) {
    var raw = isFinite(e.value) ? e.value : CFG.spawn.coinValue;
    var coinMul = (this.upStats && isFinite(this.upStats.coinMul)) ? this.upStats.coinMul : 1;
    var scoreMul = (this.upStats && isFinite(this.upStats.scoreMul)) ? this.upStats.scoreMul : 1;
    var amount = Math.round(raw * this.mode.coinMul * coinMul);   // 冲刺 ×1.5 与金币猎人叠加后四舍五入
    this.coins += amount;
    this.score += CFG.score.coin * this.mode.scoreMul * scoreMul;
    this._emit({ t: 'coin', amount: amount, total: this.coins });
  };

  Run.prototype._collectPower = function (e) {
    var def = CFG.powerups[e.power];
    if (!def) return;
    var powerupMul = (this.upStats && isFinite(this.upStats.powerupMul) && this.upStats.powerupMul > 0) ? this.upStats.powerupMul : 1;
    var duration = def.duration * powerupMul;
    this.powerups[e.power] = duration;
    this._emit({ t: 'powerup', power: e.power, duration: duration });
  };

  /** 撞到障碍：护盾抵挡 / 扣心 + 无敌 + 掉方块 + 减速 */
  Run.prototype._hitObstacle = function () {
    var p = this.player;
    if (this.powerups.shield > 0) {
      this.powerups.shield = 0;
      this._emit({ t: 'shieldBlock' });
      return;
    }
    var invulnBonus = (this.upStats && isFinite(this.upStats.invulnBonus)) ? this.upStats.invulnBonus : 0;
    this.hearts -= 1;
    this.stats.hits += 1;
    p.invuln = CFG.run.invuln + invulnBonus;
    p.hurt = CFG.run.hurtPoseTime || 0.4;    // 受击表情只短暂播放，不再长时间闪烁
    this._hurtSlowTimer = CFG.run.hurtSlowTime;
    this._emit({ t: 'hit', heartsLeft: Math.max(0, this.hearts) });

    var dropped = this.rack.removeRandom(this.rng);
    if (dropped) this._emit({ t: 'drop', value: dropped.value, slot: dropped.slot });

    if (this.hearts <= 0) {
      this.hearts = 0;
      this._gameOver('hearts');
    }
  };

  /* ------------------------------ 结算 / 复活 ------------------------------ */

  Run.prototype._gameOver = function (reason) {
    if (this.isOver) return;
    var reasonId = reason || 'hearts';

    /* v0.9.4 二次机会：还有复活次数 → 消耗并原地复活，不结算 */
    if (this.reviveLeft > 0) {
      this.reviveLeft -= 1;
      this.isOver = false;
      this.overReason = null;
      this.phase = 'run';
      this.hearts = 1;
      this.player.invuln = CFG.run.reviveInvuln;
      this.player.hurt = 0;
      this._resetActionState();
      this._hurtSlowTimer = 0;
      this._emit({ t: 'revive' });
      return;
    }

    this.isOver = true;
    this.overReason = reasonId;
    this.phase = 'over';
    this._emit({
      t: 'gameover',
      reason: this.overReason,
      score: Math.floor(this.score),
      distance: Math.floor(this.distance),
      maxTile: this.maxTile,
      coins: Math.floor(this.coins)
    });
  };

  Run.prototype.forceOver = function (reason) {
    if (this.isOver) return;
    this._gameOver(reason || 'hearts');
  };

  /**
   * 复活（每局 1 次）：hearts=1、无敌 CFG.run.reviveInvuln、清除前方 35m 障碍。
   * 仅 hearts 结算可复活；冲刺时间到（time）不可复活。
   * @returns {boolean} 是否成功
   */
  Run.prototype.revive = function () {
    if (!this.isOver || this.overReason !== 'hearts' || this._revived) return false;
    this._revived = true;
    this.isOver = false;
    this.overReason = null;
    this.phase = 'run';
    this.hearts = 1;
    this.player.invuln = CFG.run.reviveInvuln;
    this.player.hurt = 0;
    this._resetActionState();
    this._hurtSlowTimer = 0;

    var clearZ = reviveClearZ();
    var arr = this.entities, w = 0;
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (e.kind === 'obstacle' && e.z > -1 && e.z <= clearZ) continue;
      arr[w++] = e;
    }
    arr.length = w;

    this._emit({ t: 'revive' });
    return true;
  };

  /* ------------------------------ Debug ------------------------------ */

  /** debug：设置心数（夹紧到 [0, maxHearts]，不触发结算） */
  Run.prototype.debugSetHearts = function (n) {
    n = Math.floor(Number(n));
    if (!isFinite(n)) n = this.maxHearts;
    this.hearts = U.clamp(n, 0, this.maxHearts);
    return this.hearts;
  };

  /** debug：直接向合成槽插入数值（走正常合并/计分/事件，不发 tileCollect） */
  Run.prototype.debugInsertTile = function (value) {
    return this._applyInsert(Number(value));
  };

  /* ------------------------------ 事件 / 视图 ------------------------------ */

  Run.prototype._emit = function (ev) { this._events.push(ev); };

  /** 取出上次调用后新增的事件数组 */
  Run.prototype.drainEvents = function () {
    var ev = this._events;
    this._events = [];
    return ev;
  };

  Run.prototype._viewTimeLeft = function () {
    if (!(this.mode.duration > 0)) return 0;      // 无尽模式无倒计时
    if (this.phase === 'intro') return this.mode.duration;
    return Math.max(0, this.timeLeft);
  };

  /**
   * 只读快照（SPEC 3.3）。顶层对象每帧新建；entities 返回内部数组引用（渲染同步消费）。
   * @returns {object}
   */
  Run.prototype.view = function () {
    var p = this.player, pu = this.powerups, m = this.mode, i, uk;
    var slots = this.rack.slots;
    var rack = new Array(slots.length);
    for (i = 0; i < slots.length; i++) {
      var t = slots[i];
      rack[i] = t ? { id: t.id, value: t.value } : null;
    }
    /* v0.9.4：upgrades 浅拷贝；pendingUpgrade 安全快照 */
    var upgradesView = {};
    for (uk in this.upgrades) {
      if (Object.prototype.hasOwnProperty.call(this.upgrades, uk)) upgradesView[uk] = this.upgrades[uk];
    }
    var pendingView = null;
    if (this.pendingUpgrade) {
      pendingView = {
        value: this.pendingUpgrade.value,
        offers: (this.pendingUpgrade.offers || []).slice()
      };
    }
    return {
      t: this.t,
      distance: this.distance,
      speed: this.speed,
      score: Math.floor(this.score),
      hearts: this.hearts,
      maxHearts: this.maxHearts,
      coins: this.coins,
      combo: this.combo,
      comboMult: this.comboMult,
      maxTile: this.maxTile,
      bestTile: this.bestTile,
      rack: rack,
      player: {
        lane: p.lane, x: p.x, tilt: p.tilt,
        invuln: p.invuln, hurt: p.hurt, moving: p.moving,
        y: p.y, jumping: p.jumping, rolling: p.rolling, rollT: p.rollT, jumpT: p.jumpT,
        diving: p.diving, buffered: p.buffer
      },
      powerups: {
        shield: pu.shield, slow: pu.slow, magnet: pu.magnet, double: pu.double
      },
      entities: this.entities,
      mode: {
        id: m.id,
        name: m.name,
        duration: m.duration,
        timeLeft: this._viewTimeLeft(),
        phase: this.phase,
        introLeft: this.phase === 'intro' ? this.introLeft : 0
      },
      stats: {
        tiles: this.stats.tiles,
        merges: this.stats.merges,
        hits: this.stats.hits
      },
      upgrades: upgradesView,
      pendingUpgrade: pendingView,
      introLeft: this.phase === 'intro' ? this.introLeft : 0
    };
  };

  core.Run = Run;
})(typeof window !== 'undefined' ? window : globalThis);
