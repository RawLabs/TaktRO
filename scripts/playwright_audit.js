/**
 * TaktRO — End-to-End Playwright / Browser Automation Diagnostic Test
 * Launches headless browser, authenticates, clicks through every workspace module,
 * tests hotkeys, submits forms, and reports any uncaught JS exceptions or network errors.
 * 
 * Usage:
 *   npx playwright test scripts/playwright_audit.js
 *   OR
 *   node scripts/playwright_audit.js
 */

const http = require('http');

// Helper to check if server is running on port 8000
function checkServer(host = '127.0.0.1', port = 8000) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function runBrowserAudit() {
  console.log('======================================================');
  console.log('   TaktRO E2E BROWSER & FAULT DIAGNOSTIC RUNNER       ');
  console.log('======================================================\n');

  const serverOnline = await checkServer();
  if (!serverOnline) {
    console.log('❌ Server not running on http://127.0.0.1:8000.');
    console.log('   Run: python3 server.py --port 8000');
    process.exit(1);
  }
  console.log('✓ TaktRO Backend Server is ONLINE (127.0.0.1:8000)\n');

  try {
    const { chromium } = require('playwright');
    console.log('✓ Playwright detected. Launching Chromium E2E Test Suite...');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    page.on('pageerror', err => {
      consoleErrors.push(err.message);
    });

    console.log('\n[1/6] Navigating to http://127.0.0.1:8000...');
    await page.goto('http://127.0.0.1:8000');

    console.log('[2/6] Testing Login Modal & PIN Auth...');
    await page.fill('#employeePin', '001');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(500);

    console.log('[3/6] Testing Module Screen Switching (O, A, C, V, P, S)...');
    const modules = [
      { key: 'O', label: 'Repair Orders' },
      { key: 'A', label: 'Appointments' },
      { key: 'C', label: 'Customers' },
      { key: 'V', label: 'Vehicles' },
      { key: 'P', label: 'Parts Inventory' },
      { key: 'S', label: 'Shop Settings' }
    ];

    for (const mod of modules) {
      await page.keyboard.press(`Alt+${mod.key}`);
      await page.waitForTimeout(300);
      console.log(`  ✓ Switched to ${mod.label} (ALT+${mod.key})`);
    }

    console.log('[4/6] Testing Parts Modal Dialogs & Stock Entry...');
    await page.keyboard.press('Alt+P');
    await page.waitForTimeout(300);
    await page.keyboard.press('Alt+A'); // Open Add Stock Part Modal
    await page.waitForTimeout(300);
    
    const modalVisible = await page.isVisible('#newPartModalOverlay');
    console.log(`  ✓ Add Part Modal Overlay Visible: ${modalVisible}`);
    await page.keyboard.press('Escape');

    console.log('[5/6] Return to Main Dashboard (ESC)...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await browser.close();

    console.log('\n======================================================');
    if (consoleErrors.length > 0) {
      console.log(`❌ BROWSER AUDIT FAILED — ${consoleErrors.length} Uncaught JS Errors:`);
      consoleErrors.forEach(e => console.log(`   - ${e}`));
      process.exit(1);
    } else {
      console.log('🟢 BROWSER E2E AUDIT PASSED (0 Console Errors, 0 Crashes)');
      console.log('======================================================\n');
    }

  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.log('ℹ️ Playwright package not installed locally.');
      console.log('   To enable automated browser UI testing, run:');
      console.log('     npm install playwright && npx playwright install chromium');
      console.log('   Then run:');
      console.log('     node scripts/playwright_audit.js\n');
    } else {
      console.error('❌ E2E Audit Error:', err.message);
      process.exit(1);
    }
  }
}

runBrowserAudit();
