const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { JSDOM } = require('jsdom');
const axeCore = require('axe-core');
const https = require('https');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Track MongoDB connection status
let dbConnected = false;

// Enhanced CORS configuration for production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? [
        process.env.FRONTEND_URL,
        // Add your specific frontend domains here
        'https://your-frontend-domain.netlify.app',
        'https://your-frontend-domain.vercel.app',
        'https://your-custom-domain.com'
      ].filter(Boolean) // Remove undefined values
    : [
        'http://localhost:3000', 
        'http://localhost:5173', 
        'http://localhost:3001'
      ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept']
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

// Helper function to fetch HTML from URL without Puppeteer
const fetchHtmlFromUrl = (url) => {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const timeout = 30000; // 30 second timeout
    
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: timeout
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`Redirecting to: ${res.headers.location}`);
        return fetchHtmlFromUrl(res.headers.location).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      
      res.on('data', (chunk) => {
        data += chunk;
        // Limit response size to prevent memory issues
        if (data.length > 10 * 1024 * 1024) { // 10MB limit
          req.destroy();
          reject(new Error('Response too large'));
        }
      });
      
      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout - the website took too long to respond'));
    });

    req.on('error', (err) => {
      if (err.code === 'ENOTFOUND') {
        reject(new Error('Website not found - please check the URL'));
      } else if (err.code === 'ECONNREFUSED') {
        reject(new Error('Connection refused - the website is not accessible'));
      } else if (err.code === 'ETIMEDOUT') {
        reject(new Error('Connection timeout - the website took too long to respond'));
      } else {
        reject(new Error(`Network error: ${err.message}`));
      }
    });
  });
};

// Helper Functions (same as before)
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
    severityBreakdown,
    note: type === 'url' ? 'Analysis performed on initial HTML - JavaScript-generated content not included' : undefined
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
    if (severities[severity] !== undefined) {
      severities[severity]++;
    }
  });

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
    'MINOR': '#0891b2'
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

// Root endpoint for Render health checks
app.get('/', (req, res) => {
  res.json({ 
    message: 'Accessibility Analyzer API is running (Puppeteer-free version)',
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    mode: 'Static HTML Analysis',
    endpoints: {
      health: '/api/health',
      analyzeUrl: '/api/analyze-url',
      analyzeHtml: '/api/analyze-html',
      history: '/api/analysis-history'
    }
  });
});

// Analyze URL endpoint - No Puppeteer version
app.post('/api/analyze-url', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Enhanced URL validation
    try {
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return res.status(400).json({ error: 'URL must use HTTP or HTTPS protocol' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    console.log(`Analyzing URL (static HTML): ${url}`);

    // Fetch HTML content from URL
    const htmlContent = await fetchHtmlFromUrl(url);
    
    console.log(`Fetched HTML content (${htmlContent.length} characters)`);

    // Use JSDOM to create a DOM from the HTML
    const dom = new JSDOM(htmlContent, {
      url: url,
      resources: 'usable',
      runScripts: 'outside-only'
    });
    const { window } = dom;

    // Set up global variables for axe-core
    global.window = window;
    global.document = window.document;

    console.log('Running axe-core analysis...');

    // Run axe-core analysis
    const results = await axeCore.run(window.document);

    // Clean up globals
    delete global.window;
    delete global.document;

    console.log('Axe analysis completed');

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
        console.log('Analysis saved to database');
      } catch (dbError) {
        console.error('Failed to save analysis to database:', dbError.message);
      }
    } else {
      console.log('Skipping database save: MongoDB not connected');
    }

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    console.error('URL analysis error:', error);
    
    let errorMessage = 'Failed to analyze URL. ';
    
    if (error.message.includes('ENOTFOUND')) {
      errorMessage += 'Website not found. Please check if the URL is correct and accessible.';
    } else if (error.message.includes('timeout')) {
      errorMessage += 'The website took too long to respond. Please try again later.';
    } else if (error.message.includes('HTTP 4')) {
      errorMessage += 'The page could not be found (404) or is not accessible.';
    } else if (error.message.includes('HTTP 5')) {
      errorMessage += 'The website is experiencing server issues. Please try again later.';
    } else if (error.message.includes('ECONNREFUSED')) {
      errorMessage += 'Connection refused. The website may be down or blocking requests.';
    } else {
      errorMessage += error.message || 'Please check if the URL is accessible and try again.';
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

// Analyze HTML endpoint (unchanged)
app.post('/api/analyze-html', async (req, res) => {
  try {
    const { htmlContent } = req.body;
    
    if (!htmlContent) {
      return res.status(400).json({ error: 'HTML content is required' });
    }

    // Basic HTML validation
    if (!htmlContent.includes('<') || !htmlContent.includes('>')) {
      return res.status(400).json({ error: 'Please provide valid HTML content' });
    }

    console.log('Analyzing HTML content...');

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
        console.log('Analysis saved to database');
      } catch (dbError) {
        console.error('Failed to save analysis to database:', dbError.message);
      }
    } else {
      console.log('Skipping database save: MongoDB not connected');
    }

    res.json({
      success: true,
      data: mappedResults
    });

  } catch (error) {
    console.error('HTML analysis error:', error);
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
    console.error('Get history error:', error);
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
    console.error('Get analysis error:', error);
    res.status(500).json({ error: 'Failed to retrieve analysis' });
  }
});

// Enhanced health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Accessibility Analyzer API (Puppeteer-free)',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    mongodbConnected: dbConnected,
    mode: 'Static HTML Analysis',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message 
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    availableEndpoints: {
      root: '/',
      health: '/api/health',
      analyzeUrl: 'POST /api/analyze-url',
      analyzeHtml: 'POST /api/analyze-html',
      history: 'GET /api/analysis-history',
      analysis: 'GET /api/analysis/:id'
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Accessibility Analyzer API running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 MongoDB connected: ${dbConnected ? 'Yes' : 'No'}`);
  console.log(`🔧 Mode: Static HTML Analysis (Puppeteer-free)`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
});
