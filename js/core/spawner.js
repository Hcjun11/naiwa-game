/* ==========================================================================
 * 《奶娃》核心模拟 · 实体生成器（跑道行生成：障碍 / 数字方块 / 金币 / 道具）
 * 负责人：core-sim（队友 A）
 *
 * 对外 API（NW.core.Spawner；由 NW.core.Run 内部持有，测试可直接单测）：
 *   var sp = new NW.core.Spawner({ rng, mode });   // rng 必传，保证同 seed 可复现
 *   sp.reset()
 *   sp.rowGap(speed) -> number                      // 行距（米，已 clamp）
 *   sp.spawnRow(trackDistance, z, {power:boolean})  // -> {entities, powerSpawned, ordinal, trackDistance}
 *   sp.prefill(speed) -> Entity[]                   // 开局预填充（由近到远生成，rowOrdinal 即遭遇顺序）
 *   sp.rowOrdinal / sp.trail / sp.nextId
 *
 * 生成不变量（SPEC 1.3 / 3.6）：
 *   - 每行障碍 ≤ 2，且永远至少留 1 条空跑道；
 *   - 数字方块不与同行障碍同道，每行 1~2 个；
 *   - 前 CFG.spawn.graceRows 行 且 前 CFG.run.graceDistance 米只出方块不出障碍；
 *   - 金币可连续 coinTrailRows 行排成同列“金条”（coinTrailValue 价值更高）；
 *   - 道具按 Run 的 22~34s 计时请求生成，放在本行空闲跑道。
 * 纯逻辑，无 DOM 依赖；所有随机数仅来自 this.rng。
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG || (NW.CFG = {});
  var U = NW.util || (NW.util = {});
  var core = (NW.core = NW.core || {});

  /* ---------------- 可选配置读取（CFG 未提供时的 SPEC 默认值） ---------------- */
  function cfgNum(obj, key, fallback) {
    if (!obj) return fallback;
    var v = obj[key];
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }
  function tileHeight() { return cfgNum(CFG.tileSize, 'y', 0.55); }
  function obstacleSize() {
    var s = CFG.spawn && CFG.spawn.obstacleSize;
    return {
      w: cfgNum(s, 'w', 1.05),   // SPEC 3.5：障碍世界尺寸默认 w≈1.05, h≈1.3
      h: cfgNum(s, 'h', 1.3)
    };
  }
  function coinHeight() { return cfgNum(CFG.spawn, 'coinY', tileHeight()); }
  function powerHeight() { return cfgNum(CFG.spawn, 'powerY', tileHeight() + 0.3); }

  /* ---------------- 实体工厂 ---------------- */
  function makeTile(self, lane, z, value) {
    return {
      id: self._newId(), kind: 'tile', lane: lane,
      x: CFG.laneX(lane), y: tileHeight(), z: z,
      value: value, power: null, variant: 0
    };
  }
  function makeObstacle(self, lane, z, variant) {
    var size = obstacleSize();
    return {
      id: self._newId(), kind: 'obstacle', lane: lane,
      x: CFG.laneX(lane), y: 0, z: z,
      value: 0, power: null, variant: variant, w: size.w, h: size.h
    };
  }
  function makeCoin(self, lane, z, value) {
    return {
      id: self._newId(), kind: 'coin', lane: lane,
      x: CFG.laneX(lane), y: coinHeight(), z: z,
      value: value, power: null, variant: 0
    };
  }
  function makePower(self, lane, z, power) {
    return {
      id: self._newId(), kind: 'power', lane: lane,
      x: CFG.laneX(lane), y: powerHeight(), z: z,
      value: 0, power: power, variant: 0
    };
  }
  function rangeLanes(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(i);
    return out;
  }

  /* ---------------- Spawner ---------------- */

  /**
   * @param {{rng?:function, mode?:object}} [opts]
   */
  function Spawner(opts) {
    opts = opts || {};
    this.rng = opts.rng || Math.random;
    this.mode = opts.mode || CFG.modes.endless;
    this.reset();
  }

  Spawner.prototype.reset = function () {
    this.rowOrdinal = 0;    // 已生成行数（按“被玩家遇到”的顺序递增）
    this.trail = null;      // 金条状态：{lane, rowsLeft, value} | null
    this.nextId = 1;        // 实体 id：每局（reset 后）从 1 自增，同局唯一且可复现
    return this;
  };

  Spawner.prototype._newId = function () { return this.nextId++; };

  /** 行距 = clamp(speed * rowGapTime, rowGapMin, rowGapMax) */
  Spawner.prototype.rowGap = function (speed) {
    var s = CFG.spawn;
    return U.clamp(speed * s.rowGapTime, s.rowGapMin, s.rowGapMax);
  };

  /**
   * 生成一行实体。
   * @param {number} trackDistance 该行在赛道上的里程（米，用于难度曲线与 grace 判定）
   * @param {number} z 生成时的世界 z 坐标（通常 = CFG.world.spawnZ）
   * @param {{power?:boolean}} [opts] power=true 时尝试在本行放一个道具
   * @returns {{entities:Array, powerSpawned:boolean, ordinal:number, trackDistance:number}}
   */
  Spawner.prototype.spawnRow = function (trackDistance, z, opts) {
    opts = opts || {};
    var rng = this.rng;
    var spawn = CFG.spawn;
    var n = CFG.world.lanes;
    var entities = [];
    var laneUsed = new Array(n);   // 该跑道是否已被障碍/方块/金币占用
    var laneObstacle = new Array(n);
    var i, lane;

    for (i = 0; i < n; i++) { laneUsed[i] = false; laneObstacle[i] = false; }
    this.rowOrdinal += 1;

    /* ---------- 1) 障碍 ---------- */
    var allowObstacle = this.rowOrdinal > spawn.graceRows && trackDistance >= CFG.run.graceDistance;
    if (allowObstacle) {
      var oc = spawn.obstacleChance;
      var chance = U.clamp(U.remap(trackDistance, 0, oc.rampDistance, oc.start, oc.end), oc.start, oc.end);
      if (U.chance(chance, rng)) {
        var twoChance = cfgNum(spawn, 'twoObstacleChance', 0.5);
        var count = U.chance(twoChance, rng) ? 2 : 1;
        if (count > n - 1) count = n - 1;   // 永远至少留 1 条空跑道
        var order = U.shuffle(rangeLanes(n), rng);
        for (i = 0; i < count; i++) {
          lane = order[i];
          laneUsed[lane] = true;
          laneObstacle[lane] = true;
          entities.push(makeObstacle(this, lane, z, U.randInt(rng, 0, 2)));
        }
      }
    }

    /* 空闲跑道（障碍之后必然 ≥ 1 条） */
    var freeLanes = [];
    for (i = 0; i < n; i++) if (!laneUsed[i]) freeLanes.push(i);

    /* ---------- 2) 数字方块：每行 1~2 个，不与障碍同道 ---------- */
    var tileCount = U.randInt(rng, spawn.tilesPerRow.min, spawn.tilesPerRow.max);
    if (tileCount > freeLanes.length) tileCount = freeLanes.length;
    if (tileCount < 1) tileCount = 1;
    var weights = (this.mode && this.mode.id === 'sprint') ? spawn.sprintTileWeights : spawn.tileWeights;
    var tileLanes = U.shuffle(freeLanes, rng);
    for (i = 0; i < tileCount; i++) {
      lane = tileLanes[i];
      laneUsed[lane] = true;
      entities.push(makeTile(this, lane, z, U.weightedPick(weights, rng)));
    }

    /* ---------- 3) 金币 / 金条 ---------- */
    var coinCandidates = [];
    for (i = 0; i < n; i++) if (!laneUsed[i]) coinCandidates.push(i);
    if (this.trail) {
      if (coinCandidates.indexOf(this.trail.lane) >= 0) {
        entities.push(makeCoin(this, this.trail.lane, z, this.trail.value));
        laneUsed[this.trail.lane] = true;
        this.trail.rowsLeft -= 1;
        if (this.trail.rowsLeft <= 0) this.trail = null;
      } else {
        this.trail = null;   // 金条被障碍/方块打断
      }
    } else if (coinCandidates.length && U.chance(spawn.coinTrailChance, rng)) {
      lane = coinCandidates[U.randInt(rng, 0, coinCandidates.length - 1)];
      entities.push(makeCoin(this, lane, z, spawn.coinValue));
      laneUsed[lane] = true;
      if (spawn.coinTrailRows > 1) {
        this.trail = { lane: lane, rowsLeft: spawn.coinTrailRows - 1, value: spawn.coinTrailValue };
      }
    }

    /* ---------- 4) 道具（由 Run 的 22~34s 计时到期后请求） ---------- */
    var powerSpawned = false;
    if (opts.power) {
      var powerCandidates = [];
      for (i = 0; i < n; i++) if (!laneUsed[i]) powerCandidates.push(i);
      if (powerCandidates.length) {
        lane = powerCandidates[U.randInt(rng, 0, powerCandidates.length - 1)];
        entities.push(makePower(this, lane, z, U.weightedPick(spawn.powerupWeights, rng)));
        powerSpawned = true;
      }
    }

    return {
      entities: entities,
      powerSpawned: powerSpawned,
      ordinal: this.rowOrdinal,
      trackDistance: trackDistance
    };
  };

  /**
   * 开局预填充：把视距内的行一次性铺好（由近到远生成，保证 rowOrdinal = 遭遇顺序）。
   * @param {number} speed 起始速度（决定行距）
   * @returns {Array} 实体数组（z 沿 spawnZ → 近处递减）
   */
  Spawner.prototype.prefill = function (speed) {
    var gap = this.rowGap(speed);
    var minZ = gap * cfgNum(CFG.spawn, 'prefillMinGaps', 2);
    var zs = [];
    var z;
    for (z = CFG.world.spawnZ; z >= minZ - 1e-9; z -= gap) zs.push(z);
    zs.reverse();   // 由近到远
    var out = [];
    for (var i = 0; i < zs.length; i++) {
      var res = this.spawnRow(zs[i], zs[i], { power: false });
      for (var k = 0; k < res.entities.length; k++) out.push(res.entities[k]);
    }
    return out;
  };

  core.Spawner = Spawner;
})(typeof window !== 'undefined' ? window : globalThis);
