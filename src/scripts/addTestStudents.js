require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Student = require('../models/Student');

const addTestStudents = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    console.log('Connected to database\n');

    const testStudents = [
      {
        firstName: 'TEST1',
        enrollmentNo: 'TEST20251',
        email: 'test1@gmail.com',
      },
      {
        firstName: 'TEST2',
        enrollmentNo: 'TEST20252',
        email: 'test2@gmail.com',
      },
    ];

    let added = 0;
    let skipped = 0;

    for (const studentData of testStudents) {
      try {
        // Check if student already exists
        const existing = await Student.findOne({
          $or: [
            { email: studentData.email.toLowerCase() },
            { enrollmentNo: studentData.enrollmentNo.toUpperCase() }
          ]
        });

        if (existing) {
          console.log(`⚠️  Student already exists: ${studentData.firstName} (${studentData.email})`);
          skipped++;
        } else {
          await Student.create(studentData);
          console.log(`✅ Added student: ${studentData.firstName} (${studentData.email})`);
          added++;
        }
      } catch (err) {
        console.error(`❌ Error adding ${studentData.firstName}:`, err.message);
      }
    }

    console.log('\nSummary:');
    console.log(`  Added: ${added}`);
    console.log(`  Skipped (already exists): ${skipped}`);

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
};

addTestStudents();

