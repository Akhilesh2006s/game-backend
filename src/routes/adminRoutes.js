const express = require('express');
const Game = require('../models/Game');
const User = require('../models/User');
const Student = require('../models/Student');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Get all students with stats (for leaderboard)
router.get('/leaderboard', adminAuth, async (req, res) => {
  try {
    const { groupId, classroomNumber, teamNumber, search } = req.query;
    
    // Get all students
    const students = await Student.find({}).lean();
    
    // Get all unique groups, classrooms, and teams
    const allUniqueGroups = [...new Set(students.map(s => s.groupId).filter(Boolean))].sort();
    const allUniqueClassrooms = [...new Set(students.map(s => s.classroomNumber).filter(Boolean))].sort();
    const allUniqueTeams = [...new Set(students.map(s => s.teamNumber).filter(Boolean))].sort();
    
    // Get all users who are students (not admin)
    let users = await User.find({ role: { $ne: 'admin' } })
      .select('username studentName email gameStats goUnlocked rpsUnlocked penniesUnlocked')
      .lean();
    
    // Filter users to only those with emails in Student collection
    const studentEmails = new Set(students.map(s => s.email.toLowerCase()));
    users = users.filter(u => studentEmails.has(u.email.toLowerCase()));
    
    // Map users with student data
    const leaderboard = users.map(user => {
      const student = students.find(s => s.email.toLowerCase() === user.email.toLowerCase());
      return {
        ...user,
        enrollmentNo: student?.enrollmentNo || '',
        groupId: student?.groupId || '',
        classroomNumber: student?.classroomNumber || '',
        teamNumber: student?.teamNumber || '',
        firstName: student?.firstName || user.studentName || user.username,
        lastName: student?.lastName || '',
        goUnlocked: user.goUnlocked || false,
        rpsUnlocked: user.rpsUnlocked || false,
        penniesUnlocked: user.penniesUnlocked || false,
        stats: user.gameStats || {
          totalGames: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          totalPoints: 0,
          rpsWins: 0,
          rpsLosses: 0,
          rpsPoints: 0,
          goWins: 0,
          goLosses: 0,
          goPoints: 0,
          penniesWins: 0,
          penniesLosses: 0,
          penniesPoints: 0,
        },
      };
    });
    
    // Apply filters
    let filtered = leaderboard;
    if (groupId && groupId !== 'all') {
      filtered = filtered.filter(p => p.groupId === groupId);
    }
    if (classroomNumber && classroomNumber !== 'all') {
      filtered = filtered.filter(p => p.classroomNumber === classroomNumber);
    }
    if (teamNumber && teamNumber !== 'all') {
      filtered = filtered.filter(p => p.teamNumber === teamNumber);
    }
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(p => 
        p.firstName?.toLowerCase().includes(searchLower) ||
        p.lastName?.toLowerCase().includes(searchLower) ||
        p.email?.toLowerCase().includes(searchLower) ||
        p.enrollmentNo?.toLowerCase().includes(searchLower) ||
        p.username?.toLowerCase().includes(searchLower)
      );
    }
    
    // Sort by wins, then points
    filtered.sort((a, b) => {
      if (b.stats.wins !== a.stats.wins) return b.stats.wins - a.stats.wins;
      return b.stats.totalPoints - a.stats.totalPoints;
    });
    
    res.json({
      leaderboard: filtered,
      filters: {
        groups: allUniqueGroups,
        classrooms: allUniqueClassrooms,
        teams: allUniqueTeams,
      },
      total: filtered.length,
    });
  } catch (err) {
    console.error('Error fetching admin leaderboard:', err);
    res.status(500).json({ message: 'Failed to load leaderboard' });
  }
});

// Get all games (for game history)
router.get('/games', adminAuth, async (req, res) => {
  try {
    const { status, limit = 100, skip = 0, search } = req.query;
    
    const query = {};
    
    if (status && status !== 'all') {
      if (status === 'complete') {
        query.status = 'COMPLETE';
      } else if (status === 'in_progress') {
        query.status = { $in: ['IN_PROGRESS', 'READY'] };
      }
    }
    
    let games = await Game.find(query)
      .sort('-updatedAt')
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .populate('host', 'username studentName avatarColor email')
      .populate('guest', 'username studentName avatarColor email')
      .select('code host guest hostScore guestScore hostPenniesScore guestPenniesScore goFinalScore goBoardSize goCapturedBlack goCapturedWhite status activeStage createdAt updatedAt completedAt')
      .lean();
    
    // Add enrollment numbers
    const gamesWithEnrollment = await Promise.all(
      games.map(async (game) => {
        if (game.host?.email) {
          const hostStudent = await Student.findOne({ email: game.host.email.toLowerCase() });
          if (hostStudent) {
            game.host.enrollmentNo = hostStudent.enrollmentNo;
          }
        }
        if (game.guest?.email) {
          const guestStudent = await Student.findOne({ email: game.guest.email.toLowerCase() });
          if (guestStudent) {
            game.guest.enrollmentNo = guestStudent.enrollmentNo;
          }
        }
        return game;
      })
    );
    
    // Apply search filter if provided
    let filteredGames = gamesWithEnrollment;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredGames = filteredGames.filter(game => 
        game.code?.toLowerCase().includes(searchLower) ||
        game.host?.studentName?.toLowerCase().includes(searchLower) ||
        game.host?.username?.toLowerCase().includes(searchLower) ||
        game.host?.email?.toLowerCase().includes(searchLower) ||
        game.host?.enrollmentNo?.toLowerCase().includes(searchLower) ||
        game.guest?.studentName?.toLowerCase().includes(searchLower) ||
        game.guest?.username?.toLowerCase().includes(searchLower) ||
        game.guest?.email?.toLowerCase().includes(searchLower) ||
        game.guest?.enrollmentNo?.toLowerCase().includes(searchLower)
      );
    }
    
    const total = await Game.countDocuments(query);
    
    res.json({
      games: filteredGames,
      total,
      limit: parseInt(limit),
      skip: parseInt(skip),
    });
  } catch (err) {
    console.error('Error fetching admin games:', err);
    res.status(500).json({ message: 'Failed to load games' });
  }
});

// Get individual student stats
router.get('/student/:email', adminAuth, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = email.toLowerCase().trim();
    
    // Get user
    const user = await User.findOne({ email: normalizedEmail, role: { $ne: 'admin' } })
      .select('username studentName email gameStats createdAt')
      .lean();
    
    if (!user) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    // Get student data
    const student = await Student.findOne({ email: normalizedEmail }).lean();
    
    // Get ALL games for this user (no limit)
    const games = await Game.find({
      $or: [
        { host: user._id },
        { guest: user._id }
      ]
    })
      .sort('-updatedAt')
      .populate('host', 'username studentName email')
      .populate('guest', 'username studentName email')
      .select('code host guest hostScore guestScore hostPenniesScore guestPenniesScore goFinalScore goBoardSize goCapturedBlack goCapturedWhite status activeStage createdAt updatedAt completedAt')
      .lean();
    
    // Add enrollment numbers to games
    const gamesWithEnrollment = await Promise.all(
      games.map(async (game) => {
        if (game.host?.email) {
          const hostStudent = await Student.findOne({ email: game.host.email.toLowerCase() });
          if (hostStudent) {
            game.host.enrollmentNo = hostStudent.enrollmentNo;
          }
        }
        if (game.guest?.email) {
          const guestStudent = await Student.findOne({ email: game.guest.email.toLowerCase() });
          if (guestStudent) {
            game.guest.enrollmentNo = guestStudent.enrollmentNo;
          }
        }
        return game;
      })
    );
    
    // Calculate detailed stats
    const gameStats = {
      totalGames: games.length,
      completedGames: games.filter(g => g.status === 'COMPLETE').length,
      inProgressGames: games.filter(g => g.status === 'IN_PROGRESS' || g.status === 'READY').length,
      rpsGames: games.filter(g => g.activeStage === 'ROCK_PAPER_SCISSORS').length,
      goGames: games.filter(g => g.activeStage === 'GAME_OF_GO').length,
      penniesGames: games.filter(g => g.activeStage === 'MATCHING_PENNIES').length,
    };

    // Calculate win/loss breakdown per game type
    const rpsWins = games.filter(g => 
      g.activeStage === 'ROCK_PAPER_SCISSORS' && 
      g.status === 'COMPLETE' &&
      ((String(g.host._id) === String(user._id) && g.hostScore > g.guestScore) ||
       (String(g.guest._id) === String(user._id) && g.guestScore > g.hostScore))
    ).length;

    const goWins = games.filter(g => 
      g.activeStage === 'GAME_OF_GO' && 
      g.status === 'COMPLETE' &&
      g.goFinalScore &&
      ((String(g.host._id) === String(user._id) && g.goFinalScore.winner === 'black') ||
       (String(g.guest._id) === String(user._id) && g.goFinalScore.winner === 'white'))
    ).length;

    const penniesWins = games.filter(g => 
      g.activeStage === 'MATCHING_PENNIES' && 
      g.status === 'COMPLETE' &&
      ((String(g.host._id) === String(user._id) && g.hostPenniesScore > g.guestPenniesScore) ||
       (String(g.guest._id) === String(user._id) && g.guestPenniesScore > g.hostPenniesScore))
    ).length;
    
    res.json({
      user: {
        ...user,
        _id: user._id,
        id: user._id,
        enrollmentNo: student?.enrollmentNo || '',
        groupId: student?.groupId || '',
        classroomNumber: student?.classroomNumber || '',
        teamNumber: student?.teamNumber || '',
        firstName: student?.firstName || user.studentName || user.username,
        lastName: student?.lastName || '',
      },
      stats: user.gameStats || {},
      gameStats: {
        ...gameStats,
        rpsWins,
        goWins,
        penniesWins,
      },
      allGames: gamesWithEnrollment, // ALL games, not just recent
    });
  } catch (err) {
    console.error('Error fetching student stats:', err);
    res.status(500).json({ message: 'Failed to load student stats' });
  }
});

// Unlock/Lock games for a user
router.put('/user/:userId/game-unlock', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { gameType, unlocked } = req.body;

    if (!['go', 'rps', 'pennies'].includes(gameType)) {
      return res.status(400).json({ message: 'gameType must be one of: go, rps, pennies' });
    }

    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({ message: 'unlocked must be a boolean' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const gameNames = {
      go: 'Game of Go',
      rps: 'Rock Paper Scissors',
      pennies: 'Matching Pennies'
    };

    if (gameType === 'go') {
      user.goUnlocked = unlocked;
    } else if (gameType === 'rps') {
      user.rpsUnlocked = unlocked;
    } else if (gameType === 'pennies') {
      user.penniesUnlocked = unlocked;
    }

    await user.save();

    res.json({
      message: unlocked ? `${gameNames[gameType]} unlocked for user` : `${gameNames[gameType]} locked for user`,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        goUnlocked: user.goUnlocked,
        rpsUnlocked: user.rpsUnlocked,
        penniesUnlocked: user.penniesUnlocked,
      },
    });
  } catch (err) {
    console.error('Error updating game unlock status:', err);
    res.status(500).json({ message: 'Failed to update unlock status' });
  }
});

module.exports = router;

