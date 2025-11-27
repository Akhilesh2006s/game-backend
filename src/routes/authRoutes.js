const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Student = require('../models/Student');

const router = express.Router();

const buildToken = (user) =>
  jwt.sign(
    { id: user._id, username: user.username, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Validate email domain - only @bennett.edu.in allowed
    const emailDomain = email.toLowerCase().trim();
    if (!emailDomain.endsWith('@bennett.edu.in')) {
      return res.status(400).json({ message: 'Only @bennett.edu.in email addresses are allowed' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // Fetch student name from Student database
    const student = await Student.findOne({ email: email.toLowerCase().trim() });
    const studentName = student ? student.firstName : username;

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ 
      username, 
      email, 
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
    
    // Validate email domain - only @bennett.edu.in allowed
    const emailDomain = email.toLowerCase().trim();
    if (!emailDomain.endsWith('@bennett.edu.in')) {
      return res.status(400).json({ message: 'Only @bennett.edu.in email addresses are allowed' });
    }
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Update student name if not set or if student data has been updated
    const student = await Student.findOne({ email: email.toLowerCase().trim() });
    if (student && (!user.studentName || user.studentName !== student.firstName)) {
      user.studentName = student.firstName;
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

module.exports = router;




