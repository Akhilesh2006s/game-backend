const mongoose = require('mongoose');

const connectDB = async (mongoUri) => {
  try {
    if (!mongoUri) {
      throw new Error('Missing Mongo connection string');
    }

    mongoose.set('strictQuery', true);
    
    // Optimize connection for better performance
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000, // Reduced timeout
      socketTimeoutMS: 45000, // 45 seconds
      maxPoolSize: 10, // Maintain up to 10 socket connections
      minPoolSize: 2, // Maintain at least 2 socket connections
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
      bufferCommands: false, // Disable mongoose buffering
      bufferMaxEntries: 0, // Disable mongoose buffering
    });

    console.log('⚡ Connected to MongoDB Atlas');
  } catch (err) {
    console.error('MongoDB connection failed', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;




