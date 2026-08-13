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

// 超能力（アクティブ）— timing: 'anytime'=いつでも, 'beforeMove'=移動前, 'battle'=戦闘時
const POWERS = [
  {
    id: 'telekinesis', name: '念動力', cost: 3, timing: 'beforeMove',
    description: '移動前に使用。サイコロの出目を+2する',
    effect: { type: 'diceBonus', value: 2 },
    evolved: { name: '強化念動力', cost: 3, description: '移動前に使用。サイコロの出目を+4する', effect: { type: 'diceBonus', value: 4 } },
  },
  {
    id: 'precognition', name: '予知', cost: 2, timing: 'beforeMove',
    description: '移動前に使用。悪いマスイベントを無効化する',
    effect: { type: 'precognition_block' },
    evolved: { name: '完全予知', cost: 1, description: '移動前に使用。悪いマスイベントを無効化する（コスト軽減）', effect: { type: 'precognition_block' } },
  },
  {
    id: 'mindblast', name: '精神攻撃', cost: 3, timing: 'battle',
    description: '戦闘時に使用。相手のサイコロ出目を-2する',
    effect: { type: 'battleDebuff', value: 2 },
    evolved: { name: '精神崩壊', cost: 3, description: '戦闘時に使用。相手のサイコロ出目を-4する', effect: { type: 'battleDebuff', value: 4 } },
  },
  {
    id: 'regeneration', name: '自己再生', cost: 4, timing: 'anytime',
    description: 'いつでも使用可。体力を3回復する',
    effect: { type: 'heal', value: 3 },
    evolved: { name: '完全再生', cost: 4, description: 'いつでも使用可。体力を6回復する', effect: { type: 'heal', value: 6 } },
  },
  {
    id: 'teleport', name: 'テレポート', cost: 5, timing: 'beforeMove',
    description: '移動前に使用。サイコロの代わりに4マス確定で進む',
    effect: { type: 'fixedMove', value: 4 },
    evolved: { name: '空間跳躍', cost: 5, description: '移動前に使用。サイコロの代わりに7マス確定で進む', effect: { type: 'fixedMove', value: 7 } },
  },
  {
    id: 'barrier', name: 'バリア', cost: 3, timing: 'anytime',
    description: 'いつでも使用可。次に受けるダメージを1回無効化する',
    effect: { type: 'barrier' },
    evolved: { name: '絶対防御', cost: 3, description: 'いつでも使用可。次に受けるダメージを1回無効化し、体力を1回復する', effect: { type: 'barrierHeal', healValue: 1 } },
  },
  {
    id: 'energybolt', name: 'エナジーボルト', cost: 2, timing: 'anytime',
    description: 'いつでも使用可。同じマスの相手1人の体力を2減らす',
    effect: { type: 'directDamage', value: 2 },
    evolved: { name: '超エナジーボルト', cost: 2, description: 'いつでも使用可。同じマスの相手1人の体力を4減らす', effect: { type: 'directDamage', value: 4 } },
  },
  {
    id: 'haste', name: '加速', cost: 2, timing: 'beforeMove',
    description: '移動前に使用。サイコロの出目を+1し、マスイベントが良い結果になりやすくなる',
    effect: { type: 'diceBonus', value: 1 },
    evolved: { name: '超加速', cost: 2, description: '移動前に使用。サイコロの出目を+2し、マスイベントが良い結果になりやすくなる', effect: { type: 'diceBonus', value: 2 } },
  },
];

const POWERS_PER_PLAYER = 2;

// 経験値・レベルシステム
const XP_PER_TILE = 2;        // 1マス移動あたり
const XP_ABILITY_USE = 10;    // 超能力1回使用
const XP_BATTLE_WIN = 15;     // 戦闘勝利
const XP_BATTLE_LOSE = 5;     // 戦闘敗北
const XP_BATTLE_DRAW = 10;    // 戦闘引き分け
const MAX_LEVEL = 3;
const LEVEL_XP = [0, 80, 180, 300]; // 各レベルに必要な累計XP
// Lv1: 超能力1が進化, Lv2: 超能力2が進化, Lv3: HP上限+2, PSY上限+2

const CELL_EVENTS = [
  { id: 'nothing', label: '何も起こらなかった', weight: 4, apply: () => ({}) },
  { id: 'heal', label: '泉を見つけ、体力が2回復した', weight: 3, apply: () => ({ hp: 2 }) },
  { id: 'damage', label: '罠にかかり、体力が2減少した', weight: 2, apply: () => ({ hp: -2 }) },
  { id: 'energy_gain', label: '不思議な力を感じ、サイコエナジーが2回復した', weight: 3, apply: () => ({ energy: 2 }) },
  { id: 'energy_loss', label: '精神を乱され、サイコエナジーが2減少した', weight: 2, apply: () => ({ energy: -2 }) },
  { id: 'move_forward', label: '追い風が吹き、2マス進んだ', weight: 2, apply: () => ({ move: 2 }) },
  { id: 'move_back', label: '道に迷い、2マス戻った', weight: 2, apply: () => ({ move: -2 }) },
];

const EVENT_CARDS = [
  { id: 'card_energy_surge', label: '空間にサイコエナジーが満ちる。全員のサイコエナジーが2回復した', apply: () => ({ energy: 2 }) },
  { id: 'card_storm', label: '嵐が吹き荒れる。全員の体力が1減少した', apply: () => ({ hp: -1 }) },
  { id: 'card_calm', label: '静寂が訪れる。全員の体力が1回復した', apply: () => ({ hp: 1 }) },
  { id: 'card_drain', label: '謎の力が精神を消耗させる。全員のサイコエナジーが1減少した', apply: () => ({ energy: -1 }) },
];

function pickWeightedCellEvent() {
  const total = CELL_EVENTS.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of CELL_EVENTS) { if (r < e.weight) return e; r -= e.weight; }
  return CELL_EVENTS[0];
}
function pickRandomEventCard() { return EVENT_CARDS[Math.floor(Math.random() * EVENT_CARDS.length)]; }

module.exports = { ROLES, POWERS, POWERS_PER_PLAYER, XP_PER_TILE, XP_ABILITY_USE, XP_BATTLE_WIN, XP_BATTLE_LOSE, XP_BATTLE_DRAW, MAX_LEVEL, LEVEL_XP, CELL_EVENTS, EVENT_CARDS, pickWeightedCellEvent, pickRandomEventCard };
