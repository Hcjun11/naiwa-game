/* ==========================================================================
 * 《奶娃》核心模拟 · 合成槽（手牌式 5 槽，非 2048 网格）
 * 负责人：core-sim（队友 A）
 *
 * 对外 API（挂载 NW.core.MergeRack，纯逻辑，无 DOM / localStorage 依赖，Node 可 require）：
 *   var rack = new NW.core.MergeRack();   // 槽位数 = CFG.merge.slots
 *   rack.reset()
 *   rack.slots                            // Array(5): null | {id:number, value:number}
 *   rack.count()                          // 已占用槽位数
 *   rack.maxValue()                       // 槽内最大数值（空槽为 0）
 *   rack.insert(value) -> { tile, slot, replaced, merges, maxValue, newMax }
 *   rack.removeRandom(rng) -> {id, value, slot} | null
 *
 * 规则（SPEC 1.2 / 3.1）：
 *   - 收集后放入最左空槽；
 *   - 自动合并 + 连锁（任意两个相同数字 → 2 倍，结果占据较左槽位）；
 *   - 槽满且无可合并时替换最小数值方块（CFG.merge.overflowPolicy === 'replace-lowest'），
 *     槽满但新方块与某槽同数时直接与之合成（不触发替换）；
 *   - 本局首次达到 ≥ 配置里程碑最小值的更高数值时返回 newMax（金币由 Run 结算）。
 *   - 方块 id 模块级全局自增、永不复用；同一次 insert 内合成结果使用新 id。
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG || (NW.CFG = {});
  var U = NW.util || (NW.util = {});
  var core = (NW.core = NW.core || {});

  /* 方块 id：模块级自增（SPEC 3.1：全局自增且不复用） */
  var nextTileId = 1;

  /* 本局新高起算值：配置表 newMaxCoins 的最小键（默认 32） */
  function milestoneMin() {
    var table = (CFG.merge && CFG.merge.newMaxCoins) || {};
    var min = Infinity;
    for (var k in table) {
      if (!Object.prototype.hasOwnProperty.call(table, k)) continue;
      var v = Number(k);
      if (isFinite(v) && v < min) min = v;
    }
    return min;
  }

  /* ------------------------------ MergeRack ------------------------------ */

  function MergeRack() {
    this.slots = [];
    this.reset();
  }

  MergeRack.prototype.reset = function () {
    var n = (CFG.merge && CFG.merge.slots) || 5;
    this.slots = new Array(n);
    for (var i = 0; i < n; i++) this.slots[i] = null;
    this._maxEver = 0;   // 本局（相对 reset 后）曾达到过的最大数值
    return this;
  };

  MergeRack.prototype.count = function () {
    var n = 0;
    for (var i = 0; i < this.slots.length; i++) if (this.slots[i]) n++;
    return n;
  };

  MergeRack.prototype.maxValue = function () {
    var max = 0;
    for (var i = 0; i < this.slots.length; i++) {
      var t = this.slots[i];
      if (t && t.value > max) max = t.value;
    }
    return max;
  };

  /**
   * 连锁合并：反复取“最左的相同数值对”，合成值占据较左槽位。
   * @param {Array} merges 输出数组（按发生顺序 push）
   */
  MergeRack.prototype._chain = function (merges) {
    var slots = this.slots, n = slots.length, changed = true, i, j, a, b;
    while (changed) {
      changed = false;
      for (i = 0; i < n && !changed; i++) {
        a = slots[i];
        if (!a) continue;
        for (j = i + 1; j < n; j++) {
          b = slots[j];
          if (!b || b.value !== a.value) continue;
          var mergedValue = a.value * 2;
          slots[i] = { id: nextTileId++, value: mergedValue };
          slots[j] = null;
          merges.push({ ids: [a.id, b.id], slot: i, from: a.value, value: mergedValue });
          changed = true;
          break;
        }
      }
    }
  };

  /**
   * 放入一个数字方块并自动合并。
   * @param {number} value 方块数值（应为正数，通常是 2 的幂）
   * @returns {{tile:{id:number,value:number}|null, slot:number,
   *            replaced:{id:number,value:number,slot:number}|null,
   *            merges:Array<{ids:number[],slot:number,from:number,value:number}>,
   *            maxValue:number, newMax:{value:number}|null}}
   */
  MergeRack.prototype.insert = function (value) {
    value = Number(value);
    var result = {
      tile: null,
      slot: -1,
      replaced: null,
      merges: [],
      maxValue: this.maxValue(),
      newMax: null
    };
    if (!isFinite(value) || value <= 0) return result;

    var slots = this.slots, n = slots.length, i;
    var tile = { id: nextTileId++, value: value };
    var slot = -1;

    /* 1) 放入最左空槽 */
    for (i = 0; i < n; i++) {
      if (!slots[i]) { slot = i; break; }
    }

    if (slot >= 0) {
      slots[slot] = tile;
    } else if (CFG.merge && CFG.merge.overflowPolicy !== 'replace-lowest') {
      /* 预留：其他溢出策略（当前 SPEC 只定义 replace-lowest） */
      slots[0] = tile;
      slot = 0;
    } else {
      /* 2) 满槽：先看能否与同数槽位直接合成（“无可合并时”才替换） */
      var match = -1;
      for (i = 0; i < n; i++) {
        if (slots[i] && slots[i].value === value) { match = i; break; }
      }
      if (match >= 0) {
        var other = slots[match];
        var matchedValue = other.value * 2;
        slots[match] = { id: nextTileId++, value: matchedValue };
        result.merges.push({ ids: [other.id, tile.id], slot: match, from: other.value, value: matchedValue });
        slot = match;
      } else {
        /* 3) 替换最小数值方块（平局取最左槽） */
        var lowSlot = 0, lowValue = Infinity;
        for (i = 0; i < n; i++) {
          if (slots[i] && slots[i].value < lowValue) {
            lowValue = slots[i].value;
            lowSlot = i;
          }
        }
        result.replaced = { id: slots[lowSlot].id, value: slots[lowSlot].value, slot: lowSlot };
        slots[lowSlot] = tile;
        slot = lowSlot;
      }
    }

    /* 4) 连锁合并 */
    this._chain(result.merges);

    result.tile = tile;
    result.slot = slot;
    result.maxValue = this.maxValue();

    /* 5) 本局新高（相对 reset 后首次达到，且不小于配置里程碑最小值） */
    if (result.maxValue > this._maxEver) {
      if (result.maxValue >= milestoneMin()) result.newMax = { value: result.maxValue };
      this._maxEver = result.maxValue;
    }
    return result;
  };

  /**
   * 随机移除一个槽内方块（受击掉落）。
   * @param {function} [rng] 随机源（默认 Math.random；Run 传入本局 rng 保证可复现）
   * @returns {{id:number, value:number, slot:number}|null}
   */
  MergeRack.prototype.removeRandom = function (rng) {
    var slots = this.slots, occupied = [], i;
    for (i = 0; i < slots.length; i++) if (slots[i]) occupied.push(i);
    if (!occupied.length) return null;
    var idx = occupied.length === 1 ? 0 : U.randInt(rng, 0, occupied.length - 1);
    var slot = occupied[idx];
    var tile = slots[slot];
    slots[slot] = null;
    return { id: tile.id, value: tile.value, slot: slot };
  };

  core.MergeRack = MergeRack;
})(typeof window !== 'undefined' ? window : globalThis);
