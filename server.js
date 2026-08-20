const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  ROLES,
  SUPER_SETS,
  XP_PER_TILE, XP_ABILITY_USE, XP_BATTLE_WIN, XP_BATTLE_LOSE, XP_BATTLE_DRAW,
  MAX_LEVEL, LEVEL_XP,
  pickWeightedCellEvent,
  pickRandomDisaster,
  getLineStage,
} = require('./gameData');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const BOARD_SIZE = 34;
const DISASTER_MIN_ROUNDS = 2;  // 最初のこの数のラウンドは自然発生の災害が起きない
const DISASTER_EXTRA_TURNS = 20; // 発生可能な最短ターンから、さらに何ターン分の幅を持たせるか
const BASE_MAX_HP = 10;
const BASE_MAX_ENERGY = 6;
const BASE_HP_REGEN = 1;
const BASE_ENERGY_REGEN = 1;
const REST_BONUS = 2;
const INCAPACITATED_TURNS = 2;
const BATTLE_DAMAGE = 3;
const PLAYER_COLORS = ['#8b5cf6', '#22d3ee', '#f2b705', '#ef4444'];
const BOT_NAMES = ['アルファ', 'ベータ', 'ガンマ', 'デルタ'];
const BOT_DELAY = 1200; // Botの行動間隔(ms)
let botIdCounter = 0;

const rooms = new Map();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function generateRoomId() {
  let id;
  do {
    id = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(id));
  return id;
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.id === socketId)) return room;
  }
  return null;
}

function getPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function emitHpChange(room, p, amount) {
  if (!amount || amount === 0) return;
  io.to(room.id).emit('hpChange', {
    playerId: p.id,
    playerName: p.name,
    amount,
  });
}

function emitEnergyChange(room, p, amount) {
  if (!amount || amount === 0) return;
  io.to(room.id).emit('energyChange', {
    playerId: p.id,
    playerName: p.name,
    amount,
  });
}

function addLog(room, message, opts) {
  room.log = room.log || [];
  // opts: { secret: true, ownerId: socketId } → 他プレイヤーには隠す
  room.log.push(opts ? { msg: message, ...opts } : { msg: message });
  if (room.log.length > 40) room.log.shift();
}

function buildLogForPlayer(log, forSocketId) {
  return (log || []).map(entry => {
    if (entry.secret && entry.ownerId !== forSocketId) {
      return entry.hiddenMsg || entry.msg.replace(entry.abilityName, '???');
    }
    return entry.msg;
  });
}

function getSetById(setId) {
  return SUPER_SETS.find(s => s.id === setId) || null;
}

// 通常の系統(line)、または模倣でコピーした能力のどちらかを、lineIdから統一的に検索する
function findAbilityStage(player, lineId) {
  const set = player.superSetId ? getSetById(player.superSetId) : null;
  if (set) {
    const line = set.lines.find(l => l.id === lineId);
    if (line) {
      const stage = getLineStage(line, player.level || 0);
      if (stage) return { stage, isCopy: false };
    }
  }
  if (player.copiedAbilities) {
    const copy = player.copiedAbilities.find(c => c.id === lineId);
    if (copy) return { stage: copy, isCopy: true };
  }
  return { stage: null, isCopy: false };
}

// 現在のマスで使われた超能力を記録する（模倣のコピー元として参照される）
function recordAbilityUse(room, player, lineId, stage) {
  if (!lineId || !stage) return;
  if (!room.abilityHistoryByPosition) room.abilityHistoryByPosition = {};
  const pos = player.position;
  if (!room.abilityHistoryByPosition[pos]) room.abilityHistoryByPosition[pos] = [];
  const history = room.abilityHistoryByPosition[pos];
  room._historyIdCounter = (room._historyIdCounter || 0) + 1;
  history.push({
    id: 'hist_' + room._historyIdCounter,
    ownerId: player.id, ownerName: player.name,
    lineId, setId: player.superSetId,
    stage: JSON.parse(JSON.stringify(stage)),
  });
  // 1マスあたりの履歴は直近20件までに制限（無制限な蓄積を防ぐ）
  if (history.length > 20) history.splice(0, history.length - 20);
}

function isAbilityBanned(room, setId, lineId) {
  if (!room.bannedAbilities || !setId || !lineId) return false;
  return room.bannedAbilities.some(b => b.setId === setId && b.lineId === lineId && room.roundNumber <= b.expiresAtRound);
}

function cleanupBannedAbilities(room) {
  if (!room.bannedAbilities) return;
  room.bannedAbilities = room.bannedAbilities.filter(b => room.roundNumber <= b.expiresAtRound);
}

function publicPlayer(p) {
  const set = p.superSetId ? getSetById(p.superSetId) : null;
  const level = p.level || 0;
  const lines = set ? set.lines.map(line => {
    const stage = getLineStage(line, level);
    if (!stage) {
      // 未解放: 系統名は分かるが、性能は伏せる
      const firstUnlock = line.stages[0] ? line.stages[0].level : 0;
      const nextStage = line.stages.find(s => s.level > level) || line.stages[0];
      return {
        lineId: line.id, locked: true,
        name: nextStage ? nextStage.name : '???',
        description: '未解放（Lv.' + (line.stages.find(s => level < s.level) ? line.stages.find(s => level < s.level).level : firstUnlock) + 'で解放）',
        cost: null, timing: null, type: null, evolved: false,
      };
    }
    return {
      lineId: line.id, id: stage.id, locked: false,
      name: stage.name, description: stage.description, cost: stage.cost,
      timing: stage.timing, type: stage.type,
      evolved: line.stages.indexOf(stage) > 0,
      requiresTarget: stage.effect && stage.effect.type === 'energyDrain',
      requiresHistoryChoice: stage.effect && stage.effect.type === 'copyAbility',
    };
  }) : [];
  const copyLines = (p.copiedAbilities || []).map(c => ({
    lineId: c.id, id: c.id, locked: false,
    name: c.name, description: c.description, cost: c.cost,
    timing: c.timing, type: c.type, evolved: false, isCopy: true,
    requiresTarget: c.effect && c.effect.type === 'energyDrain',
  }));
  const allLines = lines.concat(copyLines);
  return {
    id: p.id,
    name: p.name,
    ready: p.ready,
    roleId: p.roleId || null,
    roleName: p.role ? p.role.name : null,
    superSetId: p.superSetId || null,
    superSetName: set ? set.name : null,
    superSetImage: set ? set.image : null,
    powers: allLines,
    hp: p.hp,
    maxHp: p.maxHp,
    energy: p.energy,
    maxEnergy: p.maxEnergy,
    position: p.position,
    incapacitatedTurns: p.incapacitatedTurns || 0,
    finished: !!p.finished,
    finishOrder: p.finishOrder || null,
    color: p.color,
    isBot: !!p.isBot,
    actionTaken: !!p.actionTaken,
    hasBarrier: !!p.hasBarrier,
    powersConfirmed: !!p.powersConfirmed,
    usedTimings: p.usedTimings || [],
    battleDoneThisTurn: !!p.battleDoneThisTurn,
    hasRerolledThisTurn: !!p.hasRerolledThisTurn,
    hasUsedTripleDice: !!p.hasUsedTripleDice,
    canReroll: !!(p.role && p.role.passive && p.role.passive.rerollPerTurn && !p.hasRerolledThisTurn),
    canTripleDice: !!(p.role && p.role.passive && p.role.passive.tripleDicePerMap && !p.hasUsedTripleDice),
    xp: p.xp || 0,
    level: p.level || 0,
    xpToNext: LEVEL_XP ? ((p.level || 0) < MAX_LEVEL ? (LEVEL_XP[(p.level || 0) + 1] || 80) : (LEVEL_XP[MAX_LEVEL] || 300)) : 80,
  };
}

function publicRoomState(room, forSocketId) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => {
      const pub = publicPlayer(p);
      // 自分以外の超能力セットの詳細を隠す
      if (forSocketId && p.id !== forSocketId) {
        pub.superSetName = '???';
        pub.superSetImage = null;
        pub.powers = pub.powers.map(() => ({ lineId: '???', id: '???', name: '???', description: '???', cost: 0, timing: '', type: '', evolved: false, locked: false }));
      }
      return pub;
    }),
    boardSize: BOARD_SIZE,
    turnOrder: room.turnOrder || [],
    currentTurnId: room.phase === 'playing' ? room.turnOrder[room.turnIndex] : null,
    roundNumber: room.roundNumber || 0,
    roles: ROLES.map((r) => ({ id: r.id, name: r.name, description: r.description })),
    superSets: SUPER_SETS.map(s => ({
      id: s.id, name: s.name, image: s.image,
      lines: s.lines.map(line => ({
        id: line.id,
        stages: line.stages.map(st => ({ level: st.level, name: st.name, description: st.description, cost: st.cost, timing: st.timing, type: st.type })),
      })),
    })),
    winnerId: room.winnerId || null,
    log: buildLogForPlayer(room.log, forSocketId),
    traps: (room.traps || []).map(t => ({ id: t.id, ownerId: t.ownerId, ownerName: t.ownerName, position: t.position })),
    abilityHistoryByPosition: Object.fromEntries(
      Object.entries(room.abilityHistoryByPosition || {}).map(([pos, list]) => [
        pos,
        list.map(h => ({ id: h.id, ownerId: h.ownerId, ownerName: h.ownerName, name: h.stage.name, description: h.stage.description })),
      ])
    ),
  };
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    if (p.isBot) return;
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('roomUpdate', publicRoomState(room, p.id));
  });
}

function removePlayerFromRoom(room, socketId) {
  room.players = room.players.filter((p) => p.id !== socketId);

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
  }

  if (room.phase === 'playing' || room.phase === 'roleSelect') {
    const removedIndex = room.turnOrder.indexOf(socketId);
    room.turnOrder = room.turnOrder.filter((id) => id !== socketId);
    if (room.turnOrder.length === 0) {
      rooms.delete(room.id);
      return;
    }
    if (room.phase === 'playing') {
      if (removedIndex !== -1 && removedIndex < room.turnIndex) {
        room.turnIndex -= 1;
      }
      room.turnIndex = ((room.turnIndex % room.turnOrder.length) + room.turnOrder.length) % room.turnOrder.length;
    }
  }

  broadcastRoom(room);
}

function initPlayerForGame(p) {
  const passive = p.role.passive || {};
  p.maxHp = BASE_MAX_HP + (passive.maxHpBonus || 0);
  p.maxEnergy = BASE_MAX_ENERGY + (passive.maxEnergyBonus || 0);
  p.hp = p.maxHp;
  p.energy = p.maxEnergy;
  p.position = 0;
  p.incapacitatedTurns = 0;
  p.finished = false;
  p.finishOrder = null;
  p.xp = 0;
  p.level = 0;
  p.actionTaken = false;
  p.restedThisTurn = false;
  p.pendingDiceBonus = 0;
  p.pendingFixedMove = 0;
  p.blockNextBadEvent = false;
  p.hasBarrier = false;
  p.usedTimings = [];
  p.battleDoneThisTurn = false;
  p.hasRerolledThisTurn = false;
  p.hasUsedTripleDice = false;
  p.pendingBattleDiceBonus = 0;
  p.pendingBattleDamageBonus = 0;
  p.pendingBattleDiceMultiplier = 1;
  p.pendingBattleSplash = null;
  p.pendingBattleEvade = null;
  p.pendingBattleOpponentDiceFix = null;
  p.pendingBattleDamageReflect = false;
  p.pendingIncomingMoveEffect = null;
  p.copiedAbilities = [];
  p.disasterPrayerUsed = false;
}

function applyDelta(room, p, delta) {
  if (!delta) return { hpApplied: 0, energyApplied: 0 };
  let hpApplied = 0, energyApplied = 0;
  if (delta.hp) {
    if (delta.hp < 0 && p.hasBarrier) {
      addLog(room, `${p.name} のバリアがダメージを無効化した`);
      p.hasBarrier = false;
    } else if (delta.hp < 0 && p.blockNextBadEvent) {
      addLog(room, `${p.name} は予知の力で悪い効果を無効化した`);
      p.blockNextBadEvent = false;
    } else {
      const before = p.hp;
      p.hp = clamp(p.hp + delta.hp, 0, p.maxHp);
      hpApplied = p.hp - before;
    }
  }
  if (delta.energy) {
    if (delta.energy < 0 && p.blockNextBadEvent) {
      addLog(room, `${p.name} は予知の力で悪い効果を無効化した`);
      p.blockNextBadEvent = false;
    } else {
      const before = p.energy;
      p.energy = clamp(p.energy + delta.energy, 0, p.maxEnergy);
      energyApplied = p.energy - before;
    }
  }
  if (delta.move) {
    p.position = clamp(p.position + delta.move, 0, BOARD_SIZE);
  }
  if (p.hp <= 0) {
    p.hp = 0;
    if (p.incapacitatedTurns <= 0) {
      p.incapacitatedTurns = INCAPACITATED_TURNS;
      addLog(room, `${p.name} は力尽きて行動不能になった`);
    }
  }
  return { hpApplied, energyApplied };
}

function checkGoal(room, p) {
  if (p.position >= BOARD_SIZE && !p.finished) {
    p.finished = true;
    room.phase = 'finished';
    room.winnerId = p.id;
    addLog(room, `${p.name} が誰よりも先にゴールに到達した！勝利！`);
  }
}

function resetTurnFlags(p) {
  p.actionTaken = false;
  p.restedThisTurn = false;
  p.pendingDiceBonus = 0;
  p.pendingFixedMove = 0;
  p.usedTimings = [];
  p.battleDoneThisTurn = false;
  p.hasRerolledThisTurn = false;
}

function applyRegen(room, p) {
  const passive = p.role.passive || {};
  let hpGain = BASE_HP_REGEN + (passive.hpRegenBonus || 0);
  let energyGain = BASE_ENERGY_REGEN + (passive.energyRegenBonus || 0);
  if (p.restedThisTurn) {
    hpGain += REST_BONUS;
    energyGain += REST_BONUS;
  }
  p.hp = clamp(p.hp + hpGain, 0, p.maxHp);
  p.energy = clamp(p.energy + energyGain, 0, p.maxEnergy);
}

function getAvailableLines(room, player, timingFilter) {
  const set = player.superSetId ? getSetById(player.superSetId) : null;
  const usedT = player.usedTimings || [];
  const level = player.level || 0;
  const result = [];
  if (set) {
    set.lines.forEach(line => {
      const stage = getLineStage(line, level);
      if (!stage) return; // 未解放
      if (timingFilter && stage.timing !== timingFilter) return;
      if (usedT.includes(stage.timing)) return;
      if (player.energy < stage.cost) return;
      if (isAbilityBanned(room, player.superSetId, line.id)) return;
      if (stage.effect.type === 'trashCopy' && (!player.copiedAbilities || player.copiedAbilities.length === 0)) return;
      result.push({ line: { id: line.id }, stage });
    });
  }
  (player.copiedAbilities || []).forEach(copy => {
    if (timingFilter && copy.timing !== timingFilter) return;
    if (usedT.includes(copy.timing)) return;
    if (player.energy < copy.cost) return;
    if (isAbilityBanned(room, copy.sourceSetId, copy.sourceLineId)) return;
    result.push({ line: { id: copy.id }, stage: copy });
  });
  return result;
}

function botChooseBattleAbility(room, bot) {
  const options = getAvailableLines(room, bot, 'battle').filter(o => o.stage.type === 'self');
  if (options.length === 0) return null;
  if (Math.random() < 0.6) {
    const pick = options[Math.floor(Math.random() * options.length)];
    return pick.line.id;
  }
  return null;
}

function applyBattleAbility(room, player, lineId, suppressEffect) {
  if (!lineId) return null;
  const found = findAbilityStage(player, lineId);
  const stage = found.stage;
  const isCopy = found.isCopy;
  if (!stage) return null;
  if (player.energy < stage.cost) return null;
  if ((player.usedTimings || []).includes(stage.timing)) return null;
  const checkSetId = isCopy ? stage.sourceSetId : player.superSetId;
  const checkLineId = isCopy ? stage.sourceLineId : lineId;
  if (isAbilityBanned(room, checkSetId, checkLineId)) return null;
  if (stage.effect.type === 'trashCopy' && (!player.copiedAbilities || player.copiedAbilities.length === 0)) return null;

  player.energy -= stage.cost;
  if (!player.usedTimings) player.usedTimings = [];
  player.usedTimings.push(stage.timing);

  if (suppressEffect) {
    // カウンターにより無効化された: エナジーは消費されるが効果は発動しない
    addLog(room, `${player.name} の「${stage.name}」は無効化された`, { secret: true, ownerId: player.id, abilityName: stage.name, hiddenMsg: `${player.name} の超能力は無効化された` });
    return null;
  }

  addLog(room, `${player.name} は「${stage.name}」を発動した`, { secret: true, ownerId: player.id, abilityName: stage.name, hiddenMsg: `${player.name} は超能力を発動した` });
  if (!isCopy) recordAbilityUse(room, player, lineId, stage);

  switch (stage.effect.type) {
    case 'battleDebuff':
      player.pendingBattleDebuff = (player.pendingBattleDebuff || 0) + stage.effect.value;
      break;
    case 'battleSelfBuff':
      player.pendingBattleDiceBonus = (player.pendingBattleDiceBonus || 0) + (stage.effect.diceBonus || 0);
      player.pendingBattleDamageBonus = (player.pendingBattleDamageBonus || 0) + (stage.effect.dmgBonus || 0);
      break;
    case 'battleMultiply':
      player.pendingBattleDiceMultiplier = stage.effect.multiplier || 1;
      player.pendingBattleDamageBonus = (player.pendingBattleDamageBonus || 0) + (stage.effect.dmgBonus || 0);
      if (stage.effect.splashDmg) player.pendingBattleSplash = { dmg: stage.effect.splashDmg, range: stage.effect.splashRange || 1 };
      break;
    case 'battleEvade':
      player.pendingBattleEvade = { knockback: stage.effect.knockback || 0 };
      break;
    case 'battleOpponentDiceFix':
      player.pendingBattleOpponentDiceFix = stage.effect.value;
      player.pendingBattleDamageBonus = (player.pendingBattleDamageBonus || 0) + (stage.effect.dmgBonus || 0);
      break;
    case 'battleDamageReflect':
      player.pendingBattleDamageReflect = true;
      break;
    case 'trashCopy': {
      if (!player.copiedAbilities || player.copiedAbilities.length === 0) break;
      const discarded = player.copiedAbilities.pop();
      player.pendingBattleDiceBonus = (player.pendingBattleDiceBonus || 0) + (stage.effect.diceBonus || 0);
      addLog(room, `${player.name} は「${discarded.name}」を破棄した`);
      if (stage.effect.ban) {
        if (!room.bannedAbilities) room.bannedAbilities = [];
        room.bannedAbilities.push({ lineId: discarded.sourceLineId, setId: discarded.sourceSetId, expiresAtRound: room.roundNumber + 1 });
        addLog(room, `「${discarded.name.replace('(コピー)', '')}」は次の1ターンの間、全プレイヤーが使用できなくなった`);
      }
      break;
    }
    case 'counterNegate':
      // カウンター自体は効果を持たない（相手の無効化のみ）。hijackはresolveCounterで別途処理
      break;
  }
  const abilityXp = isCopy ? Math.ceil(XP_ABILITY_USE * 0.7) : XP_ABILITY_USE;
  grantXP(room, player, abilityXp, isCopy ? 'コピー能力発動' : '超能力発動');
  return stage.name;
}

function startBattleNegotiation(room, attacker, defender, type, extra) {
  room.pendingBattleChoice = {
    type, attackerId: attacker.id, defenderId: defender.id,
    attackerChoice: undefined, defenderChoice: undefined,
    extra: extra || {},
  };
  [attacker, defender].forEach(p => {
    if (!p.isBot) {
      const opponent = p.id === attacker.id ? defender : attacker;
      io.to(p.id).emit('battleChoicePending', { opponentName: opponent.name });
    }
  });
  if (attacker.isBot) room.pendingBattleChoice.attackerChoice = botChooseBattleAbility(room, attacker);
  if (defender.isBot) room.pendingBattleChoice.defenderChoice = botChooseBattleAbility(room, defender);
  broadcastRoom(room);
  tryResolveBattleNegotiation(room);
}

// マインドハイジャック用: 無効化した相手の効果を、カウンターした側が代わりに得る
function applyHijackedEffect(player, effect) {
  switch (effect.type) {
    case 'battleDebuff':
      player.pendingBattleDebuff = (player.pendingBattleDebuff || 0) + effect.value;
      break;
    case 'battleSelfBuff':
      player.pendingBattleDiceBonus = (player.pendingBattleDiceBonus || 0) + (effect.diceBonus || 0);
      player.pendingBattleDamageBonus = (player.pendingBattleDamageBonus || 0) + (effect.dmgBonus || 0);
      break;
    case 'battleMultiply':
      player.pendingBattleDiceMultiplier = effect.multiplier || 1;
      player.pendingBattleDamageBonus = (player.pendingBattleDamageBonus || 0) + (effect.dmgBonus || 0);
      if (effect.splashDmg) player.pendingBattleSplash = { dmg: effect.splashDmg, range: effect.splashRange || 1 };
      break;
    case 'battleEvade':
      player.pendingBattleEvade = { knockback: effect.knockback || 0 };
      break;
    case 'battleOpponentDiceFix':
      player.pendingBattleOpponentDiceFix = effect.value;
      player.pendingBattleDamageBonus = (player.pendingBattleDamageBonus || 0) + (effect.dmgBonus || 0);
      break;
    case 'battleDamageReflect':
      player.pendingBattleDamageReflect = true;
      break;
  }
}

function tryOfferCounter(room, pb, attacker, defender) {
  let caster = null, casterChoice = null, responder = null, isAttackerCaster = null;
  if (pb.attackerChoice && !pb.defenderChoice) { caster = attacker; casterChoice = pb.attackerChoice; responder = defender; isAttackerCaster = true; }
  else if (pb.defenderChoice && !pb.attackerChoice) { caster = defender; casterChoice = pb.defenderChoice; responder = attacker; isAttackerCaster = false; }
  else return false;

  const counterLines = getAvailableLines(room, responder, 'battle').filter(o => o.stage.type === 'counter');
  if (counterLines.length === 0) return false;

  const casterSet = caster.superSetId ? getSetById(caster.superSetId) : null;
  const casterLine = casterSet ? casterSet.lines.find(l => l.id === casterChoice) : null;
  const casterStage = casterLine ? getLineStage(casterLine, caster.level || 0) : null;
  if (!casterStage) return false;

  pb.counterPending = { casterIsAttacker: isAttackerCaster, casterPowerName: casterStage.name, responderChoice: undefined };

  if (!responder.isBot) {
    io.to(responder.id).emit('counterOpportunity', { casterName: caster.name, powerName: casterStage.name });
    broadcastRoom(room);
    return true;
  } else {
    const pick = Math.random() < 0.5 ? counterLines[0] : null;
    pb.counterPending.responderChoice = pick ? pick.line.id : null;
    broadcastRoom(room);
    resolveCounter(room);
    return true;
  }
}

function resolveCounter(room) {
  const pb = room.pendingBattleChoice;
  if (!pb || !pb.counterPending) return;
  const attacker = getPlayer(room, pb.attackerId);
  const defender = getPlayer(room, pb.defenderId);
  if (!attacker || !defender) { room.pendingBattleChoice = null; return; }
  const cp = pb.counterPending;
  const responder = cp.casterIsAttacker ? defender : attacker;
  const caster = cp.casterIsAttacker ? attacker : defender;

  if (cp.responderChoice) {
    const counterName = applyBattleAbility(room, responder, cp.responderChoice);
    const rSet = responder.superSetId ? getSetById(responder.superSetId) : null;
    if (counterName) io.to(room.id).emit('battleAbilityActivated', { playerId: responder.id, playerName: responder.name, powerName: counterName, setImage: rSet ? rSet.image : null });

    pb.negatedSide = cp.casterIsAttacker ? 'attacker' : 'defender';
    addLog(room, `${responder.name} が ${caster.name} の「${cp.casterPowerName}」をカウンターした！`);

    const counterSet = responder.superSetId ? getSetById(responder.superSetId) : null;
    const counterLineObj = counterSet ? counterSet.lines.find(l => l.id === cp.responderChoice) : null;
    const counterStageObj = counterLineObj ? getLineStage(counterLineObj, responder.level || 0) : null;
    if (counterStageObj && counterStageObj.effect && counterStageObj.effect.hijack) {
      const casterChoiceId = cp.casterIsAttacker ? pb.attackerChoice : pb.defenderChoice;
      const casterSetObj = caster.superSetId ? getSetById(caster.superSetId) : null;
      const casterLineObj = casterSetObj ? casterSetObj.lines.find(l => l.id === casterChoiceId) : null;
      const casterStageObj = casterLineObj ? getLineStage(casterLineObj, caster.level || 0) : null;
      if (casterStageObj) {
        applyHijackedEffect(responder, casterStageObj.effect);
        addLog(room, `${responder.name} は「${cp.casterPowerName}」の力を奪い取った！`);
      }
    }
  }
  pb.counterPending = null;
  pb.counterResolved = true;
  broadcastRoom(room);
  tryResolveBattleNegotiation(room);
}

function tryResolveBattleNegotiation(room) {
  const pb = room.pendingBattleChoice;
  if (!pb) return;
  if (pb.attackerChoice === undefined || pb.defenderChoice === undefined) return;

  const attacker = getPlayer(room, pb.attackerId);
  const defender = getPlayer(room, pb.defenderId);
  if (!attacker || !defender) { room.pendingBattleChoice = null; return; }

  // カウンター発動の機会チェック（まだ提示・解決していない場合のみ）
  if (!pb.counterResolved) {
    const offered = tryOfferCounter(room, pb, attacker, defender);
    if (offered) return; // カウンター選択待ち。resolveCounter経由で再度呼ばれる
    pb.counterResolved = true;
  }

  console.log('[battle] resolving negotiation', {
    attacker: attacker.name, attackerChoice: pb.attackerChoice,
    defender: defender.name, defenderChoice: pb.defenderChoice,
  });

  try {
    const aName = applyBattleAbility(room, attacker, pb.attackerChoice, pb.negatedSide === 'attacker');
    const aSet = attacker.superSetId ? getSetById(attacker.superSetId) : null;
    if (aName) io.to(room.id).emit('battleAbilityActivated', { playerId: attacker.id, playerName: attacker.name, powerName: aName, setImage: aSet ? aSet.image : null });
    else if (pb.attackerChoice) console.log('[battle] attackerChoice was set but applyBattleAbility returned null:', pb.attackerChoice);
  } catch (err) {
    console.error('[battle] error applying attacker ability:', err);
  }

  try {
    const dName = applyBattleAbility(room, defender, pb.defenderChoice, pb.negatedSide === 'defender');
    const dSet = defender.superSetId ? getSetById(defender.superSetId) : null;
    if (dName) io.to(room.id).emit('battleAbilityActivated', { playerId: defender.id, playerName: defender.name, powerName: dName, setImage: dSet ? dSet.image : null });
    else if (pb.defenderChoice) console.log('[battle] defenderChoice was set but applyBattleAbility returned null:', pb.defenderChoice);
  } catch (err) {
    console.error('[battle] error applying defender ability:', err);
  }

  const type = pb.type;
  const extra = pb.extra;
  room.pendingBattleChoice = null;

  try {
    executeBattle(room, attacker, defender);
  } catch (err) {
    console.error('[battle] error in executeBattle:', err);
  }

  if (type === 'path') {
    const steps = extra.moveSteps || 0;
    if (steps > 0) grantXP(room, attacker, steps * XP_PER_TILE, 'マス移動');
    applyRegen(room, attacker);
    resetTurnFlags(attacker);
    addLog(room, `${attacker.name} はターンを終了した`);
    advanceTurn(room);
  }
  broadcastRoom(room);
}

// 共通戦闘処理: attacker=仕掛けた側, defender=仕掛けられた側
function executeBattle(room, attacker, defender) {
  const aP = attacker.role.passive || {};
  const dP = defender.role.passive || {};

  // サイクロン/ハリケーン等の「戦闘回避」判定（ダイスロールなし・引き分け扱い）
  const aEvade = attacker.pendingBattleEvade;
  const dEvade = defender.pendingBattleEvade;
  if (aEvade || dEvade) {
    const battleData = {
      aId: attacker.id, aName: attacker.name, aRoleName: attacker.role.name, aRoleId: attacker.role.id,
      bId: defender.id, bName: defender.name, bRoleName: defender.role.name, bRoleId: defender.role.id,
      evaded: true, result: 'draw',
    };
    if (aEvade) {
      const before = defender.position;
      defender.position = Math.max(0, defender.position - aEvade.knockback);
      const moved = before - defender.position;
      if (moved > 0) addLog(room, `${attacker.name} は戦闘を回避し、${defender.name} を${moved}マス後退させた`);
      else addLog(room, `${attacker.name} は戦闘を回避した`);
      battleData.evadedByName = attacker.name;
      if (moved > 0) { battleData.knockedName = defender.name; battleData.knockback = moved; }
      battleData.knockedId = defender.id; battleData.knockedToPos = defender.position;
    }
    if (dEvade) {
      const before = attacker.position;
      attacker.position = Math.max(0, attacker.position - dEvade.knockback);
      const moved = before - attacker.position;
      if (moved > 0) addLog(room, `${defender.name} は戦闘を回避し、${attacker.name} を${moved}マス後退させた`);
      else addLog(room, `${defender.name} は戦闘を回避した`);
      battleData.evadedByName = battleData.evadedByName ? battleData.evadedByName + '・' + defender.name : defender.name;
      if (moved > 0) { battleData.knockedName = battleData.knockedName ? battleData.knockedName + '・' + attacker.name : attacker.name; battleData.knockback = (battleData.knockback || 0) + moved; }
      battleData.knockedId2 = attacker.id; battleData.knockedToPos2 = attacker.position;
    }
    battleData.aFinalPos = attacker.position;
    battleData.bFinalPos = defender.position;
    addLog(room, '戦闘は不成立に終わった');

    // 使用済みの戦闘用超能力補正をリセット
    attacker.pendingBattleDebuff = 0; defender.pendingBattleDebuff = 0;
    attacker.pendingBattleDiceBonus = 0; defender.pendingBattleDiceBonus = 0;
    attacker.pendingBattleDiceMultiplier = 1; defender.pendingBattleDiceMultiplier = 1;
    attacker.pendingBattleDamageBonus = 0; defender.pendingBattleDamageBonus = 0;
    attacker.pendingBattleSplash = null; defender.pendingBattleSplash = null;
    attacker.pendingBattleEvade = null; defender.pendingBattleEvade = null;
    attacker.pendingBattleOpponentDiceFix = null; defender.pendingBattleOpponentDiceFix = null;
    attacker.pendingBattleDamageReflect = false; defender.pendingBattleDamageReflect = false;

    io.to(room.id).emit('battleRolled', battleData);
    grantXP(room, attacker, XP_BATTLE_DRAW, '戦闘引き分け');
    grantXP(room, defender, XP_BATTLE_DRAW, '戦闘引き分け');
    return battleData;
  }

  const aRoleBonus = (aP.battleDiceBonus || 0) + (aP.attackDiceBonus || 0);
  const dRoleBonus = (dP.battleDiceBonus || 0) + (dP.defendDiceBonus || 0) - (dP.defendDicePenalty || 0);
  const debuff = attacker.pendingBattleDebuff || 0;

  const aAbilityDice = attacker.pendingBattleDiceBonus || 0;
  const dAbilityDice = defender.pendingBattleDiceBonus || 0;
  const aMult = attacker.pendingBattleDiceMultiplier || 1;
  const dMult = defender.pendingBattleDiceMultiplier || 1;
  const aAbilityDmg = attacker.pendingBattleDamageBonus || 0;
  const dAbilityDmg = defender.pendingBattleDamageBonus || 0;
  const aSplash = attacker.pendingBattleSplash;
  const dSplash = defender.pendingBattleSplash;

  const dieA = Math.floor(Math.random() * 6) + 1;
  const dieB = Math.floor(Math.random() * 6) + 1;
  // (基礎ダイス + 役職ボーナス) を超能力の倍率で乗算した後、超能力の固定ダイスボーナスを加算
  let rollA = Math.max(0, (dieA + aRoleBonus) * aMult + aAbilityDice);
  let rollB = Math.max(0, (dieB + dRoleBonus) * dMult + dAbilityDice - debuff);
  // タイムストップ/ジャッジメントタイム: 相手の出目を固定値に上書き（役職・他ボーナスは無視）
  const aFixesOpponent = attacker.pendingBattleOpponentDiceFix;
  const dFixesOpponent = defender.pendingBattleOpponentDiceFix;
  let bFixed = false, aFixed = false;
  if (aFixesOpponent !== undefined && aFixesOpponent !== null) { rollB = aFixesOpponent; bFixed = true; }
  if (dFixesOpponent !== undefined && dFixesOpponent !== null) { rollA = dFixesOpponent; aFixed = true; }

  addLog(room, `戦闘: ${attacker.name}(${rollA}) vs ${defender.name}(${rollB})`);
  const battleData = {
    aId: attacker.id, aName: attacker.name, aDie: dieA, aRoll: rollA, aRoleName: attacker.role.name, aRoleId: attacker.role.id, aBonus: rollA - dieA,
    bId: defender.id, bName: defender.name, bDie: dieB, bRoll: rollB, bRoleName: defender.role.name, bRoleId: defender.role.id, bBonus: rollB - dieB,
    aFixed, bFixed,
  };

  // 結果を先に全て確定（ダメージは適用後の実量を使う）
  let loser = null, winner = null, dmg = 0, dmgBonus = 0, dmgReduction = 0, winnerSplash = null;
  if (rollA > rollB) {
    dmgBonus = (aP.battleDamageBonus || 0) + aAbilityDmg;
    dmgReduction = (dP.battleDamageReduction || 0);
    dmg = Math.max(0, BATTLE_DAMAGE + dmgBonus - dmgReduction);
    battleData.result = 'a';
    loser = defender; winner = attacker; winnerSplash = aSplash;
  } else if (rollB > rollA) {
    dmgBonus = (dP.battleDamageBonus || 0) + dAbilityDmg;
    dmgReduction = (aP.battleDamageReduction || 0);
    dmg = Math.max(0, BATTLE_DAMAGE + dmgBonus - dmgReduction);
    battleData.result = 'b';
    loser = attacker; winner = defender; winnerSplash = dSplash;
  } else {
    battleData.result = 'draw';
  }

  // 使用済みの戦闘用超能力補正をリセット（反射判定のため一時保持してから消す）
  const loserHasReflect = loser ? !!loser.pendingBattleDamageReflect : false;
  attacker.pendingBattleDebuff = 0;
  attacker.pendingBattleDiceBonus = 0; defender.pendingBattleDiceBonus = 0;
  attacker.pendingBattleDiceMultiplier = 1; defender.pendingBattleDiceMultiplier = 1;
  attacker.pendingBattleDamageBonus = 0; defender.pendingBattleDamageBonus = 0;
  attacker.pendingBattleSplash = null; defender.pendingBattleSplash = null;
  attacker.pendingBattleEvade = null; defender.pendingBattleEvade = null;
  attacker.pendingBattleOpponentDiceFix = null; defender.pendingBattleOpponentDiceFix = null;
  attacker.pendingBattleDamageReflect = false; defender.pendingBattleDamageReflect = false;

  // ダメージを先に適用し、実際に反映された量をbattleData/hpChangeに使う
  let actualDmg = 0;
  let reflectTarget = null, reflectActual = 0;
  if (loser) {
    if (loserHasReflect) {
      // タイムカウンター: 自分へのダメージを0にし、その分を相手(勝者)に反射する
      battleData.dmg = 0; battleData.dmgBonus = dmgBonus; battleData.dmgReduction = dmgReduction;
      battleData.reflected = true; battleData.reflectedToName = winner.name;
      reflectTarget = winner;
    } else {
      const { hpApplied } = applyDelta(room, loser, { hp: -dmg });
      actualDmg = -hpApplied; // 実際に減った量（バリア等で無効化されれば0）
      battleData.dmg = actualDmg; battleData.dmgBonus = dmgBonus; battleData.dmgReduction = dmgReduction;
      battleData.blocked = actualDmg === 0 && dmg > 0;
    }
  }

  // battleRolled → hpChange の順で送信（キューに正しい順序で積まれる）
  io.to(room.id).emit('battleRolled', battleData);

  if (loser) {
    if (loserHasReflect) {
      const { hpApplied } = applyDelta(room, reflectTarget, { hp: -dmg });
      reflectActual = -hpApplied;
      if (reflectActual > 0) {
        emitHpChange(room, reflectTarget, -reflectActual);
        addLog(room, `${loser.name} はタイムカウンターでダメージを無効化し、${reflectActual}のダメージを${reflectTarget.name}に返した`);
      } else {
        addLog(room, `${loser.name} はタイムカウンターでダメージを無効化した`);
      }
    } else if (actualDmg > 0) {
      emitHpChange(room, loser, -actualDmg);
      addLog(room, `${loser.name} は戦闘に敗れ、体力を${actualDmg}失った`);
    } else {
      addLog(room, `${loser.name} は戦闘に敗れたが、ダメージを無効化した`);
    }
    grantXP(room, winner, XP_BATTLE_WIN, '戦闘勝利');
    grantXP(room, loser, XP_BATTLE_LOSE, '戦闘敗北');
  } else {
    addLog(room, '戦闘は引き分けに終わった');
    grantXP(room, attacker, XP_BATTLE_DRAW, '戦闘引き分け');
    grantXP(room, defender, XP_BATTLE_DRAW, '戦闘引き分け');
  }

  // 勝者のスプラッシュ効果（例: エンドレスインフェルノ）
  if (winner && winnerSplash) {
    const range = winnerSplash.range || 1;
    const targets = room.players.filter(t =>
      t.id !== attacker.id && t.id !== defender.id && !t.finished && t.incapacitatedTurns === 0 &&
      Math.abs(t.position - winner.position) <= range && t.position !== winner.position
    );
    targets.forEach(t => {
      const { hpApplied } = applyDelta(room, t, { hp: -winnerSplash.dmg });
      if (hpApplied !== 0) {
        emitHpChange(room, t, hpApplied);
        addLog(room, `${t.name} は${winner.name}の業火に巻き込まれ、体力を${-hpApplied}失った`);
      }
    });
  }

  return battleData;
}

function grantXP(room, p, amount, reason) {
  if (!amount || amount <= 0) return;
  const mult = (p.role && p.role.passive && p.role.passive.xpMultiplier) || 1;
  const final = Math.ceil(amount * mult);
  p.xp = (p.xp || 0) + final;
  console.log(`[XP] ${p.name}: +${final} (${reason}) → 合計 ${p.xp}`);
  addLog(room, `${p.name} は${reason}で経験値${final}を得た`);
  checkLevelUp(room, p);
}

function checkLevelUp(room, p) {
  while (p.level < MAX_LEVEL && p.xp >= LEVEL_XP[p.level + 1]) {
    p.level += 1;
    addLog(room, `${p.name} がレベル${p.level}に上がった！`);
    // 超能力の解放・進化はレベルから動的に判定されるため、ここでは通知のみ行う
    const set = p.superSetId ? getSetById(p.superSetId) : null;
    if (set) {
      set.lines.forEach(line => {
        const changed = line.stages.find(st => st.level === p.level);
        if (changed) {
          const isFirst = line.stages.indexOf(changed) === 0;
          const msg = isFirst ? `${p.name} の超能力「${changed.name}」が解放された！` : `${p.name} の超能力が「${changed.name}」に進化した！`;
          addLog(room, msg, { secret: true, ownerId: p.id, abilityName: changed.name, hiddenMsg: isFirst ? `${p.name} の超能力が解放された！` : `${p.name} の超能力が進化した！` });
        }
      });
    }
    if (p.level === 3) {
      p.maxHp += 2;
      p.maxEnergy += 2;
      p.hp = Math.min(p.hp + 2, p.maxHp);
      p.energy = Math.min(p.energy + 2, p.maxEnergy);
      addLog(room, `${p.name} はレベル3到達！ HP上限+2、PSY上限+2`);
    }
    io.to(room.id).emit('levelUp', { playerId: p.id, playerName: p.name, level: p.level });
  }
}

function distributeSuperSet(room) {
  room.players.forEach((p) => {
    const set = SUPER_SETS[Math.floor(Math.random() * SUPER_SETS.length)];
    p.superSetId = set.id;
    p.powersConfirmed = p.isBot ? true : false;
    addLog(room, `${p.name} は超能力セット「${set.name}」に目覚めた`, { secret: true, ownerId: p.id, abilityName: set.name, hiddenMsg: `${p.name} は超能力に目覚めた` });
  });
}

function advanceTurn(room) {
  if (room.phase !== 'playing') return;

  // 災害チェック: 直前に終わったターンをカウントし、抽選されたターン数に達したら発生させる
  room.globalTurnCount = (room.globalTurnCount || 0) + 1;
  if (!room.disasterFired && room.disasterTriggerTurn && room.globalTurnCount >= room.disasterTriggerTurn) {
    room.disasterFired = true;
    resolveDisaster(room, null);
  }

  let guard = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
    if (room.turnIndex === 0) {
      room.roundNumber += 1;
      cleanupBannedAbilities(room);
    }
    const currentId = room.turnOrder[room.turnIndex];
    const current = getPlayer(room, currentId);
    if (!current) { guard++; continue; }
    if (current.incapacitatedTurns > 0) {
      current.incapacitatedTurns -= 1;
      applyRegen(room, current);
      addLog(room, `${current.name} は行動不能のためターンをスキップした（残り${current.incapacitatedTurns}ターン）`);
      guard++;
      continue;
    }
    break;
  } while (guard < room.turnOrder.length * 3);

  // ターン開始通知
  const nextPlayer = getPlayer(room, room.turnOrder[room.turnIndex]);
  if (nextPlayer) {
    io.to(room.id).emit('turnStart', { playerId: nextPlayer.id, playerName: nextPlayer.name });
  }

  // Botのターンなら自動行動を開始
  scheduleBotTurn(room);
}

// 災害の効果適用ヘルパー: 1人分のHP/エナジー/移動変化を、通知含めて安全に適用する
function applyDisasterDelta(room, pl, { hp, energy, move } = {}) {
  if (hp) {
    const { hpApplied } = applyDelta(room, pl, { hp });
    if (hpApplied !== 0) emitHpChange(room, pl, hpApplied);
  }
  if (energy) {
    const before = pl.energy;
    applyDelta(room, pl, { energy });
    const energyApplied = pl.energy - before;
    if (energyApplied !== 0) emitEnergyChange(room, pl, energyApplied);
  }
  if (move) {
    const before = pl.position;
    pl.position = clamp(pl.position + move, 0, BOARD_SIZE);
    checkGoal(room, pl);
    if (pl.position !== before) {
      io.to(room.id).emit('disasterMoveResult', { playerId: pl.id, playerName: pl.name, fromPos: before, toPos: pl.position });
    }
  }
}

// 災害: マップごとに1度、抽選されたターンの終わりに発生する（自然発生）。
// 祈祷による発動時はexcludePlayerIdに発動者のidを渡し、その本人だけ効果を除外する。
// プレイヤー人数に応じて「最初のDISASTER_MIN_ROUNDSラウンドを除外した」トリガーターンを抽選する
function computeDisasterTriggerTurn(room) {
  const playerCount = room.turnOrder.length || 1;
  const minTurn = playerCount * DISASTER_MIN_ROUNDS + 1; // これより後のターンでのみ発生しうる
  const maxTurn = minTurn + DISASTER_EXTRA_TURNS;
  return minTurn + Math.floor(Math.random() * (maxTurn - minTurn + 1));
}

function resolveDisaster(room, excludePlayerId) {
  const disaster = pickRandomDisaster();
  if (!disaster) return;
  console.log('[resolveDisaster] picked disaster:', disaster.id, disaster.name);
  addLog(room, `災害発生: ${disaster.label}`);
  // 先に発生バナーを送り、その後に各プレイヤーへの影響を通知する（表示順序を保証）
  io.to(room.id).emit('disasterTriggered', { name: disaster.name, label: disaster.label, image: disaster.image });

  const activePlayers = room.players.filter(pl => !pl.finished && pl.id !== excludePlayerId);

  switch (disaster.id) {
    case 'arawa': {
      // 全員に3ダメージ。全員サイコロを一度振り、次の1周の移動がその目の分だけ減少する
      activePlayers.forEach(pl => {
        const roll = Math.floor(Math.random() * 6) + 1;
        // 先にダイス演出イベントを送信し、結果（HP減少）はその後に届くようにする
        console.log('[resolveDisaster:arawa] emitting disasterPlayerRoll for', pl.name, 'roll:', roll);
        io.to(room.id).emit('disasterPlayerRoll', {
          playerId: pl.id, playerName: pl.name, roll,
          disasterId: disaster.id, disasterName: disaster.name,
          introText: `${pl.name} は荒波の中でサイコロを振る`,
          resultText: `次の移動が${roll}マス減少する`,
        });
        pl.pendingIncomingMoveEffect = { mode: 'reduce', value: roll };
        addLog(room, `${pl.name} は荒波の中でサイコロを振り、${roll}の目が出た（次の移動が${roll}減少する）`);
        applyDisasterDelta(room, pl, { hp: -3 });
      });
      break;
    }
    case 'jiware': {
      // 全員5マス後退
      activePlayers.forEach(pl => applyDisasterDelta(room, pl, { move: -5 }));
      break;
    }
    case 'oohiji': {
      // 全員に5ダメージ
      activePlayers.forEach(pl => applyDisasterDelta(room, pl, { hp: -5 }));
      break;
    }
    case 'taifu': {
      // 全員サイコロを一度振り、その目の分だけ後退。全員サイコエナジー-3
      activePlayers.forEach(pl => {
        const roll = Math.floor(Math.random() * 6) + 1;
        console.log('[resolveDisaster:taifu] emitting disasterPlayerRoll for', pl.name, 'roll:', roll);
        io.to(room.id).emit('disasterPlayerRoll', {
          playerId: pl.id, playerName: pl.name, roll,
          disasterId: disaster.id, disasterName: disaster.name,
          introText: `${pl.name} は台風の中でサイコロを振る`,
          resultText: `${roll}マス後退する`,
        });
        addLog(room, `${pl.name} は台風の中でサイコロを振り、${roll}の目が出た（${roll}マス後退する）`);
        applyDisasterDelta(room, pl, { move: -roll, energy: -3 });
      });
      break;
    }
    case 'gouu': {
      // 全員サイコエナジー-5
      activePlayers.forEach(pl => applyDisasterDelta(room, pl, { energy: -5 }));
      break;
    }
    case 'ameame': {
      // 全員HP+3・サイコエナジー+3。次の移動のサイコロが-3される
      activePlayers.forEach(pl => {
        applyDisasterDelta(room, pl, { hp: 3, energy: 3 });
        pl.pendingIncomingMoveEffect = { mode: 'reduce', value: 3 };
      });
      break;
    }
  }
}

/* ========== Bot AI ========== */

function scheduleBotTurn(room) {
  if (room.phase !== 'playing') return;
  const currentId = room.turnOrder[room.turnIndex];
  const current = getPlayer(room, currentId);
  if (!current || !current.isBot) return;
  setTimeout(() => botTakeTurn(room, current), 2000);
}

function botTakeTurn(room, bot) {
  if (room.phase !== 'playing') return;
  if (room.turnOrder[room.turnIndex] !== bot.id) return;
  if (bot.actionTaken) return;

  // 能力使用判断 (移動前)
  const usedAbility = botTryUseAbility(room, bot);
  const abilityExtra = usedAbility ? 1800 : 0;

  // 行動選択: HP低い場合は休息、そうでなければサイコロ
  if (bot.hp <= bot.maxHp * 0.3 && !bot.restedThisTurn) {
    bot.actionTaken = true;
    bot.restedThisTurn = true;
    addLog(room, `${bot.name} は休息を選択した`);
    broadcastRoom(room);
    setTimeout(() => botEndTurn(room, bot), BOT_DELAY + abilityExtra);
  } else {
    // サイコロを振る
    let baseRoll, bonus, roll;
    let gamblerAdjust = 0;
    if (bot.pendingFixedMove) {
      baseRoll = bot.pendingFixedMove; bonus = 0; roll = baseRoll; bot.pendingFixedMove = 0;
    } else {
      const bPassive = bot.role.passive || {};
      baseRoll = Math.floor(Math.random() * 6) + 1;
      if (bPassive.gamblerEffect) {
        gamblerAdjust = (baseRoll % 2 === 1) ? -3 : 3;
      }
      bonus = (bot.pendingDiceBonus || 0) + (bPassive.moveDiceBonus || 0) + gamblerAdjust;
      roll = Math.max(0, baseRoll + bonus);
    }
    bot.pendingDiceBonus = 0;

    if (bot.pendingIncomingMoveEffect) {
      const eff = bot.pendingIncomingMoveEffect;
      bot.pendingIncomingMoveEffect = null;
      if (eff.mode === 'fixed') { baseRoll = eff.value; bonus = 0; roll = eff.value; }
      else if (eff.mode === 'reduce') { roll = Math.max(0, roll - eff.value); }
      addLog(room, `${bot.name} は時間の干渉を受けた`);
    }

    bot.actionTaken = true;
    const startPos = bot.position;

    // パスを1マスずつチェック
    let battleOnPath = false;
    let battlePos = 0;
    let battleOpp = null;
    for (let step = 1; step <= roll; step++) {
      const pos = Math.min(startPos + step, BOARD_SIZE);
      if (pos <= 0) continue;
      const opponents = room.players.filter(p =>
        p.id !== bot.id && p.position === pos && !p.finished && p.incapacitatedTurns === 0
      );
      if (opponents.length > 0 && step < roll && Math.random() < 0.35) {
        const opp = opponents[0];
        bot.position = pos;
        checkTrapsOnPath(room, bot, startPos, pos);
        bot.battleDoneThisTurn = true;
        bot.lastPathBattle = { opponentId: opp.id, position: pos };
        battleOnPath = true; battlePos = pos; battleOpp = opp;
        break;
      }
      if (pos >= BOARD_SIZE) break;
    }

    if (!battleOnPath) {
      bot.position = Math.min(startPos + roll, BOARD_SIZE);
      checkTrapsOnPath(room, bot, startPos, bot.position);
      grantXP(room, bot, roll * XP_PER_TILE, 'マス移動');
      checkGoal(room, bot);
      let cellEventLabel = null;
      let cellMoveDelta = 0;
      let cellHpApplied = 0;
      if (!bot.finished) {
        const event = pickWeightedCellEvent();
        cellEventLabel = event.label;
        addLog(room, `${bot.name} が止まったマス: ${event.label}`);
        const delta = event.apply(bot);
        if (delta.move) { cellMoveDelta = delta.move; bot.position = clamp(bot.position + delta.move, 0, BOARD_SIZE); }
        if (delta.hp) { const { hpApplied } = applyDelta(room, bot, { hp: delta.hp }); cellHpApplied = hpApplied; }
        if (delta.energy) applyDelta(room, bot, { energy: delta.energy });
        checkGoal(room, bot);
      }
      addLog(room, `${bot.name} はサイコロを振り、${roll}マス進む`);
      io.to(room.id).emit('diceRolled', { playerId: bot.id, baseRoll, bonus, total: roll, startPos, finalPos: Math.min(startPos + roll, BOARD_SIZE), roleName: bot.role.name, roleBonus: (bot.role.passive||{}).moveDiceBonus||0, isGambler: !!(bot.role.passive||{}).gamblerEffect, gamblerAdjust });
      broadcastRoom(room);
      if (cellEventLabel) {
        io.to(room.id).emit('cellEventResult', { playerId: bot.id, label: cellEventLabel, moveDelta: cellMoveDelta, finalPos: bot.position });
      }
      if (cellHpApplied !== 0) emitHpChange(room, bot, cellHpApplied);
      const steps=Math.min(roll,BOARD_SIZE-startPos);
      const animTime=1800+1200+300+steps*450+2500;
      setTimeout(() => botEndTurn(room, bot), animTime);
    } else {
      addLog(room, `${bot.name} はサイコロを振り、${roll}マス進む`);
      io.to(room.id).emit('diceRolled', { playerId: bot.id, baseRoll, bonus, total: roll, startPos, finalPos: battlePos, roleName: bot.role.name, roleBonus: (bot.role.passive||{}).moveDiceBonus||0, isGambler: !!(bot.role.passive||{}).gamblerEffect, gamblerAdjust });
      broadcastRoom(room);
      addLog(room, `${bot.name} が移動中に ${battleOpp.name} に戦闘を仕掛けた`);
      // 交渉フローに移行（ターン終了はtryResolveBattleNegotiationが担当）
      startBattleNegotiation(room, bot, battleOpp, 'path', { moveSteps: battlePos - startPos });
    }
  }
}

function placeTrap(room, player, stage) {
  if (!room.traps) room.traps = [];
  const trap = {
    id: 'trap_' + (++room._trapIdCounter || (room._trapIdCounter = 1)),
    ownerId: player.id, ownerName: player.name,
    position: player.position, dmg: stage.effect.dmg,
    hitPlayers: [player.id], // 設置者は最初から免疫
  };
  room.traps.push(trap);
  addLog(room, `${player.name} がマス${player.position}に罠を仕掛けた`, { secret: true, ownerId: player.id, abilityName: stage.name, hiddenMsg: `${player.name} が罠を仕掛けた` });
}

// fromPos(exclusive)〜toPos(inclusive)を通過した際の罠ダメージを判定
function checkTrapsOnPath(room, player, fromPos, toPos) {
  if (!room.traps || room.traps.length === 0) return;
  const dir = toPos > fromPos ? 1 : (toPos < fromPos ? -1 : 0);
  if (dir === 0) return;
  for (let pos = fromPos + dir; ; pos += dir) {
    room.traps.forEach(trap => {
      if (trap.position !== pos) return;
      if (trap.hitPlayers.includes(player.id)) return;
      trap.hitPlayers.push(player.id);
      const { hpApplied } = applyDelta(room, player, { hp: -trap.dmg });
      if (hpApplied !== 0) {
        emitHpChange(room, player, hpApplied);
        addLog(room, `${player.name} は${trap.ownerName}の罠にかかり、体力を${-hpApplied}失った`);
      }
    });
    if (pos === toPos) break;
  }
}
function botTryUseAbility(room, bot) {
  const options = getAvailableLines(room, bot, null).filter(o => o.stage.timing !== 'battle' && o.stage.type === 'self');
  if (options.length === 0) return false;
  for (const { line, stage } of options) {
    let shouldUse = false;
    switch (stage.effect.type) {
      case 'diceBonus': case 'fixedMove': shouldUse = Math.random() < 0.5; break;
      case 'heal': shouldUse = bot.hp <= bot.maxHp * 0.5; break;
      case 'precognition_block': shouldUse = Math.random() < 0.3; break;
      case 'barrier': case 'barrierHeal': shouldUse = !bot.hasBarrier && Math.random() < 0.4; break;
      case 'trap': shouldUse = Math.random() < 0.4; break;
      case 'moveDebuffAll': shouldUse = Math.random() < 0.6; break;
      case 'disasterForesight': shouldUse = Math.random() < 0.3; break;
      case 'triggerDisasterPrayer': shouldUse = !bot.disasterPrayerUsed && Math.random() < 0.15; break;
      case 'copyAbility': {
        const history = ((room.abilityHistoryByPosition && room.abilityHistoryByPosition[bot.position]) || []).filter(h => h.ownerId !== bot.id);
        shouldUse = history.length > 0 && Math.random() < 0.5;
        break;
      }
      case 'energyDrain': {
        const targets = room.players.filter(t => t.id !== bot.id && t.position === bot.position && !t.finished && t.incapacitatedTurns === 0 && t.energy > 0);
        shouldUse = targets.length > 0 && Math.random() < 0.5;
        break;
      }
      case 'directDamage': {
        const targets = room.players.filter(t => t.id !== bot.id && t.position === bot.position && !t.finished);
        shouldUse = targets.length > 0 && Math.random() < 0.5;
        break;
      }
    }
    if (shouldUse) {
      bot.energy -= stage.cost;
      if (!bot.usedTimings) bot.usedTimings = [];
      bot.usedTimings.push(stage.timing);
      addLog(room, `${bot.name} は「${stage.name}」を発動した`, { secret: true, ownerId: bot.id, abilityName: stage.name, hiddenMsg: `${bot.name} は超能力を発動した` });
      grantXP(room, bot, XP_ABILITY_USE, '超能力発動');
      if (stage.sourceLineId === undefined) recordAbilityUse(room, bot, line.id, stage);
      const botSet = bot.superSetId ? getSetById(bot.superSetId) : null;
      io.to(room.id).emit('abilityActivated', { playerId: bot.id, playerName: bot.name, powerName: stage.name, setImage: botSet ? botSet.image : null });
      switch (stage.effect.type) {
        case 'diceBonus': bot.pendingDiceBonus += stage.effect.value; break;
        case 'fixedMove': bot.pendingFixedMove = stage.effect.value; break;
        case 'heal': { const { hpApplied } = applyDelta(room, bot, { hp: stage.effect.value }); if (hpApplied !== 0) emitHpChange(room, bot, hpApplied); break; }
        case 'precognition_block': bot.blockNextBadEvent = true; break;
        case 'barrier': bot.hasBarrier = true; break;
        case 'barrierHeal': { bot.hasBarrier = true; const { hpApplied } = applyDelta(room, bot, { hp: stage.effect.healValue || 1 }); if (hpApplied !== 0) emitHpChange(room, bot, hpApplied); break; }
        case 'trap': placeTrap(room, bot, stage); break;
        case 'copyAbility': {
          const history = ((room.abilityHistoryByPosition && room.abilityHistoryByPosition[bot.position]) || []).filter(h => h.ownerId !== bot.id);
          if (history.length > 0) {
            const record = history[Math.floor(Math.random() * history.length)];
            const bonus = stage.effect.bonus || 0;
            const clonedEffect = JSON.parse(JSON.stringify(record.stage.effect));
            if (bonus) {
              if (clonedEffect.value !== undefined) clonedEffect.value += bonus;
              if (clonedEffect.diceBonus !== undefined) clonedEffect.diceBonus += bonus;
            }
            if (!bot.copiedAbilities) bot.copiedAbilities = [];
            bot._copyCounter = (bot._copyCounter || 0) + 1;
            bot.copiedAbilities.push({
              id: 'copy_' + bot.id + '_' + bot._copyCounter, sourceLineId: record.lineId, sourceSetId: record.setId, sourceOwnerName: record.ownerName,
              name: record.stage.name + '(コピー)', description: record.stage.description, cost: record.stage.cost,
              timing: record.stage.timing, type: record.stage.type, effect: clonedEffect,
            });
            addLog(room, `${bot.name} は ${record.ownerName} の「${record.stage.name}」をコピーした！`);
          }
          break;
        }
        case 'moveDebuffAll': {
          const others = room.players.filter(t => t.id !== bot.id && !t.finished);
          others.forEach(t => { t.pendingIncomingMoveEffect = { mode: stage.effect.mode, value: stage.effect.value }; });
          addLog(room, `${bot.name} は時間を操り、他の全プレイヤーの次の移動に干渉した`);
          break;
        }
        case 'disasterForesight': {
          addLog(room, `${bot.name} は予知の祈祷を行った`, { secret: true, ownerId: bot.id, abilityName: stage.name, hiddenMsg: `${bot.name} は超能力を発動した` });
          break;
        }
        case 'triggerDisasterPrayer': {
          bot.disasterPrayerUsed = true;
          addLog(room, `${bot.name} が災害の祈祷を捧げた…`);
          resolveDisaster(room, bot.id);
          break;
        }
        case 'energyDrain': {
          const targets = room.players.filter(t => t.id !== bot.id && t.position === bot.position && !t.finished && t.incapacitatedTurns === 0 && t.energy > 0);
          if (targets.length > 0) {
            const tgt = targets[0];
            const before = tgt.energy;
            if (stage.effect.setZero) tgt.energy = 0;
            else tgt.energy = clamp(tgt.energy - (stage.effect.value || 0), 0, tgt.maxEnergy);
            const energyApplied = tgt.energy - before;
            if (energyApplied !== 0) { emitEnergyChange(room, tgt, energyApplied); addLog(room, `${tgt.name} は${bot.name}にサイコエナジーを${-energyApplied}奪われた`); }
          }
          break;
        }
        case 'directDamage': {
          const targets = room.players.filter(t => t.id !== bot.id && t.position === bot.position && !t.finished && t.incapacitatedTurns === 0);
          if (targets.length > 0) {
            const tgt = targets[0];
            const { hpApplied } = applyDelta(room, tgt, { hp: -(stage.effect.value) });
            if (hpApplied !== 0) { emitHpChange(room, tgt, hpApplied); addLog(room, `${tgt.name} は${-hpApplied}のダメージを受けた`); }
            else { addLog(room, `${tgt.name} へのダメージは無効化された`); }
          }
          break;
        }
      }
      return true; // 1ターンに1回だけ使用
    }
  }
  return false;
}

function botEndTurn(room, bot) {
  if (room.phase !== 'playing') return;
  if (room.turnOrder[room.turnIndex] !== bot.id) return;
  if (!bot.actionTaken) return;
  if (room.pendingBattle) return;

  applyRegen(room, bot);
  resetTurnFlags(bot);
  addLog(room, `${bot.name} はターンを終了した`);
  advanceTurn(room);
  broadcastRoom(room);
}

function botAutoSelectRoles(room) {
  if (room.phase !== 'roleSelect') return;
  room.players.forEach((p) => {
    if (p.isBot && !p.roleId) {
      setTimeout(() => {
        if (room.phase !== 'roleSelect' || p.roleId) return;
        const role = ROLES[Math.floor(Math.random() * ROLES.length)];
        p.roleId = role.id;
        p.role = role;
        addLog(room, `${p.name} が役職「${role.name}」を選択した`);

        if (room.players.every((pl) => pl.roleId)) {
          distributeSuperSet(room);
          room.phase = 'powerReveal';
          addLog(room, '超能力が覚醒しました。各自の能力を確認してください');
          // Botは自動で確認済み
          if (room.players.every((pl) => pl.powersConfirmed)) {
            room.players.forEach((pl) => initPlayerForGame(pl));
            room.phase = 'playing';
            room.turnIndex = 0;
            room.roundNumber = 1;
            room.globalTurnCount = 0;
            room.disasterFired = false;
            room.disasterTriggerTurn = computeDisasterTriggerTurn(room);
            addLog(room, 'ゲームプレイを開始します');
            broadcastRoom(room);
            const first = getPlayer(room, room.turnOrder[room.turnIndex]);
            if (first) io.to(room.id).emit('turnStart', { playerId: first.id, playerName: first.name });
            scheduleBotTurn(room);
          } else {
            broadcastRoom(room);
          }
        } else {
          broadcastRoom(room);
        }
      }, BOT_DELAY + Math.random() * 800);
    }
  });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      players: [{ id: socket.id, name: name || 'Player', ready: false, color: PLAYER_COLORS[0] }],
      phase: 'lobby',
      turnOrder: [],
      turnIndex: 0,
      roundNumber: 0,
      log: [],
      traps: [],
      _trapIdCounter: 0,
      abilityHistoryByPosition: {},
      bannedAbilities: [],
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('errorMsg', { message: '指定されたロビーIDが見つかりません' });
    if (room.phase !== 'lobby') return socket.emit('errorMsg', { message: 'このロビーはすでにゲームが開始されています' });
    if (room.players.length >= MAX_PLAYERS) return socket.emit('errorMsg', { message: 'ロビーの定員（4人）に達しています' });
    room.players.push({ id: socket.id, name: name || 'Player', ready: false, color: PLAYER_COLORS[room.players.length % PLAYER_COLORS.length] });
    socket.join(roomId);
    broadcastRoom(room);
  });

  socket.on('toggleReady', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'lobby') return;
    const player = getPlayer(room, socket.id);
    if (!player) return;
    player.ready = !player.ready;
    broadcastRoom(room);
  });

  socket.on('addBot', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) { console.log('addBot: room not found for', socket.id); return socket.emit('errorMsg', { message: 'ロビーが見つかりません。再度ロビーを作成してください' }); }
    if (room.phase !== 'lobby') return socket.emit('errorMsg', { message: 'ロビー画面でのみBotを追加できます' });
    if (room.hostId !== socket.id) return socket.emit('errorMsg', { message: 'Botの追加はホストのみ実行できます' });
    if (room.players.length >= MAX_PLAYERS) return socket.emit('errorMsg', { message: 'ロビーの定員（4人）に達しています' });
    botIdCounter++;
    const botId = 'bot_' + botIdCounter;
    const botIndex = room.players.length;
    const botName = BOT_NAMES[botIndex % BOT_NAMES.length] + '(Bot)';
    room.players.push({
      id: botId,
      name: botName,
      ready: true,
      isBot: true,
      color: PLAYER_COLORS[botIndex % PLAYER_COLORS.length],
    });
    addLog(room, `${botName} がロビーに参加した`);
    console.log('addBot: added', botName, 'to room', room.id, 'players:', room.players.length);
    broadcastRoom(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'lobby') return;
    if (room.hostId !== socket.id) return socket.emit('errorMsg', { message: 'Botの削除はホストのみ実行できます' });
    const bot = room.players.find(p => p.id === botId && p.isBot);
    if (!bot) return;
    room.players = room.players.filter(p => p.id !== botId);
    addLog(room, `${bot.name} がロビーから退出した`);
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('errorMsg', { message: 'ゲーム開始はホストのみ実行できます' });
    if (room.players.length < MIN_PLAYERS) return socket.emit('errorMsg', { message: `開始には最低${MIN_PLAYERS}人が必要です` });
    if (!room.players.every((p) => p.ready)) return socket.emit('errorMsg', { message: '全員が準備完了していません' });

    room.phase = 'roleSelect';
    room.turnOrder = room.players.map((p) => p.id);
    addLog(room, 'ゲームが開始されました。各プレイヤーは役職を選択してください');
    broadcastRoom(room);
    botAutoSelectRoles(room);
  });

  socket.on('selectRole', ({ roleId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'roleSelect') return;
    const role = ROLES.find((r) => r.id === roleId);
    if (!role) return socket.emit('errorMsg', { message: '無効な役職です' });
    const player = getPlayer(room, socket.id);
    if (!player) return;
    player.roleId = role.id;
    player.role = role;
    addLog(room, `${player.name} が役職「${role.name}」を選択した`);

    if (room.players.every((p) => p.roleId)) {
      distributeSuperSet(room);
      room.phase = 'powerReveal';
      addLog(room, '超能力が覚醒しました。各自の能力を確認してください');
    }
    broadcastRoom(room);
  });

  socket.on('confirmPowers', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'powerReveal') return;
    const player = getPlayer(room, socket.id);
    if (!player) return;
    player.powersConfirmed = true;
    if (room.players.every((p) => p.powersConfirmed)) {
      room.players.forEach((p) => initPlayerForGame(p));
      room.phase = 'playing';
      room.turnIndex = 0;
      room.roundNumber = 1;
      room.globalTurnCount = 0;
      room.disasterFired = false;
      room.disasterTriggerTurn = computeDisasterTriggerTurn(room);
      addLog(room, 'ゲームプレイを開始します');
      broadcastRoom(room);
      const first = getPlayer(room, room.turnOrder[room.turnIndex]);
      if (first) io.to(room.id).emit('turnStart', { playerId: first.id, playerName: first.name });
      scheduleBotTurn(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('rollDice', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) {
      return socket.emit('errorMsg', { message: '自分のターンではありません' });
    }
    if (player.actionTaken) return socket.emit('errorMsg', { message: 'このターンはすでに行動済みです' });

    const passive = player.role.passive || {};
    let baseRoll, bonus, roll, gamblerAdjust = 0;
    if (player.pendingFixedMove) {
      baseRoll = player.pendingFixedMove; bonus = 0; roll = baseRoll; player.pendingFixedMove = 0;
    } else {
      if (passive.tripleDicePerMap && player.useTripleDiceNow) {
        const d1=Math.floor(Math.random()*6)+1, d2=Math.floor(Math.random()*6)+1, d3=Math.floor(Math.random()*6)+1;
        baseRoll = d1+d2+d3;
        player.hasUsedTripleDice = true;
        player.useTripleDiceNow = false;
        player._tripleDice = [d1,d2,d3];
        addLog(room, `${player.name} はサイコロを3個振った！(${d1}+${d2}+${d3}=${baseRoll})`);
      } else {
        baseRoll = Math.floor(Math.random() * 6) + 1;
      }
      // ギャンブラー効果（出目そのものは変えず、別ボーナスとして加算）
      if (passive.gamblerEffect) {
        gamblerAdjust = (baseRoll % 2 === 1) ? -3 : 3;
      }
      bonus = (player.pendingDiceBonus || 0) + (passive.moveDiceBonus || 0) + gamblerAdjust;
      roll = Math.max(0, baseRoll + bonus);
    }
    player.pendingDiceBonus = 0;

    // タイムジャマー/タイムグラヴィティの影響を適用（次の移動を減少 or 固定）
    let timeEffectApplied = null;
    if (player.pendingIncomingMoveEffect) {
      const eff = player.pendingIncomingMoveEffect;
      player.pendingIncomingMoveEffect = null; // 先にクリアしてから適用（多重適用防止）
      if (eff.mode === 'fixed') {
        baseRoll = eff.value; bonus = 0; roll = eff.value;
        timeEffectApplied = `移動距離が${eff.value}マスに固定された`;
      } else if (eff.mode === 'reduce') {
        roll = Math.max(0, roll - eff.value);
        timeEffectApplied = `移動距離が${eff.value}マス減少した`;
      }
      addLog(room, `${player.name} は${timeEffectApplied}`);
    }

    player.actionTaken = true;
    player.moveStartPos = player.position;
    player.pendingMoveTotal = roll;
    // 移動はまだ確定しない — confirmMove/battleOnPath を待つ

    addLog(room, `${player.name} はサイコロを振り、${roll}マス進む`);

    io.to(room.id).emit('diceRolled', {
      playerId: player.id,
      baseRoll,
      bonus,
      total: roll,
      startPos: player.position,
      roleName: player.role.name,
      roleBonus: passive.moveDiceBonus || 0,
      isGambler: !!passive.gamblerEffect,
      gamblerAdjust,
      tripleDice: player._tripleDice || null,
      timeEffect: timeEffectApplied,
    });
    player._tripleDice = null;
    broadcastRoom(room);
  });

  socket.on('activateTripleDice', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) return;
    if (player.actionTaken) return socket.emit('errorMsg', { message: 'すでに行動済みです' });
    const passive = player.role.passive || {};
    if (!passive.tripleDicePerMap || player.hasUsedTripleDice) return socket.emit('errorMsg', { message: 'トリプルダイスはすでに使用済みです' });
    player.useTripleDiceNow = true;
    addLog(room, `${player.name} はトリプルダイスを発動！`);
    broadcastRoom(room);
  });

  socket.on('rerollDice', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) return;
    if (!player.pendingMoveTotal) return socket.emit('errorMsg', { message: '振り直すサイコロがありません' });
    const passive = player.role.passive || {};
    if (!passive.rerollPerTurn || player.hasRerolledThisTurn) return socket.emit('errorMsg', { message: '振り直しはすでに使用済みです' });

    player.hasRerolledThisTurn = true;
    let baseRoll = Math.floor(Math.random() * 6) + 1;
    let gamblerAdjust = 0;
    if (passive.gamblerEffect) {
      gamblerAdjust = (baseRoll % 2 === 1) ? -3 : 3;
    }
    const moveBonus = passive.moveDiceBonus || 0;
    const totalBonus = moveBonus + gamblerAdjust;
    const roll = Math.max(0, baseRoll + totalBonus);
    player.pendingMoveTotal = roll;
    player.moveStartPos = player.position;

    addLog(room, `${player.name} はサイコロを振り直した！ ${roll}マス進む`);
    io.to(room.id).emit('diceRolled', { playerId: player.id, baseRoll, bonus: totalBonus, total: roll, startPos: player.position, reroll: true, roleName: player.role.name, roleBonus: moveBonus, isGambler: !!passive.gamblerEffect, gamblerAdjust });
    broadcastRoom(room);
  });

  socket.on('confirmMove', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') { console.log('[confirmMove] room not found or not playing'); return; }
    const player = getPlayer(room, socket.id);
    if (!player) { console.log('[confirmMove] player not found'); return; }
    if (!player.pendingMoveTotal) { console.log('[confirmMove] no pendingMoveTotal for', player.name, 'value:', player.pendingMoveTotal); return; }

    const moveSteps = player.pendingMoveTotal;
    console.log('[confirmMove]', player.name, 'steps:', moveSteps);
    const startPosForTrap = player.moveStartPos;
    const finalPos = clamp(player.moveStartPos + moveSteps, 0, BOARD_SIZE);
    player.position = finalPos;
    player.pendingMoveTotal = 0;

    // 罠の通過判定（移動した全マス）
    checkTrapsOnPath(room, player, startPosForTrap, finalPos);

    // 移動XP
    grantXP(room, player, moveSteps * XP_PER_TILE, 'マス移動');
    checkGoal(room, player);

    let cellEventLabel = null;
    let cellMoveDelta = 0;
    let cellHpApplied = 0;
    if (!player.finished) {
      let event = pickWeightedCellEvent();
      // 旅人のbadEventResist: 不利なイベントを50%の確率で無効化
      const passive = player.role.passive || {};
      if (passive.badEventResist) {
        const delta = event.apply(player);
        const isBad = (delta.hp && delta.hp < 0) || (delta.energy && delta.energy < 0) || (delta.move && delta.move < 0);
        if (isBad && Math.random() < 0.5) {
          event = { id: 'resist', label: '旅人の直感で危険を回避した', apply: () => ({}) };
        }
      }
      cellEventLabel = event.label;
      addLog(room, `${player.name} が止まったマス: ${event.label}`);
      const delta = event.apply(player);
      if (delta.move) {
        cellMoveDelta = delta.move;
        const newPos = clamp(player.position + delta.move, 0, BOARD_SIZE);
        player.position = newPos;
      }
      if (delta.hp) { const { hpApplied } = applyDelta(room, player, { hp: delta.hp }); cellHpApplied = hpApplied; }
      if (delta.energy) applyDelta(room, player, { energy: delta.energy });
      checkGoal(room, player);
    }

    // 先に「止まったマスの効果」を通知し、その後にHP変動を通知する
    io.to(room.id).emit('cellEventResult', {
      playerId: player.id,
      label: cellEventLabel,
      moveDelta: cellMoveDelta,
      finalPos: player.position,
    });
    if (cellHpApplied !== 0) emitHpChange(room, player, cellHpApplied);
    broadcastRoom(room);
  });

  socket.on('battleOnPath', ({ position, opponentId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    const opponent = getPlayer(room, opponentId);
    if (!player || !opponent || !player.pendingMoveTotal) return;
    if (position <= 0 || position > BOARD_SIZE) return;

    const moveSteps = position - (player.moveStartPos || 0);
    const startPosForTrap = player.moveStartPos || 0;
    player.position = position;
    player.pendingMoveTotal = 0;
    player.battleDoneThisTurn = true;
    player.lastPathBattle = { opponentId, position };

    // 罠の通過判定（戦闘に入る手前までの移動分）
    checkTrapsOnPath(room, player, startPosForTrap, position);

    addLog(room, `${player.name} が移動中に ${opponent.name} に戦闘を仕掛けた`);
    startBattleNegotiation(room, player, opponent, 'path', { moveSteps });
  });

  socket.on('submitBattleChoice', ({ powerId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || !room.pendingBattleChoice) { console.log('[submitBattleChoice] no room or no pendingBattleChoice for', socket.id); return; }
    const pb = room.pendingBattleChoice;
    console.log('[submitBattleChoice] from', socket.id, 'powerId:', powerId, 'attackerId:', pb.attackerId, 'defenderId:', pb.defenderId);
    let mePlayer = null;
    if (socket.id === pb.attackerId) {
      if (pb.attackerChoice !== undefined) { console.log('[submitBattleChoice] attacker already chose'); return; }
      pb.attackerChoice = powerId || null;
      mePlayer = getPlayer(room, pb.attackerId);
    } else if (socket.id === pb.defenderId) {
      if (pb.defenderChoice !== undefined) { console.log('[submitBattleChoice] defender already chose'); return; }
      pb.defenderChoice = powerId || null;
      mePlayer = getPlayer(room, pb.defenderId);
    } else {
      console.log('[submitBattleChoice] socket is neither attacker nor defender');
      return;
    }
    // 選択が実際に使用可能か事前検証し、不可能ならその場でフィードバック
    if (powerId && mePlayer) {
      const set = mePlayer.superSetId ? getSetById(mePlayer.superSetId) : null;
      const line = set ? set.lines.find(l => l.id === powerId) : null;
      const stage = line ? getLineStage(line, mePlayer.level || 0) : null;
      if (!stage) {
        socket.emit('errorMsg', { message: 'その超能力はまだ解放されていません' });
      } else if (mePlayer.energy < stage.cost) {
        socket.emit('errorMsg', { message: 'サイコエナジーが足りません' });
      } else if ((mePlayer.usedTimings || []).includes(stage.timing)) {
        socket.emit('errorMsg', { message: 'この超能力は既に使用済みです' });
      }
    }
    broadcastRoom(room);
    tryResolveBattleNegotiation(room);
  });

  socket.on('submitCounterChoice', ({ powerId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || !room.pendingBattleChoice || !room.pendingBattleChoice.counterPending) return;
    const pb = room.pendingBattleChoice;
    const cp = pb.counterPending;
    const responderId = cp.casterIsAttacker ? pb.defenderId : pb.attackerId;
    if (socket.id !== responderId) return;
    if (cp.responderChoice !== undefined) return;
    cp.responderChoice = powerId || null;
    resolveCounter(room);
  });

  socket.on('rest', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) {
      return socket.emit('errorMsg', { message: '自分のターンではありません' });
    }
    if (player.actionTaken) return socket.emit('errorMsg', { message: 'このターンはすでに行動済みです' });
    player.actionTaken = true;
    player.restedThisTurn = true;
    addLog(room, `${player.name} は休息を選択した`);
    broadcastRoom(room);
  });

  socket.on('useAbility', ({ powerId, targetId, choiceId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) {
      return socket.emit('errorMsg', { message: '自分のターンではありません' });
    }
    const found = findAbilityStage(player, powerId);
    const stage = found.stage;
    const isCopy = found.isCopy;
    if (!stage) return socket.emit('errorMsg', { message: 'この超能力はまだ解放されていません' });
    if (player.energy < stage.cost) return socket.emit('errorMsg', { message: 'サイコエナジーが足りません' });
    const timing = stage.timing;
    if (timing === 'battle') return socket.emit('errorMsg', { message: 'この超能力は戦闘開始時の選択画面で使用してください' });
    if ((player.usedTimings || []).includes(timing)) return socket.emit('errorMsg', { message: '同じタイミングの超能力は1ターンに1つまでです' });
    if (timing === 'beforeMove' && player.actionTaken) return socket.emit('errorMsg', { message: 'この超能力は移動前にしか使えません' });
    const checkSetId = isCopy ? stage.sourceSetId : player.superSetId;
    const checkLineId = isCopy ? stage.sourceLineId : powerId;
    if (isAbilityBanned(room, checkSetId, checkLineId)) return socket.emit('errorMsg', { message: 'この超能力は現在使用禁止になっています' });

    // 対象選択が必要な効果は、対象の妥当性を先に検証する
    let target = null;
    let historyEntry = null;
    if (stage.effect.type === 'energyDrain') {
      target = getPlayer(room, targetId);
      if (!target || target.id === player.id || target.position !== player.position || target.finished || target.incapacitatedTurns > 0) {
        return socket.emit('errorMsg', { message: '対象が無効です' });
      }
    }
    if (stage.effect.type === 'copyAbility') {
      const history = (room.abilityHistoryByPosition && room.abilityHistoryByPosition[player.position]) || [];
      historyEntry = history.find(h => h.id === choiceId && h.ownerId !== player.id);
      if (!historyEntry) return socket.emit('errorMsg', { message: 'コピーする超能力を選択してください' });
    }
    if (stage.effect.type === 'triggerDisasterPrayer' && player.disasterPrayerUsed) {
      return socket.emit('errorMsg', { message: '災害の祈祷はこのマップで既に使用済みです' });
    }

    player.energy -= stage.cost;
    if (!player.usedTimings) player.usedTimings = [];
    player.usedTimings.push(timing);
    addLog(room, `${player.name} は「${stage.name}」を発動した`, { secret: true, ownerId: socket.id, abilityName: stage.name, hiddenMsg: `${player.name} は超能力を発動した` });
    // 模倣のコピー元として、このマスでの使用を記録（コピー能力自体はコピー元にしない）
    if (!isCopy) recordAbilityUse(room, player, powerId, stage);

    // 発動演出イベントは、効果によるHP変動等の結果通知より必ず先に送信する
    const set2 = player.superSetId ? getSetById(player.superSetId) : null;
    io.to(room.id).emit('abilityActivated', { playerId: player.id, playerName: player.name, powerName: stage.name, setImage: set2 ? set2.image : null });

    switch (stage.effect.type) {
      case 'diceBonus':
        player.pendingDiceBonus += stage.effect.value;
        break;
      case 'fixedMove':
        player.pendingFixedMove = stage.effect.value;
        break;
      case 'heal': {
        const { hpApplied } = applyDelta(room, player, { hp: stage.effect.value });
        if (hpApplied !== 0) emitHpChange(room, player, hpApplied);
        break;
      }
      case 'precognition_block':
        player.blockNextBadEvent = true;
        break;
      case 'barrier':
        player.hasBarrier = true;
        break;
      case 'barrierHeal': {
        player.hasBarrier = true;
        const { hpApplied } = applyDelta(room, player, { hp: stage.effect.healValue || 1 });
        if (hpApplied !== 0) emitHpChange(room, player, hpApplied);
        break;
      }
      case 'trap':
        placeTrap(room, player, stage);
        break;
      case 'copyAbility': {
        const record = historyEntry;
        const bonus = stage.effect.bonus || 0;
        const clonedEffect = JSON.parse(JSON.stringify(record.stage.effect));
        if (bonus) {
          if (clonedEffect.value !== undefined) clonedEffect.value += bonus;
          if (clonedEffect.diceBonus !== undefined) clonedEffect.diceBonus += bonus;
        }
        if (!player.copiedAbilities) player.copiedAbilities = [];
        player._copyCounter = (player._copyCounter || 0) + 1;
        const copyId = 'copy_' + player.id + '_' + player._copyCounter;
        player.copiedAbilities.push({
          id: copyId, sourceLineId: record.lineId, sourceSetId: record.setId, sourceOwnerName: record.ownerName,
          name: record.stage.name + '(コピー)', description: record.stage.description, cost: record.stage.cost,
          timing: record.stage.timing, type: record.stage.type, effect: clonedEffect,
        });
        addLog(room, `${player.name} は ${record.ownerName} の「${record.stage.name}」をコピーした！`, { secret: true, ownerId: player.id, abilityName: record.stage.name, hiddenMsg: `${player.name} は超能力をコピーした` });
        break;
      }
      case 'moveDebuffAll': {
        const others = room.players.filter(t => t.id !== player.id && !t.finished);
        others.forEach(t => {
          t.pendingIncomingMoveEffect = { mode: stage.effect.mode, value: stage.effect.value };
        });
        addLog(room, `${player.name} は時間を操り、他の全プレイヤーの次の移動に干渉した`);
        break;
      }
      case 'disasterForesight': {
        let message, positive;
        if (room.disasterFired) {
          message = '災害は既にこのマップで発生済みのようだ';
          positive = false;
        } else if (room.disasterTriggerTurn != null) {
          const remaining = room.disasterTriggerTurn - room.globalTurnCount;
          if (remaining >= 0 && remaining <= (stage.effect.withinTurns || 8)) {
            message = `不吉な予感がする…${stage.effect.withinTurns || 8}ターン以内に災害が起こりそうだ`;
            positive = true;
          } else {
            message = '当分の間、災害の気配は感じられない';
            positive = false;
          }
        } else {
          message = '当分の間、災害の気配は感じられない';
          positive = false;
        }
        socket.emit('disasterForesightResult', { message, positive });
        addLog(room, `${player.name} は予知の祈祷を行った`, { secret: true, ownerId: player.id, abilityName: stage.name, hiddenMsg: `${player.name} は超能力を発動した` });
        break;
      }
      case 'triggerDisasterPrayer': {
        player.disasterPrayerUsed = true;
        addLog(room, `${player.name} が災害の祈祷を捧げた…`);
        resolveDisaster(room, player.id);
        break;
      }
      case 'energyDrain': {
        const before = target.energy;
        if (stage.effect.setZero) {
          target.energy = 0;
        } else {
          target.energy = clamp(target.energy - (stage.effect.value || 0), 0, target.maxEnergy);
        }
        const energyApplied = target.energy - before;
        if (energyApplied !== 0) {
          emitEnergyChange(room, target, energyApplied);
          addLog(room, `${target.name} は${player.name}にサイコエナジーを${-energyApplied}奪われた`);
        }
        break;
      }
      case 'directDamage': {
        const targets = room.players.filter(t => t.id !== player.id && t.position === player.position && !t.finished && t.incapacitatedTurns === 0);
        if (targets.length > 0) {
          const target2 = targets[Math.floor(Math.random() * targets.length)];
          const { hpApplied } = applyDelta(room, target2, { hp: -(stage.effect.value) });
          if (hpApplied !== 0) {
            emitHpChange(room, target2, hpApplied);
            addLog(room, `${target2.name} は${-hpApplied}のダメージを受けた`);
          } else {
            addLog(room, `${target2.name} へのダメージは無効化された`);
          }
        } else {
          addLog(room, '周囲に対象がおらず不発に終わった');
        }
        break;
      }
    }

    // 経験値付与（コピーした能力の使用は0.7倍）
    const abilityXp = isCopy ? Math.ceil(XP_ABILITY_USE * 0.7) : XP_ABILITY_USE;
    grantXP(room, player, abilityXp, isCopy ? 'コピー能力発動' : '超能力発動');

    broadcastRoom(room);
  });

  socket.on('proposeBattle', ({ opponentId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    const opponent = getPlayer(room, opponentId);
    if (!player || !opponent) return;
    if (room.turnOrder[room.turnIndex] !== socket.id) {
      return socket.emit('errorMsg', { message: '自分のターンではありません' });
    }
    if (!player.actionTaken) return socket.emit('errorMsg', { message: '先にサイコロを振るか休息してください' });
    if (player.position === 0) return socket.emit('errorMsg', { message: 'スタート地点では戦闘できません' });
    if (player.position !== opponent.position) return socket.emit('errorMsg', { message: '同じマスにいません' });
    if (opponent.incapacitatedTurns > 0 || player.incapacitatedTurns > 0) return socket.emit('errorMsg', { message: '行動不能状態では戦闘できません' });
    if (player.battleDoneThisTurn) return socket.emit('errorMsg', { message: 'このターンはすでに戦闘済みです' });
    if (player.lastPathBattle && player.lastPathBattle.opponentId === opponentId && player.lastPathBattle.position === player.position) {
      return socket.emit('errorMsg', { message: '前回同じマスで戦闘した相手には仕掛けられません' });
    }

    // 交渉フロー開始（超能力選択を待つ）
    player.battleDoneThisTurn = true;
    addLog(room, `${player.name} が ${opponent.name} に戦闘を仕掛けた`);
    startBattleNegotiation(room, player, opponent, 'normal', {});
  });

  socket.on('endTurn', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) {
      return socket.emit('errorMsg', { message: '自分のターンではありません' });
    }
    if (!player.actionTaken) {
      return socket.emit('errorMsg', { message: 'サイコロを振るか休息を選んでください' });
    }
    applyRegen(room, player);
    resetTurnFlags(player);
    addLog(room, `${player.name} はターンを終了した`);
    advanceTurn(room);
    broadcastRoom(room);
    // advanceTurn内でもscheduleBotTurnは呼ばれるが、
    // 行動不能スキップ連鎖の後にBotに回った場合に備えて再度呼ぶ
  });

  socket.on('leaveRoom', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    socket.leave(room.id);
    removePlayerFromRoom(room, socket.id);
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    removePlayerFromRoom(room, socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
