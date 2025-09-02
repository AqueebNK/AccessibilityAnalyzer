// server.js - Fixed version with better error handling
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const { JSDOM } = require('jsdom');
const axeCore = require('axe-core');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware - Fixed CORS for Render deployment
app.use(cors({
  origin: [
    'http://localhost:3000',           // for local development
    'http://localhost:3001',           // alternative local port
    'http://localhost:5173',           // Vite default port
    'https://your-netlify-app.netlify.app',  // replace with your actual Netlify URL
    'https://*.netlify.app',           // allows any Netlify subdomain
    'https://*.vercel.app',            // if using Vercel
    // Add your actual frontend domain here
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 200 // For legacy browser support
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// MongoDB Connection (Optional for testing)
let Analysis = null;
let dbConnected = false;

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }).then(() => {
    console.log('📊 MongoDB connected successfully');
    dbConnected = true;
  }).catch((err) => {
    console.log('⚠️  MongoDB connection failed:', err.message);
    console.log('🔄 Running without database - results won\'t be saved');
  });

  // Analysis Results Schema
  const analysisSchema = new mongoose.Schema({
    type: { type: String, enum: ['url', 'html'], required: true },
    input: { type: String, required: true }, // URL or HTML content
    results: { type: Object, required: true },
    timestamp: { type: Date, default: Date.now },
    complianceScore: { type: Number, required: true },
    totalIssues: { type: Number, required: true },
  });

  Analysis = mongoose.model('Analysis', analysisSchema);
} else {
  console.log('⚠️  No MONGODB_URI found - running without database');
  console.log('🔄 Analysis results won\'t be saved but API will work');
}

// Helper Functions
const calculateComplianceScore = (violations, passes, incomplete) => {
  const totalChecks = violations.length + passes.length + incomplete.length;
  if (totalChecks === 0) return 100;
  
  const passedChecks = passes.length;
  const partialCredit = incomplete.length * 0.5; // Give partial credit for incomplete
  
  return Math.round(((passedChecks + partialCredit) / totalChecks) * 100);
};

const mapSeverity = (impact) => {
  const severityMap = {
    'critical': 'Critical',
    'serious': 'Serious', 
    'moderate': 'Moderate',
    'minor': 'Minor'
  };
  return severityMap[impact?.toLowerCase()] || 'Moderate';
};

const mapSeverityToPriority = (impact) => {
  const priorityMap = {
    'critical': 'High',
    'serious': 'High',
    'moderate': 'Medium',
    'minor': 'Low'
  };
  return priorityMap[impact?.toLowerCase()] || 'Medium';
};

const getEstimatedEffort = (impact) => {
  const effortMap = {
    'critical': '2-4 hours',
    'serious': '1-3 hours',
    'moderate': '30 minutes - 1 hour',
    'minor': '15-30 minutes'
  };
  return effortMap[impact?.toLowerCase()] || '1 hour';
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
  // Generate simple fix examples based on violation type
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

const calculateIssueDistribution = (violations) => {
  const categories = {
    'Visual': 0,
    'Navigation': 0,
    'Forms': 0,
    'ARIA': 0
  };

  violations.forEach(violation => {
    if (violation.tags.includes('cat.color') || violation.tags.includes('cat.images')) {
      categories.Visual++;
    } else if (violation.tags.includes('cat.keyboard') || violation.tags.includes('cat.navigation')) {
      categories.Navigation++;
    } else if (violation.tags.includes('cat.forms')) {
      categories.Forms++;
    } else if (violation.tags.includes('cat.aria')) {
      categories.ARIA++;
    } else {
      categories.Visual++; // Default category
    }
  });

  const total = Object.values(categories).reduce((sum, count) => sum + count, 0);
  
  return Object.entries(categories).map(([name, count]) => ({
    name,
    value: total > 0 ? Math.round((count / total) * 100) : 0,
    color: getCategoryColor(name)
  }));
};

const calculateSeverityBreakdown = (violations) => {
  console.log('=== SEVERITY BREAKDOWN DEBUG ===');
  console.log('Total violations received:', violations.length);
  
  const severities = {
    'Critical': 0,
    'Serious': 0,
    'Moderate': 0,
    'Minor': 0
  };

  violations.forEach((violation, index) => {
    const severity = mapSeverity(violation.impact);
    console.log(`Violation ${index}: impact="${violation.impact}" -> severity="${severity}"`);
    if (severities[severity] !== undefined) {
      severities[severity]++;
    } else {
      console.log(`Warning: Unknown severity "${severity}" for violation ${index}`);
    }
  });

  console.log('Severity counts:', severities);

  const result = Object.entries(severities).map(([name, count]) => ({
    name,
    count,
    color: getSeverityColor(name)
  }));

  console.log('Final severityBreakdown result:', result);
  console.log('=== END SEVERITY DEBUG ===');

  return result;
};

const getCategoryColor = (category) => {
  const colors = {
    'Visual': '#ef4444',
    'Navigation': '#f97316', 
    'Forms': '#eab308',
    'ARIA': '#06b6d4'
  };
  return colors[category] || '#6b7280';
};

const getSeverityColor = (severity) => {
  const colors = {
    'Critical': '#dc2626',
    'Serious': '#ea580c',
    'Moderate': '#d97706', 
    'Minor': '#0891b2'
  };
  return colors[severity] || '#6b7280';
};

const calculateAccessibilityImpact = (violations) => {
  // Calculate percentage of users potentially affected
  const criticalCount = violations.filter(v => v.impact === 'critical').length;
  const seriousCount = violations.filter(v => v.impact === 'serious').length;
  
  // Rough estimation based on severity
  const impact = (criticalCount * 15) + (seriousCount * 8) + (violations.length * 2);
  return Math.min(Math.round(impact), 100);
};

const mapAxeResults = (axeResults, input, type) => {
  const { violations, passes, incomplete } = axeResults;
  
  console.log('=== MAPPING AXE RESULTS ===');
  console.log('Violations:', violations.length);
  console.log('Passes:', passes.length);
  console.log('Incomplete:', incomplete.length);
  
  // Calculate compliance score
  const complianceScore = calculateComplianceScore(violations, passes, incomplete);
  
  // Map violations to your format
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

  // Map passed checks
  const mappedPasses = passes.map(pass => ({
    id: pass.id,
    description: pass.description,
    wcagReference: `WCAG 2.1 SC ${pass.tags.find(tag => tag.includes('wcag'))?.replace('wcag', '') || 'N/A'}`
  }));

  // Map incomplete checks
  const mappedIncomplete = incomplete.map(inc => ({
    id: inc.id,
    description: inc.description,
    wcagReference: `WCAG 2.1 SC ${inc.tags.find(tag => tag.includes('wcag'))?.replace('wcag', '') || 'N/A'}`
  }));

  // Calculate issue distribution
  const issueDistribution = calculateIssueDistribution(violations);
  
  // Calculate severity breakdown
  const severityBreakdown = calculateSeverityBreakdown(violations);

  const result = {
    type,
    input: type === 'url' ? input : 'HTML Content',
    timestamp: new Date().toISOString(),
    complianceScore,
    totalIssues: violations.length,
    pagesScanned: 1,
    totalPagesFound: 1,
    accessibilityImpactScore: calculateAccessibilityImpact(violations),
    violations: mappedViolations,
    passes: mappedPasses,
    incomplete: mappedIncomplete,
    issueDistribution,
    severityBreakdown
  };

  console.log('=== FINAL MAPPED RESULT ===');
  console.log('Issue Distribution:', result.issueDistribution);
  console.log('Severity Breakdown:', result.severityBreakdown);
  console.log('=== END MAPPING ===');

  return result;
};

// Error handling middleware
const handleError = (error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error occurred',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
};

// API Routes

// Health check endpoint (moved up for easier testing)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Accessibility Analyzer API',
    environment: process.env.NODE_ENV || 'development',
    database: dbConnected ? 'connected' : 'disconnected'
  });
});

// Analyze URL endpoint with improved error handling
app.post('/api/analyze-url', async (req, res) => {
  let browser = null;
  
  try {
    const { url } = req.body;
    
    console.log('Received URL analysis request:', { url });
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL format
    let validUrl;
    try {
      validUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    console.log(`🔍 Analyzing URL: ${validUrl.href}`);

    // Launch Puppeteer with better error handling
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
    } catch (browserError) {
      console.error('Failed to launch browser:', browserError);
      return res.status(500).json({ 
        error: 'Failed to initialize browser for analysis' 
      });
    }
    
    const page = await browser.newPage();
    
    // Set user agent and viewport
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setViewport({ width: 1200, height: 800 });
    
    // Set timeout and try to load page
    try {
      await page.goto(validUrl.href, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });
    } catch (pageError) {
      await browser.close();
      console.error('Failed to load page:', pageError);
      return res.status(400).json({ 
        error: 'Failed to load the URL. Please check if the website is accessible and try again.' 
      });
    }

    // Run axe-core analysis
    let results;
    try {
      results = await new AxePuppeteer(page).analyze();
    } catch (axeError) {
      await browser.close();
      console.error('Axe analysis failed:', axeError);
      return res.status(500).json({ 
        error: 'Failed to perform accessibility analysis on the page' 
      });
    }
    
    await browser.close();

    // Map results to your format
    const mappedResults = mapAxeResults(results, validUrl.href, 'url');

    // Save to database (if connected)
    if (dbConnected && Analysis) {
      try {
        const analysis = new Analysis({
          type: 'url',
          input: validUrl.href,
          results: mappedResults,
          complianceScore: mappedResults.complianceScore,
          totalIssues: mappedResults.totalIssues
        });

        await analysis.save();
        console.log('✅ Analysis saved to database');
      } catch (saveError) {
        console.log('❌ Failed to save to database:', saveError.message);
      }
    }

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Failed to close browser:', closeError);
      }
    }
    
    console.error('❌ URL analysis error:', error);
    res.status(500).json({ 
      error: 'Failed to analyze URL. Please check if the URL is accessible and try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Analyze HTML endpoint with improved error handling
app.post('/api/analyze-html', async (req, res) => {
  try {
    const { htmlContent } = req.body;
    
    console.log('Received HTML analysis request');
    
    if (!htmlContent) {
      return res.status(400).json({ error: 'HTML content is required' });
    }

    if (typeof htmlContent !== 'string' || htmlContent.trim().length === 0) {
      return res.status(400).json({ error: 'HTML content must be a non-empty string' });
    }

    console.log('🔍 Analyzing HTML content...');

    // Create JSDOM instance with error handling
    let dom;
    try {
      dom = new JSDOM(htmlContent, {
        contentType: 'text/html',
        includeNodeLocations: true
      });
    } catch (domError) {
      console.error('JSDOM creation failed:', domError);
      return res.status(400).json({ 
        error: 'Invalid HTML content. Please check your HTML syntax.' 
      });
    }

    const { window } = dom;

    // Make axe-core work with JSDOM
    global.window = window;
    global.document = window.document;

    // Run axe-core analysis with error handling
    let results;
    try {
      results = await axeCore.run(window.document);
    } catch (axeError) {
      // Clean up global variables
      delete global.window;
      delete global.document;
      
      console.error('Axe analysis failed:', axeError);
      return res.status(500).json({ 
        error: 'Failed to perform accessibility analysis on the HTML content' 
      });
    }

    // Clean up global variables
    delete global.window;
    delete global.document;

    // Map results to your format
    const mappedResults = mapAxeResults(results, htmlContent, 'html');

    // Save to database (if connected)
    if (dbConnected && Analysis) {
      try {
        const analysis = new Analysis({
          type: 'html',
          input: htmlContent.substring(0, 1000) + '...', // Store truncated version
          results: mappedResults,
          complianceScore: mappedResults.complianceScore,
          totalIssues: mappedResults.totalIssues
        });

        await analysis.save();
        console.log('✅ Analysis saved to database');
      } catch (saveError) {
        console.log('❌ Failed to save to database:', saveError.message);
      }
    }

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    console.error('❌ HTML analysis error:', error);
    res.status(500).json({ 
      error: 'Failed to analyze HTML content. Please check your HTML and try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get analysis history
app.get('/api/analysis-history', async (req, res) => {
  try {
    if (!dbConnected || !Analysis) {
      return res.json({
        success: true,
        message: 'Database not connected - no history available',
        data: {
          analyses: [],
          pagination: {
            page: 1,
            limit: 10,
            total: 0,
            pages: 0
          }
        }
      });
    }

    const { page = 1, limit = 10, type } = req.query;
    const skip = (page - 1) * limit;
    
    const filter = type ? { type } : {};
    
    const analyses = await Analysis.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-results'); // Exclude full results for list view

    const total = await Analysis.countDocuments(filter);

    res.json({
      success: true,
      data: {
        analyses,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('❌ Get history error:', error);
    res.status(500).json({ error: 'Failed to retrieve analysis history' });
  }
});

// Get specific analysis by ID
app.get('/api/analysis/:id', async (req, res) => {
  try {
    if (!dbConnected || !Analysis) {
      return res.status(404).json({ 
        error: 'Database not connected - analysis not available' 
      });
    }

    const { id } = req.params;
    
    // Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
