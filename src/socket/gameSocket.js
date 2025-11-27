const jwt = require('jsonwebtoken');
const Game = require('../models/Game');
const User = require('../models/User');

const activeMatches = new Map();
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
 * Only subtracts elapsed time for the ACTIVE player
 */
function getCurrentTimeRemaining(game, color) {
  if (!game.goTimeControl || game.goTimeControl.mode === 'none') {
    return null;
  }

  const state = game.goTimeState[color];
  if (!state) return null;

  // Only calculate elapsed time if this is the active player
  const isActive = game.goCurrentTurn === color;
  const elapsed = isActive ? getElapsedTime(game) : 0;
  
  if (game.goTimeControl.mode === 'fischer') {
    const remaining = Math.max(0, state.mainTime - elapsed);
    return {
      mode: 'fischer',
      mainTime: remaining,
      isByoYomi: false,
      byoYomiTime: null,
      byoYomiPeriods: null,
    };
  } else if (game.goTimeControl.mode === 'japanese') {
    if (!state.isByoYomi) {
      const remaining = Math.max(0, state.mainTime - elapsed);
      return {
        mode: 'japanese',
        mainTime: remaining,
        isByoYomi: false,
        byoYomiTime: null,
        byoYomiPeriods: null,
      };
    } else {
      const remaining = Math.max(0, state.byoYomiTime - elapsed);
      return {
        mode: 'japanese',
        mainTime: 0,
        isByoYomi: true,
        byoYomiTime: remaining,
        byoYomiPeriods: state.byoYomiPeriods,
      };
    }
  }
  
  return null;
}

/**
 * Update time for current player (called periodically)
 */
function updateCurrentPlayerTime(game) {
  if (!game.goTimeControl || game.goTimeControl.mode === 'none') {
    return false;
  }

  const currentColor = game.goCurrentTurn;
  const state = game.goTimeState[currentColor];
  if (!state) return false;

  const elapsed = getElapsedTime(game);
  let updated = false;

  if (game.goTimeControl.mode === 'fischer') {
    const newTime = Math.max(0, state.mainTime - elapsed);
    if (newTime !== state.mainTime) {
      state.mainTime = newTime;
      updated = true;
      
      if (state.mainTime <= 0) {
        game.goTimeExpired = currentColor;
      }
    }
  } else if (game.goTimeControl.mode === 'japanese') {
    if (!state.isByoYomi) {
      const newTime = Math.max(0, state.mainTime - elapsed);
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
      const newTime = Math.max(0, state.byoYomiTime - elapsed);
      if (newTime !== state.byoYomiTime) {
        state.byoYomiTime = newTime;
        updated = true;
        
        if (state.byoYomiTime <= 0) {
          state.byoYomiPeriods = Math.max(0, state.byoYomiPeriods - 1);
          if (state.byoYomiPeriods <= 0) {
            game.goTimeExpired = currentColor;
          } else {
            state.byoYomiTime = game.goTimeControl.byoYomiTime;
          }
        }
      }
    }
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
      hostWon = game.hostScore >= 10;
      guestWon = game.guestScore >= 10;
      hostPoints = game.hostScore;
      guestPoints = game.guestScore;
    } else if (gameType === 'MATCHING_PENNIES') {
      hostWon = game.hostPenniesScore >= 10;
      guestWon = game.guestPenniesScore >= 10;
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
        result,
        hostMove,
        guestMove,
        hostScore: game.hostScore,
        guestScore: game.guestScore,
        isGameComplete,
        winner: isGameComplete ? (game.hostScore >= 10 ? 'host' : 'guest') : null,
        nextStage: isGameComplete ? null : 'ROCK_PAPER_SCISSORS',
      };

      console.log(`[${upper}] Emitting roundResult:`, resultPayload);
      io.to(upper).emit('roundResult', resultPayload);

      activeMatches.delete(upper);
    });

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

      // Increment consecutive passes
      game.goConsecutivePasses += 1;
      
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
        game.goPhase = 'SCORING';
        game.goScoringConfirmations = [];
        game.goPendingScoringMethod = DEFAULT_SCORING_METHOD;
        passPayload.phase = game.goPhase;
      }

      await game.save();
      io.to(upper).emit('goPass', passPayload);

      if (game.goPhase === 'SCORING') {
        const scoringPayload = {
          code: upper,
          board: game.goBoard,
          boardSize: game.goBoardSize || BOARD_DEFAULT_SIZE,
          komi: game.goKomi,
          captures: {
            black: game.goCapturedBlack,
            white: game.goCapturedWhite,
          },
          deadStones: game.goDeadStones || [],
          message: 'Both players passed. Entering dead stone marking phase.',
        };

        io.to(upper).emit('goScoringStart', scoringPayload);
      }
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
  });

  // Periodic time update for active Go games
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
  }, 1000); // Update every second
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

