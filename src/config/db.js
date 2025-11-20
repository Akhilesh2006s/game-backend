const mongoose = require('mongoose');

const connectDB = async (mongoUri) => {
  try {
    if (!mongoUri) {
      throw new Error('Missing Mongo connection string');
    }

    mongoose.set('strictQuery', true);
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log('⚡ Connected to MongoDB Atlas');
  } catch (err) {
    console.error('MongoDB connection failed', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;




