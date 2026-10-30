/* ==========================================================================
 * 《奶娃》跑酷 × 2048 合成 —— 全局配置（唯一数值来源，任何模块不得硬编码数值）
 * 经典脚本：挂载到 window.NW.CFG，同时兼容 Node（globalThis.NW.CFG）
 * ========================================================================== */
(function (global) {
  'use strict';
  var NW = (global.NW = global.NW || {});
  var CFG = (NW.CFG = {});

  /* ---------- 基础信息 ---------- */
  CFG.version = '0.9.4-demo';
  CFG.title = '奶娃';
  CFG.subtitle = '跑酷 × 2048 合成';
  CFG.tagline = '轻松上手 · 策略合成 · 短局挑战';
  CFG.W = 540;      // 逻辑分辨率宽（所有绘制坐标均以 540×960 为准）
  CFG.H = 960;

  CFG.fonts = {
    ui: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
    num: '"Arial Black", "Microsoft YaHei", "PingFang SC", sans-serif'
  };

  /* ---------- 伪 3D 相机 / 投影 ----------
   * 世界坐标：x 横向（车道中心 -laneW / 0 / +laneW），y 向上（地面 y=0），z 向前（玩家在 z=0）
   * 投影公式：scale = f / (z - camZ); sx = W/2 + (x-camX)*scale; sy = horizonY + (camY-y)*scale
   */
  CFG.cam = {
    f: 820,
    camY: 2.55,
    camZ: -6.5,
    horizonY: 340,
    followX: 0.32,     // 相机横向跟随玩家车道的比例
    laneCurve: 2.2     // 车道切换时的相机侧倾（像素级，渲染层使用）
  };

  CFG.world = {
    lanes: 3,
    laneW: 1.35,
    roadHalf: 2.45,
    shoulder: 0.55,
    playerHeight: 2.05,   // 奶娃世界高度（用于投影缩放）
    spawnZ: 88,
    cullZ: -8
  };

  /* ---------- 模式 ---------- */
  CFG.modes = {
    endless: {
      id: 'endless', name: '无尽模式', short: '无尽',
      desc: '一直向前跑，能跑多远就跑多远',
      duration: 0, scoreMul: 1, coinMul: 1,
      // 速度随时间持续提升：约 60s 从 6.2 提升到满速 21.0 m/s
      speed: { start: 6.2, max: 21.0, accel: 0.24 }
    },
    sprint: {
      id: 'sprint', name: '限时冲刺', short: '冲刺',
      desc: '60 秒内冲击最高分',
      duration: 60, scoreMul: 1.5, coinMul: 1.5,
      // 冲刺模式起步更快、约 45s 达到 19.5 m/s
      speed: { start: 9.0, max: 19.5, accel: 0.22 }
    }
  };

  /* ---------- 跑酷手感 ---------- */
  CFG.run = {
    hearts: 3,
    laneSwitch: 0.13,        // 换道耗时（秒）
    invuln: 1.5,             // 受击无敌时间（无敌期间可正常换道、不再闪烁）
    hurtPoseTime: 0.4,       // 受击表情/挤压持续时间（表情结束即恢复跑步动作）
    speedMilestone: 2.0,     // 速度每提升 2 m/s 弹出一次「加速」提示
    hurtSlowMul: 0.72,       // 受击瞬间减速倍率
    hurtSlowTime: 0.55,
    /* ---- 地铁跑酷式操作：上滑跳跃 / 下滑滑铲 ---- */
    playerScale: 0.70,       // 游戏内角色渲染缩小（解决人物太大遮挡数字）
    playerOffsetY: 82,       // 角色脚底相对投影点下移（像素，贴近屏幕下方）
    playerYaw: 1.7,          // 换道倾斜 tilt → 3D 转向 yaw 的放大倍率（弧度，tilt≈0.22 → yaw≈0.37）
    jump: { velocity: 5.2, gravity: 18.0, clearY: 0.6, bufferTime: 0.20 },  // 起跳速度 / 重力 / 跨过低栏高度 / 落地前缓冲窗口（v0.9.4 无缝衔接）
    slide: { duration: 0.62, heightScale: 0.62, diveSpeed: 9.5 },           // 滑铲时长 / 压低比例 / 空中下滑的加速下坠速度（v0.9.4）
    chainBlend: 0.14,        // 滑铲 ↔ 跳跃 姿态融合时长（秒，渲染层无缝衔接用）
    pickupMaxY: 0.30,        // v0.9.4：离地高度 > 该值时跳过数字方块（跳跃可主动放弃拾取）
    introTime: 2.4,          // 开局 3-2-1-GO 倒计时时长（两种模式一致）
    graceDistance: 30,       // 前 30 米只出数字方块，不出障碍
    distanceScore: 1.0,      // 每米得分
    collideZ: 0.66,          // 碰撞 z 判定窗口
    collideX: 0.62,          // 碰撞横向判定窗口（世界单位）
    reviveInvuln: 3.0
  };

  /* ---------- 合成槽（手牌式，非网格） ---------- */
  CFG.merge = {
    slots: 5,
    scorePerValue: 10,        // 合成得分 = 合成值 * 10 * 连击倍率
    comboWindow: 3.0,         // 连击窗口（秒）
    comboStep: 0.5,           // 每层连击加成
    comboMax: 5,              // 连击倍率上限
    overflowPolicy: 'replace-lowest',   // 满槽时替换最小方块
    newMaxCoins: { 32: 5, 64: 10, 128: 20, 256: 40, 512: 80, 1024: 160, 2048: 320, 4096: 640 },
    milestoneBanner: { 32: '合成 32！', 64: '合成 64！', 128: '合成 128！', 256: '合成 256！', 512: '合成 512！', 1024: '合成 1024！', 2048: '合成 2048！' }
  };

  /* ---------- Roguelike 强化（v0.9.4）：首次合成新数字 → 三选一强化 ---------- */
  CFG.upgrade = {
    minValue: 8,             // 首次合成达到该数值起触发强化（8/16/32/64/… 每档一次）
    choices: 3,              // 每次提供的强化数量
    rarityWeights: { common: 62, rare: 30, epic: 8 },
    fillerId: 'coins'        // 可选池耗尽时的保底强化
  };

  /* ---------- 方块外观（数值 → 颜色，渲染/UI 共用） ---------- */
  CFG.tileColors = {
    2:    { a: '#FFF4C8', b: '#FFE08A', text: '#7A4E00' },
    4:    { a: '#FFE08A', b: '#FFC94D', text: '#7A4E00' },
    8:    { a: '#FFD25C', b: '#FFB020', text: '#5C3A00' },
    16:   { a: '#FFBE45', b: '#FF8F1A', text: '#4A2A00' },
    32:   { a: '#FF9C45', b: '#FF6B28', text: '#FFFFFF' },
    64:   { a: '#FF7B45', b: '#F24822', text: '#FFFFFF' },
    128:  { a: '#FF6B6B', b: '#D62E3C', text: '#FFFFFF' },
    256:  { a: '#FF76B8', b: '#C2266F', text: '#FFFFFF' },
    512:  { a: '#C77CFF', b: '#7C2FC4', text: '#FFFFFF' },
    1024: { a: '#7FA8FF', b: '#2F5FE0', text: '#FFFFFF' },
    2048: { a: '#43E3B5', b: '#0FA37A', text: '#FFFFFF' },
    4096: { a: '#FFE066', b: '#E09B00', text: '#5C3A00' },
    other: { a: '#FFFFFF', b: '#B9B9C9', text: '#333344' }
  };
  CFG.tileSize = { world: 0.95, y: 0.55 };

  /* ---------- 道具 ---------- */
  CFG.powerups = {
    order: ['shield', 'slow', 'magnet', 'double'],
    shield: { id: 'shield', name: '护盾', icon: 'shield', color: '#4FC3F7', color2: '#0277BD', duration: 30, desc: '抵挡一次撞击' },
    slow:   { id: 'slow', name: '减速', icon: 'slow', color: '#B388FF', color2: '#5E35B1', duration: 6, factor: 0.55, desc: '短时间内速度降低' },
    magnet: { id: 'magnet', name: '磁铁', icon: 'magnet', color: '#FF6B6B', color2: '#C62828', duration: 8, range: 26, desc: '自动吸取附近方块和金币' },
    double: { id: 'double', name: '双倍', icon: 'double', color: '#FFD54F', color2: '#F9A825', duration: 10, desc: '短时间内分数翻倍' }
  };

  /* ---------- 生成 / 难度曲线 ---------- */
  CFG.spawn = {
    rowGapTime: 0.92,                    // 行距 = 当前速度 * rowGapTime（秒）
    rowGapMin: 5.8,
    rowGapMax: 12.5,
    graceRows: 4,                        // 前 4 行不出障碍
    obstacleChance: { start: 0.22, end: 0.78, rampDistance: 600 },
    tilesPerRow: { min: 1, max: 2 },
    coinTrailChance: 0.22,
    coinTrailRows: 4,
    powerupInterval: { min: 19, max: 31 },   // 秒；受「只放空闲跑道」影响，实际生成间隔约 21~35s
    tileWeights: [[2, 44], [4, 28], [8, 17], [16, 8], [32, 3]],
    sprintTileWeights: [[2, 34], [4, 28], [8, 20], [16, 12], [32, 6]],
    powerupWeights: [['shield', 34], ['slow', 20], ['magnet', 26], ['double', 20]],
    coinValue: 1,
    coinTrailValue: 2,
    /* ---- 地铁跑酷式动作障碍（跳 / 滑） ---- */
    actionObstacleChance: { start: 0.16, end: 0.40, rampDistance: 900 }, // 每个障碍行额外出现动作障碍的概率
    actionObstacleWeights: [['hurdle', 55], ['bar', 45]],               // 低栏(需跳) / 横杆(需滑)
    actionObstacleGap: 14                                               // 两个动作障碍之间的最小行距（米）
  };

  /* ---------- 计分 ---------- */
  CFG.score = {
    merge: 10,        // 见 CFG.merge.scorePerValue（保持同义）
    coin: 1,
    doubleMul: 2
  };

  /* ---------- 激励广告（Demo 内为可关闭的模拟流程） ---------- */
  CFG.ads = {
    revive: { delay: 2.2, label: '模拟激励广告' },
    double: { delay: 2.2, label: '模拟激励广告' }
  };

  CFG.audio = { master: 0.7, music: 0.28, sfx: 0.75 };

  /* ---------- 奶娃外观（皮肤） ---------- */
  CFG.skins = [
    {
      id: 'classic', name: '经典奶黄', price: 0, tag: '默认',
      desc: '最经典的奶娃，暖黄软糯',
      body: '#FFC53D', bodyShade: '#F0A81F', bodyHi: '#FFE07A',
      belly: '#FFF3D1', bellyShade: '#F7E2AE',
      limb: '#6A4A32', limbShade: '#4E3523',
      mouth: '#5A2A1E', teeth: '#FFFDF5', cheek: '#FF9E7A',
      eye: '#3A2418', accent: '#FF7A45'
    },
    {
      id: 'mint', name: '薄荷奶绿', price: 400, tag: '清新',
      desc: '薄荷味的奶娃，凉凉的很提神',
      body: '#7FE3B8', bodyShade: '#4FCB97', bodyHi: '#B6F5D9',
      belly: '#EAFFF4', bellyShade: '#CFF7E6',
      limb: '#2F6B58', limbShade: '#1F4C3E',
      mouth: '#1F4C3E', teeth: '#FFFFFF', cheek: '#FFB3A7',
      eye: '#14382C', accent: '#2FA97C'
    },
    {
      id: 'sakura', name: '樱花奶粉', price: 600, tag: '甜美',
      desc: '樱花季限定的粉粉奶娃',
      body: '#FFB3CC', bodyShade: '#F27FA5', bodyHi: '#FFD6E4',
      belly: '#FFF2F7', bellyShade: '#FBDDE8',
      limb: '#7A4557', limbShade: '#59303E',
      mouth: '#5C2738', teeth: '#FFFFFF', cheek: '#FF8FA8',
      eye: '#3C1F29', accent: '#E8568C'
    },
    {
      id: 'sky', name: '夜空奶蓝', price: 800, tag: '梦幻',
      desc: '裹着星光的蓝色奶娃',
      body: '#8CB8FF', bodyShade: '#5B8FE8', bodyHi: '#BFD6FF',
      belly: '#EEF4FF', bellyShade: '#D7E4FF',
      limb: '#33456B', limbShade: '#22304F',
      mouth: '#1D2A47', teeth: '#FFFFFF', cheek: '#FFA6B8',
      eye: '#101A30', accent: '#3D6BDB'
    },
    {
      id: 'caramel', name: '焦糖奶棕', price: 1000, tag: '稀有',
      desc: '烤得刚刚好的焦糖色奶娃',
      body: '#D9A066', bodyShade: '#B97A3E', bodyHi: '#F2C68E',
      belly: '#F8EAD6', bellyShade: '#EAD3B4',
      limb: '#5A3A22', limbShade: '#3E2614',
      mouth: '#3A2414', teeth: '#FFFFFF', cheek: '#E98A6B',
      eye: '#2A190E', accent: '#A5652B'
    }
  ];

  /* ---------- 赛道主题 ---------- */
  CFG.themes = [
    {
      id: 'day', name: '晴日草原', price: 0, tag: '默认',
      desc: '蓝天白云，最适合奔跑的天气',
      skyTop: '#79C7FF', skyMid: '#BFE9FF', skyBottom: '#EAF9FF',
      sun: { color: '#FFF3B0', glow: '#FFE066', x: 0.78, y: 0.16, r: 46 },
      cloud: '#FFFFFF',
      groundFar: '#A6E06B', groundNear: '#79C94F',
      roadLight: '#F7C97F', roadDark: '#EFB35E',
      laneLine: '#FFF6E0', edge: '#E39A4A',
      fog: '#EAF9FF',
      props: 'tree',
      prop: { trunk: '#9A6234', leaf: '#5FBF52', leaf2: '#7ED968', accent: '#FFE066' },
      ambient: 'day', star: false
    },
    {
      id: 'sunset', name: '黄昏海滩', price: 600, tag: '氛围',
      desc: '落日、海风和脚印',
      skyTop: '#FF9A62', skyMid: '#FFC98A', skyBottom: '#FFE9C2',
      sun: { color: '#FFE0A0', glow: '#FFB45E', x: 0.74, y: 0.22, r: 62 },
      cloud: '#FFE9D6',
      groundFar: '#F2D9A8', groundNear: '#E8C58C',
      roadLight: '#F5E3C0', roadDark: '#EACB9B',
      laneLine: '#FFF8EA', edge: '#D9A566',
      fog: '#FFE9C2',
      props: 'palm',
      prop: { trunk: '#B97A3E', leaf: '#5FBF52', leaf2: '#8FCF5E', accent: '#FF8A5C' },
      ambient: 'sunset', star: false
    },
    {
      id: 'night', name: '夜空星河', price: 900, tag: '梦幻',
      desc: '在星河下奔跑的奶娃',
      skyTop: '#101A3E', skyMid: '#26306B', skyBottom: '#4A3C8C',
      sun: { color: '#FFF7D6', glow: '#C9D6FF', x: 0.72, y: 0.14, r: 34 },
      cloud: '#3B3F7A',
      groundFar: '#2E2A5A', groundNear: '#221E46',
      roadLight: '#5B4A8A', roadDark: '#4A3A75',
      laneLine: '#9C8CE8', edge: '#7C6BC4',
      fog: '#4A3C8C',
      props: 'crystal',
      prop: { trunk: '#3A3566', leaf: '#8F7BFF', leaf2: '#B7A9FF', accent: '#7EF0E0' },
      ambient: 'night', star: true
    },
    {
      id: 'candy', name: '糖果乐园', price: 1200, tag: '缤纷',
      desc: '连路都是草莓味的',
      skyTop: '#FFC1E3', skyMid: '#FFD9EC', skyBottom: '#FFF2FA',
      sun: { color: '#FFF0A8', glow: '#FFD1EC', x: 0.24, y: 0.15, r: 44 },
      cloud: '#FFFFFF',
      groundFar: '#FFD1EC', groundNear: '#FFB7D8',
      roadLight: '#FFF0F8', roadDark: '#FFDCF0',
      laneLine: '#FFFFFF', edge: '#FF8DC7',
      fog: '#FFF2FA',
      props: 'lolli',
      prop: { trunk: '#FFFFFF', leaf: '#FF6FAB', leaf2: '#FFB3D6', accent: '#7EE8FF' },
      ambient: 'candy', star: false
    }
  ];

  CFG.save = { key: 'naiwa_save_v1' };

  /* ---------- 在线排行榜（ntfy.sh 公共 topic 作为无账号轻量后端） ----------
   * 说明：ntfy.sh 公共服务器的 topic 消息缓存约 12 小时，客户端轮询聚合最近的成绩，
   * 实现「打开排行榜即实时更新」；断网 / 服务不可用时自动回退到本地榜单。
   * 只公开昵称与分数，不包含任何账号或设备信息。
   */
  CFG.online = {
    enabled: true,
    server: 'https://ntfy.sh',
    topic: 'naiwa-runner-online-7f3d2c',
    since: '12h',
    pollMs: 8000,        // 排行榜打开时轮询间隔
    timeoutMs: 6000,
    maxRows: 10,
    maxScore: 300000,    // 防脏数据：超过此分数的在线记录忽略
    submitCooldownMs: 6000
  };

  CFG.refs = {
    dir: 'assets/',
    keyart: 'assets/keyart.png',
    icon: 'assets/icon.png',
    refs: [
      'assets/refs/ref_laugh.png',
      'assets/refs/ref_laugh2.png',
      'assets/refs/ref_idle.png'
    ]
  };

  /* ---------- 便捷查询 ---------- */
  CFG.tileColor = function (value) {
    return CFG.tileColors[value] || CFG.tileColors.other;
  };
  CFG.skin = function (id) {
    for (var i = 0; i < CFG.skins.length; i++) if (CFG.skins[i].id === id) return CFG.skins[i];
    return CFG.skins[0];
  };
  CFG.theme = function (id) {
    for (var i = 0; i < CFG.themes.length; i++) if (CFG.themes[i].id === id) return CFG.themes[i];
    return CFG.themes[0];
  };
  CFG.mode = function (id) {
    return CFG.modes[id] || CFG.modes.endless;
  };
  CFG.laneX = function (lane) {
    return (lane - (CFG.world.lanes - 1) / 2) * CFG.world.laneW;
  };
})(typeof window !== 'undefined' ? window : globalThis);


