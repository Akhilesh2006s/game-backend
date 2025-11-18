require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const gameRoutes = require('./routes/gameRoutes');
const initGameSocket = require('./socket/gameSocket');

const PORT = process.env.PORT || 5000;
// Allow multiple origins for development and production
// Always include regex patterns for Vercel preview URLs
const vercelRegexPatterns = [
  /^https:\/\/games-frontend-.*\.vercel\.app$/, // Allow all games-frontend Vercel preview URLs
  /^https:\/\/.*\.vercel\.app$/ // Allow any Vercel domain
];

const defaultStringOrigins = [
  'http://localhost:5173', 
  'https://games-frontend-mocha.vercel.app',
  'https://games-frontend-92qdx6knh-akhilesh2006s-projects.vercel.app'
];

// Combine all allowed origins
const allowedOrigins = process.env.CLIENT_ORIGIN 
  ? [
      ...process.env.CLIENT_ORIGIN.split(',').map(origin => origin.trim()),
      ...defaultStringOrigins,
      ...vercelRegexPatterns
    ]
  : [
      ...defaultStringOrigins,
      ...vercelRegexPatterns
    ];

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      // Check if origin is in allowed list
      const isAllowed = allowedOrigins.some(allowedOrigin => {
        if (typeof allowedOrigin === 'string') {
          return allowedOrigin === origin;
        } else if (allowedOrigin instanceof RegExp) {
          return allowedOrigin.test(origin);
        }
        return false;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        // Log for debugging
        console.log(`CORS blocked origin: ${origin}`);
        console.log(`Allowed origins:`, allowedOrigins);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ 
    message: 'Ceteris-Paribus Arena backend online',
    allowedOrigins: allowedOrigins,
    timestamp: new Date().toISOString()
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);

const io = require('socket.io')(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      
      const isAllowed = allowedOrigins.some(allowedOrigin => {
        if (typeof allowedOrigin === 'string') {
          return allowedOrigin === origin;
        } else if (allowedOrigin instanceof RegExp) {
          return allowedOrigin.test(origin);
        }
        return false;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

initGameSocket(io);

connectDB(process.env.MONGO_URI).then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});


