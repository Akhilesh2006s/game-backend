require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const path = require('path');
const Student = require('../models/Student');
const connectDB = require('../config/db');

const excelPath = path.join(__dirname, '../../../client/extended_list.xlsx');

(async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    console.log('Connected to database');

    // Read Excel file
    const workbook = XLSX.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`Found ${data.length} rows in Excel file`);

    let imported = 0;
    let updated = 0;
    let errors = 0;

    for (const row of data) {
      try {
        const email = (row['Email Id'] || '').trim().toLowerCase();
        const enrollmentNo = (row['Enrollment No'] || '').trim().toUpperCase();
        const firstName = (row['First Name'] || '').trim();
        const lastName = (row['Last Name'] || '').trim();
        const groupId = (row['Group Id'] || '').trim();
        const classroomNumber = (row['Classroom Number'] || '').trim();
        const teamNumber = (row['Team Number'] || '').trim();

        if (!email || !enrollmentNo || !firstName) {
          console.log(`Skipping row: missing required fields`, row);
          errors++;
          continue;
        }

        // Check if student exists
        const existing = await Student.findOne({ 
          $or: [
            { email },
            { enrollmentNo }
          ]
        });

        if (existing) {
          // Update existing student
          existing.firstName = firstName;
          existing.lastName = lastName;
          existing.groupId = groupId;
          existing.classroomNumber = classroomNumber;
          existing.teamNumber = teamNumber;
          await existing.save();
          updated++;
        } else {
          // Create new student
          await Student.create({
            firstName,
            lastName,
            enrollmentNo,
            email,
            groupId,
            classroomNumber,
            teamNumber,
          });
          imported++;
        }
      } catch (err) {
        console.error(`Error processing row:`, err.message);
        errors++;
      }
    }

    console.log('\n=== Import Summary ===');
    console.log(`Imported: ${imported}`);
    console.log(`Updated: ${updated}`);
    console.log(`Errors: ${errors}`);
    console.log(`Total processed: ${imported + updated + errors}`);

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();




