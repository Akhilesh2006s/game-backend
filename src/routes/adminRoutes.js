const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Game = require('../models/Game');
const User = require('../models/User');
const Student = require('../models/Student');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Get all students with stats (for leaderboard)
router.get('/leaderboard', adminAuth, async (req, res) => {
  try {
    const { groupId, classroomNumber, teamNumber, search } = req.query;
    
    // Get ALL students from database (even if they haven't logged in)
    const students = await Student.find({}).lean();
    
    // Get all unique groups, classrooms, and teams
    const allUniqueGroups = [...new Set(students.map(s => s.groupId).filter(Boolean))].sort();
    const allUniqueClassrooms = [...new Set(students.map(s => s.classroomNumber).filter(Boolean))].sort();
    const allUniqueTeams = [...new Set(students.map(s => s.teamNumber).filter(Boolean))].sort();
    
    // Get all users who are students (not admin) - for those who have logged in
    const users = await User.find({ role: { $ne: 'admin' } })
      .select('username studentName email gameStats goUnlocked rpsUnlocked penniesUnlocked _id')
      .lean();
    
    // Create a map of users by email for quick lookup
    const userMap = new Map();
    users.forEach(user => {
      userMap.set(user.email.toLowerCase(), user);
    });
    
    // Map ALL students (including those who haven't logged in) with their user data if available
    const leaderboard = students.map(student => {
      const user = userMap.get(student.email.toLowerCase());
      
      // If user exists (has logged in or account was created for game unlock), use their data
      if (user) {
        return {
          _id: user._id,
          email: student.email,
          username: user.username || '',
          studentName: user.studentName || '',
          enrollmentNo: student.enrollmentNo || '',
          groupId: student.groupId || '',
          classroomNumber: student.classroomNumber || '',
          teamNumber: student.teamNumber || '',
          firstName: student.firstName || user.studentName || user.username || '',
          lastName: student.lastName || '',
          goUnlocked: user.goUnlocked === true,
          rpsUnlocked: user.rpsUnlocked === true,
          penniesUnlocked: user.penniesUnlocked === true,
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
      } else {
        // Student hasn't logged in yet - still show them with default values
        return {
          _id: null, // No user account yet
          email: student.email,
          username: '',
          studentName: '',
          enrollmentNo: student.enrollmentNo || '',
          groupId: student.groupId || '',
          classroomNumber: student.classroomNumber || '',
          teamNumber: student.teamNumber || '',
          firstName: student.firstName || '',
          lastName: student.lastName || '',
          goUnlocked: false,
          rpsUnlocked: false,
          penniesUnlocked: false,
          stats: {
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
      }
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

// Unlock/Lock games for a user (by userId or email)
router.put('/user/:userId/game-unlock', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { gameType, unlocked, email } = req.body;

    if (!['go', 'rps', 'pennies'].includes(gameType)) {
      return res.status(400).json({ message: 'gameType must be one of: go, rps, pennies' });
    }

    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({ message: 'unlocked must be a boolean' });
    }

    const gameNames = {
      go: 'Game of Go',
      rps: 'Rock Paper Scissors',
      pennies: 'Matching Pennies'
    };

    const updateField = gameType === 'go' ? 'goUnlocked' : gameType === 'rps' ? 'rpsUnlocked' : 'penniesUnlocked';

    // Try to find user by ID first (faster)
    let user = userId && userId !== 'new' ? await User.findById(userId).lean() : null;
    
    // If user doesn't exist, try to find by email or create new account
    if (!user) {
      // If email is provided, use it to find or create user
      if (email) {
        const normalizedEmail = email.toLowerCase().trim();
        
        // Check if user already exists by email (in case account was created)
        user = await User.findOne({ email: normalizedEmail }).lean();
        
        if (!user) {
          // Check if student exists in Student collection
          const student = await Student.findOne({ email: normalizedEmail }).lean();
          if (!student) {
            return res.status(404).json({ message: 'Student not found. Please ensure the student email exists in the database.' });
          }
          
          // Create a minimal user account for student who hasn't logged in yet
          // They'll set password when they first log in
          const tempPassword = crypto.randomBytes(16).toString('hex');
          const passwordHash = await bcrypt.hash(tempPassword, 10);
          
          const newUser = await User.create({
            username: student.firstName || student.email.split('@')[0],
            email: normalizedEmail,
            passwordHash: passwordHash,
            studentName: student.firstName,
            role: 'student',
            goUnlocked: gameType === 'go' ? unlocked : false,
            rpsUnlocked: gameType === 'rps' ? unlocked : false,
            penniesUnlocked: gameType === 'pennies' ? unlocked : false,
            autoCreated: true, // Mark as auto-created so user can complete registration
          });
          
          return res.json({
            message: unlocked 
              ? `${gameNames[gameType]} unlocked for user. User account created automatically.` 
              : `${gameNames[gameType]} locked for user. User account created automatically.`,
            user: {
              id: newUser._id,
              email: newUser.email,
              username: newUser.username,
              goUnlocked: newUser.goUnlocked,
              rpsUnlocked: newUser.rpsUnlocked,
              penniesUnlocked: newUser.penniesUnlocked,
            },
          });
        }
      } else if (userId === 'new') {
        // If userId is 'new' but no email provided, return error
        return res.status(400).json({ message: 'Email is required to create a new user account' });
      }
    }
    
    if (!user) {
      return res.status(404).json({ message: 'User not found. Please provide a valid user ID or email.' });
    }

    // Use findByIdAndUpdate for better performance (single query)
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { $set: { [updateField]: unlocked } },
      { new: true, lean: true }
    ).select('_id email username goUnlocked rpsUnlocked penniesUnlocked');

    res.json({
      message: unlocked ? `${gameNames[gameType]} unlocked for user` : `${gameNames[gameType]} locked for user`,
      user: {
        id: updatedUser._id,
        email: updatedUser.email,
        username: updatedUser.username,
        goUnlocked: updatedUser.goUnlocked,
        rpsUnlocked: updatedUser.rpsUnlocked,
        penniesUnlocked: updatedUser.penniesUnlocked,
      },
    });
  } catch (err) {
    console.error('Error updating game unlock status:', err);
    res.status(500).json({ message: 'Failed to update unlock status' });
  }
});

// Unlock/Lock RPS and Pennies for all users matching filters
router.post('/unlock-all-rps-pennies', adminAuth, async (req, res) => {
  try {
    const { groupId, classroomNumber, teamNumber, search, unlock = true } = req.body;
    
    // Get all students
    const students = await Student.find({}).lean();
    
    // Get all users who are students (not admin)
    let users = await User.find({ role: { $ne: 'admin' } })
      .select('username studentName email rpsUnlocked penniesUnlocked')
      .lean();
    
    // Create a map of users by email
    const userMap = new Map();
    users.forEach(u => userMap.set(u.email.toLowerCase(), u));
    
    // Map ALL students (including those who haven't logged in)
    let filteredStudents = students.map(student => {
      const user = userMap.get(student.email.toLowerCase());
      return {
        user,
        student,
        enrollmentNo: student.enrollmentNo || '',
        groupId: student.groupId || '',
        classroomNumber: student.classroomNumber || '',
        teamNumber: student.teamNumber || '',
        firstName: student.firstName || '',
        lastName: student.lastName || '',
      };
    });
    
    // Apply filters
    if (groupId && groupId !== 'all') {
      filteredStudents = filteredStudents.filter(item => item.groupId === groupId);
    }
    if (classroomNumber && classroomNumber !== 'all') {
      filteredStudents = filteredStudents.filter(item => item.classroomNumber === classroomNumber);
    }
    if (teamNumber && teamNumber !== 'all') {
      filteredStudents = filteredStudents.filter(item => item.teamNumber === teamNumber);
    }
    if (search) {
      const searchLower = search.toLowerCase();
      filteredStudents = filteredStudents.filter(item => 
        item.firstName?.toLowerCase().includes(searchLower) ||
        item.lastName?.toLowerCase().includes(searchLower) ||
        item.student.email?.toLowerCase().includes(searchLower) ||
        item.enrollmentNo?.toLowerCase().includes(searchLower) ||
        item.user?.username?.toLowerCase().includes(searchLower)
      );
    }
    
    // Create User accounts for students who don't have one, then update all
    let createdCount = 0;
    let updatedCount = 0;
    
    for (const item of filteredStudents) {
      if (!item.user) {
        // Create user account for student who hasn't logged in
        const tempPassword = crypto.randomBytes(16).toString('hex');
        const passwordHash = await bcrypt.hash(tempPassword, 10);
        
        const newUser = await User.create({
          username: item.student.firstName || item.student.email.split('@')[0],
          email: item.student.email.toLowerCase(),
          passwordHash: passwordHash,
          studentName: item.student.firstName,
          role: 'student',
          goUnlocked: false,
          rpsUnlocked: unlock,
          penniesUnlocked: unlock,
          autoCreated: true, // Mark as auto-created so user can complete registration
        });
        createdCount++;
        item.user = newUser;
      } else {
        // Update existing user
        await User.updateOne(
          { _id: item.user._id },
          { $set: { rpsUnlocked: unlock, penniesUnlocked: unlock } }
        );
        updatedCount++;
      }
    }
    
    res.json({
      message: unlock 
        ? `Unlocked RPS and Matching Pennies for ${createdCount + updatedCount} student(s) (${createdCount} new accounts created)`
        : `Locked RPS and Matching Pennies for ${updatedCount} user(s)`,
      count: createdCount + updatedCount,
      created: createdCount,
      updated: updatedCount,
    });
  } catch (err) {
    console.error('Error unlocking games for all users:', err);
    res.status(500).json({ message: 'Failed to unlock games' });
  }
});

// Unlock/Lock Game of Go for all users matching filters
router.post('/unlock-all-go', adminAuth, async (req, res) => {
  try {
    const { groupId, classroomNumber, teamNumber, search, unlock = true } = req.body;
    
    // Get all students
    const students = await Student.find({}).lean();
    
    // Get all users who are students (not admin)
    let users = await User.find({ role: { $ne: 'admin' } })
      .select('username studentName email goUnlocked')
      .lean();
    
    // Create a map of users by email
    const userMap = new Map();
    users.forEach(u => userMap.set(u.email.toLowerCase(), u));
    
    // Map ALL students (including those who haven't logged in)
    let filteredStudents = students.map(student => {
      const user = userMap.get(student.email.toLowerCase());
      return {
        user,
        student,
        enrollmentNo: student.enrollmentNo || '',
        groupId: student.groupId || '',
        classroomNumber: student.classroomNumber || '',
        teamNumber: student.teamNumber || '',
        firstName: student.firstName || '',
        lastName: student.lastName || '',
      };
    });
    
    // Apply filters
    if (groupId && groupId !== 'all') {
      filteredStudents = filteredStudents.filter(item => item.groupId === groupId);
    }
    if (classroomNumber && classroomNumber !== 'all') {
      filteredStudents = filteredStudents.filter(item => item.classroomNumber === classroomNumber);
    }
    if (teamNumber && teamNumber !== 'all') {
      filteredStudents = filteredStudents.filter(item => item.teamNumber === teamNumber);
    }
    if (search) {
      const searchLower = search.toLowerCase();
      filteredStudents = filteredStudents.filter(item => 
        item.firstName?.toLowerCase().includes(searchLower) ||
        item.lastName?.toLowerCase().includes(searchLower) ||
        item.student.email?.toLowerCase().includes(searchLower) ||
        item.enrollmentNo?.toLowerCase().includes(searchLower) ||
        item.user?.username?.toLowerCase().includes(searchLower)
      );
    }
    
    // Create User accounts for students who don't have one, then update all
    let createdCount = 0;
    let updatedCount = 0;
    
    for (const item of filteredStudents) {
      if (!item.user) {
        // Create user account for student who hasn't logged in
        const tempPassword = crypto.randomBytes(16).toString('hex');
        const passwordHash = await bcrypt.hash(tempPassword, 10);
        
        const newUser = await User.create({
          username: item.student.firstName || item.student.email.split('@')[0],
          email: item.student.email.toLowerCase(),
          passwordHash: passwordHash,
          studentName: item.student.firstName,
          role: 'student',
          goUnlocked: unlock,
          rpsUnlocked: false,
          penniesUnlocked: false,
          autoCreated: true, // Mark as auto-created so user can complete registration
        });
        createdCount++;
        item.user = newUser;
      } else {
        // Update existing user
        await User.updateOne(
          { _id: item.user._id },
          { $set: { goUnlocked: unlock } }
        );
        updatedCount++;
      }
    }
    
    res.json({
      message: unlock 
        ? `Unlocked Game of Go for ${createdCount + updatedCount} student(s) (${createdCount} new accounts created)`
        : `Locked Game of Go for ${updatedCount} user(s)`,
      count: createdCount + updatedCount,
      created: createdCount,
      updated: updatedCount,
    });
  } catch (err) {
    console.error('Error unlocking Game of Go for all users:', err);
    res.status(500).json({ message: 'Failed to unlock Game of Go' });
  }
});

// Bulk unlock/lock games for selected users
router.post('/bulk-game-unlock', adminAuth, async (req, res) => {
  try {
    const { userIds, gameType, unlock = true, emails } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: 'userIds must be a non-empty array' });
    }

    if (!['go', 'rps', 'pennies'].includes(gameType)) {
      return res.status(400).json({ message: 'gameType must be one of: go, rps, pennies' });
    }

    const gameNames = {
      go: 'Game of Go',
      rps: 'Rock Paper Scissors',
      pennies: 'Matching Pennies'
    };

    const updateField = gameType === 'go' ? 'goUnlocked' : gameType === 'rps' ? 'rpsUnlocked' : 'penniesUnlocked';
    
    // Get valid userIds (filter out null/undefined)
    const validUserIds = userIds.filter(id => id !== null && id !== undefined);
    
    let updatedCount = 0;
    let createdCount = 0;
    
    // Update existing users
    if (validUserIds.length > 0) {
      const result = await User.updateMany(
        { _id: { $in: validUserIds } },
        { $set: { [updateField]: unlock } }
      );
      updatedCount = result.modifiedCount;
    }
    
    // Create accounts for students who haven't logged in (if emails provided)
    if (emails && Array.isArray(emails) && emails.length > 0) {
      for (const email of emails) {
        if (!email) continue;
        
        const normalizedEmail = email.toLowerCase().trim();
        let user = await User.findOne({ email: normalizedEmail });
        
        if (!user) {
          // Check if student exists
          const student = await Student.findOne({ email: normalizedEmail });
          if (student) {
            // Create user account
            const tempPassword = crypto.randomBytes(16).toString('hex');
            const passwordHash = await bcrypt.hash(tempPassword, 10);
            
            user = await User.create({
              username: student.firstName || student.email.split('@')[0],
              email: normalizedEmail,
              passwordHash: passwordHash,
              studentName: student.firstName,
              role: 'student',
              goUnlocked: gameType === 'go' ? unlock : false,
              rpsUnlocked: gameType === 'rps' ? unlock : false,
              penniesUnlocked: gameType === 'pennies' ? unlock : false,
              autoCreated: true, // Mark as auto-created so user can complete registration
            });
            createdCount++;
          }
        } else if (!validUserIds.includes(String(user._id))) {
          // User exists but wasn't in the userIds list (shouldn't happen, but handle it)
          user[updateField] = unlock;
          await user.save();
          updatedCount++;
        }
      }
    }

    res.json({
      message: unlock 
        ? `Unlocked ${gameNames[gameType]} for ${updatedCount + createdCount} student(s)${createdCount > 0 ? ` (${createdCount} new accounts created)` : ''}`
        : `Locked ${gameNames[gameType]} for ${updatedCount} user(s)`,
      count: updatedCount + createdCount,
      created: createdCount,
      updated: updatedCount,
    });
  } catch (err) {
    console.error('Error bulk updating game unlock status:', err);
    res.status(500).json({ message: 'Failed to update unlock status' });
  }
});

module.exports = router;

