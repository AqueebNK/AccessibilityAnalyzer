// server.js - Complete version with fallback method (no Puppeteer dependency)
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { JSDOM } = require('jsdom');
const axeCore = require('axe-core');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://your-netlify-app.netlify.app',
    'https://*.netlify.app',
    'https://*.vercel.app',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true,
  optionsSuccessStatus: 200
}));

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// MongoDB Connection (Optional)
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

  const analysisSchema = new mongoose.Schema({
    type: { type: String, enum: ['url', 'html'], required: true },
    input: { type: String, required: true },
    results: { type: Object, required: true },
    timestamp: { type: Date, default: Date.now },
    complianceScore: { type: Number, required: true },
    totalIssues: { type: Number, required: true },
  });

  Analysis = mongoose.model('Analysis', analysisSchema);
} else {
  console.log('⚠️  No MONGODB_URI found - running without database');
}

// Helper Functions (same as before)
const calculateComplianceScore = (violations, passes, incomplete) => {
  const totalChecks = violations.length + passes.length + incomplete.length;
  if (totalChecks === 0) return 100;
  
  const passedChecks = passes.length;
  const partialCredit = incomplete.length * 0.5;
  
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
    'Critical': 0,
    'Serious': 0,
    'Moderate': 0,
    'Minor': 0
  };

  violations.forEach(violation => {
    const severity = mapSeverity(violation.impact);
    if (severities[severity] !== undefined) {
      severities[severity]++;
    }
  });

  return Object.entries(severities).map(([name, count]) => ({
    name,
    count,
    color: getSeverityColor(name)
  }));
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
  const criticalCount = violations.filter(v => v.impact === 'critical').length;
  const seriousCount = violations.filter(v => v.impact === 'serious').length;
  
  const impact = (criticalCount * 15) + (seriousCount * 8) + (violations.length * 2);
  return Math.min(Math.round(impact), 100);
};

const mapAxeResults = (axeResults, input, type) => {
  const { violations, passes, incomplete } = axeResults;
  
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

// Routes

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Accessibility Analyzer API is running!',
    version: '1.0.0',
    mode: 'Fallback (JSDOM)',
    endpoints: {
      health: '/api/health',
      analyzeUrl: 'POST /api/analyze-url',
      analyzeHtml: 'POST /api/analyze-html',
      history: 'GET /api/analysis-history',
      analysis: 'GET /api/analysis/:id'
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Accessibility Analyzer API',
    mode: 'Fallback (JSDOM)',
    environment: process.env.NODE_ENV || 'development',
    database: dbConnected ? 'Connected' : 'Disconnected'
  });
});

// Analyze URL endpoint - FALLBACK VERSION (no Puppeteer)
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

    console.log(`🔍 Analyzing URL (fallback method): ${url}`);

    // Fetch HTML content
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      },
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`✅ Fetched HTML (${html.length} characters)`);
    
    // Create JSDOM instance
    const dom = new JSDOM(html, {
      url: url,
      features: {
        FetchExternalResources: false,
        ProcessExternalResources: false
      }
    });
    
    const { window } = dom;

    // Make axe-core work with JSDOM
    global.window = window;
    global.document = window.document;

    console.log('🔍 Running accessibility analysis with axe-core...');
    
    // Run axe-core analysis
    const results = await axeCore.run(window.document);
    
    console.log(`✅ Analysis completed: ${results.violations.length} violations found`);

    // Clean up global variables
    delete global.window;
    delete global.document;

    // Map results
    const mappedResults = mapAxeResults(results, url, 'url');

    // Save to database if available
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
    console.error('❌ URL analysis error:', error);
    
    let errorMessage = 'Failed to analyze URL. Please check if the URL is accessible and try again.';
    
    if (error.message.includes('timeout')) {
      errorMessage = 'The website took too long to respond. Please try again.';
    } else if (error.message.includes('HTTP')) {
      errorMessage = `Could not access the website (${error.message}). Please check the URL.`;
    } else if (error.message.includes('fetch')) {
      errorMessage = 'Network error: Could not connect to the website.';
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

    console.log('🔍 Analyzing HTML content...');

    const dom = new JSDOM(htmlContent, {
      features: {
        FetchExternalResources: false,
        ProcessExternalResources: false
      }
    });
    
    const { window } = dom;

    global.window = window;
    global.document = window.document;

    const results = await axeCore.run(window.document);

    delete global.window;
    delete global.document;

    const mappedResults = mapAxeResults(results, htmlContent, 'html');

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
      error: 'Failed to analyze HTML content. Please check your HTML and try again.' 
    });
  }
});

// Analysis history endpoint
app.get('/api/analysis-history', async (req, res) => {
  try {
    if (!dbConnected || !Analysis) {
      return res.json({
        success: true,
        message: 'Database not connected - no history available',
        data: {
          analyses: [],
          pagination: { page: 1, limit: 10, total: 0, pages: 0 }
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

// Get analysis by ID
app.get('/api/analysis/:id', async (req, res) => {
  try {
    if (!dbConnected || !Analysis) {
      return res.status(404).json({ 
        error: 'Database not connected - analysis not available' 
      });
    }

    const analysis = await Analysis.findById(req.params.id);
    
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

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// Handle 404s
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found'
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
  }
  process.exit(0);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Accessibility Analyzer API running on port ${PORT}`);
  console.log(`📊 MongoDB connected: ${mongoose.connection.readyState === 1 ? 'Yes' : 'No'}`);
  console.log(`🔄 Mode: Fallback (JSDOM) - No Puppeteer dependency`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
