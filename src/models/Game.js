const mongoose = require('mongoose');

const deadStoneSchema = new mongoose.Schema(
  {
    row: { type: Number, required: true },
    col: { type: Number, required: true },
    color: { type: String, enum: ['black', 'white'], required: true },
  },
  { _id: false }
);

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
        row: { type: Number },
        col: { type: Number },
        color: { type: String },
        captured: { type: Number },
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
    goBoard: { type: [[String]], default: null }, // NxN board: null, 'black', or 'white'
    goPreviousBoard: { type: [[String]], default: null }, // For Ko rule - previous board state
    goBoardSize: { type: Number, default: 9 },
    goKomi: { type: Number, default: 6.5 },
    goPositionHashes: { type: [String], default: [] }, // Superko tracking
    goCurrentTurn: { type: String, enum: ['black', 'white'], default: 'black' },
    goCapturedBlack: { type: Number, default: 0 },
    goCapturedWhite: { type: Number, default: 0 },
    goConsecutivePasses: { type: Number, default: 0 }, // Track consecutive passes for game end
    goDeadStones: { type: [deadStoneSchema], default: [] },
    goPhase: {
      type: String,
      enum: ['PLAY', 'SCORING', 'COMPLETE'],
      default: 'PLAY',
    },
    goFinalScore: { type: mongoose.Schema.Types.Mixed, default: null },
    goScoringConfirmations: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    goPendingScoringMethod: {
      type: String,
      enum: ['chinese', 'japanese'],
      default: 'chinese',
    },
    goTimeControl: {
      mode: { type: String, enum: ['fischer', 'japanese', 'none'], default: 'none' },
      mainTime: { type: Number, default: 0 }, // Main time in seconds
      increment: { type: Number, default: 0 }, // Fischer increment in seconds
      byoYomiTime: { type: Number, default: 0 }, // Byo-yomi period time in seconds
      byoYomiPeriods: { type: Number, default: 0 }, // Number of byo-yomi periods
    },
    goTimeState: {
      black: {
        mainTime: { type: Number, default: 0 },
        isByoYomi: { type: Boolean, default: false },
        byoYomiTime: { type: Number, default: 0 },
        byoYomiPeriods: { type: Number, default: 0 },
      },
      white: {
        mainTime: { type: Number, default: 0 },
        isByoYomi: { type: Boolean, default: false },
        byoYomiTime: { type: Number, default: 0 },
        byoYomiPeriods: { type: Number, default: 0 },
      },
    },
    goLastMoveTime: { type: Date, default: null }, // When the current turn started
    goTimeExpired: { type: String, enum: ['black', 'white'], default: null }, // Which player ran out of time
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

