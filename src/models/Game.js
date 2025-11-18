const mongoose = require('mongoose');

const roundSchema = new mongoose.Schema(
  {
    gameType: {
      type: String,
      enum: ['ROCK_PAPER_SCISSORS', 'GAME_OF_GO', 'MATCHING_PENNIES'],
      required: true,
    },
    moves: [
      {
        player: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        choice: { type: String },
      },
    ],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    summary: String,
  },
  { timestamps: true }
);

const gameSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    guest: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    hostScore: { type: Number, default: 0 },
    guestScore: { type: Number, default: 0 },
    hostPenniesScore: { type: Number, default: 0 },
    guestPenniesScore: { type: Number, default: 0 },
    penniesRoundNumber: { type: Number, default: 0 },
    goBoard: { type: [[String]], default: null }, // 9x9 board: null, 'black', or 'white'
    goPreviousBoard: { type: [[String]], default: null }, // For Ko rule - previous board state
    goCurrentTurn: { type: String, enum: ['black', 'white'], default: 'black' },
    goCapturedBlack: { type: Number, default: 0 },
    goCapturedWhite: { type: Number, default: 0 },
    goConsecutivePasses: { type: Number, default: 0 }, // Track consecutive passes for game end
    status: {
      type: String,
      enum: ['WAITING', 'READY', 'IN_PROGRESS', 'COMPLETE'],
      default: 'WAITING',
    },
    activeStage: {
      type: String,
      enum: ['ROCK_PAPER_SCISSORS', 'GAME_OF_GO', 'MATCHING_PENNIES'],
      default: null,
      required: false,
    },
    rounds: [roundSchema],
    completedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Game', gameSchema);

