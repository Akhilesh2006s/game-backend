const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
    },
    studentName: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    avatarColor: {
      type: String,
      default: '#6d6afe',
    },
    role: {
      type: String,
      enum: ['student', 'admin'],
      default: 'student',
    },
    gameStats: {
      totalGames: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      draws: { type: Number, default: 0 },
      totalPoints: { type: Number, default: 0 },
      goWins: { type: Number, default: 0 },
      goLosses: { type: Number, default: 0 },
      goPoints: { type: Number, default: 0 },
      rpsWins: { type: Number, default: 0 },
      rpsLosses: { type: Number, default: 0 },
      rpsPoints: { type: Number, default: 0 },
      penniesWins: { type: Number, default: 0 },
      penniesLosses: { type: Number, default: 0 },
      penniesPoints: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);




