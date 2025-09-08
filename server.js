const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer-core');
const chromium = require('chromium');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const { JSDOM } = require('jsdom');
const axeCore = require('axe-core');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Track MongoDB connection status
let dbConnected = false;

// Enhanced CORS configuration for production
const corsOptions = {
  origin:
    process.env.NODE_ENV === 'production'
      ? [
          process.env.FRONTEND_URL,
          'https://your-frontend-domain.netlify.app',
          'https://your-frontend-domain.vercel.app',
          'https://your-custom-domain.com',
        ].filter(Boolean)
      : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// MongoDB Connection (Optional)
if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {
      dbConnected = true;
      console.log('📊 MongoDB connected: Yes');
    })
    .catch((err) => {
      dbConnected = false;
      console.error('📊 MongoDB connection error:', err.message);
      console.log('📊 Continuing without MongoDB connection...');
    });
} else {
  console.log('📊 No MONGODB_URI provided, running without MongoDB connection');
}

// Analysis Results Schema (only defined if MongoDB is used)
const analysisSchema = new mongoose.Schema({
  type: { type: String, enum: ['url', 'html'], required: true },
  input: { type: String, required: true },
  results: { type: Object, required: true },
  timestamp: { type: Date, default: Date.now },
  complianceScore: { type: Number, required: true },
  totalIssues: { type: Number, required: true },
});

const Analysis = dbConnected ? mongoose.model('Analysis', analysisSchema) : null;

// --- helper functions (unchanged) ---
// calculateComplianceScore, mapAxeResults, mapSeverity, etc...
// (keep all of your existing helper functions here)

// API Routes

app.get('/', (req, res) => {
  res.json({
    message: 'Accessibility Analyzer API is running',
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      analyzeUrl: '/api/analyze-url',
      analyzeHtml: '/api/analyze-html',
      history: '/api/analysis-history',
    },
  });
});

app.post('/api/analyze-url', async (req, res) => {
  let browser = null;
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    try {
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return res.status(400).json({ error: 'URL must use HTTP or HTTPS protocol' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    console.log(`Analyzing URL: ${url}`);

    // ✅ Puppeteer config updated for Render (using chromium npm)
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || chromium.path,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection',
        '--disable-features=VizDisplayCompositor',
      ],
      timeout: process.env.NODE_ENV === 'production' ? 30000 : 60000,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/91.0.4472.124 Safari/537.36'
    );
    await page.goto(url, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: process.env.NODE_ENV === 'production' ? 30000 : 60000,
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve);
        }
      });
    });
    await page.waitForTimeout(1000);

    console.log('Page loaded successfully, starting axe analysis...');
    const results = await new AxePuppeteer(page)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    console.log('Axe analysis completed');
    const mappedResults = mapAxeResults(results, url, 'url');

    if (dbConnected && Analysis) {
      try {
        const analysis = new Analysis({
          type: 'url',
          input: url,
          results: mappedResults,
          complianceScore: mappedResults.complianceScore,
          totalIssues: mappedResults.totalIssues,
        });
        await analysis.save();
        console.log('Analysis saved to database');
      } catch (dbError) {
        console.error('Failed to save analysis to database:', dbError.message);
      }
    } else {
      console.log('Skipping database save: MongoDB not connected');
    }
    if (page) {
      await page.close();
    }
    res.json({ success: true, data: mappedResults });
  } catch (error) {
    console.error('URL analysis error:', error);
    let errorMessage = 'Failed to analyze URL. ';
    if (error.message.includes('Page/Frame is not ready')) {
      errorMessage += 'The page could not be loaded properly.';
    } else if (error.message.includes('timeout')) {
      errorMessage += 'The page took too long to load.';
    } else if (error.message.includes('net::ERR_')) {
      errorMessage += 'Network error occurred.';
    } else if (error.message.includes('Navigation timeout')) {
      errorMessage += 'The website took too long to respond.';
    } else {
      errorMessage += 'Please check if the URL is accessible and try again.';
    }
    res.status(500).json({ error: errorMessage });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
  }
});

// --- your /api/analyze-html, /api/analysis-history, /api/health routes stay the same ---

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 MongoDB connected: ${dbConnected ? 'Yes' : 'No'}`);
});
