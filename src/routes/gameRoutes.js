const express = require('express');
const Game = require('../models/Game');
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
const getDefaultKomi = (size) => {
  if (size >= 19) return 6.5;
  if (size >= 13) return 6.5;
  return 5.5;
};

const createEmptyBoard = (size) => Array(size).fill(null).map(() => Array(size).fill(null));

const getPositionHash = (board, nextTurn) =>
  JSON.stringify({ board, next: nextTurn });

router.post('/start-go', authGuard, async (req, res) => {
  try {
    const { code, boardSize, komi } = req.body;
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

    const resolvedSize = DEFAULT_SIZES.includes(Number(boardSize)) ? Number(boardSize) : 9;
    const resolvedKomi =
      typeof komi === 'number' && komi >= 0 ? komi : getDefaultKomi(resolvedSize);

    const initialBoard = createEmptyBoard(resolvedSize);
    const initialHash = getPositionHash(initialBoard, 'black');

    game.activeStage = 'GAME_OF_GO';
    game.status = 'READY';
    // Initialize Go board if not already set
    game.goBoardSize = resolvedSize;
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
    await game.save();
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

