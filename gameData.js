// 役職（永続パッシブ）
const ROLES = [
  { id: 'traveler', name: '旅人', description: '移動時のサイコロの目+2、マス目の不利な効果を負いづらくなる。',
    passive: { moveDiceBonus: 2, badEventResist: true } },
  { id: 'professor', name: '教授', description: '経験値の入手量が1.5倍(切り上げ)、サイコエナジー上限+2、サイコエナジーのターン回復量+1',
    passive: { xpMultiplier: 1.5, maxEnergyBonus: 2, energyRegenBonus: 1 } },
  { id: 'veteran', name: '退役軍人', description: '戦闘時のサイコロの目+2、HP上限+3、戦闘時の相手へのダメージ+2。',
    passive: { battleDiceBonus: 2, maxHpBonus: 3, battleDamageBonus: 2 } },
  { id: 'farmer', name: '農夫', description: 'ターン回復量+2、HP上限+5、戦闘時に受けるダメージ-2。',
    passive: { hpRegenBonus: 2, maxHpBonus: 5, battleDamageReduction: 2 } },
  { id: 'sheriff', name: '保安官', description: 'HP上限+3、相手から戦闘を仕掛けられた場合、サイコロの目+4。戦闘時の相手へのダメージ+2。',
    passive: { maxHpBonus: 3, defendDiceBonus: 4, battleDamageBonus: 2 } },
  { id: 'assassin', name: 'アサシン', description: '移動時のサイコロの目+1。自分から戦闘を仕掛けた場合サイコロの目+5、相手から仕掛けられた場合-1。戦闘時の相手へのダメージ+1。',
    passive: { moveDiceBonus: 1, attackDiceBonus: 5, defendDicePenalty: 1, battleDamageBonus: 1 } },
  { id: 'illusionist', name: '奇術師', description: '1ターンに1回、サイコロを振り直す事ができる。1マップに1回、サイコロを3個同時に振ることが出来る。',
    passive: { rerollPerTurn: true, tripleDicePerMap: true } },
  { id: 'gambler', name: 'ギャンブラー', description: 'サイコロの目が奇数の場合-3,サイコロの目が偶数の場合+3する。',
    passive: { gamblerEffect: true } },
];

// 超能力セット
// 各セットは複数の「系統(line)」を持ち、各系統は進化段階(stages)の配列。
// stage.level: そのプレイヤーのレベルがこの値以上になった時点で、そのstageが「現在の姿」になる。
//   level:0 のstageはゲーム開始時から使用可能。level:2等は、それ未満のレベルでは未解放（使用不可）。
// timing: 'anytime' | 'beforeMove' | 'battle'
// type: 'self'（自発型） | 'counter'（カウンター型）
const SUPER_SETS = [
  {
    id: 'fire', name: '炎の超能力', image: 'set_fire',
    lines: [
      {
        id: 'pyro',
        stages: [
          { level: 0, id: 'pyrokinesis', name: 'パイロキネシス', cost: 2, timing: 'battle', type: 'self',
            description: '戦闘時に使用。サイコロの目+2、相手へのダメージ+1',
            effect: { type: 'battleSelfBuff', diceBonus: 2, dmgBonus: 1 } },
          { level: 1, id: 'pyrostrike', name: 'パイロストライク', cost: 2, timing: 'battle', type: 'self',
            description: '戦闘時に使用。サイコロの目+3、相手へのダメージ+2',
            effect: { type: 'battleSelfBuff', diceBonus: 3, dmgBonus: 2 } },
          { level: 3, id: 'pyroboost', name: 'パイロブースト', cost: 2, timing: 'battle', type: 'self',
            description: '戦闘時に使用。サイコロの目+4、相手へのダメージ+3',
            effect: { type: 'battleSelfBuff', diceBonus: 4, dmgBonus: 3 } },
        ],
      },
      {
        id: 'barricade',
        stages: [
          { level: 0, id: 'firebarricade', name: 'ファイヤバリケード', cost: 2, timing: 'beforeMove', type: 'self',
            description: '移動時に使用。今いるマスに罠を仕掛ける。通過した敵に1ダメージ',
            effect: { type: 'trap', dmg: 1 } },
          { level: 2, id: 'prominencedivide', name: 'プロミネンスディバイド', cost: 2, timing: 'beforeMove', type: 'self',
            description: '移動時に使用。今いるマスに罠を仕掛ける。通過した敵に3ダメージ',
            effect: { type: 'trap', dmg: 3 } },
        ],
      },
      {
        id: 'burningend',
        stages: [
          { level: 2, id: 'burningend', name: 'バーニングエンド', cost: 6, timing: 'battle', type: 'self',
            description: '戦闘時に使用。(基礎ダイス+役職ボーナス)を2倍にする、ダメージ+4',
            effect: { type: 'battleMultiply', multiplier: 2, dmgBonus: 4 } },
          { level: 3, id: 'endlessinferno', name: 'エンドレスインフェルノ', cost: 6, timing: 'battle', type: 'self',
            description: '戦闘時に使用。(基礎ダイス+役職ボーナス)を4倍にする、ダメージ+6、自分の前後1マスの非戦闘中の敵に2ダメージ',
            effect: { type: 'battleMultiply', multiplier: 4, dmgBonus: 6, splashDmg: 2, splashRange: 1 } },
        ],
      },
    ],
  },
  {
    id: 'wind', name: '風の超能力', image: 'set_wind',
    lines: [
      {
        id: 'airboost',
        stages: [
          { level: 0, id: 'airboost', name: 'エアブースト', cost: 2, timing: 'beforeMove', type: 'self',
            description: '移動時に使用。サイコロの目+2',
            effect: { type: 'diceBonus', value: 2 } },
          { level: 1, id: 'stormforward', name: 'ストームフォワード', cost: 2, timing: 'beforeMove', type: 'self',
            description: '移動時に使用。サイコロの目+3',
            effect: { type: 'diceBonus', value: 3 } },
        ],
      },
      {
        id: 'againstwind',
        stages: [
          { level: 0, id: 'againstwind', name: 'アゲインストウィンド', cost: 1, timing: 'battle', type: 'self',
            description: '戦闘時に使用。サイコロの目+2',
            effect: { type: 'battleSelfBuff', diceBonus: 2, dmgBonus: 0 } },
          { level: 2, id: 'tornadobreak', name: 'トルネードブレイク', cost: 1, timing: 'battle', type: 'self',
            description: '戦闘時に使用。サイコロの目+6',
            effect: { type: 'battleSelfBuff', diceBonus: 6, dmgBonus: 0 } },
        ],
      },
      {
        id: 'cyclone',
        stages: [
          { level: 0, id: 'cyclone', name: 'サイクロン', cost: 4, timing: 'battle', type: 'self',
            description: '戦闘を回避し、相手を2マス後退させる（戦闘不成立・引き分け扱い）',
            effect: { type: 'battleEvade', knockback: 2 } },
          { level: 2, id: 'hurricane', name: 'ハリケーン', cost: 4, timing: 'battle', type: 'self',
            description: '戦闘を回避し、相手を5マス後退させる（戦闘不成立・引き分け扱い）',
            effect: { type: 'battleEvade', knockback: 5 } },
        ],
      },
    ],
  },
  {
    id: 'mind', name: '精神の超能力', image: 'set_mind',
    lines: [
      {
        id: 'mentalabsorb',
        stages: [
          { level: 0, id: 'mentalabsorb', name: 'メンタルアブソーブ', cost: 3, timing: 'anytime', type: 'self',
            description: '同じマスの相手を1人選び、サイコエナジー-2（対象選択が必要）',
            effect: { type: 'energyDrain', value: 2 } },
          { level: 3, id: 'mentalcrush', name: 'メンタルクラッシュ', cost: 5, timing: 'anytime', type: 'self',
            description: '同じマスの相手を1人選び、サイコエナジーを0にする（対象選択が必要）',
            effect: { type: 'energyDrain', setZero: true } },
        ],
      },
      {
        id: 'manipulation',
        stages: [
          { level: 0, id: 'manipulation', name: 'マニピュレーション', cost: 5, timing: 'battle', type: 'counter',
            description: 'カウンター型。自分の戦闘時、相手が戦闘超能力を発動しようとした場合、それを無効化する',
            effect: { type: 'counterNegate' } },
          { level: 3, id: 'mindhijack', name: 'マインドハイジャック', cost: 5, timing: 'battle', type: 'counter',
            description: 'カウンター型。相手の戦闘超能力を無効化し、その効果を自分が代わりに得る',
            effect: { type: 'counterNegate', hijack: true } },
        ],
      },
    ],
  },
  {
    id: 'time', name: '時間の超能力', image: 'set_time',
    lines: [
      {
        id: 'timejammer',
        stages: [
          { level: 0, id: 'timejammer', name: 'タイムジャマー', cost: 2, timing: 'beforeMove', type: 'self',
            description: '次のターン、自分以外の全プレイヤーの移動を-1する',
            effect: { type: 'moveDebuffAll', mode: 'reduce', value: 1 } },
          { level: 3, id: 'timegravity', name: 'タイムグラヴィティ', cost: 5, timing: 'beforeMove', type: 'self',
            description: '次のターン、自分以外の全プレイヤーの移動距離を1マスに固定する（超能力・役職によるボーナスを無効化）',
            effect: { type: 'moveDebuffAll', mode: 'fixed', value: 1 } },
        ],
      },
      {
        id: 'timeslice',
        stages: [
          { level: 0, id: 'timeslice', name: 'タイムスライス', cost: 4, timing: 'battle', type: 'self',
            description: '戦闘を終了させる（戦闘不成立・引き分け扱い）',
            effect: { type: 'battleEvade', knockback: 0 } },
          { level: 2, id: 'timecounter', name: 'タイムカウンター', cost: 4, timing: 'battle', type: 'self',
            description: '戦闘を行う。敗北した場合、受けるダメージを0まで減らし、減らした分を相手に返す',
            effect: { type: 'battleDamageReflect' } },
        ],
      },
      {
        id: 'timestop',
        stages: [
          { level: 2, id: 'timestop', name: 'タイムストップ', cost: 6, timing: 'battle', type: 'self',
            description: '相手のサイコロの目を1にする。ダメージ+3',
            effect: { type: 'battleOpponentDiceFix', value: 1, dmgBonus: 3 } },
          { level: 3, id: 'judgementtime', name: 'ジャッジメントタイム', cost: 6, timing: 'battle', type: 'self',
            description: '相手のサイコロの目を0にする。ダメージ+6',
            effect: { type: 'battleOpponentDiceFix', value: 0, dmgBonus: 6 } },
        ],
      },
    ],
  },
  {
    id: 'imitation', name: '模倣の超能力', image: 'set_imitation',
    lines: [
      {
        id: 'copy',
        stages: [
          { level: 0, id: 'copy', name: 'コピー', cost: 4, timing: 'beforeMove', type: 'self',
            description: '現在のマスで直近に他人が使った超能力をコピーして保持する（複数保持可）',
            effect: { type: 'copyAbility', bonus: 0 } },
          { level: 2, id: 'advancedcopy', name: 'アドバンスドコピー', cost: 4, timing: 'beforeMove', type: 'self',
            description: '現在のマスで直近に他人が使った超能力をコピーする。サイコロ・移動関連の値+2で保持',
            effect: { type: 'copyAbility', bonus: 2 } },
        ],
      },
      {
        id: 'trash',
        stages: [
          { level: 0, id: 'trash', name: 'トラッシュ', cost: 2, timing: 'battle', type: 'self',
            description: '戦闘超能力選択時に使用。コピーした能力を1つ破棄し、サイコロの目+3',
            effect: { type: 'trashCopy', diceBonus: 3, ban: false } },
          { level: 3, id: 'clear', name: 'クリアー', cost: 2, timing: 'battle', type: 'self',
            description: '戦闘超能力選択時に使用。コピーした能力を1つ破棄し、サイコロの目+5。破棄した能力は次の1ターンの間、全プレイヤーが使用不可に',
            effect: { type: 'trashCopy', diceBonus: 5, ban: true } },
        ],
      },
    ],
  },
  {
    id: 'prayer', name: '祈祷の超能力', image: 'set_prayer',
    lines: [
      {
        id: 'foresight',
        stages: [
          { level: 0, id: 'foresight', name: '予知の祈祷', cost: 1, timing: 'beforeMove', type: 'self',
            description: '8ターン（2ラウンド）以内に災害が起こるか予知できる（自分にのみ結果が表示される）',
            effect: { type: 'disasterForesight', withinTurns: 8 } },
        ],
      },
      {
        id: 'blessing',
        stages: [
          { level: 0, id: 'blessing', name: '恵みの祈祷', cost: 2, timing: 'beforeMove', type: 'self',
            description: 'HPを4回復する',
            effect: { type: 'heal', value: 4 } },
        ],
      },
      {
        id: 'disasterprayer',
        stages: [
          { level: 0, id: 'disasterprayer', name: '災害の祈祷', cost: 6, timing: 'beforeMove', type: 'self',
            description: '災害を発動させる（マップで1度のみ）。自身はその効果を一切受けない',
            effect: { type: 'triggerDisasterPrayer' } },
        ],
      },
    ],
  },
];

// 経験値・レベルシステム
const XP_PER_TILE = 2;        // 1マス移動あたり
const XP_ABILITY_USE = 10;    // 超能力1回使用
const XP_BATTLE_WIN = 15;     // 戦闘勝利
const XP_BATTLE_LOSE = 5;     // 戦闘敗北
const XP_BATTLE_DRAW = 10;    // 戦闘引き分け
const XP_MAP_FIRST = 60;      // マップで最初にゴールした際のボーナス
const MAX_LEVEL = 3;
const LEVEL_XP = [0, 80, 180, 300]; // 各レベルに必要な累計XP
// レベル到達で各超能力系統がそれぞれのstage.levelに応じて解放・進化する
// Lv3到達時: HP上限+2、PSY上限+2（役職とは別の全プレイヤー共通ボーナス）

const CELL_EVENTS = [
  { id: 'nothing', label: '何も起こらなかった', weight: 4, apply: () => ({}) },
  { id: 'heal', label: '泉を見つけ、体力が2回復した', weight: 3, apply: () => ({ hp: 2 }) },
  { id: 'damage', label: '罠にかかり、体力が2減少した', weight: 2, apply: () => ({ hp: -2 }) },
  { id: 'energy_gain', label: '不思議な力を感じ、サイコエナジーが2回復した', weight: 3, apply: () => ({ energy: 2 }) },
  { id: 'energy_loss', label: '精神を乱され、サイコエナジーが2減少した', weight: 2, apply: () => ({ energy: -2 }) },
  { id: 'move_forward', label: '追い風が吹き、2マス進んだ', weight: 2, apply: () => ({ move: 2 }) },
  { id: 'move_back', label: '道に迷い、2マス戻った', weight: 2, apply: () => ({ move: -2 }) },
];

// 災害: マップごとに1度、ランダムなターンの終わりに発生する共通システム。
// 実際の効果ロジックはserver.js側のtriggerDisasterで、idに応じて実装される。
const DISASTERS = [
  { id: 'arawa', name: '荒波', label: '荒波が発生した', image: 'disaster_arawa',
    description: '全員に3ダメージ。全員サイコロを一度振り、次の1周のサイコロはその目の分だけ-される。' },
  { id: 'jiware', name: '地割れ', label: '地割れが発生した', image: 'disaster_jiware',
    description: '全員5マス後退する。' },
  { id: 'oohiji', name: '大火事', label: '大火事が発生した', image: 'disaster_oohiji',
    description: '全員に5ダメージ。' },
  { id: 'taifu', name: '台風', label: '台風が発生した', image: 'disaster_taifu',
    description: '全員サイコロを一度振り、その目の分だけ後退する。全員サイコエナジー-3。' },
  { id: 'gouu', name: '豪雨', label: '豪雨が発生した', image: 'disaster_gouu',
    description: '全員サイコエナジー-5。' },
  { id: 'ameame', name: '飴の雨', label: '飴の雨が降ってきた', image: 'disaster_ameame',
    description: '全員HPとサイコエナジーを3回復。次の移動のサイコロが-3される。' },
];

// モンスター: マスイベントで遭遇し、1回のダイス勝負で決着する
const MONSTERS = [
  { id: 'skeleton', name: 'リベンジャースケルトン', image: 'monster_skeleton',
    diceBonus: 3, damage: 4, xp: 8,
    abilityName: '弾幕掃射', abilityDesc: '戦闘ダイス+3' },
  { id: 'snake', name: 'マインドスネーク', image: 'monster_snake',
    diceBonus: 0, damage: 3, xp: 8, playerDiceDebuff: 3,
    abilityName: '精神侵食', abilityDesc: '相手の戦闘ダイス-3' },
  { id: 'dog', name: 'チェインドッグ', image: 'monster_dog',
    diceBonus: 1, damage: 3, xp: 8, knockbackOnWin: 2,
    abilityName: '鎖の呪縛', abilityDesc: '勝利時に相手を2マス後退させる' },
  { id: 'seekhead', name: 'シークヘッド', image: 'monster_seekhead',
    diceBonus: 0, damage: 5, xp: 9,
    abilityName: '断罪の刃', abilityDesc: '戦闘時のダメージ+2' },
  { id: 'goblin', name: 'ゴブリンアサルト', image: 'monster_goblin',
    diceBonus: 2, damage: 2, xp: 6,
    abilityName: '奇襲', abilityDesc: '戦闘ダイス+2' },
  { id: 'crow', name: 'クロウドクロウ', image: 'monster_crow',
    diceBonus: 1, damage: 2, xp: 7, energyDrainOnWin: 2,
    abilityName: '群れの目', abilityDesc: '勝利時にサイコエナジーを2奪う' },
];

function pickRandomMonster() { return MONSTERS[Math.floor(Math.random() * MONSTERS.length)]; }

// マップ定義: 4つのマップそれぞれで盤面サイズ・開始位置・マスイベントの傾向が異なる
const MAPS = [
  {
    index: 1, name: '始まりの平原', boardSize: 34, startPos: 0,
    cols: 7,             // 蛇行の折り返し幅
    layout: 'serpentine', // 盤面の形（蛇行）
    terrain: ['grass', 'tree'],
    description: '穏やかな平原。まっすぐ進みやすい',
    shortcuts: [],        // ショートカット（from→to の一方通行）
    cellEvents: [
      { id: 'nothing', label: '何も起こらなかった', weight: 5, apply: () => ({}) },
      { id: 'heal', label: '泉を見つけ、体力が2回復した', weight: 4, apply: () => ({ hp: 2 }) },
      { id: 'damage', label: '罠にかかり、体力が2減少した', weight: 2, apply: () => ({ hp: -2 }) },
      { id: 'energy_gain', label: '不思議な力を感じ、サイコエナジーが2回復した', weight: 4, apply: () => ({ energy: 2 }) },
      { id: 'energy_loss', label: '精神を乱され、サイコエナジーが2減少した', weight: 2, apply: () => ({ energy: -2 }) },
      { id: 'move_forward', label: '追い風が吹き、2マス進んだ', weight: 2, apply: () => ({ move: 2 }) },
      { id: 'move_back', label: '道に迷い、2マス戻った', weight: 2, apply: () => ({ move: -2 }) },
      { id: 'monster', label: 'モンスターが現れた！', weight: 2, monster: true },
    ],
  },
  {
    index: 2, name: '渦巻きの荒野', boardSize: 40, startPos: 0,
    cols: 5,
    layout: 'spiral',     // 外周から内側へ渦を巻く
    terrain: ['mtn', 'ruin'],
    description: '渦を巻く荒野。近道が口を開けている',
    // 近道: 通過するだけで一気に飛ぶ（強力だが数は少ない）
    shortcuts: [
      { from: 8, to: 17, label: '崖の抜け道を駆け上がった！' },
      { from: 24, to: 33, label: '砂の谷を滑り降りた！' },
    ],
    cellEvents: [
      { id: 'nothing', label: '何も起こらなかった', weight: 3, apply: () => ({}) },
      { id: 'heal', label: 'オアシスを見つけ、体力が3回復した', weight: 3, apply: () => ({ hp: 3 }) },
      { id: 'damage', label: '砂嵐に巻き込まれ、体力が2減少した', weight: 2, apply: () => ({ hp: -2 }) },
      { id: 'energy_gain', label: '風のざわめきに共鳴し、サイコエナジーが2回復した', weight: 3, apply: () => ({ energy: 2 }) },
      { id: 'move_forward_big', label: '強い追い風に乗り、4マス進んだ', weight: 3, apply: () => ({ move: 4 }) },
      { id: 'move_back_big', label: '向かい風に押し返され、3マス戻った', weight: 3, apply: () => ({ move: -3 }) },
      { id: 'monster', label: 'モンスターが現れた！', weight: 3, monster: true },
    ],
  },
  {
    index: 3, name: '呪詛の魔境', boardSize: 44, startPos: 0,
    cols: 9,
    layout: 'zigzag',     // 大きく上下に振れる稲妻状
    terrain: ['cave', 'ruin'],
    description: '呪いが渦巻く魔境。落とし穴と抜け道が入り乱れる',
    shortcuts: [
      { from: 11, to: 19, label: '魔法陣に飲み込まれ、跳躍した！' },
      { from: 30, to: 21, label: '呪詛の落とし穴に落ちた…', backward: true },
      { from: 36, to: 42, label: '闇の回廊を突き抜けた！' },
    ],
    cellEvents: [
      { id: 'nothing', label: '何も起こらなかった', weight: 2, apply: () => ({}) },
      { id: 'heal', label: '聖なる泉を見つけ、体力が4回復した', weight: 3, apply: () => ({ hp: 4 }) },
      { id: 'damage_big', label: '呪詛を浴び、体力が4減少した', weight: 4, apply: () => ({ hp: -4 }) },
      { id: 'energy_gain_big', label: '濃密な魔力に触れ、サイコエナジーが4回復した', weight: 3, apply: () => ({ energy: 4 }) },
      { id: 'energy_loss_big', label: '精神を蝕まれ、サイコエナジーが3減少した', weight: 3, apply: () => ({ energy: -3 }) },
      { id: 'move_back', label: '瘴気に阻まれ、2マス戻った', weight: 2, apply: () => ({ move: -2 }) },
      { id: 'monster', label: 'モンスターが現れた！', weight: 5, monster: true },
    ],
  },
  {
    index: 4, name: '決戦の廃都', boardSize: 48, startPos: 0,
    cols: 6,
    layout: 'spiral',
    terrain: ['ruin', 'cave', 'mtn'],
    description: '全てが決する廃都。一手で運命が変わる',
    shortcuts: [
      { from: 9, to: 20, label: '崩れた大橋を飛び越えた！' },
      { from: 28, to: 15, label: '地の底へ崩落した…', backward: true },
      { from: 33, to: 44, label: '古の転送陣が起動した！' },
    ],
    cellEvents: [
      { id: 'nothing', label: '何も起こらなかった', weight: 2, apply: () => ({}) },
      { id: 'heal_big', label: '秘薬を発見し、体力が5回復した', weight: 3, apply: () => ({ hp: 5 }) },
      { id: 'damage_big', label: '崩落に巻き込まれ、体力が5減少した', weight: 4, apply: () => ({ hp: -5 }) },
      { id: 'energy_gain_big', label: '古の力が流れ込み、サイコエナジーが5回復した', weight: 3, apply: () => ({ energy: 5 }) },
      { id: 'move_forward_big', label: '崩れた道を駆け抜け、5マス進んだ', weight: 3, apply: () => ({ move: 5 }) },
      { id: 'move_back_big', label: '瓦礫に道を塞がれ、4マス戻った', weight: 3, apply: () => ({ move: -4 }) },
      { id: 'monster', label: 'モンスターが現れた！', weight: 6, monster: true },
    ],
  },
];

function getMapByIndex(index) {
  return MAPS.find(m => m.index === index) || MAPS[0];
}

// 指定マップ・指定マスにショートカット（近道/落とし穴）があれば返す
function getShortcutAt(mapIndex, position) {
  const map = getMapByIndex(mapIndex);
  return (map.shortcuts || []).find(s => s.from === position) || null;
}

// 指定マップのマスイベントを重み付き抽選する
function pickCellEventForMap(mapIndex) {
  const map = getMapByIndex(mapIndex);
  const list = map.cellEvents;
  const total = list.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of list) { if (r < e.weight) return e; r -= e.weight; }
  return list[0];
}

function pickWeightedCellEvent() {
  const total = CELL_EVENTS.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of CELL_EVENTS) { if (r < e.weight) return e; r -= e.weight; }
  return CELL_EVENTS[0];
}
function pickRandomDisaster() { return DISASTERS.length ? DISASTERS[Math.floor(Math.random() * DISASTERS.length)] : null; }

// 系統(line)とプレイヤーレベルから、現在有効なstageを返す。未解放ならnull。
function getLineStage(line, level) {
  let current = null;
  for (const stage of line.stages) {
    if (level >= stage.level) current = stage;
  }
  return current;
}

module.exports = {
  ROLES, SUPER_SETS,
  XP_PER_TILE, XP_ABILITY_USE, XP_BATTLE_WIN, XP_BATTLE_LOSE, XP_BATTLE_DRAW, XP_MAP_FIRST,
  MAX_LEVEL, LEVEL_XP,
  CELL_EVENTS, DISASTERS, MONSTERS, MAPS,
  pickWeightedCellEvent, pickRandomDisaster, getLineStage,
  pickRandomMonster, getMapByIndex, pickCellEventForMap, getShortcutAt,
};
