const express = require('express');
const Game = require('../models/Game');
const User = require('../models/User');
const authGuard = require('../middleware/auth');
const generateMatchCode = require('../utils/generateMatchCode');

const router = express.Router();

// Store io instance - will be set by index.js
let ioInstance = null;
router.setIO = (io) => {
  ioInstance = io;
};

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

    await game.populate('host', 'username studentName avatarColor');

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
      { path: 'host', select: 'username studentName avatarColor' },
      { path: 'guest', select: 'username studentName avatarColor' },
    ]);

    // Notify host via socket that guest has joined
    if (ioInstance) {
      const guestDisplayName = req.user.studentName || req.user.username;
      // Ensure game is properly populated before sending
      const gameData = {
        _id: game._id,
        code: game.code,
        host: {
          _id: game.host._id,
          username: game.host.username,
          studentName: game.host.studentName,
          avatarColor: game.host.avatarColor,
        },
        guest: {
          _id: game.guest._id,
          username: game.guest.username,
          studentName: game.guest.studentName,
          avatarColor: game.guest.avatarColor,
        },
        status: game.status,
        activeStage: game.activeStage,
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
      };
      ioInstance.to(game.code.toUpperCase()).emit('game:guest_joined', {
        game: gameData,
        guestName: guestDisplayName,
      });
    }

    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to join game' });
  }
});

// Get user game statistics - MUST be before /code/:code to avoid route conflicts
router.get('/stats', authGuard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('gameStats username studentName');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      username: user.username,
      studentName: user.studentName || user.username,
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
      .populate('host', 'username studentName avatarColor')
      .populate('guest', 'username studentName avatarColor');
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
    const { status, limit = 50, skip = 0 } = req.query;
    
    // Build query
    const query = {
      $or: [{ host: req.user.id }, { guest: req.user.id }],
    };
    
    // Add status filter if provided
    if (status && status !== 'all') {
      if (status === 'complete') {
        query.status = 'COMPLETE';
      } else if (status === 'in_progress') {
        query.status = { $in: ['IN_PROGRESS', 'READY'] };
      }
    }

    const games = await Game.find(query)
      .sort('-updatedAt')
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .populate('host', 'username studentName avatarColor email')
      .populate('guest', 'username studentName avatarColor email')
      .select('code host guest hostScore guestScore hostPenniesScore guestPenniesScore goFinalScore goBoardSize goCapturedBlack goCapturedWhite status activeStage createdAt updatedAt completedAt');

    // Get total count for pagination
    const total = await Game.countDocuments(query);

    res.json({ 
      games,
      total,
      limit: parseInt(limit),
      skip: parseInt(skip),
    });
  } catch (err) {
    console.error('Error fetching games:', err);
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
      { path: 'host', select: 'username studentName avatarColor' },
      { path: 'guest', select: 'username studentName avatarColor' },
    ]);

    // Notify both players via socket that game has started
    if (ioInstance) {
      const gameData = {
        _id: game._id,
        code: game.code,
        host: {
          _id: game.host._id,
          username: game.host.username,
          studentName: game.host.studentName,
          avatarColor: game.host.avatarColor,
        },
        guest: {
          _id: game.guest._id,
          username: game.guest.username,
          studentName: game.guest.studentName,
          avatarColor: game.guest.avatarColor,
        },
        status: game.status,
        activeStage: game.activeStage,
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
      };
      ioInstance.to(game.code.toUpperCase()).emit('game:started', {
        game: gameData,
        gameType: 'MATCHING_PENNIES',
      });
    }

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
      { path: 'host', select: 'username studentName avatarColor' },
      { path: 'guest', select: 'username studentName avatarColor' },
    ]);

    // Notify both players via socket that game has started
    if (ioInstance) {
      const gameData = {
        _id: game._id,
        code: game.code,
        host: {
          _id: game.host._id,
          username: game.host.username,
          studentName: game.host.studentName,
          avatarColor: game.host.avatarColor,
        },
        guest: {
          _id: game.guest._id,
          username: game.guest.username,
          studentName: game.guest.studentName,
          avatarColor: game.guest.avatarColor,
        },
        status: game.status,
        activeStage: game.activeStage,
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
      };
      ioInstance.to(game.code.toUpperCase()).emit('game:started', {
        game: gameData,
        gameType: 'ROCK_PAPER_SCISSORS',
      });
    }

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
      { path: 'host', select: 'username studentName avatarColor' },
      { path: 'guest', select: 'username studentName avatarColor' },
    ]);

    // Notify both players via socket that game has started
    if (ioInstance) {
      const gameData = {
        _id: game._id,
        code: game.code,
        host: {
          _id: game.host._id,
          username: game.host.username,
          studentName: game.host.studentName,
          avatarColor: game.host.avatarColor,
        },
        guest: {
          _id: game.guest._id,
          username: game.guest.username,
          studentName: game.guest.studentName,
          avatarColor: game.guest.avatarColor,
        },
        status: game.status,
        activeStage: game.activeStage,
        goBoardSize: game.goBoardSize,
        goKomi: game.goKomi,
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
      };
      ioInstance.to(game.code.toUpperCase()).emit('game:started', {
        game: gameData,
        gameType: 'GAME_OF_GO',
      });
    }

    res.json({ game });
  } catch (err) {
    res.status(500).json({ message: 'Failed to start Game of Go' });
  }
});

// Get game analysis/report
router.get('/analysis/:code', authGuard, async (req, res) => {
  try {
    const game = await Game.findOne({ code: req.params.code.toUpperCase() })
      .populate('host', 'username studentName avatarColor')
      .populate('guest', 'username studentName avatarColor')
      .populate('rounds.moves.player', 'username studentName')
      .populate('rounds.winner', 'username studentName');

    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }

    // Check if user is part of this game
    const userId = String(req.user.id);
    const hostId = String(game.host?._id || game.host?.id || game.host);
    const guestId = game.guest ? String(game.guest?._id || game.guest?.id || game.guest) : null;
    
    if (userId !== hostId && userId !== guestId) {
      return res.status(403).json({ message: 'You are not part of this game' });
    }

    // Build analysis data
    const analysis = {
      gameCode: game.code,
      host: {
        name: game.host.studentName || game.host.username,
        username: game.host.username,
        email: game.host.email,
      },
      guest: game.guest ? {
        name: game.guest.studentName || game.guest.username,
        username: game.guest.username,
        email: game.guest.email,
      } : null,
      status: game.status,
      activeStage: game.activeStage,
      createdAt: game.createdAt,
      completedAt: game.completedAt,
      scores: {
        rps: { host: game.hostScore || 0, guest: game.guestScore || 0 },
        pennies: { host: game.hostPenniesScore || 0, guest: game.guestPenniesScore || 0 },
        go: game.goFinalScore || null,
      },
      rounds: [],
      moveCount: 0,
      highlights: [],
    };

    // Process rounds by game type
    const rpsRounds = [];
    const goMoves = [];
    const penniesRounds = [];

    game.rounds.forEach((round, index) => {
      const roundData = {
        roundNumber: index + 1,
        gameType: round.gameType,
        timestamp: round.createdAt,
        moves: (round.moves || []).map(move => ({
          player: {
            name: move.player?.studentName || move.player?.username || 'Unknown',
            id: move.player?._id || move.player?.id,
            isHost: String(move.player?._id || move.player?.id) === hostId,
          },
          choice: move.choice,
          row: move.row,
          col: move.col,
          color: move.color,
          captured: move.captured,
        })),
        winner: round.winner ? {
          name: round.winner.studentName || round.winner.username,
          isHost: String(round.winner._id || round.winner.id) === hostId,
        } : null,
        summary: round.summary,
      };

      if (round.gameType === 'ROCK_PAPER_SCISSORS') {
        rpsRounds.push(roundData);
        analysis.moveCount += 2; // Each round has 2 moves
        if (round.winner) {
          analysis.highlights.push({
            type: 'round_win',
            gameType: 'ROCK_PAPER_SCISSORS',
            round: rpsRounds.length,
            winner: roundData.winner.name,
            summary: round.summary,
          });
        }
      } else if (round.gameType === 'GAME_OF_GO') {
        goMoves.push(roundData);
        analysis.moveCount += 1;
        if (round.moves && round.moves[0] && round.moves[0].captured > 0) {
          analysis.highlights.push({
            type: 'capture',
            gameType: 'GAME_OF_GO',
            move: goMoves.length,
            player: roundData.moves[0]?.player?.name || 'Unknown',
            captured: round.moves[0].captured,
            position: `(${(round.moves[0].row || 0) + 1}, ${(round.moves[0].col || 0) + 1})`,
          });
        }
      } else if (round.gameType === 'MATCHING_PENNIES') {
        penniesRounds.push(roundData);
        analysis.moveCount += 2; // Each round has 2 moves
        if (round.winner) {
          analysis.highlights.push({
            type: 'round_win',
            gameType: 'MATCHING_PENNIES',
            round: penniesRounds.length,
            winner: roundData.winner.name,
            summary: round.summary,
          });
        }
      }
    });

    // Add game-specific data
    if (game.activeStage === 'GAME_OF_GO' || goMoves.length > 0) {
      analysis.goData = {
        boardSize: game.goBoardSize,
        komi: game.goKomi,
        capturedBlack: game.goCapturedBlack,
        capturedWhite: game.goCapturedWhite,
        finalScore: game.goFinalScore,
        moves: goMoves,
        totalMoves: goMoves.length,
      };
    }

    analysis.rounds = {
      rockPaperScissors: rpsRounds,
      matchingPennies: penniesRounds,
      gameOfGo: goMoves,
    };

    analysis.totalRounds = {
      rps: rpsRounds.length,
      pennies: penniesRounds.length,
      go: goMoves.length,
    };

    res.json({ analysis });
  } catch (err) {
    console.error('Error fetching game analysis:', err);
    res.status(500).json({ message: 'Failed to fetch game analysis' });
  }
});

// Get leaderboard
router.get('/leaderboard', authGuard, async (req, res) => {
  try {
    const { type, filter } = req.query; // type: 'all', 'group', 'classroom', 'team'
    
    // Get student data from extended list (CSV/Excel)
    const Student = require('../models/Student');
    const students = await Student.find({}).lean();
    
    if (students.length === 0) {
      return res.json({
        leaderboard: [],
        filters: { groups: [], classrooms: [], teams: [] },
        total: 0,
      });
    }

    // Get emails from students to filter users
    const studentEmails = students.map(s => s.email.toLowerCase());
    
    // Get only users whose email matches a student in the extended list
    let users = await User.find({
      email: { $in: studentEmails }
    })
      .select('username studentName email gameStats')
      .lean();

    // Create student map for quick lookup
    const studentMap = new Map();
    students.forEach(s => {
      studentMap.set(s.email.toLowerCase(), s);
    });

    // Enrich users with student data - only include users that have student data
    const enrichedUsers = users
      .map(user => {
        const student = studentMap.get(user.email.toLowerCase());
        if (!student) return null; // Skip if no student data found
        
        return {
          ...user,
          groupId: student.groupId || null,
          classroomNumber: student.classroomNumber || null,
          teamNumber: student.teamNumber || null,
          fullName: `${student.firstName} ${student.lastName || ''}`.trim(),
        };
      })
      .filter(user => user !== null); // Remove null entries

    // Filter based on type
    let filteredUsers = enrichedUsers;
    if (type === 'group' && filter) {
      filteredUsers = enrichedUsers.filter(u => u.groupId === filter);
    } else if (type === 'classroom' && filter) {
      filteredUsers = enrichedUsers.filter(u => u.classroomNumber === filter);
    } else if (type === 'team' && filter) {
      filteredUsers = enrichedUsers.filter(u => u.teamNumber === filter);
    }

    // Sort by total wins (descending), then by total points
    filteredUsers.sort((a, b) => {
      const winsA = a.gameStats?.wins || 0;
      const winsB = b.gameStats?.wins || 0;
      if (winsB !== winsA) return winsB - winsA;
      const pointsA = a.gameStats?.totalPoints || 0;
      const pointsB = b.gameStats?.totalPoints || 0;
      return pointsB - pointsA;
    });

    // Add rank
    const leaderboard = filteredUsers.map((user, index) => ({
      rank: index + 1,
      username: user.username,
      studentName: user.studentName,
      fullName: user.fullName,
      email: user.email,
      groupId: user.groupId,
      classroomNumber: user.classroomNumber,
      teamNumber: user.teamNumber,
      stats: {
        totalGames: user.gameStats?.totalGames || 0,
        wins: user.gameStats?.wins || 0,
        losses: user.gameStats?.losses || 0,
        draws: user.gameStats?.draws || 0,
        totalPoints: user.gameStats?.totalPoints || 0,
        rpsWins: user.gameStats?.rpsWins || 0,
        goWins: user.gameStats?.goWins || 0,
        penniesWins: user.gameStats?.penniesWins || 0,
      },
    }));

    // Get unique filter values for dropdowns
    const uniqueGroups = [...new Set(enrichedUsers.map(u => u.groupId).filter(Boolean))].sort();
    const uniqueClassrooms = [...new Set(enrichedUsers.map(u => u.classroomNumber).filter(Boolean))].sort();
    const uniqueTeams = [...new Set(enrichedUsers.map(u => u.teamNumber).filter(Boolean))].sort();

    res.json({
      leaderboard,
      filters: {
        groups: uniqueGroups,
        classrooms: uniqueClassrooms,
        teams: uniqueTeams,
      },
      total: leaderboard.length,
    });
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ message: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;

