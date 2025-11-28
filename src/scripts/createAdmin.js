require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const connectDB = require('../config/db');

const createAdmin = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    console.log('Connected to database');

    const adminEmail = 'gameamenity@gmail.com';
    const adminPassword = 'Amenity';
    const adminUsername = 'Admin';

    // Check if admin already exists
    const existing = await User.findOne({ email: adminEmail });
    if (existing) {
      if (existing.role === 'admin') {
        console.log('Admin user already exists');
        // Update password in case it changed
        const passwordHash = await bcrypt.hash(adminPassword, 10);
        existing.passwordHash = passwordHash;
        existing.username = adminUsername;
        existing.role = 'admin';
        await existing.save();
        console.log('Admin user updated');
      } else {
        // Convert existing user to admin
        const passwordHash = await bcrypt.hash(adminPassword, 10);
        existing.passwordHash = passwordHash;
        existing.username = adminUsername;
        existing.role = 'admin';
        await existing.save();
        console.log('User converted to admin');
      }
    } else {
      // Create new admin user
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      const admin = await User.create({
        username: adminUsername,
        email: adminEmail,
        passwordHash,
        studentName: 'Admin',
        role: 'admin',
      });
      console.log('Admin user created:', admin.email);
    }

    console.log('\nAdmin credentials:');
    console.log('Email:', adminEmail);
    console.log('Password:', adminPassword);
    console.log('\n✅ Admin user ready!');
    process.exit(0);
  } catch (err) {
    console.error('Error creating admin:', err);
    process.exit(1);
  }
};

createAdmin();

