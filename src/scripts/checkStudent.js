require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Student = require('../models/Student');

const checkStudent = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    console.log('Connected to database\n');

    // Check for the specific student
    const student = await Student.findOne({ email: 's25cseu1560@bennett.edu.in' });
    console.log('Looking for: s25cseu1560@bennett.edu.in');
    console.log('Student found:', student ? JSON.stringify(student, null, 2) : 'NOT FOUND\n');

    // Check total count
    const count = await Student.countDocuments({});
    console.log(`Total students in database: ${count}\n`);

    // Show first 5 students
    const allStudents = await Student.find({}).limit(5);
    console.log('First 5 students in database:');
    allStudents.forEach(s => {
      console.log(`  - ${s.firstName} (${s.email})`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
};

checkStudent();

