/* ==========================================================================
 * 《奶娃》跑酷 × 2048 合成 —— 音频层（NW.audio）
 * 负责人：ui-shell
 * 职责：全部音效由 WebAudio 实时合成（振荡器 + 包络 + 噪声），无任何外部音频文件；
 *       菜单 / 游戏两条轻快循环 BGM（琶音 + 低音 + 打击）。
 * 对外 API（SPEC 5.3）：
 *   NW.audio.init()  unlock()  play(name, opts)  setSfx(on)  setMusic(on)
 *   startMusic(kind)  stopMusic()
 * 音效名：tap collect merge mergeBig coin powerup hit shield gameover countdown go
 *         record revive buy equip error
 * 安全策略：AudioContext 惰性创建（仅首次用户手势后）；不可用 / 被拦截 / 任何异常时静默降级，
 *           绝不抛出、绝不产生控制台错误。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = (global.NW = global.NW || {});
  var CFG = NW.CFG || {};
  var A = (NW.audio = {});

  var DOC = global.document;

  /* ---------------- 内部状态 ---------------- */
  var ctx = null;
  var master = null;
  var sfxBus = null;
  var musicBus = null;
  var sfxOn = true;
  var musicOn = true;
  var unlocked = false;
  var unsupported = false;
  var musicKind = null;       // 当前（或期望的）BGM：'menu' | 'game'
  var musicTimer = null;
  var musicStep = 0;
  var nextNoteTime = 0;
  var lastPlayAt = {};        // 同名音效节流

  var MIN_GAIN = 0.0001;

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function getAC() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function ensureCtx() {
    if (ctx || unsupported) return ctx;
    var AC = getAC();
    if (!AC) { unsupported = true; return null; }
    try {
      ctx = new AC();
      var cfgA = CFG.audio || {};
      master = ctx.createGain();
      master.gain.value = typeof cfgA.master === 'number' ? cfgA.master : 0.7;
      master.connect(ctx.destination);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = typeof cfgA.sfx === 'number' ? cfgA.sfx : 0.75;
      sfxBus.connect(master);

      musicBus = ctx.createGain();
      musicBus.gain.value = (typeof cfgA.music === 'number' ? cfgA.music : 0.28) * 0.62;
      musicBus.connect(master);
    } catch (e) {
      ctx = null;
      unsupported = true;
    }
    return ctx;
  }

  function ctxReady() {
    return !!(ctx && ctx.state === 'running');
  }

  function syncSettings() {
    safe(function () {
      if (NW.save && NW.save.snapshot) {
        var snap = NW.save.snapshot();
        var st = snap && snap.settings ? snap.settings : null;
        if (st) {
          sfxOn = st.sfx !== false;
          musicOn = st.music !== false;
        }
      }
    });
  }

  /* ======================== 合成器基础 ======================== */
  function tone(opts) {
    if (!ctxReady()) return;
    try {
      var t0 = ctx.currentTime + (opts.delay || 0);
      var dur = Math.max(0.02, opts.dur || 0.15);
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(Math.max(20, opts.freq || 440), t0);
      if (opts.slide) {
        try { osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), t0 + dur * (opts.slideTime || 1)); } catch (e) { }
      }
      if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);

      var peak = Math.max(0.0002, opts.vol === undefined ? 0.3 : opts.vol);
      var atk = Math.max(0.002, opts.attack === undefined ? 0.006 : opts.attack);
      gain.gain.setValueAtTime(MIN_GAIN, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + atk);
      gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + dur);

      var node = osc;
      if (opts.filter) {
        var flt = ctx.createBiquadFilter();
        flt.type = opts.filterType || 'lowpass';
        flt.frequency.setValueAtTime(opts.filter, t0);
        if (opts.filterTo) {
          try { flt.frequency.exponentialRampToValueAtTime(Math.max(60, opts.filterTo), t0 + dur); } catch (e) { }
        }
        flt.Q.value = opts.q || 0.8;
        node.connect(flt);
        flt.connect(gain);
      } else {
        node.connect(gain);
      }
      gain.connect(opts.bus === 'music' ? musicBus : sfxBus);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (e) { }
  }

  var noiseBuffer = null;
  function getNoiseBuffer() {
    if (noiseBuffer || !ctx) return noiseBuffer;
    try {
      var len = Math.floor(ctx.sampleRate * 0.5);
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) {
      noiseBuffer = null;
    }
    return noiseBuffer;
  }

  function noise(opts) {
    if (!ctxReady()) return;
    try {
      var buf = getNoiseBuffer();
      if (!buf) return;
      var t0 = ctx.currentTime + (opts.delay || 0);
      var dur = Math.max(0.02, opts.dur || 0.15);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      var flt = ctx.createBiquadFilter();
      flt.type = opts.type || 'lowpass';
      flt.frequency.setValueAtTime(opts.freq || 1200, t0);
      if (opts.freqTo) {
        try { flt.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freqTo), t0 + dur); } catch (e) { }
      }
      flt.Q.value = opts.q || 0.9;
      var gain = ctx.createGain();
      var peak = Math.max(0.0002, opts.vol === undefined ? 0.2 : opts.vol);
      gain.gain.setValueAtTime(peak, t0);
      gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + dur);
      src.connect(flt);
      flt.connect(gain);
      gain.connect(opts.bus === 'music' ? musicBus : sfxBus);
      src.start(t0);
      src.stop(t0 + dur + 0.03);
    } catch (e) { }
  }

  /* ======================== 音效配方 ======================== */
  var SFX = {
    tap: function () {
      tone({ freq: 760, slide: 980, dur: 0.07, type: 'sine', vol: 0.16, attack: 0.002 });
    },
    collect: function () {
      tone({ freq: 880, slide: 1220, dur: 0.1, type: 'triangle', vol: 0.2, attack: 0.002 });
      tone({ freq: 1470, dur: 0.07, type: 'sine', vol: 0.09, delay: 0.03 });
    },
    merge: function () {
      tone({ freq: 523.25, dur: 0.13, type: 'triangle', vol: 0.24 });
      tone({ freq: 783.99, dur: 0.17, type: 'triangle', vol: 0.2, delay: 0.06 });
      tone({ freq: 1046.5, dur: 0.1, type: 'sine', vol: 0.1, delay: 0.1 });
    },
    mergeBig: function () {
      var notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      for (var i = 0; i < notes.length; i++) {
        tone({ freq: notes[i], dur: 0.2, type: i < 2 ? 'triangle' : 'sawtooth', vol: 0.13, delay: i * 0.05, filter: 3200 });
      }
      noise({ dur: 0.22, vol: 0.07, freq: 5200, type: 'highpass', freqTo: 2000 });
    },
    coin: function () {
      tone({ freq: 1567.98, dur: 0.06, type: 'square', vol: 0.09 });
      tone({ freq: 2093, dur: 0.09, type: 'square', vol: 0.07, delay: 0.045 });
    },
    powerup: function () {
      tone({ freq: 300, slide: 1320, dur: 0.28, type: 'sawtooth', vol: 0.13, filter: 2400, filterTo: 5200 });
      tone({ freq: 880, slide: 1760, dur: 0.24, type: 'sine', vol: 0.1, delay: 0.08 });
    },
    hit: function () {
      noise({ dur: 0.22, vol: 0.32, freq: 900, type: 'lowpass', freqTo: 220, q: 1.2 });
      tone({ freq: 150, slide: 58, dur: 0.26, type: 'sine', vol: 0.3 });
    },
    shield: function () {
      tone({ freq: 1180, dur: 0.16, type: 'sine', vol: 0.16, attack: 0.002 });
      tone({ freq: 1760, dur: 0.3, type: 'sine', vol: 0.11, delay: 0.015 });
      noise({ dur: 0.12, vol: 0.06, freq: 6000, type: 'highpass' });
    },
    gameover: function () {
      var notes = [523.25, 466.16, 392, 261.63];
      for (var i = 0; i < notes.length; i++) {
        tone({ freq: notes[i], dur: 0.32, type: 'triangle', vol: 0.18, delay: i * 0.15 });
      }
      tone({ freq: 130.81, dur: 0.7, type: 'sine', vol: 0.12, delay: 0.3 });
    },
    countdown: function () {
      tone({ freq: 587.33, dur: 0.12, type: 'square', vol: 0.12, filter: 2600 });
    },
    go: function () {
      tone({ freq: 880, dur: 0.18, type: 'square', vol: 0.14, filter: 3600 });
      tone({ freq: 1318.5, dur: 0.3, type: 'triangle', vol: 0.16, delay: 0.05 });
    },
    record: function () {
      var notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
      for (var i = 0; i < notes.length; i++) {
        tone({ freq: notes[i], dur: 0.26, type: 'triangle', vol: 0.15, delay: i * 0.08 });
      }
      noise({ dur: 0.4, vol: 0.05, freq: 6500, type: 'highpass', delay: 0.2 });
    },
    revive: function () {
      var notes = [392, 523.25, 659.25, 783.99, 1046.5];
      for (var i = 0; i < notes.length; i++) {
        tone({ freq: notes[i], dur: 0.22, type: 'triangle', vol: 0.13, delay: i * 0.07 });
      }
      tone({ freq: 1567.98, dur: 0.5, type: 'sine', vol: 0.09, delay: 0.34 });
    },
    buy: function () {
      noise({ dur: 0.12, vol: 0.12, freq: 4200, type: 'highpass' });
      tone({ freq: 1046.5, dur: 0.1, type: 'triangle', vol: 0.16, delay: 0.05 });
      tone({ freq: 1567.98, dur: 0.16, type: 'triangle', vol: 0.13, delay: 0.13 });
    },
    equip: function () {
      tone({ freq: 659.25, dur: 0.1, type: 'triangle', vol: 0.14 });
      tone({ freq: 987.77, dur: 0.16, type: 'triangle', vol: 0.12, delay: 0.06 });
    },
    error: function () {
      tone({ freq: 196, dur: 0.13, type: 'sawtooth', vol: 0.14, filter: 1400 });
      tone({ freq: 155.56, dur: 0.2, type: 'sawtooth', vol: 0.12, delay: 0.1, filter: 1200 });
    }
  };

  var THROTTLE = {
    coin: 45,
    collect: 45,
    tap: 40
  };

  /* ======================== 对外：音效 ======================== */
  A.play = function (name, opts) {
    try {
      if (!sfxOn || unsupported) return;
      if (!ctx || ctx.state !== 'running') return;
      var fn = SFX[name];
      if (!fn) return;
      var t = (global.performance && performance.now) ? performance.now() : Date.now();
      var gap = THROTTLE[name] || 0;
      if (gap) {
        if (lastPlayAt[name] && t - lastPlayAt[name] < gap) return;
        lastPlayAt[name] = t;
      }
      opts = opts || {};
      fn(opts);
    } catch (e) { }
  };

  A.setSfx = function (on) {
    safe(function () {
      sfxOn = !!on;
      if (sfxBus && ctx) {
        try { sfxBus.gain.setTargetAtTime(sfxOn ? ((CFG.audio && CFG.audio.sfx) || 0.75) : 0, ctx.currentTime, 0.02); } catch (e) { }
      }
    });
  };

  A.setMusic = function (on) {
    safe(function () {
      musicOn = !!on;
      if (musicBus && ctx) {
        try {
          var base = (CFG.audio && CFG.audio.music) || 0.28;
          musicBus.gain.setTargetAtTime(musicOn ? base * 0.62 : 0, ctx.currentTime, 0.05);
        } catch (e) { }
      }
      if (!musicOn) {
        stopScheduler();
      } else if (musicKind) {
        startScheduler(musicKind);
      }
    });
  };

  A.init = function () {
    safe(function () {
      syncSettings();
      bindUnlock();
      if (DOC && DOC.addEventListener) {
        DOC.addEventListener('visibilitychange', function () {
          try {
            if (DOC.hidden) {
              stopScheduler();
            } else if (musicOn && musicKind) {
              startScheduler(musicKind);
            }
          } catch (e) { }
        });
      }
    });
  };

  /* ======================== 解锁（首次用户手势） ======================== */
  function doUnlock() {
    safe(function () {
      var c = ensureCtx();
      if (!c) return;
      if (c.state === 'suspended' && c.resume) {
        var p = c.resume();
        if (p && p.then) {
          p.then(function () {
            unlocked = true;
            if (musicOn && musicKind) startScheduler(musicKind);
          }).catch(function () { });
        }
      }
      if (c.state === 'running') unlocked = true;
      if (unlocked && musicOn && musicKind) startScheduler(musicKind);
    });
  }

  A.unlock = function () {
    doUnlock();
  };

  var unlockBound = false;
  function bindUnlock() {
    if (unlockBound || !DOC || !DOC.addEventListener) return;
    unlockBound = true;
    var handler = function () {
      try {
        doUnlock();
        if (unlocked) {
          ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach(function (ev) {
            DOC.removeEventListener(ev, handler, true);
          });
        }
      } catch (e) { }
    };
    ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach(function (ev) {
      DOC.addEventListener(ev, handler, true);
    });
  }

  /* ======================== BGM 调度 ======================== */
  /* 音符用相对 C4 的半音偏移；和弦进行简单而轻快 */
  var MENU_SEQ = [0, 4, 7, 11, 7, 4, 2, 4, 5, 9, 12, 16, 12, 9, 7, 9,
    0, 4, 7, 12, 7, 4, 2, 0, -3, 0, 4, 9, 7, 4, 2, 0];
  var MENU_BASS = [0, 0, -3, -3, 5, 5, -3, -3];
  var MENU_BPM = 100;

  var GAME_SEQ = [0, 7, 12, 7, 4, 9, 16, 9, 5, 12, 16, 12, 7, 14, 19, 14,
    0, 7, 12, 7, 4, 9, 16, 9, 2, 9, 14, 9, 7, 14, 19, 19];
  var GAME_BASS = [0, 0, 4, 4, 5, 5, 7, 7];
  var GAME_BPM = 132;

  function midiToFreq(semitonesFromC4) {
    return 261.63 * Math.pow(2, semitonesFromC4 / 12);
  }

  function scheduleMusicNote(freq, time, dur, type, vol, bus) {
    if (!ctxReady()) return;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, time);
      gain.gain.setValueAtTime(MIN_GAIN, time);
      gain.gain.exponentialRampToValueAtTime(vol, time + 0.02);
      gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + dur);
      osc.connect(gain);
      gain.connect(bus === 'music' ? musicBus : sfxBus);
      osc.start(time);
      osc.stop(time + dur + 0.02);
    } catch (e) { }
  }

  function scheduleMusicNoise(time, dur, vol) {
    if (!ctxReady()) return;
    try {
      var buf = getNoiseBuffer();
      if (!buf) return;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var flt = ctx.createBiquadFilter();
      flt.type = 'highpass';
      flt.frequency.value = 7000;
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, time);
      gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + dur);
      src.connect(flt); flt.connect(gain); gain.connect(musicBus);
      src.start(time);
      src.stop(time + dur + 0.02);
    } catch (e) { }
  }

  function scheduleStep(kind, step, time) {
    var isGame = kind === 'game';
    var seq = isGame ? GAME_SEQ : MENU_SEQ;
    var bpm = isGame ? GAME_BPM : MENU_BPM;
    var stepDur = 60 / bpm / 2;   // 八分音符
    var idx = step % seq.length;
    var semi = seq[idx];
    var melodyVol = isGame ? 0.055 : 0.05;
    scheduleMusicNote(midiToFreq(semi + 12), time, stepDur * 1.5, isGame ? 'triangle' : 'sine', melodyVol, 'music');
    if (isGame && step % 4 === 2) {
      scheduleMusicNote(midiToFreq(seq[idx] + 24), time, stepDur * 0.7, 'sine', 0.022, 'music');
    }
    /* 低音：每 4 步一次 */
    if (step % 4 === 0) {
      var basses = isGame ? GAME_BASS : MENU_BASS;
      var bar = Math.floor(step / 4) % basses.length;
      scheduleMusicNote(midiToFreq(basses[bar] - 12), time, stepDur * 3.6, 'sine', isGame ? 0.075 : 0.06, 'music');
    }
    /* 打击：游戏模式更明显 */
    if (isGame) {
      if (step % 4 === 2) scheduleMusicNoise(time, 0.045, 0.028);
      if (step % 8 === 6) scheduleMusicNoise(time, 0.09, 0.02);
    } else if (step % 8 === 4) {
      scheduleMusicNote(midiToFreq(seq[idx] + 24), time, stepDur, 'sine', 0.02, 'music');
    }
  }

  function schedulerLoop() {
    if (!ctxReady() || !musicOn || !musicKind) return;
    try {
      var isGame = musicKind === 'game';
      var stepDur = 60 / (isGame ? GAME_BPM : MENU_BPM) / 2;
      var horizon = ctx.currentTime + 0.22;
      var guard = 0;
      while (nextNoteTime < horizon && guard < 8) {
        scheduleStep(musicKind, musicStep, nextNoteTime);
        musicStep++;
        nextNoteTime += stepDur;
        guard++;
      }
    } catch (e) { }
  }

  function startScheduler(kind) {
    try {
      if (!ctx || !ctxReady()) return;
      if (!musicOn) return;
      if (musicTimer) return;
      if (musicKind !== kind) {
        musicKind = kind;
        musicStep = 0;
      }
      nextNoteTime = ctx.currentTime + 0.08;
      musicTimer = setInterval(schedulerLoop, 60);
    } catch (e) { }
  }

  function stopScheduler() {
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
  }

  A.startMusic = function (kind) {
    safe(function () {
      kind = kind === 'game' ? 'game' : 'menu';
      if (musicTimer && musicKind === kind) return;
      musicKind = kind;
      if (!musicOn) return;
      /* 首次用户手势前不创建 AudioContext，避免浏览器 autoplay 警告 */
      if (!unlocked) return;
      var c = ensureCtx();
      if (!c) return;
      if (c.state !== 'running') return;
      if (musicTimer) stopScheduler();
      musicKind = kind;
      musicStep = 0;
      startScheduler(kind);
    });
  };

  A.stopMusic = function () {
    safe(function () {
      musicKind = null;
      stopScheduler();
    });
  };

  /* ======================== 调试 / 状态 ======================== */
  A.isSupported = function () { return !!getAC(); };
  A.isUnlocked = function () { return !!unlocked; };
  A._debug = {
    state: function () {
      return {
        supported: !!getAC(),
        ctxState: ctx ? ctx.state : 'none',
        unlocked: unlocked,
        sfxOn: sfxOn,
        musicOn: musicOn,
        musicKind: musicKind,
        scheduled: !!musicTimer
      };
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
