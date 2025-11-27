const express = require('express');
const Game = require('../models/Game');
const User = require('../models/User');
const authGuard = require('../middleware/auth');
const generateMatchCode = require('../utils/generateMatchCode');

const router = express.Router();

router.post('/create', authGuard, async (req, res) => {
  try {
    let code;
    let exists = true;
    while (exists) {
      code = await generateMatchCode();
      exists = await Game.exists({ code });
    }

    const game = await Game.create({
      code,
      host: req.user.id,
      activeStage: null, // No game selected yet
    });

    await game.populate('host', 'username avatarColor');

    res.status(201).json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create game' });
  }
});

router.post('/join', authGuard, async (req, res) => {
  try {
    const { code } = req.body;
    const game = await Game.findOne({ code });
    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }
    if (game.guest && String(game.guest) !== req.user.id) {
      return res.status(400).json({ message: 'Game already has two players' });
    }
    if (String(game.host) === req.user.id) {
      return res.status(400).json({ message: 'You are already the host' });
    }

    game.guest = req.user.id;
    game.status = 'READY';
    game.activeStage = null; // No game selected yet, show game selector
    await game.save();
    await game.populate([
      { path: 'host', select: 'username avatarColor' },
      { path: 'guest', select: 'username avatarColor' },
    ]);

    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to join game' });
  }
});

// Get user game statistics - MUST be before /code/:code to avoid route conflicts
router.get('/stats', authGuard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('gameStats username');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      username: user.username,
      stats: user.gameStats || {
        totalGames: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        totalPoints: 0,
        goWins: 0,
        goLosses: 0,
        goPoints: 0,
        rpsWins: 0,
        rpsLosses: 0,
        rpsPoints: 0,
        penniesWins: 0,
        penniesLosses: 0,
        penniesPoints: 0,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch user stats' });
  }
});

router.get('/code/:code', authGuard, async (req, res) => {
  try {
    const game = await Game.findOne({ code: req.params.code })
      .populate('host', 'username avatarColor')
      .populate('guest', 'username avatarColor');
    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }
    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch game' });
  }
});

router.get('/', authGuard, async (req, res) => {
  try {
    const games = await Game.find({
      $or: [{ host: req.user.id }, { guest: req.user.id }],
    })
      .sort('-updatedAt')
      .limit(20)
      .populate('host', 'username avatarColor')
      .populate('guest', 'username avatarColor');

    res.json({ games });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load games' });
  }
});

router.post('/start-pennies', authGuard, async (req, res) => {
  try {
    const { code } = req.body;
    const game = await Game.findOne({ code });
    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }
    if (String(game.host) !== req.user.id && String(game.guest) !== req.user.id) {
      return res.status(403).json({ message: 'You are not part of this game' });
    }
    if (!game.guest) {
      return res.status(400).json({ message: 'Waiting for opponent to join' });
    }

    game.activeStage = 'MATCHING_PENNIES';
    game.status = 'READY';
    await game.save();
    await game.populate([
      { path: 'host', select: 'username avatarColor' },
      { path: 'guest', select: 'username avatarColor' },
    ]);

    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to start Matching Pennies' });
  }
});

router.post('/start-rps', authGuard, async (req, res) => {
  try {
    const { code } = req.body;
    const game = await Game.findOne({ code });
    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }
    if (String(game.host) !== req.user.id && String(game.guest) !== req.user.id) {
      return res.status(403).json({ message: 'You are not part of this game' });
    }
    if (!game.guest) {
      return res.status(400).json({ message: 'Waiting for opponent to join' });
    }

    game.activeStage = 'ROCK_PAPER_SCISSORS';
    game.status = 'READY';
    await game.save();
    await game.populate([
      { path: 'host', select: 'username avatarColor' },
      { path: 'guest', select: 'username avatarColor' },
    ]);

    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to start Rock Paper Scissors' });
  }
});

const DEFAULT_SIZES = [9, 13, 19];
const FIXED_KOMI = 6.5; // Fixed komi compensation for all board sizes

const createEmptyBoard = (size) => Array(size).fill(null).map(() => Array(size).fill(null));

const getPositionHash = (board, nextTurn) =>
  JSON.stringify({ board, next: nextTurn });

router.post('/start-go', authGuard, async (req, res) => {
  try {
    const { code, boardSize, komi, timeControl } = req.body;
    console.log('Backend received - boardSize:', boardSize, 'Type:', typeof boardSize, 'DEFAULT_SIZES:', DEFAULT_SIZES);
    const game = await Game.findOne({ code });
    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }
    if (String(game.host) !== req.user.id && String(game.guest) !== req.user.id) {
      return res.status(403).json({ message: 'You are not part of this game' });
    }
    if (!game.guest) {
      return res.status(400).json({ message: 'Waiting for opponent to join' });
    }

    const numBoardSize = Number(boardSize);
    console.log('Converted boardSize to number:', numBoardSize, 'Is in DEFAULT_SIZES?', DEFAULT_SIZES.includes(numBoardSize));
    const resolvedSize = DEFAULT_SIZES.includes(numBoardSize) ? numBoardSize : 9;
    console.log('Resolved size:', resolvedSize, 'Previous game.goBoardSize:', game.goBoardSize);
    // Komi is fixed at 6.5 for all board sizes
    const resolvedKomi = FIXED_KOMI;

    const initialBoard = createEmptyBoard(resolvedSize);
    const initialHash = getPositionHash(initialBoard, 'black');

    game.activeStage = 'GAME_OF_GO';
    game.status = 'READY';
    // Initialize Go board if not already set
    game.set('goBoardSize', resolvedSize);
    game.goBoard = initialBoard;
    game.goPreviousBoard = null;
    game.goCurrentTurn = 'black';
    game.goCapturedBlack = 0;
    game.goCapturedWhite = 0;
    game.goConsecutivePasses = 0;
    game.goKomi = resolvedKomi;
    game.goPositionHashes = [initialHash];
    game.goDeadStones = [];
    game.goPhase = 'PLAY';
    game.goFinalScore = null;
    game.goScoringConfirmations = [];
    game.goPendingScoringMethod = 'chinese';
    
    // Initialize time control
    if (timeControl && timeControl.mode && timeControl.mode !== 'none' && timeControl.mainTime > 0) {
      game.goTimeControl = {
        mode: timeControl.mode, // 'fischer' or 'japanese'
        mainTime: timeControl.mainTime,
        increment: timeControl.increment || 0, // For Fischer
        byoYomiTime: timeControl.byoYomiTime || 0, // For Japanese
        byoYomiPeriods: timeControl.byoYomiPeriods || 0, // For Japanese
      };
      
      // Initialize time state for both players
      game.goTimeState = {
        black: {
          mainTime: timeControl.mainTime,
          isByoYomi: false,
          byoYomiTime: 0,
          byoYomiPeriods: 0,
        },
        white: {
          mainTime: timeControl.mainTime,
          isByoYomi: false,
          byoYomiTime: 0,
          byoYomiPeriods: 0,
        },
      };
      
      game.goLastMoveTime = new Date();
    } else {
      // No time control
      game.goTimeControl = { mode: 'none', mainTime: 0, increment: 0, byoYomiTime: 0, byoYomiPeriods: 0 };
      game.goTimeState = {
        black: { mainTime: 0, isByoYomi: false, byoYomiTime: 0, byoYomiPeriods: 0 },
        white: { mainTime: 0, isByoYomi: false, byoYomiTime: 0, byoYomiPeriods: 0 },
      };
      game.goLastMoveTime = null;
    }
    game.goTimeExpired = null;
    
    console.log('Before save - game.goBoardSize:', game.goBoardSize, 'resolvedSize:', resolvedSize);
    await game.save();
    console.log('After save - game.goBoardSize:', game.goBoardSize);
    await game.populate([
      { path: 'host', select: 'username avatarColor' },
      { path: 'guest', select: 'username avatarColor' },
    ]);

    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to start Game of Go' });
  }
});

module.exports = router;

