const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  ROLES,
  POWERS,
  POWERS_PER_PLAYER,
  XP_PER_TILE, XP_ABILITY_USE, XP_BATTLE_WIN, XP_BATTLE_LOSE, XP_BATTLE_DRAW,
  MAX_LEVEL, LEVEL_XP,
  pickWeightedCellEvent,
  pickRandomEventCard,
} = require('./gameData');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const BOARD_SIZE = 34;
const EVENT_CARD_INTERVAL = 4; // 4ラウンド毎
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

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    ready: p.ready,
    roleId: p.roleId || null,
    roleName: p.role ? p.role.name : null,
    powers: (p.powers || []).map((pw, i) => ({
      id: pw.id,
      name: (p.powerStates && p.powerStates[i] && p.powerStates[i].evolved && pw.evolved) ? pw.evolved.name : pw.name,
      description: (p.powerStates && p.powerStates[i] && p.powerStates[i].evolved && pw.evolved) ? pw.evolved.description : pw.description,
      cost: (p.powerStates && p.powerStates[i] && p.powerStates[i].evolved && pw.evolved) ? pw.evolved.cost : pw.cost,
      timing: pw.timing,
      evolved: !!(p.powerStates && p.powerStates[i] && p.powerStates[i].evolved),
    })),
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
    position: p.position,
  };
}

function publicRoomState(room, forSocketId) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => {
      const pub = publicPlayer(p);
      // 自分以外の超能力を隠す
      if (forSocketId && p.id !== forSocketId) {
        pub.powers = pub.powers.map(() => ({ id: '???', name: '???', description: '???', cost: 0, timing: '', evolved: false }));
      }
      return pub;
    }),
    boardSize: BOARD_SIZE,
    turnOrder: room.turnOrder || [],
    currentTurnId: room.phase === 'playing' ? room.turnOrder[room.turnIndex] : null,
    roundNumber: room.roundNumber || 0,
    roles: ROLES.map((r) => ({ id: r.id, name: r.name, description: r.description })),
    winnerId: room.winnerId || null,
    log: buildLogForPlayer(room.log, forSocketId),
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
  p.powerStates = (p.powers || []).map(() => ({ evolved: false, useCount: 0 }));
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
}

function applyDelta(room, p, delta) {
  if (!delta) return;
  if (delta.hp) {
    if (delta.hp < 0 && p.hasBarrier) {
      addLog(room, `${p.name} のバリアがダメージを無効化した`);
      p.hasBarrier = false;
    } else if (delta.hp < 0 && p.blockNextBadEvent) {
      addLog(room, `${p.name} は予知の力で悪い効果を無効化した`);
      p.blockNextBadEvent = false;
    } else {
      p.hp = clamp(p.hp + delta.hp, 0, p.maxHp);
    }
  }
  if (delta.energy) {
    if (delta.energy < 0 && p.blockNextBadEvent) {
      addLog(room, `${p.name} は予知の力で悪い効果を無効化した`);
      p.blockNextBadEvent = false;
    } else {
      p.energy = clamp(p.energy + delta.energy, 0, p.maxEnergy);
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

// 共通戦闘処理: attacker=仕掛けた側, defender=仕掛けられた側
function executeBattle(room, attacker, defender, silent) {
  const aP = attacker.role.passive || {};
  const dP = defender.role.passive || {};
  const aBonus = (aP.battleDiceBonus || 0) + (aP.attackDiceBonus || 0);
  const dBonus = (dP.battleDiceBonus || 0) + (dP.defendDiceBonus || 0) - (dP.defendDicePenalty || 0);
  const debuff = attacker.pendingBattleDebuff || 0;
  attacker.pendingBattleDebuff = 0;

  const dieA = Math.floor(Math.random() * 6) + 1;
  const dieB = Math.floor(Math.random() * 6) + 1;
  const rollA = Math.max(0, dieA + aBonus);
  const rollB = Math.max(0, dieB + dBonus - debuff);

  addLog(room, `戦闘: ${attacker.name}(${rollA}) vs ${defender.name}(${rollB})`);
  const battleData = {
    aId: attacker.id, aName: attacker.name, aDie: dieA, aRoll: rollA, aRoleName: attacker.role.name, aBonus,
    bId: defender.id, bName: defender.name, bDie: dieB, bRoll: rollB, bRoleName: defender.role.name, bBonus: dBonus - debuff,
  };

  if (rollA > rollB) {
    const dmgBonus = (aP.battleDamageBonus || 0);
    const dmgReduction = (dP.battleDamageReduction || 0);
    const dmg = Math.max(0, BATTLE_DAMAGE + dmgBonus - dmgReduction);
    applyDelta(room, defender, { hp: -dmg });
    addLog(room, `${defender.name} は戦闘に敗れ、体力を${dmg}失った`);
    battleData.result = 'a';
    battleData.dmg = dmg; battleData.dmgBonus = dmgBonus; battleData.dmgReduction = dmgReduction;
    grantXP(room, attacker, XP_BATTLE_WIN, '戦闘勝利');
    grantXP(room, defender, XP_BATTLE_LOSE, '戦闘敗北');
  } else if (rollB > rollA) {
    const dmgBonus = (dP.battleDamageBonus || 0);
    const dmgReduction = (aP.battleDamageReduction || 0);
    const dmg = Math.max(0, BATTLE_DAMAGE + dmgBonus - dmgReduction);
    applyDelta(room, attacker, { hp: -dmg });
    addLog(room, `${attacker.name} は戦闘に敗れ、体力を${dmg}失った`);
    battleData.result = 'b';
    battleData.dmg = dmg; battleData.dmgBonus = dmgBonus; battleData.dmgReduction = dmgReduction;
    grantXP(room, attacker, XP_BATTLE_LOSE, '戦闘敗北');
    grantXP(room, defender, XP_BATTLE_WIN, '戦闘勝利');
  } else {
    addLog(room, '戦闘は引き分けに終わった');
    battleData.result = 'draw';
    grantXP(room, attacker, XP_BATTLE_DRAW, '戦闘引き分け');
    grantXP(room, defender, XP_BATTLE_DRAW, '戦闘引き分け');
  }

  if (!silent) io.to(room.id).emit('battleRolled', battleData);
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
    // レベルに応じた進化・ボーナス
    if (p.level === 1 && p.powerStates && p.powerStates[0]) {
      p.powerStates[0].evolved = true;
      const pw = p.powers[0];
      if (pw && pw.evolved) addLog(room, `${p.name} の「${pw.name}」が「${pw.evolved.name}」に進化した！`, { secret: true, ownerId: p.id, abilityName: pw.evolved.name, hiddenMsg: `${p.name} の超能力が進化した！` });
    }
    if (p.level === 2 && p.powerStates && p.powerStates[1]) {
      p.powerStates[1].evolved = true;
      const pw = p.powers[1];
      if (pw && pw.evolved) addLog(room, `${p.name} の「${pw.name}」が「${pw.evolved.name}」に進化した！`, { secret: true, ownerId: p.id, abilityName: pw.evolved.name, hiddenMsg: `${p.name} の超能力が進化した！` });
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

function distributePowers(room) {
  const shuffled = [...POWERS].sort(() => Math.random() - 0.5);
  const count = room.players.length;
  const perPlayer = Math.min(POWERS_PER_PLAYER, Math.floor(shuffled.length / count));
  let idx = 0;
  room.players.forEach((p) => {
    p.powers = [];
    for (let i = 0; i < perPlayer; i++) {
      p.powers.push(shuffled[idx++]);
    }
    p.powersConfirmed = p.isBot ? true : false;
    const names = p.powers.map(pw => pw.name).join('」「');
    addLog(room, `${p.name} は超能力「${names}」に目覚めた`, { secret: true, ownerId: p.id, abilityName: names, hiddenMsg: `${p.name} は超能力に目覚めた` });
  });
}

function advanceTurn(room) {
  if (room.phase !== 'playing') return;
  let guard = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
    if (room.turnIndex === 0) {
      room.roundNumber += 1;
      if (room.roundNumber % EVENT_CARD_INTERVAL === 0) {
        const card = pickRandomEventCard();
        addLog(room, `イベントカード発生: ${card.label}`);
        room.players.forEach((pl) => {
          if (!pl.finished) applyDelta(room, pl, card.apply());
        });
      }
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
  botTryUseAbility(room, bot);

  // 行動選択: HP低い場合は休息、そうでなければサイコロ
  if (bot.hp <= bot.maxHp * 0.3 && !bot.restedThisTurn) {
    bot.actionTaken = true;
    bot.restedThisTurn = true;
    addLog(room, `${bot.name} は休息を選択した`);
    broadcastRoom(room);
    setTimeout(() => botEndTurn(room, bot), BOT_DELAY);
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
    bot.actionTaken = true;
    const startPos = bot.position;

    // パスを1マスずつチェック
    let battleOnPath = false;
    let battlePos = 0;
    for (let step = 1; step <= roll; step++) {
      const pos = Math.min(startPos + step, BOARD_SIZE);
      if (pos <= 0) continue;
      const opponents = room.players.filter(p =>
        p.id !== bot.id && p.position === pos && !p.finished && p.incapacitatedTurns === 0
      );
      if (opponents.length > 0 && step < roll && Math.random() < 0.35) {
        const opp = opponents[0];
        bot.position = pos;
        bot.battleDoneThisTurn = true;
        bot.lastPathBattle = { opponentId: opp.id, position: pos };
        addLog(room, `${bot.name} が移動中に ${opp.name} に戦闘を仕掛けた`);
        const bResult = executeBattle(room, bot, opp, true);
        battleOnPath = true; battlePos = pos;
        room._botPathBattle = bResult;
        break;
      }
      if (pos >= BOARD_SIZE) break;
    }

    if (!battleOnPath) {
      bot.position = Math.min(startPos + roll, BOARD_SIZE);
      grantXP(room, bot, roll * XP_PER_TILE, 'マス移動');
      checkGoal(room, bot);
      let cellEventLabel = null;
      let cellMoveDelta = 0;
      if (!bot.finished) {
        const event = pickWeightedCellEvent();
        cellEventLabel = event.label;
        addLog(room, `${bot.name} が止まったマス: ${event.label}`);
        const delta = event.apply(bot);
        if (delta.move) { cellMoveDelta = delta.move; bot.position = clamp(bot.position + delta.move, 0, BOARD_SIZE); }
        if (delta.hp) applyDelta(room, bot, { hp: delta.hp });
        if (delta.energy) applyDelta(room, bot, { energy: delta.energy });
        checkGoal(room, bot);
      }
      // diceRolledを先に送信し、cellEventResultは後から送信
      addLog(room, `${bot.name} はサイコロを振り、${roll}マス進む`);
      io.to(room.id).emit('diceRolled', { playerId: bot.id, baseRoll, bonus, total: roll, startPos, finalPos: Math.min(startPos + roll, BOARD_SIZE), roleName: bot.role.name, roleBonus: (bot.role.passive||{}).moveDiceBonus||0, isGambler: !!(bot.role.passive||{}).gamblerEffect, gamblerAdjust });
      broadcastRoom(room);
      if (cellEventLabel) {
        io.to(room.id).emit('cellEventResult', { playerId: bot.id, label: cellEventLabel, moveDelta: cellMoveDelta, finalPos: bot.position });
      }
    } else {
      addLog(room, `${bot.name} はサイコロを振り、${roll}マス進む`);
      grantXP(room, bot, (battlePos - startPos) * XP_PER_TILE, 'マス移動');
      const pb = room._botPathBattle || null; delete room._botPathBattle;
      io.to(room.id).emit('diceRolled', { playerId: bot.id, baseRoll, bonus, total: roll, startPos, finalPos: battlePos, pathBattle: pb, roleName: bot.role.name, roleBonus: (bot.role.passive||{}).moveDiceBonus||0, isGambler: !!(bot.role.passive||{}).gamblerEffect, gamblerAdjust });
      broadcastRoom(room);
    }

    const steps=Math.min(roll,BOARD_SIZE-startPos);
    const animTime=1800+1200+300+steps*450+2500;
    setTimeout(() => botEndTurn(room, bot), animTime);
  }
}

function botTryUseAbility(room, bot) {
  if (!bot.powers || bot.powers.length === 0) return;
  for (let i = 0; i < bot.powers.length; i++) {
    const basePw = bot.powers[i];
    const ps = bot.powerStates[i];
    const pw = (ps.evolved && basePw.evolved) ? basePw.evolved : basePw;
    if (bot.energy < pw.cost) continue;
    if (basePw.timing === 'battle') continue;

    let shouldUse = false;
    switch (pw.effect.type) {
      case 'diceBonus': case 'fixedMove': shouldUse = Math.random() < 0.5; break;
      case 'heal': shouldUse = bot.hp <= bot.maxHp * 0.5; break;
      case 'precognition_block': shouldUse = Math.random() < 0.3; break;
      case 'barrier': case 'barrierHeal': shouldUse = !bot.hasBarrier && Math.random() < 0.4; break;
      case 'directDamage': {
        const targets = room.players.filter(t => t.id !== bot.id && t.position === bot.position && !t.finished);
        shouldUse = targets.length > 0 && Math.random() < 0.5;
        break;
      }
    }
    if (shouldUse) {
      bot.energy -= pw.cost;
      ps.useCount += 1;
      addLog(room, `${bot.name} は「${pw.name}」を発動した`, { secret: true, ownerId: bot.id, abilityName: pw.name, hiddenMsg: `${bot.name} は超能力を発動した` });
      grantXP(room, bot, XP_ABILITY_USE, '超能力発動');
      switch (pw.effect.type) {
        case 'diceBonus': bot.pendingDiceBonus += pw.effect.value; break;
        case 'fixedMove': bot.pendingFixedMove = pw.effect.value; break;
        case 'heal': applyDelta(room, bot, { hp: pw.effect.value }); break;
        case 'precognition_block': bot.blockNextBadEvent = true; break;
        case 'barrier': bot.hasBarrier = true; break;
        case 'barrierHeal': bot.hasBarrier = true; applyDelta(room, bot, { hp: pw.effect.healValue || 1 }); break;
        case 'directDamage': {
          const targets = room.players.filter(t => t.id !== bot.id && t.position === bot.position && !t.finished && t.incapacitatedTurns === 0);
          if (targets.length > 0) { const tgt = targets[0]; applyDelta(room, tgt, { hp: -(pw.effect.value) }); addLog(room, `${tgt.name} は${pw.effect.value}のダメージを受けた`); }
          break;
        }
      }
      break; // 1ターンに1回だけ使用
    }
  }
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
          distributePowers(room);
          room.phase = 'powerReveal';
          addLog(room, '超能力が覚醒しました。各自の能力を確認してください');
          // Botは自動で確認済み
          if (room.players.every((pl) => pl.powersConfirmed)) {
            room.players.forEach((pl) => initPlayerForGame(pl));
            room.phase = 'playing';
            room.turnIndex = 0;
            room.roundNumber = 1;
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
      distributePowers(room);
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
    const finalPos = clamp(player.moveStartPos + moveSteps, 0, BOARD_SIZE);
    player.position = finalPos;
    player.pendingMoveTotal = 0;

    // 移動XP
    grantXP(room, player, moveSteps * XP_PER_TILE, 'マス移動');
    checkGoal(room, player);

    let cellEventLabel = null;
    let cellMoveDelta = 0;
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
      if (delta.hp) applyDelta(room, player, { hp: delta.hp });
      if (delta.energy) applyDelta(room, player, { energy: delta.energy });
      checkGoal(room, player);
    }

    io.to(room.id).emit('cellEventResult', {
      playerId: player.id,
      label: cellEventLabel,
      moveDelta: cellMoveDelta,
      finalPos: player.position,
    });
    broadcastRoom(room);
  });

  socket.on('battleOnPath', ({ position, opponentId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    const opponent = getPlayer(room, opponentId);
    if (!player || !opponent || !player.pendingMoveTotal) return;
    if (position <= 0 || position > BOARD_SIZE) return;

    player.position = position;
    player.pendingMoveTotal = 0;
    player.battleDoneThisTurn = true;
    player.lastPathBattle = { opponentId, position };

    addLog(room, `${player.name} が移動中に ${opponent.name} に戦闘を仕掛けた`);
    executeBattle(room, player, opponent);
    const pathMoveSteps = position - (player.moveStartPos || 0);
    if (pathMoveSteps > 0) grantXP(room, player, pathMoveSteps * XP_PER_TILE, 'マス移動');

    // 戦闘後ターン自動終了
    applyRegen(room, player);
    resetTurnFlags(player);
    addLog(room, `${player.name} はターンを終了した`);
    advanceTurn(room);
    broadcastRoom(room);
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

  socket.on('useAbility', ({ powerId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const player = getPlayer(room, socket.id);
    if (!player || room.turnOrder[room.turnIndex] !== socket.id) {
      return socket.emit('errorMsg', { message: '自分のターンではありません' });
    }
    const pIdx = (player.powers || []).findIndex(pw => pw.id === powerId);
    if (pIdx === -1) return socket.emit('errorMsg', { message: '無効な超能力です' });
    const basePower = player.powers[pIdx];
    const ps = player.powerStates[pIdx];
    const power = (ps.evolved && basePower.evolved) ? basePower.evolved : basePower;
    if (player.energy < power.cost) return socket.emit('errorMsg', { message: 'サイコエナジーが足りません' });
    // 同じタイミングの超能力は1ターンに1つまで
    const timing = basePower.timing;
    if ((player.usedTimings || []).includes(timing)) return socket.emit('errorMsg', { message: '同じタイミングの超能力は1ターンに1つまでです' });
    // タイミングチェック: beforeMove/battleは移動前のみ, anytimeはいつでも
    if ((timing === 'beforeMove' || timing === 'battle') && player.actionTaken) return socket.emit('errorMsg', { message: 'この超能力は移動前にしか使えません' });

    player.energy -= power.cost;
    ps.useCount += 1;
    if (!player.usedTimings) player.usedTimings = [];
    player.usedTimings.push(timing);
    addLog(room, `${player.name} は「${power.name}」を発動した`, { secret: true, ownerId: socket.id, abilityName: power.name, hiddenMsg: `${player.name} は超能力を発動した` });

    switch (power.effect.type) {
      case 'diceBonus':
        player.pendingDiceBonus += power.effect.value;
        break;
      case 'fixedMove':
        player.pendingFixedMove = power.effect.value;
        break;
      case 'heal':
        applyDelta(room, player, { hp: power.effect.value });
        break;
      case 'precognition_block':
        player.blockNextBadEvent = true;
        break;
      case 'battleDebuff':
        player.pendingBattleDebuff = (player.pendingBattleDebuff || 0) + power.effect.value;
        addLog(room, `${player.name} は次の戦闘で相手の出目を-${power.effect.value}する`, { secret: true, ownerId: socket.id, abilityName: power.name, hiddenMsg: `${player.name} は戦闘の準備をしている` });
        break;
      case 'barrier':
        player.hasBarrier = true;
        break;
      case 'barrierHeal':
        player.hasBarrier = true;
        applyDelta(room, player, { hp: power.effect.healValue || 1 });
        break;
      case 'directDamage': {
        const targets = room.players.filter(t => t.id !== player.id && t.position === player.position && !t.finished && t.incapacitatedTurns === 0);
        if (targets.length > 0) {
          const target = targets[Math.floor(Math.random() * targets.length)];
          applyDelta(room, target, { hp: -(power.effect.value) });
          addLog(room, `${target.name} は${power.effect.value}のダメージを受けた`);
        } else {
          addLog(room, '周囲に対象がおらず不発に終わった');
        }
        break;
      }
    }

    // 経験値付与
    grantXP(room, player, XP_ABILITY_USE, '超能力発動');

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

    // 即時戦闘
    player.battleDoneThisTurn = true;
    addLog(room, `${player.name} が ${opponent.name} に戦闘を仕掛けた`);
    executeBattle(room, player, opponent);

    broadcastRoom(room);
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
