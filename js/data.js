/* ============================================
   AgriPricePH - Mock Data
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Data = (function () {

  // ── Rice Types ───────────────────────────

  const riceTypes = [
    'Imported Special',
    'Imported Premium',
    'Imported Well-Milled',
    'Imported Regular',
    'Local Special',
    'Local Premium',
    'Local Well-Milled',
    'Local Regular',
  ];

  // ── Current Prices ────────────────────────

  const currentPrices = {
    'Imported Special':    { price: 52.50, change: +1.50, pct: +2.94 },
    'Imported Premium': { price: 48.00, change: +0.50, pct: +1.05 },
    'Imported Well-Milled':        { price: 60.00, change: -0.50, pct: -0.83 },
    'Imported Regular':        { price: 65.00, change: +2.00, pct: +3.17 },
    'Local Special':          { price: 72.00, change: 0.00,  pct: 0.00  },
    'Local Premium':          { price: 68.00, change: -1.00, pct: -1.45 },
    'Local Well-Milled':      { price: 76.00, change: +1.00, pct: +1.33 },
    'Local Regular':      { price: 55.00, change: +0.50, pct: +0.92 },
  };

  // ── 2-day Forecast (fallback kapag offline ang API) ──
  const forecast2d = [
    { day: 1, date: 'Day 1', price: 52.80, wm: 52.80, rm: 48.20, pm: 59.80, sp: 65.10, conf: 0.92 },
    { day: 2, date: 'Day 2', price: 53.10, wm: 53.10, rm: 48.50, pm: 60.10, sp: 65.40, conf: 0.89 },
  ];

  const forecast7d = [
    { date: 'Apr 22', wm: 52.80, rm: 48.20, pm: 59.80, sp: 65.10, conf: 0.92 },
    { date: 'Apr 23', wm: 53.10, rm: 48.50, pm: 60.10, sp: 65.40, conf: 0.89 },
    { date: 'Apr 24', wm: 53.40, rm: 48.80, pm: 59.90, sp: 65.20, conf: 0.87 },
    { date: 'Apr 25', wm: 53.20, rm: 48.60, pm: 60.30, sp: 65.50, conf: 0.85 },
    { date: 'Apr 26', wm: 53.70, rm: 49.00, pm: 60.50, sp: 65.80, conf: 0.83 },
    { date: 'Apr 27', wm: 54.00, rm: 49.20, pm: 60.80, sp: 66.00, conf: 0.81 },
    { date: 'Apr 28', wm: 54.30, rm: 49.50, pm: 61.00, sp: 66.20, conf: 0.78 },
  ];

  // ── Historical daily data (90 days) ──────

  function genHistorical(base, vol, n = 90) {
    const arr = [base];
    for (let i = 1; i < n; i++) {
      const prev = arr[i - 1];
      const delta = (Math.random() - 0.48) * vol;
      arr.push(Math.max(base * 0.85, Math.min(base * 1.15, prev + delta)));
    }
    return arr;
  }

  const historical = {
    locWellMilled: genHistorical(50, 0.6),
    locRegular:    genHistorical(46, 0.5),
    locPremium:    genHistorical(60, 0.8),
    locSpecial:    genHistorical(65, 0.7),
    impWellMilled: genHistorical(44, 0.55),
    impRegular:    genHistorical(40, 0.45),
    impPremium:    genHistorical(48, 0.65),
    impSpecial:    genHistorical(52, 0.6),
    wellMilled:    null,
    regularMilled: null,
    premium:       null,
    fuel:          genHistorical(62, 1.2),
    exchange:      genHistorical(56.4, 0.3),
    stock:         genHistorical(1200000, 15000).map(v => v / 1000),
  };
  historical.wellMilled = historical.locWellMilled;
  historical.regularMilled = historical.locRegular;
  historical.premium = historical.locPremium;

  // Generate labels: last 90 days
  const historicalLabels = (() => {
    const labels = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      labels.push(d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }));
    }
    return labels;
  })();

  // ── Training Loss ─────────────────────────

  function genLoss(startLoss, endLoss, epochs = 50) {
    const arr = [];
    for (let i = 0; i < epochs; i++) {
      const t = i / (epochs - 1);
      const base = startLoss + (endLoss - startLoss) * t;
      arr.push(base + Math.random() * base * 0.05 * (1 - t));
    }
    return arr;
  }

  const trainingLoss = genLoss(0.042, 0.008, 50);
  const valLoss      = trainingLoss.map(v => v * (1.05 + Math.random() * 0.06));

  // ── Correlation Matrix ────────────────────

  const corrLabels = ['Rice', 'Fuel', 'USD/PHP', 'Stock', 'Rainfall', 'Month'];

  const corrMatrix = [
    [ 1.00,  0.85,  0.72, -0.63,  0.41,  0.33],
    [ 0.85,  1.00,  0.68, -0.55,  0.38,  0.28],
    [ 0.72,  0.68,  1.00, -0.42,  0.31,  0.21],
    [-0.63, -0.55, -0.42,  1.00, -0.58, -0.44],
    [ 0.41,  0.38,  0.31, -0.58,  1.00,  0.62],
    [ 0.33,  0.28,  0.21, -0.44,  0.62,  1.00],
  ];

  // ── Data Sources ──────────────────────────

  const dataSources = [
    {
      id: 'da',
      name: 'DA – Dept. of Agriculture',
      type: 'Web Scraper (BeautifulSoup)',
      dataType: 'Daily Rice Prices (8 types)',
      status: 'active',
      lastFetch: '2 mins ago',
      recordsToday: '128',
      totalRecords: '36,500',
      url: 'https://www.da.gov.ph',
      color: '#4CAF6E',
      bgColor: 'rgba(76,175,110,0.12)',
    },
    {
      id: 'doe',
      name: 'DOE – Dept. of Energy',
      type: 'Web Scraper (Selenium)',
      dataType: 'Diesel Fuel Price (Weekly)',
      status: 'active',
      lastFetch: '1 hr ago',
      recordsToday: '1',
      totalRecords: '521',
      url: 'https://doe.gov.ph',
      color: '#F59E0B',
      bgColor: 'rgba(245,158,11,0.12)',
    },
    {
      id: 'api',
      name: 'ExchangeRate API',
      type: 'REST API (JSON)',
      dataType: 'USD/PHP Exchange Rate',
      status: 'active',
      lastFetch: '5 mins ago',
      recordsToday: '24',
      totalRecords: '8,760',
      url: 'https://api.exchangerate-api.com',
      color: '#3B82F6',
      bgColor: 'rgba(59,130,246,0.12)',
    },
  ];

  // ── Scraper Logs ──────────────────────────

  const scraperLogs = [
    { time: '14:02:31', level: 'INFO',    msg: 'Scheduler triggered: DA Rice Price scraper' },
    { time: '14:02:32', level: 'INFO',    msg: 'Connecting to da.gov.ph/price-monitoring' },
    { time: '14:02:34', level: 'SUCCESS', msg: 'Page loaded. Parsing price table...' },
    { time: '14:02:34', level: 'INFO',    msg: 'Extracted 8 rice type rows — Apr 21, 2026' },
    { time: '14:02:35', level: 'INFO',    msg: 'Initial cleaning: removing ₱ symbols and units' },
    { time: '14:02:35', level: 'SUCCESS', msg: 'Inserted 8 records → rice_prices table' },
    { time: '14:02:36', level: 'INFO',    msg: 'Scraper job completed in 4.8s' },
    { time: '13:58:10', level: 'INFO',    msg: 'Scheduler triggered: ExchangeRate API fetch' },
    { time: '13:58:11', level: 'SUCCESS', msg: 'USD/PHP = 56.42. Stored to exchange_rates.' },
    { time: '13:45:00', level: 'INFO',    msg: 'Scheduler triggered: PAGASA rainfall scraper' },
    { time: '13:45:03', level: 'WARN',    msg: 'Station MMWS-12 data unavailable — skipped' },
    { time: '13:45:04', level: 'SUCCESS', msg: 'Stored 23/24 station records successfully' },
    { time: '12:00:00', level: 'INFO',    msg: 'Daily pre-processing pipeline started' },
    { time: '12:00:15', level: 'INFO',    msg: 'Forward fill applied to 2 missing dates' },
    { time: '12:00:17', level: 'INFO',    msg: 'Linear interpolation: monthly stock → daily' },
    { time: '12:00:19', level: 'INFO',    msg: 'Feature engineering: 7d/30d moving averages' },
    { time: '12:00:22', level: 'INFO',    msg: 'Min-Max normalization applied to all features' },
    { time: '12:00:23', level: 'SUCCESS', msg: 'Pre-processing complete. 2,190 records updated.' },
    { time: '11:30:00', level: 'INFO',    msg: 'LSTM inference run started (Well Milled Rice)' },
    { time: '11:30:04', level: 'SUCCESS', msg: '7-day forecast generated. MAE=1.32, RMSE=1.87' },
  ];

  // ── Alerts ────────────────────────────────

  const alertRules = [
    { id: 1, name: 'Well Milled > Threshold', condition: 'Price above', value: '₱55.00', type: 'danger',  active: true,  rice: 'Well Milled Rice', triggered: 0 },
    { id: 2, name: 'Regular Milled Drop',      condition: 'Price below', value: '₱44.00', type: 'info',    active: true,  rice: 'Regular Milled Rice', triggered: 2 },
    { id: 3, name: 'Large 3-Day Spike',        condition: '3-day change >', value: '+5%', type: 'warning', active: true,  rice: 'All Types', triggered: 0 },
    { id: 4, name: 'Forecast Uncertainty',     condition: 'Confidence <',  value: '75%',  type: 'info',    active: false, rice: 'All Types', triggered: 0 },
  ];

  const notifLog = [
    { type: 'danger',  title: 'Price Alert Triggered', desc: 'Regular Milled Rice dropped to ₱47.50 — below ₱44.00 threshold.', time: '2h ago' },
    { type: 'warning', title: 'Scraper Warning',       desc: 'PSA website timeout. Retrying in 30 minutes.', time: '5h ago' },
    { type: 'info',    title: 'Model Retrained',       desc: 'LSTM model retrained with latest data. MAE improved to 1.32.', time: '1d ago' },
    { type: 'success', title: 'Forecast Published',    desc: '7-day forecast for Apr 22–28 has been published.', time: '2d ago' },
  ];

  // ── System Logs ───────────────────────────

  const systemLogs = [
    { time: '14:05:11', source: 'SCHEDULER', level: 'INFO',    msg: 'Cron job triggered: da_scraper.py' },
    { time: '14:05:12', source: 'SCRAPER',   level: 'INFO',    msg: 'GET https://da.gov.ph/price-monitoring → 200 OK' },
    { time: '14:05:14', source: 'SCRAPER',   level: 'SUCCESS', msg: '8 records extracted and inserted' },
    { time: '14:05:14', source: 'DB',        level: 'INFO',    msg: 'INSERT INTO rice_prices: 8 rows committed' },
    { time: '14:03:00', source: 'API',       level: 'INFO',    msg: 'GET /api/v1/predictions — 200 OK (45ms)' },
    { time: '14:00:00', source: 'SCHEDULER', level: 'INFO',    msg: 'Hourly health check: all services nominal' },
    { time: '13:58:10', source: 'SCRAPER',   level: 'INFO',    msg: 'ExchangeRate API fetch: USD/PHP=56.42' },
    { time: '13:45:04', source: 'SCRAPER',   level: 'WARNING', msg: 'PAGASA station MMWS-12 unavailable' },
    { time: '13:45:05', source: 'DB',        level: 'INFO',    msg: 'INSERT INTO weather_data: 23 rows' },
    { time: '12:00:23', source: 'PIPELINE',  level: 'SUCCESS', msg: 'Pre-processing pipeline completed in 23s' },
    { time: '11:30:04', source: 'LSTM',      level: 'SUCCESS', msg: 'Inference complete. 7-day forecast stored.' },
    { time: '10:15:33', source: 'AUTH',      level: 'INFO',    msg: 'Admin login: admin@agripriceph.gov.ph' },
    { time: '09:00:00', source: 'SCHEDULER', level: 'INFO',    msg: 'Daily training pipeline check — skipped (retrain not due)' },
    { time: '08:30:11', source: 'DB',        level: 'INFO',    msg: 'Backup completed: agripriceph_20260421.sql.gz' },
    { time: '00:00:01', source: 'SCHEDULER', level: 'INFO',    msg: 'Midnight reset: daily counters cleared' },
  ];

  return {
    riceTypes,
    currentPrices,
    forecast2d,
    forecast7d,
    historical,
    historicalLabels,
    trainingLoss,
    valLoss,
    corrLabels,
    corrMatrix,
    dataSources,
    scraperLogs,
    alertRules,
    notifLog,
    systemLogs,
  };

})();