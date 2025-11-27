require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Student = require('../models/Student');
const XLSX = require('xlsx');
const path = require('path');

const importStudents = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    console.log('Connected to database');

    // Read Excel file - from server/src/scripts/ go up to root, then into client
    const excelPath = path.join(__dirname, '../../../client/Student_details.xlsx');
    const workbook = XLSX.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log(`Found ${data.length} students in Excel file`);

    let imported = 0;
    let updated = 0;
    let errors = 0;

    for (const row of data) {
      try {
        const firstName = row['First Name']?.trim() || '';
        const enrollmentNo = row['Enrollment No']?.trim().toUpperCase() || '';
        const email = row['Email Id']?.trim().toLowerCase() || '';

        if (!firstName || !enrollmentNo || !email) {
          console.warn(`Skipping row with missing data:`, row);
          errors++;
          continue;
        }

        // Check if student already exists
        const existing = await Student.findOne({ email });
        
        if (existing) {
          // Update existing student
          existing.firstName = firstName;
          existing.enrollmentNo = enrollmentNo;
          await existing.save();
          updated++;
        } else {
          // Create new student
          await Student.create({
            firstName,
            enrollmentNo,
            email,
          });
          imported++;
        }
      } catch (err) {
        console.error(`Error processing row:`, row, err.message);
        errors++;
      }
    }

    console.log('\nImport Summary:');
    console.log(`  Imported: ${imported}`);
    console.log(`  Updated: ${updated}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Total: ${imported + updated}`);

    process.exit(0);
  } catch (err) {
    console.error('Import failed:', err);
    process.exit(1);
  }
};

importStudents();

