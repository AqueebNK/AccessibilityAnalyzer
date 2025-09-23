const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const axeCore = require('axe-core');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Track MongoDB connection status
let dbConnected = false;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.FRONTEND_URL,
    /\.vercel\.app$/,
    /\.netlify\.app$/
  ]
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// MongoDB Connection (Optional)
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      dbConnected = true;
      console.log('📊 MongoDB connected: Yes');
    })
    .catch(err => {
      dbConnected = false;
      console.error('📊 MongoDB connection error:', err.message);
      console.log('📊 Continuing without MongoDB connection...');
    });
} else {
  console.log('📊 No MONGODB_URI provided, running without MongoDB connection');
}

// Analysis Results Schema
const analysisSchema = new mongoose.Schema({
  type: { type: String, enum: ['url', 'html'], required: true },
  input: { type: String, required: true },
  results: { type: Object, required: true },
  timestamp: { type: Date, default: Date.now },
  complianceScore: { type: Number, required: true },
  totalIssues: { type: Number, required: true },
});

const Analysis = dbConnected ? mongoose.model('Analysis', analysisSchema) : null;

// Browserless.io configuration
const BROWSERLESS_API_URL = process.env.BROWSERLESS_API_URL || 'https://chrome.browserless.io';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// Helper function to get rendered HTML using Browserless
const getRenderedHTML = async (url) => {
  try {
    console.log(`🌐 Getting rendered HTML from Browserless for: ${url}`);
    
    const response = await axios.post(`${BROWSERLESS_API_URL}/content`, {
      url: url,
      waitFor: 2000, // Wait 2 seconds for content to load
      gotoOptions: {
        waitUntil: 'networkidle2'
      }
    }, {
      params: {
        token: BROWSERLESS_TOKEN
      },
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('❌ Browserless error:', error.message);
    
    if (error.response?.status === 401) {
      throw new Error('Browser service authentication failed. Please check API token.');
    } else if (error.response?.status === 429) {
      throw new Error('Browser service rate limit exceeded. Please try again later.');
    } else if (error.code === 'ECONNABORTED') {
      throw new Error('Browser service timeout. The page took too long to load.');
    } else {
      throw new Error('Browser service unavailable. Please try again later.');
    }
  }
};

// Alternative: Fallback to simple HTML fetch if Browserless fails
const fallbackFetchHTML = async (url) => {
  try {
    console.log(`📄 Fallback: Fetching static HTML from: ${url}`);
    
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      maxRedirects: 5
    });
    
    return response.data;
  } catch (error) {
    if (error.code === 'ENOTFOUND') {
      throw new Error('Unable to reach the website. Please check the URL.');
    } else if (error.response?.status === 404) {
      throw new Error('Page not found (404). Please check the URL.');
    } else {
      throw new Error('Unable to fetch the webpage. Please try again.');
    }
  }
};

// [Include all your existing helper functions]
const calculateComplianceScore = (violations, passes, incomplete) => {
  const totalChecks = violations.length + passes.length + incomplete.length;
  if (totalChecks === 0) return 100;
  
  const passedChecks = passes.length;
  const partialCredit = incomplete.length * 0.5;
  
  return Math.round(((passedChecks + partialCredit) / totalChecks) * 100);
};

const mapAxeResults = (axeResults, input, type) => {
  const { violations, passes, incomplete } = axeResults;
  
  console.log(`Total violations found: ${violations.length}`);
  
  const complianceScore = calculateComplianceScore(violations, passes, incomplete);
  
  const mappedViolations = violations.map((violation, index) => ({
    id: `violation-${index}`,
    description: violation.description,
    severity: mapSeverity(violation.impact),
    wcagReference: `WCAG 2.1 SC ${violation.tags.find(tag => tag.includes('wcag'))?.replace('wcag', '') || 'N/A'}`,
    wcagLevel: violation.tags.find(tag => tag.includes('level'))?.replace('wcag', '').replace('level', '') || 'A',
    userImpact: violation.help,
    affectedGroups: getAffectedGroups(violation.tags),
    element: {
      selector: violation.nodes[0]?.target[0] || 'Unknown',
      lineNumber: 'N/A',
      html: violation.nodes[0]?.html || 'N/A'
    },
    fixInstructions: {
      summary: violation.help,
      steps: [
        `Identify the element: ${violation.nodes[0]?.target[0] || 'the affected element'}`,
        violation.helpUrl ? 'Follow the detailed guidance in the provided resource' : 'Review accessibility guidelines',
        'Test the fix with assistive technologies'
      ],
      codeExample: generateCodeExample(violation),
      priority: mapSeverityToPriority(violation.impact),
      estimatedEffort: getEstimatedEffort(violation.impact),
      resources: violation.helpUrl ? [{
        title: 'Detailed Fix Guide',
        url: violation.helpUrl
      }] : []
    }
  }));

  const mappedPasses = passes.map(pass => ({
    id: pass.id,
    description: pass.description,
    wcagReference: `WCAG 2.1 SC ${pass.tags.find(tag => tag.includes('wcag'))?.replace('wcag', '') || 'N/A'}`
  }));

  const mappedIncomplete = incomplete.map(inc => ({
    id: inc.id,
    description: inc.description,
    wcagReference: `WCAG 2.1 SC ${inc.tags.find(tag => tag.includes('wcag'))?.replace('wcag', '') || 'N/A'}`
  }));

  return {
    type,
    input: type === 'url' ? input : 'HTML Content',
    timestamp: new Date().toISOString(),
    complianceScore,
    totalIssues: violations.length,
    pagesScanned: 1,
    totalPagesFound: 1,
    violations: mappedViolations,
    passes: mappedPasses,
    incomplete: mappedIncomplete
  };
};

const mapSeverity = (impact) => {
  const severityMap = {
    'critical': 'CRITICAL',
    'serious': 'SERIOUS', 
    'moderate': 'MODERATE',
    'minor': 'MINOR'
  };
  return severityMap[impact] || 'MODERATE';
};

const mapSeverityToPriority = (impact) => {
  const priorityMap = {
    'critical': 'High',
    'serious': 'High',
    'moderate': 'Medium',
    'minor': 'Low'
  };
  return priorityMap[impact] || 'Medium';
};

const getEstimatedEffort = (impact) => {
  const effortMap = {
    'critical': '2-4 hours',
    'serious': '1-3 hours',
    'moderate': '30 minutes - 1 hour',
    'minor': '15-30 minutes'
  };
  return effortMap[impact] || '1 hour';
};

const getAffectedGroups = (tags) => {
  const groups = [];
  if (tags.includes('cat.keyboard')) groups.push('Keyboard users');
  if (tags.includes('cat.images')) groups.push('Screen reader users');
  if (tags.includes('cat.color')) groups.push('Users with color blindness');
  if (tags.includes('cat.forms')) groups.push('All users interacting with forms');
  if (groups.length === 0) groups.push('All users');
  return groups;
};

const generateCodeExample = (violation) => {
  if (violation.id.includes('color-contrast')) {
    return '<!-- Ensure sufficient color contrast -->\n<div style="color: #000; background: #fff;">Good contrast</div>';
  }
  if (violation.id.includes('alt-text')) {
    return '<img src="image.jpg" alt="Descriptive alt text for the image">';
  }
  if (violation.id.includes('heading')) {
    return '<h1>Main heading</h1>\n<h2>Subheading</h2>';
  }
  return '<!-- Review the element and apply appropriate accessibility fixes -->';
};

// Analyze URL endpoint
app.post('/api/analyze-url', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    console.log(`🔍 Analyzing URL: ${url}`);

    let htmlContent;
    let analysisMethod = 'unknown';

    // Try Browserless first if token is available
    if (BROWSERLESS_TOKEN) {
      try {
        htmlContent = await getRenderedHTML(url);
        analysisMethod = 'browserless (with JavaScript)';
      } catch (browserlessError) {
        console.warn('⚠️ Browserless failed, falling back to static HTML:', browserlessError.message);
        htmlContent = await fallbackFetchHTML(url);
        analysisMethod = 'static HTML (fallback)';
      }
    } else {
      console.log('ℹ️ No Browserless token provided, using static HTML fetch');
      htmlContent = await fallbackFetchHTML(url);
      analysisMethod = 'static HTML';
    }

    console.log(`✅ HTML obtained via ${analysisMethod}, running axe analysis...`);

    // Analyze the HTML using JSDOM and axe-core
    const dom = new JSDOM(htmlContent, { url });
    const { window } = dom;

    global.window = window;
    global.document = window.document;

    const results = await axeCore.run(window.document, {
      tags: ['wcag2a', 'wcag2aa', 'wcag21aa']
    });

    delete global.window;
    delete global.document;

    console.log('✅ Axe analysis completed');

    const mappedResults = mapAxeResults(results, url, 'url');
    mappedResults.analysisMethod = analysisMethod;

    // Save to database if connected
    if (dbConnected && Analysis) {
      try {
        const analysis = new Analysis({
          type: 'url',
          input: url,
          results: mappedResults,
          complianceScore: mappedResults.complianceScore,
          totalIssues: mappedResults.totalIssues
        });
        await analysis.save();
        console.log('💾 Analysis saved to database');
      } catch (dbError) {
        console.error('❌ Failed to save analysis to database:', dbError.message);
      }
    }

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    console.error('❌ URL analysis error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to analyze URL. Please check if the URL is accessible and try again.' 
    });
  }
});

// Analyze HTML endpoint (same as before)
app.post('/api/analyze-html', async (req, res) => {
  try {
    const { htmlContent } = req.body;
    
    if (!htmlContent) {
      return res.status(400).json({ error: 'HTML content is required' });
    }

    console.log('🔍 Analyzing HTML content...');

    const dom = new JSDOM(htmlContent);
    const { window } = dom;

    global.window = window;
    global.document = window.document;

    const results = await axeCore.run(window.document, {
      tags: ['wcag2a', 'wcag2aa', 'wcag21aa']
    });

    delete global.window;
    delete global.document;

    const mappedResults = mapAxeResults(results, htmlContent, 'html');

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    console.error('❌ HTML analysis error:', error);
    res.status(500).json({ 
      error: 'Failed to analyze HTML content. Please check your HTML and try again.' 
    });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  let browserServiceWorking = false;
  
  if (BROWSERLESS_TOKEN) {
    try {
      await axios.get(`${BROWSERLESS_API_URL}/pressure`, {
        params: { token: BROWSERLESS_TOKEN },
        timeout: 5000
      });
      browserServiceWorking = true;
    } catch (error) {
      console.error('❌ Browserless service test failed:', error.message);
    }
  }

  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Accessibility Analyzer API',
    environment: process.env.NODE_ENV || 'development',
    mongodbConnected: dbConnected,
    browserServiceWorking,
    hasBrowserToken: !!BROWSERLESS_TOKEN,
    version: '1.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Accessibility Analyzer API',
    version: '1.0.0',
    capabilities: {
      urlAnalysis: true,
      htmlAnalysis: true,
      javascriptRendering: !!BROWSERLESS_TOKEN
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Accessibility Analyzer API running on port ${PORT}`);
  console.log(`🌐 Browser service: ${BROWSERLESS_TOKEN ? 'Browserless.io' : 'Static HTML only'}`);
  console.log(`📊 MongoDB connected: ${dbConnected ? 'Yes' : 'No'}`);
});
