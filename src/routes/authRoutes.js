const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Student = require('../models/Student');
const authGuard = require('../middleware/auth');

const router = express.Router();

const buildToken = (user) =>
  jwt.sign(
    { id: user._id, username: user.username, studentName: user.studentName, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Normalize email to lowercase for all operations
    const normalizedEmail = email.toLowerCase().trim();
    
    // Validate email domain - only @bennett.edu.in allowed
    if (!normalizedEmail.endsWith('@bennett.edu.in')) {
      return res.status(400).json({ message: 'Only @bennett.edu.in email addresses are allowed' });
    }

    // Always query with normalized (lowercase) email
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // Fetch student name from Student database using normalized email
    const student = await Student.findOne({ email: normalizedEmail });
    const studentName = student ? student.firstName : username;

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ 
      username, 
      email: normalizedEmail, // Store normalized email
      passwordHash,
      studentName: studentName 
    });

    res.status(201).json({
      token: buildToken(user),
      user: {
        id: user._id,
        username: user.username,
        studentName: user.studentName || user.username,
        email: user.email,
        avatarColor: user.avatarColor,
        gameStats: user.gameStats || {},
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to register' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Normalize email to lowercase for all operations
    const normalizedEmail = email.toLowerCase().trim();
    
    // Validate email domain - only @bennett.edu.in allowed
    if (!normalizedEmail.endsWith('@bennett.edu.in')) {
      return res.status(400).json({ message: 'Only @bennett.edu.in email addresses are allowed' });
    }
    
    // Always query with normalized (lowercase) email
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Always fetch and update student name from Student database using normalized email
    const student = await Student.findOne({ email: normalizedEmail });
    if (student) {
      user.studentName = student.firstName;
      await user.save();
    } else if (!user.studentName) {
      // If no student found and no name set, use username
      user.studentName = user.username;
      await user.save();
    }

    res.json({
      token: buildToken(user),
      user: {
        id: user._id,
        username: user.username,
        studentName: user.studentName || user.username,
        email: user.email,
        avatarColor: user.avatarColor,
        gameStats: user.gameStats || {},
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to login' });
  }
});

// Update user profile
router.put('/profile', authGuard, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ message: 'Username is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if username is already taken by another user
    const existing = await User.findOne({ username: username.trim(), _id: { $ne: req.user.id } });
    if (existing) {
      return res.status(409).json({ message: 'Username already taken' });
    }

    user.username = username.trim();
    await user.save();

    res.json({
      user: {
        id: user._id,
        username: user.username,
        studentName: user.studentName || user.username,
        email: user.email,
        avatarColor: user.avatarColor,
        gameStats: user.gameStats || {},
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// Refresh student name from database
router.post('/refresh-name', authGuard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Fetch student name from Student database - user.email is already lowercase from schema
    const student = await Student.findOne({ email: user.email });
    if (student) {
      user.studentName = student.firstName;
      await user.save();
    }

    res.json({
      user: {
        id: user._id,
        username: user.username,
        studentName: user.studentName || user.username,
        email: user.email,
        avatarColor: user.avatarColor,
        gameStats: user.gameStats || {},
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to refresh name' });
  }
});

// Change password
router.put('/password', authGuard, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new passwords are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordHash = passwordHash;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to change password' });
  }
});

module.exports = router;




