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

// Track MongoDB connection status
let dbConnected = false;

// Enhanced CORS configuration for Railway
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://localhost:3000',
    process.env.FRONTEND_URL,
    /\.vercel\.app$/,
    /\.netlify\.app$/,
    /\.railway\.app$/
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
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

// Optimized Puppeteer configuration for Railway
const getPuppeteerConfig = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const config = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--no-zygote'
    ]
  };

  if (isProduction) {
    console.log('🚀 Using production Puppeteer configuration for Railway');
    config.args.push(
      '--single-process',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    );
  }

  return config;
};

// Helper Functions
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
  violations.forEach((v, i) => {
    console.log(`Violation ${i}: impact=${v.impact}, id=${v.id}`);
  });
  
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

  const issueDistribution = calculateIssueDistribution(violations);
  const severityBreakdown = calculateSeverityBreakdown(violations);
  
  console.log('Final severity breakdown:', severityBreakdown);

  return {
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
      categories.Visual++;
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
  const severities = {
    'CRITICAL': 0,
    'SERIOUS': 0,
    'MODERATE': 0,
    'MINOR': 0
  };

  violations.forEach(violation => {
    const severity = mapSeverity(violation.impact);
    console.log(`Violation impact: ${violation.impact}, mapped severity: ${severity}`);
    if (severities[severity] !== undefined) {
      severities[severity]++;
    }
  });

  console.log('Severity breakdown:', severities);

  return Object.entries(severities)
    .map(([name, count]) => ({
      name,
      count,
      color: getSeverityColor(name)
    }))
    .filter(item => item.count > 0);
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
    'CRITICAL': '#dc2626',
    'SERIOUS': '#ea580c',
    'MODERATE': '#d97706',
    'MINOR': '#0891b2',
    // Fallbacks for title case
    'Critical': '#dc2626',
    'Serious': '#ea580c',
    'Moderate': '#d97706',
    'Minor': '#0891b2'
  };
  return colors[severity] || '#6b7280';
};

const calculateAccessibilityImpact = (violations) => {
  const criticalCount = violations.filter(v => v.impact === 'critical').length;
  const seriousCount = violations.filter(v => v.impact === 'serious').length;
  
  const impact = (criticalCount * 15) + (seriousCount * 8) + (violations.length * 2);
  return Math.min(Math.round(impact), 100);
};

// API Routes

// Analyze URL endpoint
app.post('/api/analyze-url', async (req, res) => {
  let browser = null;
  
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
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

    const puppeteerConfig = getPuppeteerConfig();
    console.log('🚀 Launching browser with optimized Railway config...');
    
    browser = await puppeteer.launch(puppeteerConfig);
    
    const page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Enhanced timeout for Railway
    const navigationTimeout = process.env.NODE_ENV === 'production' ? 90000 : 60000;
    
    console.log(`⏱️ Navigation timeout: ${navigationTimeout}ms`);
    
    // Navigate to page with multiple wait conditions
    await page.goto(url, { 
      waitUntil: ['networkidle0', 'domcontentloaded'], 
      timeout: navigationTimeout 
    });

    // Wait a bit more for any dynamic content
    await page.waitForTimeout(3000);

    // Ensure the page is fully loaded and ready
    await page.evaluate(() => {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve);
        }
      });
    });

    // Additional wait for any remaining async content
    await page.waitForTimeout(2000);

    console.log('✅ Page loaded successfully, starting axe analysis...');

    const results = await new AxePuppeteer(page)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    
    console.log('✅ Axe analysis completed');

    const mappedResults = mapAxeResults(results, url, 'url');

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
    } else {
      console.log('⚠️ Skipping database save: MongoDB not connected');
    }

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    console.error('❌ URL analysis error:', error);
    
    let errorMessage = 'Failed to analyze URL. ';
    
    if (error.message.includes('Page/Frame is not ready')) {
      errorMessage += 'The page could not be loaded properly. Please check if the URL is accessible and try again.';
    } else if (error.message.includes('timeout') || error.message.includes('Navigation timeout')) {
      errorMessage += 'The page took too long to load. Please try again or check if the URL is accessible.';
    } else if (error.message.includes('net::ERR_') || error.message.includes('ERR_NETWORK_CHANGED')) {
      errorMessage += 'Network error occurred. Please check the URL and your internet connection.';
    } else if (error.message.includes('Protocol error')) {
      errorMessage += 'Browser communication error. This might be a temporary issue, please try again.';
    } else {
      errorMessage += 'Please check if the URL is accessible and try again.';
    }
    
    res.status(500).json({ error: errorMessage });
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Browser closed successfully');
      } catch (closeError) {
        console.error('❌ Error closing browser:', closeError);
      }
    }
  }
});

// Analyze HTML endpoint
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

    const results = await axeCore.run(window.document);

    delete global.window;
    delete global.document;

    const mappedResults = mapAxeResults(results, htmlContent, 'html');

    // Save to database if connected
    if (dbConnected && Analysis) {
      try {
        const analysis = new Analysis({
          type: 'html',
          input: htmlContent.substring(0, 1000) + '...',
          results: mappedResults,
          complianceScore: mappedResults.complianceScore,
          totalIssues: mappedResults.totalIssues
        });
        await analysis.save();
        console.log('💾 Analysis saved to database');
      } catch (dbError) {
        console.error('❌ Failed to save analysis to database:', dbError.message);
      }
    } else {
      console.log('⚠️ Skipping database save: MongoDB not connected');
    }

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
      .select('-results');

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
    
    const analysis = await Analysis.findById(id);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    res.json({
      success: true,
      data: analysis
    });

  } catch (error) {
    console.error('❌ Get analysis error:', error);
    res.status(500).json({ error: 'Failed to retrieve analysis' });
  }
});

// Health check endpoint with browser test
app.get('/api/health', async (req, res) => {
  let browserWorking = false;
  
  try {
    const browser = await puppeteer.launch(getPuppeteerConfig());
    await browser.close();
    browserWorking = true;
  } catch (error) {
    console.error('❌ Browser test failed:', error.message);
  }

  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Accessibility Analyzer API',
    environment: process.env.NODE_ENV || 'development',
    platform: 'Railway',
    mongodbConnected: dbConnected,
    puppeteerWorking: browserWorking,
    version: '1.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Accessibility Analyzer API',
    version: '1.0.0',
    platform: 'Railway',
    environment: process.env.NODE_ENV || 'development',
    capabilities: {
      urlAnalysis: true,
      htmlAnalysis: true,
      puppeteerBrowser: true
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Accessibility Analyzer API running on port ${PORT}`);
  console.log(`🚂 Platform: Railway`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 MongoDB connected: ${dbConnected ? 'Yes' : 'No'}`);
  console.log(`🎭 Browser: Puppeteer with optimized Railway config`);
});
