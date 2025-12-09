const jwt = require('jsonwebtoken');
const Game = require('../models/Game');
const User = require('../models/User');

const activeMatches = new Map();
// Track timeout timers for RPS and Matching Pennies
const timeoutTimers = new Map(); // key: code, value: { hostTimer, guestTimer }
const BOARD_DEFAULT_SIZE = 9;
const MAX_POSITION_HISTORY = 2048;
const DEFAULT_SCORING_METHOD = 'chinese';

const beats = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
};

const cloneBoard = (board = []) => board.map(row => [...row]);
const createBoard = (size = BOARD_DEFAULT_SIZE) =>
  Array(size)
    .fill(null)
    .map(() => Array(size).fill(null));
const getPositionHash = (board, nextTurn) =>
  JSON.stringify({ board, next: nextTurn });

// ==================== TIME CONTROL FUNCTIONS ====================

/**
 * Get current time state for a player
 */
function getTimeState(game, color) {
  if (!game.goTimeControl || game.goTimeControl.mode === 'none') {
    return null;
  }
  return game.goTimeState[color] || null;
}

/**
 * Calculate elapsed time since last move
 */
function getElapsedTime(game) {
  if (!game.goLastMoveTime) return 0;
  const now = new Date();
  return Math.floor((now - game.goLastMoveTime) / 1000);
}

/**
 * FISCHER TIME: Update time after a move
 * - Deduct elapsed time
 * - Add increment if move was made in time
 */
function applyFischerTime(game, color) {
  const control = game.goTimeControl;
  const state = game.goTimeState[color];
  
  if (!state || control.mode !== 'fischer') return;

  const elapsed = getElapsedTime(game);
  
  // Deduct elapsed time
  state.mainTime = Math.max(0, state.mainTime - elapsed);
  
  // Check if time expired before increment
  if (state.mainTime <= 0) {
    game.goTimeExpired = color;
    return;
  }
  
  // Add increment after valid move (PURE FISCHER - NO CAP)
  // Time can grow indefinitely if player moves fast
  state.mainTime += control.increment;
  
  // Update last move time
  game.goLastMoveTime = new Date();
}

/**
 * JAPANESE BYO-YOMI: Update time after a move
 * - If in main time: deduct elapsed, switch to byo-yomi if expired
 * - If in byo-yomi: reset period timer if move was in time, deduct period if exceeded
 */
function applyJapaneseByoYomi(game, color) {
  const control = game.goTimeControl;
  const state = game.goTimeState[color];
  
  if (!state || control.mode !== 'japanese') return;

  const elapsed = getElapsedTime(game);
  
  if (!state.isByoYomi) {
    // Still in main time
    state.mainTime = Math.max(0, state.mainTime - elapsed);
    
    if (state.mainTime <= 0) {
      // Switch to byo-yomi
      state.isByoYomi = true;
      state.byoYomiTime = control.byoYomiTime;
      state.byoYomiPeriods = control.byoYomiPeriods;
    }
  }
  
  if (state.isByoYomi) {
    // In byo-yomi mode
    if (elapsed <= state.byoYomiTime) {
      // Move was made in time - reset period timer, keep the period
      state.byoYomiTime = control.byoYomiTime;
    } else {
      // Move exceeded period time - deduct one period
      state.byoYomiPeriods = Math.max(0, state.byoYomiPeriods - 1);
      
      if (state.byoYomiPeriods <= 0) {
        // All periods used - time expired
        game.goTimeExpired = color;
        return;
      }
      
      // Reset timer for next period
      state.byoYomiTime = control.byoYomiTime;
    }
  }
  
  // Update last move time
  game.goLastMoveTime = new Date();
}

/**
 * Update time when a move is made
 */
function updateTimeOnMove(game, color) {
  if (!game.goTimeControl || game.goTimeControl.mode === 'none') {
    return;
  }

  if (game.goTimeControl.mode === 'fischer') {
    applyFischerTime(game, color);
  } else if (game.goTimeControl.mode === 'japanese') {
    applyJapaneseByoYomi(game, color);
  }
}

/**
 * Get current time remaining for display
 * Returns the stored time directly (already decremented by updateCurrentPlayerTime)
 */
function getCurrentTimeRemaining(game, color) {
  if (!game.goTimeControl || game.goTimeControl.mode === 'none') {
    return null;
  }

  const state = game.goTimeState[color];
  if (!state) return null;

  // Return stored time directly - no need to recalculate elapsed time
  // since updateCurrentPlayerTime already decrements it by 1 second per interval
  if (game.goTimeControl.mode === 'fischer') {
    return {
      mode: 'fischer',
      mainTime: state.mainTime,
      isByoYomi: false,
      byoYomiTime: null,
      byoYomiPeriods: null,
    };
  } else if (game.goTimeControl.mode === 'japanese') {
    if (!state.isByoYomi) {
      return {
        mode: 'japanese',
        mainTime: state.mainTime,
        isByoYomi: false,
        byoYomiTime: null,
        byoYomiPeriods: null,
      };
    } else {
      return {
        mode: 'japanese',
        mainTime: 0,
        isByoYomi: true,
        byoYomiTime: state.byoYomiTime,
        byoYomiPeriods: state.byoYomiPeriods,
      };
    }
  }
  
  return null;
}

/**
 * Update time for current player (called periodically)
 * Uses real elapsed time based on Date.now() instead of trusting setInterval
 * goLastMoveTime represents when the current turn started - we calculate elapsed from that
 */
function updateCurrentPlayerTime(game) {
  if (!game.goTimeControl || game.goTimeControl.mode === 'none') {
    return false;
  }

  const currentColor = game.goCurrentTurn;
  const state = game.goTimeState[currentColor];
  if (!state) return false;

  if (!game.goLastMoveTime) return false;

  // Calculate real elapsed time since turn started
  const now = new Date();
  const elapsedSeconds = Math.floor((now - game.goLastMoveTime) / 1000);
  
  // Only update if at least 1 second has elapsed
  if (elapsedSeconds < 1) return false;

  let updated = false;
  let newTime = 0;

  if (game.goTimeControl.mode === 'fischer') {
    // Fischer: deduct elapsed time
    newTime = Math.max(0, state.mainTime - elapsedSeconds);
    if (newTime !== state.mainTime) {
      state.mainTime = newTime;
      updated = true;
      
      if (state.mainTime <= 0) {
        game.goTimeExpired = currentColor;
      }
    }
  } else if (game.goTimeControl.mode === 'japanese') {
    if (!state.isByoYomi) {
      // Main time: deduct elapsed time
      newTime = Math.max(0, state.mainTime - elapsedSeconds);
      if (newTime !== state.mainTime) {
        state.mainTime = newTime;
        updated = true;
        
        if (state.mainTime <= 0) {
          state.isByoYomi = true;
          state.byoYomiTime = game.goTimeControl.byoYomiTime;
          state.byoYomiPeriods = game.goTimeControl.byoYomiPeriods;
        }
      }
    } else {
      // Byo Yomi: deduct elapsed time from period
      newTime = Math.max(0, state.byoYomiTime - elapsedSeconds);
      if (newTime !== state.byoYomiTime) {
        state.byoYomiTime = newTime;
        updated = true;
        
        if (state.byoYomiTime <= 0) {
          // Period expired - deduct one period
          state.byoYomiPeriods = Math.max(0, state.byoYomiPeriods - 1);
          
          if (state.byoYomiPeriods <= 0) {
            game.goTimeExpired = currentColor;
          } else {
            // Reset timer for next period
            state.byoYomiTime = game.goTimeControl.byoYomiTime;
          }
        }
      }
    }
  }

  // Update goLastMoveTime to current time after deducting elapsed time
  // This ensures next interval calculates from the correct point
  if (updated) {
    game.goLastMoveTime = now;
  }

  return updated;
}

const determineWinner = (hostMove, guestMove) => {
  if (hostMove === guestMove) return 'draw';
  return beats[hostMove] === guestMove ? 'host' : 'guest';
};

/**
 * Update user game statistics when a game completes
 */
async function updateUserStats(game) {
  if (!game.host || !game.guest || game.status !== 'COMPLETE') return;

  try {
    const host = await User.findById(game.host);
    const guest = await User.findById(game.guest);
    if (!host || !guest) return;

    let hostWon = false;
    let guestWon = false;
    let hostPoints = 0;
    let guestPoints = 0;
    const gameType = game.activeStage;

    // Determine winner and points based on game type
    if (gameType === 'ROCK_PAPER_SCISSORS') {
      // Winner is determined by higher score (can be early end or first to 10)
      hostWon = game.hostScore > game.guestScore;
      guestWon = game.guestScore > game.hostScore;
      hostPoints = game.hostScore;
      guestPoints = game.guestScore;
    } else if (gameType === 'MATCHING_PENNIES') {
      // Winner is determined by higher score (can be early end or first to 10)
      hostWon = game.hostPenniesScore > game.guestPenniesScore;
      guestWon = game.guestPenniesScore > game.hostPenniesScore;
      hostPoints = game.hostPenniesScore;
      guestPoints = game.guestPenniesScore;
    } else if (gameType === 'GAME_OF_GO' && game.goFinalScore) {
      const winner = game.goFinalScore.winner;
      // In Go, host is always black, guest is always white
      if (winner === 'black') {
        hostWon = true;
        hostPoints = game.goFinalScore.black?.score || 0;
        guestPoints = game.goFinalScore.white?.score || 0;
      } else if (winner === 'white') {
        guestWon = true;
        hostPoints = game.goFinalScore.black?.score || 0;
        guestPoints = game.goFinalScore.white?.score || 0;
      }
      // If winner is null, it's a draw
    }

    // Update host stats
    host.gameStats.totalGames += 1;
    if (hostWon) {
      host.gameStats.wins += 1;
      host.gameStats.totalPoints += hostPoints;
      if (gameType === 'ROCK_PAPER_SCISSORS') {
        host.gameStats.rpsWins += 1;
        host.gameStats.rpsPoints += hostPoints;
      } else if (gameType === 'MATCHING_PENNIES') {
        host.gameStats.penniesWins += 1;
        host.gameStats.penniesPoints += hostPoints;
      } else if (gameType === 'GAME_OF_GO') {
        host.gameStats.goWins += 1;
        host.gameStats.goPoints += hostPoints;
      }
    } else if (guestWon) {
      host.gameStats.losses += 1;
      if (gameType === 'ROCK_PAPER_SCISSORS') {
        host.gameStats.rpsLosses += 1;
      } else if (gameType === 'MATCHING_PENNIES') {
        host.gameStats.penniesLosses += 1;
      } else if (gameType === 'GAME_OF_GO') {
        host.gameStats.goLosses += 1;
      }
    } else {
      host.gameStats.draws += 1;
    }
    await host.save();

    // Update guest stats
    guest.gameStats.totalGames += 1;
    if (guestWon) {
      guest.gameStats.wins += 1;
      guest.gameStats.totalPoints += guestPoints;
      if (gameType === 'ROCK_PAPER_SCISSORS') {
        guest.gameStats.rpsWins += 1;
        guest.gameStats.rpsPoints += guestPoints;
      } else if (gameType === 'MATCHING_PENNIES') {
        guest.gameStats.penniesWins += 1;
        guest.gameStats.penniesPoints += guestPoints;
      } else if (gameType === 'GAME_OF_GO') {
        guest.gameStats.goWins += 1;
        guest.gameStats.goPoints += guestPoints;
      }
    } else if (hostWon) {
      guest.gameStats.losses += 1;
      if (gameType === 'ROCK_PAPER_SCISSORS') {
        guest.gameStats.rpsLosses += 1;
      } else if (gameType === 'MATCHING_PENNIES') {
        guest.gameStats.penniesLosses += 1;
      } else if (gameType === 'GAME_OF_GO') {
        guest.gameStats.goLosses += 1;
      }
    } else {
      guest.gameStats.draws += 1;
    }
    await guest.save();
  } catch (err) {
    console.error('Error updating user stats:', err);
  }
}

const initGameSocket = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Missing token'));
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    socket.on('joinGame', async ({ code }) => {
      const upper = code?.toUpperCase();
      if (!upper) return;

      const game = await Game.findOne({ code: upper });
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }
      const isParticipant =
        String(game.host) === socket.user.id ||
        (game.guest && String(game.guest) === socket.user.id);
      if (!isParticipant) {
        socket.emit('game:error', 'You are not part of this arena yet');
        return;
      }

      socket.join(upper);
      socket.emit('game:joined', { code: upper });
      const displayName = socket.user.studentName || socket.user.username;
      socket.to(upper).emit('game:peer_joined', displayName);
    });

    socket.on('submitMove', async ({ code, move }) => {
      const upper = code?.toUpperCase();
      if (!upper || !['rock', 'paper', 'scissors'].includes(move)) {
        socket.emit('game:error', 'Invalid move or code');
        return;
      }

      // Ensure socket is in the room
      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper });
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (!game.guest) {
        socket.emit('game:error', 'Waiting for opponent to join');
        return;
      }

      // Normalize IDs to strings for consistent comparison
      const userId = String(socket.user.id);
      const hostId = String(game.host);
      const guestId = String(game.guest);

      const isParticipant = userId === hostId || userId === guestId;
      if (!isParticipant) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      // Clear timeout timer for this player
      const timeoutData = timeoutTimers.get(upper);
      if (timeoutData) {
        if (userId === hostId && timeoutData.hostTimer) {
          clearTimeout(timeoutData.hostTimer);
          timeoutData.hostTimer = null;
        } else if (userId === guestId && timeoutData.guestTimer) {
          clearTimeout(timeoutData.guestTimer);
          timeoutData.guestTimer = null;
        }
      }

      let state = activeMatches.get(upper);
      if (!state) {
        state = { moves: {} };
        activeMatches.set(upper, state);
      }

      // Store move using normalized ID
      state.moves[userId] = move;
      const displayName = socket.user.studentName || socket.user.username;
      console.log(`[${upper}] Player ${displayName} (${userId}) submitted: ${move}`);
      socket.to(upper).emit('opponentLocked', displayName);

      // Check if both players have submitted
      const hostMove = state.moves[hostId];
      const guestMove = state.moves[guestId];

      console.log(`[${upper}] Moves status - Host: ${hostMove || 'pending'}, Guest: ${guestMove || 'pending'}`);

      if (!hostMove || !guestMove) {
        // Not both moves received yet
        return;
      }

      const result = determineWinner(hostMove, guestMove);

      let winnerUserId = null;
      if (result === 'host') {
        winnerUserId = game.host;
        game.hostScore += 1;
      } else if (result === 'guest') {
        winnerUserId = game.guest;
        game.guestScore += 1;
      }

      game.rounds.push({
        gameType: 'ROCK_PAPER_SCISSORS',
        moves: [
          { player: game.host, choice: hostMove },
          { player: game.guest, choice: guestMove },
        ],
        winner: winnerUserId,
        summary:
          result === 'draw'
            ? 'It is a perfect tie!'
            : `${result.toUpperCase()} wipes the board this round.`,
      });

      // Count ROCK_PAPER_SCISSORS rounds to check if game is complete (30 rounds total)
      const rpsRoundsCount = game.rounds.filter(r => r.gameType === 'ROCK_PAPER_SCISSORS').length;
      const isGameComplete = rpsRoundsCount >= 30;
      
      if (isGameComplete) {
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        game.activeStage = 'ROCK_PAPER_SCISSORS';
        await game.save();
        await updateUserStats(game);
      } else {
        game.status = 'IN_PROGRESS';
        game.activeStage = 'ROCK_PAPER_SCISSORS';
        await game.save();
      }

      // Determine winner based on scores after 30 rounds
      let winner = null;
      if (isGameComplete) {
        if (game.hostScore > game.guestScore) {
          winner = 'host';
        } else if (game.guestScore > game.hostScore) {
          winner = 'guest';
        } else {
          winner = null; // Draw
        }
      }

      const resultPayload = {
        code: upper,
        result,
        hostMove,
        guestMove,
        hostScore: game.hostScore,
        guestScore: game.guestScore,
        isGameComplete,
        winner,
        nextStage: isGameComplete ? null : 'ROCK_PAPER_SCISSORS',
        roundsPlayed: rpsRoundsCount,
        totalRounds: 30,
      };

      console.log(`[${upper}] Emitting roundResult:`, resultPayload);
      io.to(upper).emit('roundResult', resultPayload);

      // Clear timeout timers
      const existing = timeoutTimers.get(upper);
      if (existing) {
        if (existing.hostTimer) clearTimeout(existing.hostTimer);
        if (existing.guestTimer) clearTimeout(existing.guestTimer);
        if (existing.intervalTimer) clearInterval(existing.intervalTimer);
      }
      timeoutTimers.delete(upper);
      activeMatches.delete(upper);

      // If game continues, set up timeout timers for next round
      if (!isGameComplete && game.rpsTimePerMove && game.rpsTimePerMove > 0) {
        const timePerMove = game.rpsTimePerMove * 1000; // Convert to milliseconds
        
        // Store round start time
        const roundStartTime = Date.now();
        let timeRemaining = game.rpsTimePerMove;
        
        // Send initial timer update
        io.to(upper).emit('rpsTimerUpdate', {
          timeRemaining,
          roundStartTime,
        });
        
        // Send periodic timer updates every second
        const intervalTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
          timeRemaining = Math.max(0, game.rpsTimePerMove - elapsed);
          
          io.to(upper).emit('rpsTimerUpdate', {
            timeRemaining,
            roundStartTime,
          });
          
          if (timeRemaining <= 0) {
            clearInterval(intervalTimer);
          }
        }, 1000);
        
        const timeoutData = {
          hostTimer: setTimeout(() => handleRPSTimeout(upper, hostId, guestId), timePerMove),
          guestTimer: setTimeout(() => handleRPSTimeout(upper, guestId, hostId), timePerMove),
          intervalTimer,
        };
        timeoutTimers.set(upper, timeoutData);
        // Initialize state for next round
        activeMatches.set(upper, { moves: {} });
      }
    });

    // Handle timeout for RPS - player loses if they don't submit in time
    const handleRPSTimeout = async (code, timedOutPlayerId, opponentId) => {
      const upper = code.toUpperCase();
      const game = await Game.findOne({ code: upper });
      if (!game || !game.guest) return;

      const state = activeMatches.get(upper);
      if (!state) return;

      // Clear timer interval
      const existing = timeoutTimers.get(upper);
      if (existing && existing.intervalTimer) {
        clearInterval(existing.intervalTimer);
      }

      // If player already submitted, ignore timeout
      if (state.moves[timedOutPlayerId]) return;

      const hostId = String(game.host);
      const guestId = String(game.guest);
      
      // Determine which player timed out and award round to opponent
      let winner = null;
      let hostMove = state.moves[hostId];
      let guestMove = state.moves[guestId];
      
      if (timedOutPlayerId === hostId) {
        // Host timed out - guest wins
        winner = 'guest';
        hostMove = null; // Host didn't submit
        game.guestScore += 1;
      } else if (timedOutPlayerId === guestId) {
        // Guest timed out - host wins
        winner = 'host';
        guestMove = null; // Guest didn't submit
        game.hostScore += 1;
      }

      game.rounds.push({
        gameType: 'ROCK_PAPER_SCISSORS',
        moves: [
          { player: game.host, choice: hostMove || 'timeout' },
          { player: game.guest, choice: guestMove || 'timeout' },
        ],
        winner: winner === 'host' ? game.host : game.guest,
        summary: `${winner === 'host' ? 'Host' : 'Guest'} wins - opponent ran out of time.`,
      });

      const isGameComplete = game.hostScore >= 10 || game.guestScore >= 10;
      if (isGameComplete) {
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        game.activeStage = 'ROCK_PAPER_SCISSORS';
        await game.save();
        await updateUserStats(game);
      } else {
        game.status = 'IN_PROGRESS';
        game.activeStage = 'ROCK_PAPER_SCISSORS';
        await game.save();
      }

      const resultPayload = {
        code: upper,
        result: winner,
        hostMove: hostMove || 'timeout',
        guestMove: guestMove || 'timeout',
        hostScore: game.hostScore,
        guestScore: game.guestScore,
        isGameComplete,
        winner: isGameComplete ? (game.hostScore >= 10 ? 'host' : 'guest') : null,
        nextStage: isGameComplete ? null : 'ROCK_PAPER_SCISSORS',
        timeout: true,
        timedOutPlayer: timedOutPlayerId === hostId ? 'host' : 'guest',
      };

      io.to(upper).emit('roundResult', resultPayload);
      timeoutTimers.delete(upper);
      activeMatches.delete(upper);
    };

    // Matching Pennies game handler
    socket.on('submitPenniesMove', async ({ code, choice }) => {
      const upper = code?.toUpperCase();
      if (!upper || !['heads', 'tails'].includes(choice)) {
        socket.emit('game:error', 'Invalid choice or code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (!game.guest) {
        socket.emit('game:error', 'Waiting for opponent to join');
        return;
      }

      if (game.activeStage !== 'MATCHING_PENNIES') {
        socket.emit('game:error', 'Matching Pennies is not active');
        return;
      }

      const userId = String(socket.user.id);
      // Handle both populated objects and ObjectIds
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);

      const isParticipant = userId === hostId || userId === guestId;
      if (!isParticipant) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      // Clear timeout timer for this player
      const timeoutData = timeoutTimers.get(`pennies_${upper}`);
      if (timeoutData) {
        if (userId === hostId && timeoutData.hostTimer) {
          clearTimeout(timeoutData.hostTimer);
          timeoutData.hostTimer = null;
        } else if (userId === guestId && timeoutData.guestTimer) {
          clearTimeout(timeoutData.guestTimer);
          timeoutData.guestTimer = null;
        }
      }

      let state = activeMatches.get(`pennies_${upper}`);
      if (!state) {
        state = { choices: {}, roundNumber: game.penniesRoundNumber || 0 };
        activeMatches.set(`pennies_${upper}`, state);
      }

      state.choices[userId] = choice;
      const displayName = socket.user.studentName || socket.user.username;
      console.log(`[${upper}] Player ${displayName} (${userId}) submitted: ${choice}`);
      socket.to(upper).emit('penniesOpponentLocked', displayName);

      const hostChoice = state.choices[hostId];
      const guestChoice = state.choices[guestId];

      console.log(`[${upper}] Pennies choices - Host: ${hostChoice || 'pending'}, Guest: ${guestChoice || 'pending'}`);

      if (!hostChoice || !guestChoice) {
        return;
      }

      // Constant roles: Host always chooses, Guest always chooses
      // If both choose the same: Host wins
      // If they choose differently: Guest wins
      const hostWon = hostChoice === guestChoice;
      let winnerUserId = null;
      let winner = null;

      if (hostWon) {
        // Same choice = Host wins
        winnerUserId = game.host;
        winner = 'host';
        game.hostPenniesScore += 1;
      } else {
        // Different choice = Guest wins
        winnerUserId = game.guest;
        winner = 'guest';
        game.guestPenniesScore += 1;
      }

      game.rounds.push({
        gameType: 'MATCHING_PENNIES',
        moves: [
          { player: game.host, choice: hostChoice },
          { player: game.guest, choice: guestChoice },
        ],
        winner: winnerUserId,
        summary: hostWon
          ? `Both chose ${hostChoice}. ${game.host.studentName || game.host.username} wins!`
          : `${game.host.studentName || game.host.username} chose ${hostChoice}, ${game.guest.studentName || game.guest.username} chose ${guestChoice}. ${game.guest.studentName || game.guest.username} wins!`,
      });

      state.roundNumber += 1;
      game.penniesRoundNumber = state.roundNumber;

      const isGameComplete = game.hostPenniesScore >= 10 || game.guestPenniesScore >= 10;
      if (isGameComplete) {
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        await game.save();
        await updateUserStats(game);
      } else {
        game.status = 'IN_PROGRESS';
        await game.save();
      }

      const resultPayload = {
        code: upper,
        winner: isGameComplete ? (game.hostPenniesScore >= 10 ? 'host' : 'guest') : winner,
        hostChoice,
        guestChoice,
        hostWon,
        hostScore: game.hostPenniesScore,
        guestScore: game.guestPenniesScore,
        roundNumber: state.roundNumber - 1,
        isGameComplete,
      };

      console.log(`[${upper}] Emitting penniesResult:`, resultPayload);
      io.to(upper).emit('penniesResult', resultPayload);

      // Clear choices for next round
      state.choices = {};
      activeMatches.set(`pennies_${upper}`, state);
      
      // Clear timeout timers
      timeoutTimers.delete(`pennies_${upper}`);

      // If game continues, set up timeout timers for next round
      if (!isGameComplete && game.penniesTimePerMove && game.penniesTimePerMove > 0) {
        const timePerMove = game.penniesTimePerMove * 1000;
        
        // Store round start time
        const roundStartTime = Date.now();
        let timeRemaining = game.penniesTimePerMove;
        
        // Send initial timer update
        io.to(upper).emit('penniesTimerUpdate', {
          timeRemaining,
          roundStartTime,
        });
        
        // Send periodic timer updates every second
        const intervalTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
          timeRemaining = Math.max(0, game.penniesTimePerMove - elapsed);
          
          io.to(upper).emit('penniesTimerUpdate', {
            timeRemaining,
            roundStartTime,
          });
          
          if (timeRemaining <= 0) {
            clearInterval(intervalTimer);
          }
        }, 1000);
        
        const timeoutData = {
          hostTimer: setTimeout(() => handlePenniesTimeout(upper, hostId), timePerMove),
          guestTimer: setTimeout(() => handlePenniesTimeout(upper, guestId), timePerMove),
          intervalTimer,
        };
        timeoutTimers.set(`pennies_${upper}`, timeoutData);
      }
    });

    // Handle timeout for Matching Pennies - player loses if they don't submit in time
    const handlePenniesTimeout = async (code, timedOutPlayerId) => {
      const upper = code.toUpperCase();
      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game || !game.guest) return;

      const state = activeMatches.get(`pennies_${upper}`);
      if (!state) return;

      // Clear timer interval
      const timeoutData = timeoutTimers.get(`pennies_${upper}`);
      if (timeoutData && timeoutData.intervalTimer) {
        clearInterval(timeoutData.intervalTimer);
      }

      // If player already submitted, ignore timeout
      if (state.choices[timedOutPlayerId]) return;

      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      
      // Determine which player timed out and award round to opponent
      let winner = null;
      let hostChoice = state.choices[hostId];
      let guestChoice = state.choices[guestId];
      
      if (timedOutPlayerId === hostId) {
        // Host timed out - guest wins (different choice rule)
        winner = 'guest';
        hostChoice = null; // Host didn't submit
        game.guestPenniesScore += 1;
      } else if (timedOutPlayerId === guestId) {
        // Guest timed out - host wins (same choice rule)
        winner = 'host';
        guestChoice = null; // Guest didn't submit
        game.hostPenniesScore += 1;
      }

      game.rounds.push({
        gameType: 'MATCHING_PENNIES',
        moves: [
          { player: game.host, choice: hostChoice || 'timeout' },
          { player: game.guest, choice: guestChoice || 'timeout' },
        ],
        winner: winner === 'host' ? game.host : game.guest,
        summary: `${winner === 'host' ? game.host.studentName || game.host.username : game.guest.studentName || game.guest.username} wins - opponent ran out of time.`,
      });

      state.roundNumber += 1;
      game.penniesRoundNumber = state.roundNumber;

      const isGameComplete = game.hostPenniesScore >= 10 || game.guestPenniesScore >= 10;
      if (isGameComplete) {
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        await game.save();
        await updateUserStats(game);
      } else {
        game.status = 'IN_PROGRESS';
        await game.save();
      }

      const resultPayload = {
        code: upper,
        winner: isGameComplete ? (game.hostPenniesScore >= 10 ? 'host' : 'guest') : winner,
        hostChoice: hostChoice || 'timeout',
        guestChoice: guestChoice || 'timeout',
        hostWon: winner === 'host',
        hostScore: game.hostPenniesScore,
        guestScore: game.guestPenniesScore,
        roundNumber: state.roundNumber - 1,
        isGameComplete,
        timeout: true,
        timedOutPlayer: timedOutPlayerId === hostId ? 'host' : 'guest',
      };

      io.to(upper).emit('penniesResult', resultPayload);
      
      // Clear timer interval
      const penniesTimerData = timeoutTimers.get(`pennies_${upper}`);
      if (penniesTimerData && penniesTimerData.intervalTimer) {
        clearInterval(penniesTimerData.intervalTimer);
      }
      
      // Clear choices for next round
      state.choices = {};
      activeMatches.set(`pennies_${upper}`, state);
      timeoutTimers.delete(`pennies_${upper}`);
    };

    // Start round - set up timeout timers for RPS and Matching Pennies
    socket.on('startRound', async ({ code, gameType }) => {
      const upper = code?.toUpperCase();
      if (!upper) return;

      const game = await Game.findOne({ code: upper });
      if (!game || !game.guest) return;

      if (gameType === 'ROCK_PAPER_SCISSORS' && game.rpsTimePerMove && game.rpsTimePerMove > 0) {
        const hostId = String(game.host);
        const guestId = String(game.guest);
        const timePerMove = game.rpsTimePerMove * 1000;
        
        // Clear any existing timers
        const existing = timeoutTimers.get(upper);
        if (existing) {
          if (existing.hostTimer) clearTimeout(existing.hostTimer);
          if (existing.guestTimer) clearTimeout(existing.guestTimer);
          if (existing.intervalTimer) clearInterval(existing.intervalTimer);
        }
        
        // Store round start time
        const roundStartTime = Date.now();
        let timeRemaining = game.rpsTimePerMove;
        
        // Send initial timer update
        io.to(upper).emit('rpsTimerUpdate', {
          timeRemaining,
          roundStartTime,
        });
        
        // Send periodic timer updates every second
        const intervalTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
          timeRemaining = Math.max(0, game.rpsTimePerMove - elapsed);
          
          io.to(upper).emit('rpsTimerUpdate', {
            timeRemaining,
            roundStartTime,
          });
          
          if (timeRemaining <= 0) {
            clearInterval(intervalTimer);
          }
        }, 1000);
        
        const timeoutData = {
          hostTimer: setTimeout(() => handleRPSTimeout(upper, hostId, guestId), timePerMove),
          guestTimer: setTimeout(() => handleRPSTimeout(upper, guestId, hostId), timePerMove),
          intervalTimer,
        };
        timeoutTimers.set(upper, timeoutData);
        
        // Initialize state for the round
        if (!activeMatches.has(upper)) {
          activeMatches.set(upper, { moves: {} });
        }
      } else if (gameType === 'MATCHING_PENNIES' && game.penniesTimePerMove && game.penniesTimePerMove > 0) {
        const hostId = String(game.host?._id || game.host?.id || game.host);
        const guestId = String(game.guest?._id || game.guest?.id || game.guest);
        const timePerMove = game.penniesTimePerMove * 1000;
        
        // Clear any existing timers
        const existing = timeoutTimers.get(`pennies_${upper}`);
        if (existing) {
          if (existing.hostTimer) clearTimeout(existing.hostTimer);
          if (existing.guestTimer) clearTimeout(existing.guestTimer);
          if (existing.intervalTimer) clearInterval(existing.intervalTimer);
        }
        
        // Store round start time
        const roundStartTime = Date.now();
        let timeRemaining = game.penniesTimePerMove;
        
        // Send initial timer update
        io.to(upper).emit('penniesTimerUpdate', {
          timeRemaining,
          roundStartTime,
        });
        
        // Send periodic timer updates every second
        const intervalTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
          timeRemaining = Math.max(0, game.penniesTimePerMove - elapsed);
          
          io.to(upper).emit('penniesTimerUpdate', {
            timeRemaining,
            roundStartTime,
          });
          
          if (timeRemaining <= 0) {
            clearInterval(intervalTimer);
          }
        }, 1000);
        
        const timeoutData = {
          hostTimer: setTimeout(() => handlePenniesTimeout(upper, hostId), timePerMove),
          guestTimer: setTimeout(() => handlePenniesTimeout(upper, guestId), timePerMove),
          intervalTimer,
        };
        timeoutTimers.set(`pennies_${upper}`, timeoutData);
        
        // Initialize state for the round
        if (!activeMatches.has(`pennies_${upper}`)) {
          activeMatches.set(`pennies_${upper}`, { choices: {}, roundNumber: game.penniesRoundNumber || 0 });
        }
      }
    });

    // Game of Go handler
    socket.on('submitGoMove', async ({ code, row, col, color }) => {
      const upper = code?.toUpperCase();
      if (!upper || row === undefined || col === undefined || !color) {
        socket.emit('game:error', 'Invalid move or code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (!game.guest) {
        socket.emit('game:error', 'Waiting for opponent to join');
        return;
      }

      if (game.activeStage !== 'GAME_OF_GO') {
        socket.emit('game:error', 'Game of Go is not active');
        return;
      }

      if (game.goPhase !== 'PLAY') {
        socket.emit('game:error', 'Game is currently in scoring phase');
        return;
      }

      const userId = String(socket.user.id);
      // Handle both populated objects and ObjectIds
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);

      const isParticipant = userId === hostId || userId === guestId;
      if (!isParticipant) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      // Verify it's the player's turn
      const expectedColor = userId === hostId ? 'black' : 'white';
      if (color !== expectedColor) {
        socket.emit('game:error', 'Invalid color for your player');
        return;
      }

      if (game.goCurrentTurn !== color) {
        socket.emit('game:error', 'Not your turn');
        return;
      }

      // Initialize board if needed
      if (!game.goBoard) {
        game.goBoard = Array(9).fill(null).map(() => Array(9).fill(null));
      }

      // Validate move
      const boardSize = game.goBoardSize || BOARD_DEFAULT_SIZE;

      if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) {
        socket.emit('game:error', 'Invalid board position');
        return;
      }

      if (!game.goBoard || game.goBoard.length !== boardSize) {
        game.goBoard = createBoard(boardSize);
        game.markModified?.('goBoard');
      }

      if (game.goBoard[row][col] !== null) {
        socket.emit('game:error', 'Position already occupied');
        return;
      }

      // Make a copy of the board for testing
      const testBoard = cloneBoard(game.goBoard);
      testBoard[row][col] = color;

      // Check for opponent captures first
      const captured = checkCaptures(testBoard, row, col, color === 'black' ? 'white' : 'black');
      
      // Apply opponent captures
      captured.forEach(([r, c]) => {
        testBoard[r][c] = null;
      });

      // SUICIDE RULE: Check if the placed stone's own group has liberties
      // If no opponent stones were captured AND own group has no liberties, it's suicide
      if (captured.length === 0) {
        const ownGroup = findGroup(testBoard, row, col, color, new Set());
        if (!hasLiberties(testBoard, ownGroup)) {
          socket.emit('game:error', 'Suicide rule: Cannot place stone that would capture your own group');
          return;
        }
      }

      // SUPERKO RULE: Check if this move recreates any previous board state (with next turn)
      const nextTurn = color === 'black' ? 'white' : 'black';
      const positionHash = getPositionHash(testBoard, nextTurn);
      const history = Array.isArray(game.goPositionHashes) ? game.goPositionHashes : [];
      if (history.includes(positionHash)) {
        socket.emit('game:error', 'Superko rule: Cannot repeat a previous board position');
        return;
      }

      // Store current board as previous for reference
      game.goPreviousBoard = cloneBoard(game.goBoard);
      
      // Update board
      game.goBoard = testBoard;
      game.goConsecutivePasses = 0; // Reset pass counter on valid move
      game.goPositionHashes = [...history.slice(-MAX_POSITION_HISTORY + 1), positionHash];
      
      // Update captured stones
      if (color === 'black') {
        game.goCapturedBlack += captured.length;
      } else {
        game.goCapturedWhite += captured.length;
      }

      // Update time for the player who just moved
      updateTimeOnMove(game, color);

      // Check for time expiration
      if (game.goTimeExpired) {
        game.goPhase = 'COMPLETE';
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        const winner = game.goTimeExpired === 'black' ? 'white' : 'black';
        game.goFinalScore = {
          winner,
          reason: 'time',
          message: `${game.goTimeExpired === 'black' ? 'Black' : 'White'} ran out of time. ${winner === 'black' ? 'Black' : 'White'} wins.`,
        };
        await game.save();
        await updateUserStats(game);
        io.to(upper).emit('goTimeExpired', {
          code: upper,
          expired: game.goTimeExpired,
          winner,
          message: game.goFinalScore.message,
        });
        return;
      }

      // Switch turn
      game.goCurrentTurn = color === 'black' ? 'white' : 'black';
      game.status = 'IN_PROGRESS';

      // Store move in rounds for analysis
      const movePlayer = color === 'black' ? game.host : game.guest;
      game.rounds.push({
        gameType: 'GAME_OF_GO',
        moves: [
          {
            player: movePlayer,
            choice: `place:${row}:${col}:${color}`,
            row,
            col,
            color,
            captured: captured.length,
          },
        ],
        winner: null,
        summary: `${(socket.user.studentName || socket.user.username)} placed ${color} at (${row + 1}, ${col + 1})${captured.length > 0 ? `, captured ${captured.length} stone(s)` : ''}`,
      });

      await game.save();

      const timeInfo = {
        black: getCurrentTimeRemaining(game, 'black'),
        white: getCurrentTimeRemaining(game, 'white'),
      };

      const movePayload = {
        code: upper,
        board: game.goBoard,
        currentTurn: game.goCurrentTurn,
        boardSize,
        capturedBlack: game.goCapturedBlack,
        capturedWhite: game.goCapturedWhite,
        komi: game.goKomi,
        phase: game.goPhase,
        lastMove: { row, col, color },
        timeInfo,
        message: `${(socket.user.studentName || socket.user.username)} placed a ${color} stone at (${row + 1}, ${col + 1})${captured.length > 0 ? ` and captured ${captured.length} stone(s)` : ''}`,
      };

      io.to(upper).emit('goMove', movePayload);
    });

    // Pass handler for Game of Go
    socket.on('passGo', async ({ code }) => {
      const upper = code?.toUpperCase();
      if (!upper) {
        socket.emit('game:error', 'Invalid code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (game.activeStage !== 'GAME_OF_GO') {
        socket.emit('game:error', 'Game of Go is not active');
        return;
      }

      if (game.goPhase !== 'PLAY') {
        socket.emit('game:error', 'Game is already in scoring phase');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      const isParticipant = userId === hostId || userId === guestId;
      
      if (!isParticipant) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      const expectedColor = userId === hostId ? 'black' : 'white';
      if (game.goCurrentTurn !== expectedColor) {
        socket.emit('game:error', 'Not your turn');
        return;
      }

      // Update time for the player who just passed
      updateTimeOnMove(game, expectedColor);

      // Check for time expiration
      if (game.goTimeExpired) {
        game.goPhase = 'COMPLETE';
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        const winnerColor = game.goTimeExpired === 'black' ? 'white' : 'black';
        const winner = winnerColor === 'black' ? 'host' : 'guest';
        // Set final score with reason but NO scoring details
        game.goFinalScore = {
          winner: winnerColor,
          reason: 'timeout',
          message: `${game.goTimeExpired === 'black' ? 'Black' : 'White'} ran out of time. ${winnerColor === 'black' ? 'Black' : 'White'} wins.`,
        };
        await game.save();
        await updateUserStats(game);
        io.to(upper).emit('goTimeExpired', {
          code: upper,
          expired: game.goTimeExpired,
          winner: winnerColor,
          message: game.goFinalScore.message,
        });
        return;
      }

      // Increment consecutive passes
      game.goConsecutivePasses += 1;
      
      // Store pass move in rounds for analysis
      const passPlayer = expectedColor === 'black' ? game.host : game.guest;
      game.rounds.push({
        gameType: 'GAME_OF_GO',
        moves: [
          {
            player: passPlayer,
            choice: 'pass',
            color: expectedColor,
          },
        ],
        winner: null,
        summary: `${(socket.user.studentName || socket.user.username)} passed`,
      });
      
      // Switch turn
      game.goCurrentTurn = expectedColor === 'black' ? 'white' : 'black';
      
      const timeInfo = {
        black: getCurrentTimeRemaining(game, 'black'),
        white: getCurrentTimeRemaining(game, 'white'),
      };

      const passPayload = {
        code: upper,
        currentTurn: game.goCurrentTurn,
        consecutivePasses: game.goConsecutivePasses,
        timeInfo,
        message: `${(socket.user.studentName || socket.user.username)} passed.${game.goConsecutivePasses >= 2 ? ' Both players passed. Entering scoring phase.' : ' Waiting for opponent.'}`,
        phase: game.goPhase,
      };
      
      if (game.goConsecutivePasses >= 2) {
        // Both players passed - automatically calculate and finalize score
        game.goPhase = 'SCORING';
        game.goScoringConfirmations = [];
        game.goPendingScoringMethod = DEFAULT_SCORING_METHOD;
        passPayload.phase = game.goPhase;

        // Auto-confirm for both players
        const hostId = String(game.host?._id || game.host?.id || game.host);
        const guestId = String(game.guest?._id || game.guest?.id || game.guest);
        const allPlayerIds = [hostId, guestId].filter(Boolean);
        game.goScoringConfirmations = allPlayerIds;

        // Calculate score immediately
        const workingBoard = cloneBoard(game.goBoard || createBoard(game.goBoardSize || BOARD_DEFAULT_SIZE));
        const deadCaptureBonus = removeDeadStonesForScoring(workingBoard, game.goDeadStones || []);
        const totalCaptures = {
          black: game.goCapturedBlack + deadCaptureBonus.black,
          white: game.goCapturedWhite + deadCaptureBonus.white,
        };

        let scoreSummary;
        if (DEFAULT_SCORING_METHOD === 'japanese') {
          scoreSummary = calculateJapaneseScore(workingBoard, totalCaptures, game.goKomi);
        } else {
          scoreSummary = calculateChineseScore(workingBoard, totalCaptures, game.goKomi);
        }

        game.goCapturedBlack = totalCaptures.black;
        game.goCapturedWhite = totalCaptures.white;
        game.goFinalScore = { ...scoreSummary, method: DEFAULT_SCORING_METHOD };
        game.goPhase = 'COMPLETE';
        game.status = 'COMPLETE';
        game.completedAt = new Date();
        game.goScoringConfirmations = [];

        await game.save();
        await updateUserStats(game);

        // Emit pass event first
        io.to(upper).emit('goPass', passPayload);

        // Then emit score finalized event
        io.to(upper).emit('goScoreFinalized', {
          code: upper,
          method: DEFAULT_SCORING_METHOD,
          ...scoreSummary,
          message: 'Both players passed. Game complete!',
        });

        return; // Exit early since game is complete
      }

      await game.save();
      io.to(upper).emit('goPass', passPayload);
    });

    socket.on('toggleGoDeadStone', async ({ code, row, col }) => {
      const upper = code?.toUpperCase();
      if (!upper || row === undefined || col === undefined) {
        socket.emit('game:error', 'Invalid request');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (game.activeStage !== 'GAME_OF_GO') {
        socket.emit('game:error', 'Game of Go is not active');
        return;
      }

      if (game.goPhase !== 'SCORING') {
        socket.emit('game:error', 'Dead stones can only be marked during scoring');
        return;
      }

      const boardSize = game.goBoardSize || BOARD_DEFAULT_SIZE;
      if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) {
        socket.emit('game:error', 'Invalid board position');
        return;
      }

      const stoneColor = game.goBoard?.[row]?.[col];
      if (!stoneColor) {
        socket.emit('game:error', 'Cannot mark an empty intersection as dead');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      const isParticipant = userId === hostId || userId === guestId;
      if (!isParticipant) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      const existingIndex = (game.goDeadStones || []).findIndex(
        (stone) => stone.row === row && stone.col === col
      );

      if (existingIndex >= 0) {
        game.goDeadStones.splice(existingIndex, 1);
      } else {
        game.goDeadStones.push({ row, col, color: stoneColor });
      }

      game.goScoringConfirmations = []; // invalidate confirmations when stones change

      await game.save();

      io.to(upper).emit('goDeadStonesUpdated', {
        code: upper,
        deadStones: game.goDeadStones,
        updatedBy: socket.user.studentName || socket.user.username,
      });
    });

    socket.on('finalizeGoScore', async ({ code, method }) => {
      const upper = code?.toUpperCase();
      if (!upper) {
        socket.emit('game:error', 'Invalid request');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const selectedMethod = method === 'japanese' ? 'japanese' : 'chinese';

      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (game.activeStage !== 'GAME_OF_GO') {
        socket.emit('game:error', 'Game of Go is not active');
        return;
      }

      // Allow ending game from PLAY or SCORING phase
      if (game.goPhase === 'COMPLETE') {
        socket.emit('game:error', 'Game is already complete');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      if (userId !== hostId && userId !== guestId) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      // If game is in PLAY phase, force end and auto-finalize
      const isForceEnd = game.goPhase === 'PLAY';
      if (isForceEnd) {
        game.goPhase = 'SCORING';
        game.goScoringConfirmations = [];
        game.goPendingScoringMethod = selectedMethod;
        // Auto-confirm for both players when force ending
        const allPlayerIds = [hostId, guestId].filter(Boolean);
        game.goScoringConfirmations = allPlayerIds;
      } else {
        // Normal scoring phase - require confirmations
        if (game.goPendingScoringMethod && game.goScoringConfirmations.length > 0 && game.goPendingScoringMethod !== selectedMethod) {
          socket.emit('game:error', `Scoring already in progress using ${game.goPendingScoringMethod} rules`);
          return;
        }

        game.goPendingScoringMethod = selectedMethod;

        const confirmations = new Set(
          (game.goScoringConfirmations || []).map((id) => String(id))
        );
        if (!confirmations.has(userId)) {
          game.goScoringConfirmations.push(socket.user.id);
        }

        const requiredConfirmations = game.guest ? 2 : 1;
        if (game.goScoringConfirmations.length < requiredConfirmations) {
          await game.save();
          io.to(upper).emit('goScorePending', {
            code: upper,
            method: selectedMethod,
            confirmations: game.goScoringConfirmations.length,
            required: requiredConfirmations,
            message: `${(socket.user.studentName || socket.user.username)} confirmed scoring using ${selectedMethod} rules.`,
          });
          return;
        }
      }

      const workingBoard = cloneBoard(game.goBoard || createBoard(game.goBoardSize || BOARD_DEFAULT_SIZE));
      const deadCaptureBonus = removeDeadStonesForScoring(workingBoard, game.goDeadStones || []);
      const totalCaptures = {
        black: game.goCapturedBlack + deadCaptureBonus.black,
        white: game.goCapturedWhite + deadCaptureBonus.white,
      };

      let scoreSummary;
      if (selectedMethod === 'japanese') {
        scoreSummary = calculateJapaneseScore(workingBoard, totalCaptures, game.goKomi);
      } else {
        scoreSummary = calculateChineseScore(workingBoard, totalCaptures, game.goKomi);
      }

      game.goCapturedBlack = totalCaptures.black;
      game.goCapturedWhite = totalCaptures.white;
      game.goFinalScore = { ...scoreSummary, method: selectedMethod };
      game.goPhase = 'COMPLETE';
      game.status = 'COMPLETE';
      game.completedAt = new Date();
      game.activeStage = 'GAME_OF_GO';
      game.goScoringConfirmations = [];

      await game.save();
      await updateUserStats(game);

      io.to(upper).emit('goScoreFinalized', {
        code: upper,
        method: selectedMethod,
        ...scoreSummary,
      });
    });

    // Resign handler for Game of Go - ends game without scoring
    socket.on('resignGo', async ({ code }) => {
      const upper = code?.toUpperCase();
      if (!upper) {
        socket.emit('game:error', 'Invalid code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper }).populate('host', 'username studentName').populate('guest', 'username studentName');
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      if (game.activeStage !== 'GAME_OF_GO') {
        socket.emit('game:error', 'Game of Go is not active');
        return;
      }

      if (game.goPhase === 'COMPLETE') {
        socket.emit('game:error', 'Game is already complete');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      if (userId !== hostId && userId !== guestId) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      // Determine winner - the player who resigned loses
      const resigningColor = userId === hostId ? 'black' : 'white';
      const winnerColor = resigningColor === 'black' ? 'white' : 'black';
      const winner = winnerColor === 'black' ? 'host' : 'guest';

      // End game without scoring
      game.goPhase = 'COMPLETE';
      game.status = 'COMPLETE';
      game.completedAt = new Date();
      game.goFinalScore = {
        winner: winnerColor,
        reason: 'resignation',
        message: `${resigningColor === 'black' ? 'Black' : 'White'} resigned. ${winnerColor === 'black' ? 'Black' : 'White'} wins.`,
      };

      await game.save();
      await updateUserStats(game);

      io.to(upper).emit('goResigned', {
        code: upper,
        resigningColor,
        winner: winnerColor,
        message: game.goFinalScore.message,
      });
    });

    // Rematch request handler
    socket.on('rematch:request', async ({ code }) => {
      const upper = code?.toUpperCase();
      if (!upper) {
        socket.emit('game:error', 'Invalid code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper })
        .populate('host', 'username studentName')
        .populate('guest', 'username studentName');
      
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      
      if (userId !== hostId && userId !== guestId) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      if (!game.guest) {
        socket.emit('game:error', 'Opponent has not joined yet');
        return;
      }

      // Determine opponent
      const opponentId = userId === hostId ? guestId : hostId;
      const opponentName = userId === hostId 
        ? (game.guest?.studentName || game.guest?.username || 'Opponent')
        : (game.host?.studentName || game.host?.username || 'Opponent');
      const requesterName = userId === hostId
        ? (game.host?.studentName || game.host?.username || 'You')
        : (game.guest?.studentName || game.guest?.username || 'You');

      // Send rematch request to opponent
      io.to(upper).emit('rematch:requested', {
        code: upper,
        requesterId: userId,
        requesterName,
        gameType: game.activeStage,
        gameSettings: {
          goBoardSize: game.goBoardSize,
          goTimeControl: game.goTimeControl,
          rpsTimePerMove: game.rpsTimePerMove,
          penniesTimePerMove: game.penniesTimePerMove,
        },
      });
    });

    // Rematch accept handler
    socket.on('rematch:accept', async ({ code, requesterId }) => {
      const upper = code?.toUpperCase();
      if (!upper) {
        socket.emit('game:error', 'Invalid code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper })
        .populate('host', 'username studentName')
        .populate('guest', 'username studentName');
      
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      
      if (userId !== hostId && userId !== guestId) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      if (String(requesterId) !== hostId && String(requesterId) !== guestId) {
        socket.emit('game:error', 'Invalid requester');
        return;
      }

      if (String(requesterId) === userId) {
        socket.emit('game:error', 'Cannot accept your own rematch request');
        return;
      }

      // Create new game with same players and settings
      const GameModel = require('../models/Game');
      const generateMatchCode = require('../utils/generateMatchCode');
      
      let newCode;
      let exists = true;
      while (exists) {
        newCode = await generateMatchCode();
        exists = await GameModel.exists({ code: newCode });
      }

      const newGame = new GameModel({
        code: newCode,
        host: game.host._id,
        guest: game.guest._id,
        status: 'READY',
        activeStage: game.activeStage,
        goBoardSize: game.goBoardSize,
        goTimeControl: game.goTimeControl,
        rpsTimePerMove: game.rpsTimePerMove,
        penniesTimePerMove: game.penniesTimePerMove,
      });

      await newGame.save();
      await newGame.populate('host', 'username studentName avatarColor email');
      await newGame.populate('guest', 'username studentName avatarColor email');

      // Notify both players
      io.to(upper).emit('rematch:accepted', {
        oldCode: upper,
        newCode: newGame.code,
        game: newGame,
      });
    });

    // Rematch reject handler
    socket.on('rematch:reject', async ({ code }) => {
      const upper = code?.toUpperCase();
      if (!upper) {
        socket.emit('game:error', 'Invalid code');
        return;
      }

      const rooms = Array.from(socket.rooms);
      if (!rooms.includes(upper)) {
        socket.emit('game:error', 'Please join the game first');
        return;
      }

      const game = await Game.findOne({ code: upper })
        .populate('host', 'username studentName')
        .populate('guest', 'username studentName');
      
      if (!game) {
        socket.emit('game:error', 'Game not found');
        return;
      }

      const userId = String(socket.user.id);
      const hostId = String(game.host?._id || game.host?.id || game.host);
      const guestId = String(game.guest?._id || game.guest?.id || game.guest);
      
      if (userId !== hostId && userId !== guestId) {
        socket.emit('game:error', 'You are not part of this game');
        return;
      }

      const rejectorName = userId === hostId
        ? (game.host?.studentName || game.host?.username || 'Opponent')
        : (game.guest?.studentName || game.guest?.username || 'Opponent');

      // Notify requester
      io.to(upper).emit('rematch:rejected', {
        code: upper,
        rejectorName,
      });
    });
  });

  // Periodic time update for active Go games
  // Use shorter interval (500ms) but calculate based on real elapsed time
  // This ensures smooth 1-second decrements even if intervals are delayed
  setInterval(async () => {
    try {
      const activeGoGames = await Game.find({
        activeStage: 'GAME_OF_GO',
        goPhase: 'PLAY',
        'goTimeControl.mode': { $in: ['fischer', 'japanese'] },
        goTimeExpired: null,
      });

      for (const game of activeGoGames) {
        if (!game.goLastMoveTime) continue;

        const updated = updateCurrentPlayerTime(game);

        if (updated) {
          await game.save();

          const timeInfo = {
            black: getCurrentTimeRemaining(game, 'black'),
            white: getCurrentTimeRemaining(game, 'white'),
          };

          io.to(game.code.toUpperCase()).emit('goTimeUpdate', {
            code: game.code.toUpperCase(),
            timeInfo,
          });

          if (game.goTimeExpired) {
            game.goPhase = 'COMPLETE';
            game.status = 'COMPLETE';
            game.completedAt = new Date();
            const winner = game.goTimeExpired === 'black' ? 'white' : 'black';
            game.goFinalScore = {
              winner,
              reason: 'time',
              message: `${game.goTimeExpired === 'black' ? 'Black' : 'White'} ran out of time. ${winner === 'black' ? 'Black' : 'White'} wins.`,
            };
            await game.save();
            io.to(game.code.toUpperCase()).emit('goTimeExpired', {
              code: game.code.toUpperCase(),
              expired: game.goTimeExpired,
              winner,
              message: game.goFinalScore.message,
            });
          }
        }
      }
    } catch (err) {
      console.error('Error in time update interval:', err);
    }
  }, 500); // Check every 500ms, but calculate based on real elapsed time
};

// Helper function to check for captures
function checkCaptures(board, row, col, opponentColor) {
  const captured = [];
  const visited = new Set();
  const size = board?.length || BOARD_DEFAULT_SIZE;

  // Check all adjacent opponent groups
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    if (board[nr][nc] !== opponentColor) continue;
    
    const group = findGroup(board, nr, nc, opponentColor, visited);
    if (!hasLiberties(board, group)) {
      group.forEach(([r, c]) => {
        if (!captured.some(([cr, cc]) => cr === r && cc === c)) {
          captured.push([r, c]);
        }
      });
    }
  }

  return captured;
}

function findGroup(board, startRow, startCol, color, visited) {
  const group = [];
  const stack = [[startRow, startCol]];
  const size = board?.length || BOARD_DEFAULT_SIZE;

  while (stack.length > 0) {
    const [r, c] = stack.pop();
    const key = `${r},${c}`;
    
    if (visited.has(key)) continue;
    if (r < 0 || r >= size || c < 0 || c >= size) continue;
    if (board[r][c] !== color) continue;

    visited.add(key);
    group.push([r, c]);

    const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of directions) {
      stack.push([r + dr, c + dc]);
    }
  }

  return group;
}

function hasLiberties(board, group) {
  const size = board?.length || BOARD_DEFAULT_SIZE;
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (const [r, c] of group) {
    for (const [dr, dc] of directions) {
      const nr = r + dr;
      const nc = c + dc;
      
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (board[nr][nc] === null) return true;
    }
  }

  return false;
}

function removeDeadStonesForScoring(board, deadStones = []) {
  const bonusCaptures = { black: 0, white: 0 };

  if (!board || !board.length) {
    return bonusCaptures;
  }

  deadStones.forEach(({ row, col }) => {
    if (
      row === undefined ||
      col === undefined ||
      row < 0 ||
      col < 0 ||
      row >= board.length ||
      col >= board.length
    ) {
      return;
    }
    const color = board[row][col];
    if (!color) return;
    board[row][col] = null;
    if (color === 'black') {
      bonusCaptures.white += 1;
    } else {
      bonusCaptures.black += 1;
    }
  });

  return bonusCaptures;
}

function analyzeTerritory(board) {
  if (!board || !board.length) {
    return {
      territory: { black: 0, white: 0 },
      stones: { black: 0, white: 0 },
    };
  }

  const size = board.length;
  const visited = Array(size)
    .fill(null)
    .map(() => Array(size).fill(false));
  const territory = { black: 0, white: 0 };
  const stones = { black: 0, white: 0 };
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const cell = board[r][c];
      if (cell === 'black') {
        stones.black += 1;
        continue;
      }
      if (cell === 'white') {
        stones.white += 1;
        continue;
      }
      if (visited[r][c]) continue;

      const queue = [[r, c]];
      const region = [];
      const borderingColors = new Set();
      visited[r][c] = true;

      while (queue.length > 0) {
        const [cr, cc] = queue.shift();
        region.push([cr, cc]);

        for (const [dr, dc] of directions) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
          if (visited[nr][nc]) continue;

          const neighbor = board[nr][nc];
          if (neighbor === null) {
            visited[nr][nc] = true;
            queue.push([nr, nc]);
          } else {
            borderingColors.add(neighbor);
          }
        }
      }

      if (borderingColors.size === 1) {
        const [owner] = borderingColors;
        territory[owner] += region.length;
      }
    }
  }

  return { territory, stones };
}

function calculateChineseScore(board, captures, komi) {
  const { territory, stones } = analyzeTerritory(board);
  const blackArea = stones.black + territory.black;
  const whiteArea = stones.white + territory.white;
  const blackScore = blackArea;
  const whiteScore = whiteArea + komi;
  const winner =
    blackScore === whiteScore ? null : whiteScore > blackScore ? 'white' : 'black';

  return {
    black: {
      stones: stones.black,
      territory: territory.black,
      captures: captures.black,
      area: blackArea,
      score: blackScore,
    },
    white: {
      stones: stones.white,
      territory: territory.white,
      captures: captures.white,
      area: whiteArea,
      komi,
      score: whiteScore,
    },
    komi,
    winner,
  };
}

function calculateJapaneseScore(board, captures, komi) {
  const { territory } = analyzeTerritory(board);
  const blackScore = territory.black + captures.black;
  const whiteScore = territory.white + captures.white + komi;
  const winner =
    blackScore === whiteScore ? null : whiteScore > blackScore ? 'white' : 'black';

  return {
    black: {
      territory: territory.black,
      captures: captures.black,
      score: blackScore,
    },
    white: {
      territory: territory.white,
      captures: captures.white,
      komi,
      score: whiteScore,
    },
    komi,
    winner,
  };
}

module.exports = initGameSocket;
module.exports.updateUserStats = updateUserStats;

