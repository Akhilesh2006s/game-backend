const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    enrollmentNo: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    groupId: {
      type: String,
      trim: true,
      index: true,
    },
    classroomNumber: {
      type: String,
      trim: true,
      index: true,
    },
    teamNumber: {
      type: String,
      trim: true,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Student', studentSchema);

