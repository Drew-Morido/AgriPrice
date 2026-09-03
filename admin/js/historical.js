/* ============================================
   AgriPricePH - Historical Data Logic
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.HistoricalData = (function () {
  let masterData = { labels: [], impSpecial: [], impPremium: [], impWellMilled: [], impRegular: [], locSpecial: [], locPremium: [], locWellMilled: [], locRegular: [], fuel: [], exchange: [] };
  let currentPeriod = 90;
  let hiddenSeries = new Set();
  let currentMode = 'chart'; // 'chart' | 'stats' — which top-level view is showing
  let statsCategory = 'local';
  let statsGrade = 'well_milled';
  let statsRange = 365;
  let tablePage = 1; // 1-based current page of the Data Table, TABLE_PAGE_SIZE rows per page
  const TABLE_PAGE_SIZE = 10;
  let lastChartDatasets = []; // full series (with real data arrays) behind the chart currently
  // drawn, so a chart click can look up the previous point's value without re-deriving it.

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

  // --- SVG ICONS PARA SA MODAL (No Emojis) ---
  const svgWarning = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const svgSuccess = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#4CAF6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  // Small lightbulb glyph for the Statistics "insight" callout.
  const svgInsight = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.68.69 1.23 1.44 1.41 2.5"/></svg>`;
  // Same glyph as admin/css/taxes.css's .tx-info-btn icon, reused here for the .hist-info popovers
  // so both modules' "what does this mean?" affordance looks identical.
  const INFO_ICON_SVG = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="11" x2="12" y2="17"/><circle cx="12" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>';
  function infoIcon(text) {
    return `<span class="hist-info" tabindex="0"><span class="hist-info-icon">${INFO_ICON_SVG}</span><span class="hist-info-pop">${esc(text)}</span></span>`;
  }

  async function init() {
    // Every route (re)mount starts with fresh HTML whose "Chart & Data Table" tab is hard-coded
    // active — reset the module-level mode state to match, otherwise a revisit after previously
    // switching to Statistics would leave that tab's first click a no-op (mode === currentMode).
    currentMode = 'chart';
    tablePage = 1;

    const tabsContainer = document.querySelector('.period-tabs');
    if (tabsContainer) {
        let newContainer = tabsContainer.cloneNode(true);
        tabsContainer.parentNode.replaceChild(newContainer, tabsContainer);
    }

    bindPeriodTabs();
    bindCategoryDropdown();
    bindTableFilters();
    bindExportBtn();
    bindViewTabs();
    bindStatsControls();
    renderTypeChips();

    if (masterData.labels.length === 0) {
       await fetchAndRenderData();
    } else {
       updateChartForPeriod(currentPeriod, false);
    }

    if (currentMode === 'stats') renderStats();
  }

  async function fetchAndRenderData() {
    try {
      const realData = await AgriPricePH.API.historical();
      if (realData.error) throw new Error(realData.error);

      masterData.labels = realData.labels;
      masterData.impSpecial = realData.historical.impSpecial;
      masterData.impPremium = realData.historical.impPremium;
      masterData.impWellMilled = realData.historical.impWellMilled;
      masterData.impRegular = realData.historical.impRegular;
      masterData.locSpecial = realData.historical.locSpecial;
      masterData.locPremium = realData.historical.locPremium;
      masterData.locWellMilled = realData.historical.locWellMilled;
      masterData.locRegular = realData.historical.locRegular;
      masterData.fuel = realData.historical.fuel;
      masterData.exchange = realData.historical.exchange;

      // Real record count — was a hardcoded "36,500+ records" placeholder before.
      const countEl = document.getElementById('hist-record-count');
      if (countEl) {
        const n = masterData.labels.length;
        const first = masterData.labels[0] || '?';
        const last = masterData.labels[n - 1] || '?';
        countEl.textContent = n > 0
          ? `${first} – ${last} · ${n.toLocaleString()} records`
          : 'No records loaded';
      }

      updateChartForPeriod(currentPeriod, false);
      if (currentMode === 'stats') renderStats();

    } catch (error) {
      console.error("Backend offline or error:", error);
      const countEl = document.getElementById('hist-record-count');
      if (countEl) countEl.textContent = 'Backend unreachable';
    }
  }

  function updateChartForPeriod(days, animate) {
    currentPeriod = days;
    if (masterData.labels.length === 0) return;

    let sliceStart = (days === 'all' || days === 'ALL') ? 0 : -parseInt(days);

    AgriPricePH.Data.historicalLabels = masterData.labels.slice(sliceStart);
    AgriPricePH.Data.historical.impSpecial = masterData.impSpecial.slice(sliceStart);
    AgriPricePH.Data.historical.impPremium = masterData.impPremium.slice(sliceStart);
    AgriPricePH.Data.historical.impWellMilled = masterData.impWellMilled.slice(sliceStart);
    AgriPricePH.Data.historical.impRegular = masterData.impRegular.slice(sliceStart);
    AgriPricePH.Data.historical.locSpecial = masterData.locSpecial.slice(sliceStart);
    AgriPricePH.Data.historical.locPremium = masterData.locPremium.slice(sliceStart);
    AgriPricePH.Data.historical.locWellMilled = masterData.locWellMilled.slice(sliceStart);
    AgriPricePH.Data.historical.locRegular = masterData.locRegular.slice(sliceStart);
    AgriPricePH.Data.historical.fuel = masterData.fuel.slice(sliceStart);
    AgriPricePH.Data.historical.exchange = masterData.exchange.slice(sliceStart);
    // Aliases para sa dashboard / predictions (wellMilled, etc.)
    AgriPricePH.Data.historical.wellMilled = AgriPricePH.Data.historical.locWellMilled;
    AgriPricePH.Data.historical.regularMilled = AgriPricePH.Data.historical.locRegular;
    AgriPricePH.Data.historical.premium = AgriPricePH.Data.historical.locPremium;

    renderHistChart(!!animate);
    tablePage = 1;
    renderTable();
    updateTableSub();
  }

  // ==== CUSTOM MODAL ALERTS ====
  function showModal(opts) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.7); z-index:9999; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.2s;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#122A1E; padding:32px 24px; border-radius:12px; width:340px; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); border:1px solid rgba(76,175,110,0.2); transform:scale(0.95); transition:transform 0.2s;';

    box.innerHTML = `
        <div style="margin-bottom:20px; display:flex; justify-content:center;">${opts.icon}</div>
        <h3 style="margin:0 0 10px 0; color:white; font-size:18px; font-family:var(--font-sans);">${opts.title}</h3>
        <p style="margin:0 0 24px 0; color:#A0AEC0; font-size:13px; line-height:1.6; font-family:var(--font-sans);">${opts.text}</p>
        <div style="display:flex; gap:12px; justify-content:center;">
            ${opts.showCancel ? `<button id="modal-cancel" style="padding:10px 20px; border-radius:6px; border:1px solid #333; background:transparent; color:#fff; cursor:pointer; font-weight:600; transition:background 0.2s;">Cancel</button>` : ''}
            <button id="modal-confirm" style="padding:10px 20px; border-radius:6px; border:none; background:${opts.confirmColor || '#4CAF6E'}; color:#fff; cursor:pointer; font-weight:600; box-shadow:0 2px 8px rgba(0,0,0,0.2); transition:opacity 0.2s;">${opts.confirmText}</button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        box.style.transform = 'scale(1)';
    });

    const closeModal = () => {
        overlay.style.opacity = '0';
        box.style.transform = 'scale(0.95)';
        setTimeout(() => document.body.removeChild(overlay), 200);
    };

    if (opts.showCancel) {
        box.querySelector('#modal-cancel').onclick = () => { closeModal(); if (opts.onCancel) opts.onCancel(); };
        box.querySelector('#modal-cancel').onmouseover = function() { this.style.background = 'rgba(255,255,255,0.05)'; };
        box.querySelector('#modal-cancel').onmouseout = function() { this.style.background = 'transparent'; };
    }

    box.querySelector('#modal-confirm').onclick = () => { closeModal(); if (opts.onConfirm) opts.onConfirm(); };
    box.querySelector('#modal-confirm').onmouseover = function() { this.style.opacity = '0.9'; };
    box.querySelector('#modal-confirm').onmouseout = function() { this.style.opacity = '1'; };
  }

  // Legacy 3-series grouper — kept exactly as-is because exportToCSV() (all 8 rice types + fuel
  // + USD, always, regardless of the on-screen category filter) depends on this exact shape.
  function groupDataByFrequency(labels, priceArr, fuelArr, usdArr, frequency) {
    if (frequency === 'daily') {
        return labels.map((l, i) => ({ label: l, price: priceArr[i], fuel: fuelArr[i], usd: usdArr[i] }));
    }

    let groups = {};
    let order = [];

    labels.forEach((label, i) => {
        let d = new Date(label);
        if (isNaN(d)) return;

        let key = label;
        if (frequency === 'weekly') {
            let day = d.getDay() || 7;
            let diff = d.getDate() - day + 1;
            let monday = new Date(d.setDate(diff));
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            key = `Week of ${months[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
        } else if (frequency === 'monthly') {
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            key = `${months[d.getMonth()]} ${d.getFullYear()}`;
        } else if (frequency === 'yearly') {
            key = `${d.getFullYear()}`;
        }

        if (!groups[key]) {
            groups[key] = { pSum: 0, fSum: 0, uSum: 0, count: 0 };
            order.push(key);
        }
        groups[key].pSum += priceArr[i] || 0;
        groups[key].fSum += fuelArr[i] || 0;
        groups[key].uSum += usdArr[i] || 0;
        groups[key].count += 1;
    });

    return order.map(k => {
        let g = groups[k];
        return { label: k, price: g.pSum / g.count, fuel: g.fSum / g.count, usd: g.uSum / g.count };
    });
  }

  // General N-series grouper used by the redesigned table (§4 of the plan): pass any number of
  // {key, arr} series and get back rows keyed the same way, averaged per bucket.
  function groupSeriesByFrequency(labels, series, frequency) {
    if (frequency === 'daily') {
      return labels.map((l, i) => {
        const row = { label: l };
        series.forEach(s => { row[s.key] = s.arr[i] || 0; });
        return row;
      });
    }
    let groups = {}; let order = [];
    labels.forEach((label, i) => {
      let d = new Date(label);
      if (isNaN(d)) return;
      let key = label;
      if (frequency === 'weekly') {
        let day = d.getDay() || 7;
        let diff = d.getDate() - day + 1;
        let monday = new Date(d.setDate(diff));
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        key = `Week of ${months[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
      } else if (frequency === 'monthly') {
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        key = `${months[d.getMonth()]} ${d.getFullYear()}`;
      } else if (frequency === 'yearly') {
        key = `${d.getFullYear()}`;
      }
      if (!groups[key]) {
        groups[key] = { sums: {}, count: 0 };
        series.forEach(s => { groups[key].sums[s.key] = 0; });
        order.push(key);
      }
      series.forEach(s => { groups[key].sums[s.key] += (s.arr[i] || 0); });
      groups[key].count += 1;
    });
    return order.map(k => {
      const g = groups[k];
      const row = { label: k };
      series.forEach(s => { row[s.key] = g.sums[s.key] / g.count; });
      return row;
    });
  }

    async function exportToCSV() {
        const frequency = document.getElementById('table-frequency')
            ? document.getElementById('table-frequency').value
            : 'daily';

        const labels  = AgriPricePH.Data.historicalLabels;
        const fuel    = AgriPricePH.Data.historical.fuel;
        const usd     = AgriPricePH.Data.historical.exchange;

        const locSpecial    = groupDataByFrequency(labels, AgriPricePH.Data.historical.locSpecial,    fuel, usd, frequency);
        const locPremium    = groupDataByFrequency(labels, AgriPricePH.Data.historical.locPremium,    fuel, usd, frequency);
        const locWellMilled = groupDataByFrequency(labels, AgriPricePH.Data.historical.locWellMilled, fuel, usd, frequency);
        const locRegular    = groupDataByFrequency(labels, AgriPricePH.Data.historical.locRegular,    fuel, usd, frequency);
        const impSpecial    = groupDataByFrequency(labels, AgriPricePH.Data.historical.impSpecial,    fuel, usd, frequency);
        const impPremium    = groupDataByFrequency(labels, AgriPricePH.Data.historical.impPremium,    fuel, usd, frequency);
        const impWellMilled = groupDataByFrequency(labels, AgriPricePH.Data.historical.impWellMilled, fuel, usd, frequency);
        const impRegular    = groupDataByFrequency(labels, AgriPricePH.Data.historical.impRegular,    fuel, usd, frequency);

        function parseDateParts(label) {
            const d = new Date(label);
            if (isNaN(d)) return { day: '', month: '', year: label };
            const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            return { day: d.getDate(), month: months[d.getMonth()], year: d.getFullYear() };
        }

        let csvContent = [
            "Date/Period","Day","Month","Year",
            "Local Special (₱/kg)","Local Premium (₱/kg)",
            "Local Well Milled (₱/kg)","Local Regular (₱/kg)",
            "Imported Special (₱/kg)","Imported Premium (₱/kg)",
            "Imported Well Milled (₱/kg)","Imported Regular (₱/kg)",
            "Diesel Fuel (₱/L)","USD/PHP"
        ].join(',') + '\n';

        const totalRows = locSpecial.length;
        for (let i = totalRows - 1; i >= 0; i--) {
            const { day, month, year } = parseDateParts(locSpecial[i].label);
            const row = [
                `"${locSpecial[i].label}"`,
                day, month, year,
                locSpecial[i].price.toFixed(2),
                locPremium[i].price.toFixed(2),
                locWellMilled[i].price.toFixed(2),
                locRegular[i].price.toFixed(2),
                impSpecial[i].price.toFixed(2),
                impPremium[i].price.toFixed(2),
                impWellMilled[i].price.toFixed(2),
                impRegular[i].price.toFixed(2),
                locSpecial[i].fuel.toFixed(2),
                locSpecial[i].usd.toFixed(2)
            ].join(',');
            csvContent += row + '\n';
        }

        const now     = new Date();
        const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
        const filename = `AgriPricePH_AllRiceTypes_${frequency.toUpperCase()}_${dateStr}_${timeStr}.csv`;

        try {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            return true;
        } catch(err) {
            console.error("Export failed:", err);
            return false;
        }
    }

  function bindExportBtn() {
    const btn = document.getElementById('hist-export-btn');
    if(!btn) return;

    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', () => {
        const freqSelect = document.getElementById('table-frequency');
        const freqLabel = document.getElementById('table-frequency-label');
        const freqName  = freqLabel ? freqLabel.textContent.trim() : 'Daily';

        showModal({
            icon: svgWarning,
            title: 'Export to System Folder',
            text: `Are you sure you want to save the <strong>${freqName}</strong> historical data for <strong>all rice types</strong> into the system's document folder?`,
            showCancel: true,
            confirmText: 'Save File',
            confirmColor: '#3B82F6',
            onConfirm: async () => {
                newBtn.innerHTML = 'Saving...';
                newBtn.disabled = true;

                const isSuccess = await exportToCSV();

                newBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export CSV`;
                newBtn.disabled = false;

                if(isSuccess) {
                    showModal({
                        icon: svgSuccess,
                        title: 'File Saved Successfully!',
                        text: `The CSV file was saved under the <strong>documents/Historical_Data</strong> folder inside your project directory.`,
                        showCancel: false,
                        confirmText: 'Close',
                        confirmColor: '#4CAF6E'
                    });
                } else {
                    alert("System Error: Failed to save the file. Check Python console.");
                }
            }
        });
    });
  }

  const RICE_TYPE_LABELS = {
    special: 'Special',
    premium: 'Premium',
    well_milled: 'Well Milled',
    regular: 'Regular',
  };

  function pickTypeArray(origin, type) {
    const h = AgriPricePH.Data.historical;
    const map = {
      local: { special: h.locSpecial, premium: h.locPremium, well_milled: h.locWellMilled, regular: h.locRegular },
      imported: { special: h.impSpecial, premium: h.impPremium, well_milled: h.impWellMilled, regular: h.impRegular },
    };
    return (map[origin] && map[origin][type]) || [];
  }

  function changeCell(change) {
    const pillClass = change > 0 ? 'pill-orange' : (change < 0 ? 'pill-green' : 'pill-gray');
    const sign = change > 0 ? '+' : '';
    const text = change === 0 ? '₱0.00' : `${sign}₱${Math.abs(change).toFixed(2)}`;
    return `<td><span class="pill ${pillClass}">${text}</span></td>`;
  }

  function currentCategoryLabel() {
    const el = document.getElementById('rice-category-label');
    return el ? el.textContent.trim() : 'All';
  }

  function updateTableSub() {
    const sub = document.getElementById('hist-table-sub');
    if (!sub) return;
    const periodEl = document.querySelector('#page-outlet .period-tab.active');
    const periodText = periodEl ? periodEl.textContent.trim() : '';
    sub.textContent = `${currentCategoryLabel()} · ${periodText || 'selected range'}`;
  }

  // ================= Table (now driven by the same category dropdown as the chart) =================
  function renderTable() {
    const tbody = document.getElementById('historical-tbody');
    const thead = document.getElementById('historical-thead');
    if (!tbody) return;

    const category = document.getElementById('rice-category') ? document.getElementById('rice-category').value : 'all';
    const type = document.getElementById('table-rice-type') ? document.getElementById('table-rice-type').value : 'well_milled';
    const frequency = document.getElementById('table-frequency') ? document.getElementById('table-frequency').value : 'daily';
    const labels = AgriPricePH.Data.historicalLabels || [];

    const typeWrap = document.getElementById('table-rice-type-wrap');
    if (typeWrap) typeWrap.style.display = (category === 'gas' || category === 'currency') ? 'none' : '';

    let headHtml, rowsHtml = [], grouped, colspan;

    if (category === 'gas') {
      colspan = 3;
      headHtml = '<tr><th>Date / Period</th><th>Diesel (₱/L)</th><th>Change</th></tr>';
      grouped = groupSeriesByFrequency(labels, [{ key: 'v', arr: AgriPricePH.Data.historical.fuel }], frequency);
      for (let i = grouped.length - 1; i >= 0; i--) {
        const cur = grouped[i], prev = i > 0 ? grouped[i - 1] : cur;
        rowsHtml.push(`<tr><td>${esc(cur.label)}</td><td class="font-mono">₱${cur.v.toFixed(2)}</td>${changeCell(cur.v - prev.v)}</tr>`);
      }
    } else if (category === 'currency') {
      colspan = 3;
      headHtml = '<tr><th>Date / Period</th><th>USD/PHP</th><th>Change</th></tr>';
      grouped = groupSeriesByFrequency(labels, [{ key: 'v', arr: AgriPricePH.Data.historical.exchange }], frequency);
      for (let i = grouped.length - 1; i >= 0; i--) {
        const cur = grouped[i], prev = i > 0 ? grouped[i - 1] : cur;
        rowsHtml.push(`<tr><td>${esc(cur.label)}</td><td class="font-mono">₱${cur.v.toFixed(2)}</td>${changeCell(cur.v - prev.v)}</tr>`);
      }
    } else if (category === 'all') {
      colspan = 5;
      headHtml = `<tr><th>Date / Period</th><th>Rice Type</th><th>Local (₱/kg)</th><th>Imported (₱/kg)</th><th>Change (Local)</th></tr>`;
      grouped = groupSeriesByFrequency(labels, [
        { key: 'loc', arr: pickTypeArray('local', type) },
        { key: 'imp', arr: pickTypeArray('imported', type) },
      ], frequency);
      for (let i = grouped.length - 1; i >= 0; i--) {
        const cur = grouped[i], prev = i > 0 ? grouped[i - 1] : cur;
        rowsHtml.push(`<tr><td>${esc(cur.label)}</td><td>${RICE_TYPE_LABELS[type] || type}</td><td class="font-mono">₱${cur.loc.toFixed(2)}</td><td class="font-mono">₱${cur.imp.toFixed(2)}</td>${changeCell(cur.loc - prev.loc)}</tr>`);
      }
    } else { // local / imported
      colspan = 4;
      headHtml = '<tr><th>Date / Period</th><th>Rice Type</th><th>Avg Price (₱/kg)</th><th>Change</th></tr>';
      const typeName = `${category === 'local' ? 'Local' : 'Imported'} ${RICE_TYPE_LABELS[type] || type}`;
      grouped = groupSeriesByFrequency(labels, [{ key: 'v', arr: pickTypeArray(category, type) }], frequency);
      for (let i = grouped.length - 1; i >= 0; i--) {
        const cur = grouped[i], prev = i > 0 ? grouped[i - 1] : cur;
        rowsHtml.push(`<tr><td>${esc(cur.label)}</td><td>${esc(typeName)}</td><td class="font-mono">₱${cur.v.toFixed(2)}</td>${changeCell(cur.v - prev.v)}</tr>`);
      }
    }

    if (thead) thead.innerHTML = headHtml;

    // rowsHtml holds every row (newest first) for the current filters — paginate it here rather
    // than capping the query, so "Next" can page through the full selected range instead of only
    // ever showing the most recent 100 rows.
    const totalRows = rowsHtml.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / TABLE_PAGE_SIZE));
    if (tablePage > totalPages) tablePage = totalPages;
    if (tablePage < 1) tablePage = 1;
    const start = (tablePage - 1) * TABLE_PAGE_SIZE;
    const pageRows = rowsHtml.slice(start, start + TABLE_PAGE_SIZE);

    tbody.innerHTML = pageRows.join('') || `<tr><td colspan="${colspan}" style="text-align:center; padding:20px;">No data for this selection.</td></tr>`;
    renderPagination(totalRows, totalPages);
  }

  // ================= Data Table pagination =================
  function renderPagination(totalRows, totalPages) {
    const infoEl = document.getElementById('hist-pagination-info');
    const controlsEl = document.getElementById('hist-pagination-controls');
    if (!infoEl || !controlsEl) return;

    const startRow = totalRows === 0 ? 0 : (tablePage - 1) * TABLE_PAGE_SIZE + 1;
    const endRow = Math.min(totalRows, tablePage * TABLE_PAGE_SIZE);
    infoEl.textContent = totalRows === 0
      ? 'No records'
      : `Showing ${startRow}–${endRow} of ${totalRows.toLocaleString()} records`;

    if (totalPages <= 1) { controlsEl.innerHTML = ''; return; }

    const pages = buildPageWindow(tablePage, totalPages);
    let html = `<button type="button" class="hist-page-btn" data-page="prev" ${tablePage === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>`;
    pages.forEach(p => {
      if (p === '...') { html += `<span class="hist-page-ellipsis">…</span>`; return; }
      html += `<button type="button" class="hist-page-btn${p === tablePage ? ' active' : ''}" data-page="${p}">${p}</button>`;
    });
    html += `<button type="button" class="hist-page-btn" data-page="next" ${tablePage === totalPages ? 'disabled' : ''} aria-label="Next page">›</button>`;
    controlsEl.innerHTML = html;

    controlsEl.querySelectorAll('.hist-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-page');
        if (p === 'prev') tablePage = Math.max(1, tablePage - 1);
        else if (p === 'next') tablePage = Math.min(totalPages, tablePage + 1);
        else tablePage = parseInt(p, 10);
        renderTable();
      });
    });
  }

  // Windowed page list: first page, last page, and a small run around the current page, with
  // "…" filling any gap — e.g. [1, '...', 4, 5, 6, '...', 10] instead of 10 buttons in a row.
  function buildPageWindow(current, total) {
    const delta = 1;
    const range = [];
    for (let i = Math.max(2, current - delta); i <= Math.min(total - 1, current + delta); i++) range.push(i);

    const pages = [1];
    if (range[0] > 2) pages.push('...');
    pages.push(...range);
    if (range.length && range[range.length - 1] < total - 1) pages.push('...');
    if (total > 1) pages.push(total);
    return pages;
  }

  // ================= Chart =================
  // Category -> the series it draws. Gas/Currency are now their own single-series views instead
  // of always-on secondary lines mixed into every rice view.
  function seriesForCategory(category) {
    const h = AgriPricePH.Data.historical;
    const local = [
      { id: 'loc-sp', label: 'Local Special', data: h.locSpecial, color: '#059669', lineWidth: 2 },
      { id: 'loc-pr', label: 'Local Premium', data: h.locPremium, color: '#10B981', lineWidth: 2 },
      { id: 'loc-wm', label: 'Local Well Milled', data: h.locWellMilled, color: '#34D399', lineWidth: 2 },
      { id: 'loc-rg', label: 'Local Regular', data: h.locRegular, color: '#6EE7B7', lineWidth: 2 },
    ];
    const imported = [
      { id: 'imp-sp', label: 'Imported Special', data: h.impSpecial, color: '#4338CA', lineWidth: 2 },
      { id: 'imp-pr', label: 'Imported Premium', data: h.impPremium, color: '#6366F1', lineWidth: 2 },
      { id: 'imp-wm', label: 'Imported Well Milled', data: h.impWellMilled, color: '#A78BFA', lineWidth: 2 },
      { id: 'imp-rg', label: 'Imported Regular', data: h.impRegular, color: '#C4B5FD', lineWidth: 2 },
    ];
    if (category === 'local') return local;
    if (category === 'imported') return imported;
    if (category === 'gas') return [{ id: 'fuel', label: 'Diesel Fuel (₱/L)', data: h.fuel, color: '#F59E0B', lineWidth: 2, fill: true }];
    if (category === 'currency') return [{ id: 'usd', label: 'USD/PHP', data: h.exchange, color: '#3B82F6', lineWidth: 2, fill: true }];
    return local.concat(imported); // 'all'
  }

  function renderHistChart(animate) {
    const canvas = document.getElementById('hist-main-chart');
    if (!canvas) return;

    const category = document.getElementById('rice-category') ? document.getElementById('rice-category').value : 'all';
    const baseDatasets = seriesForCategory(category);

    let legendHTML = '';
    baseDatasets.forEach(ds => {
        const isHidden = hiddenSeries.has(ds.id);
        const opacity = isHidden ? '0.3' : '1';
        legendHTML += `<div class="legend-item interactive-legend" data-id="${ds.id}" style="opacity: ${opacity}; cursor:pointer; transition: 0.2s; user-select:none;">
          <span class="legend-dot" style="background:${ds.color}"></span>${ds.label}
        </div>`;
    });

    const legendContainer = document.getElementById('dynamic-chart-legend');
    if (legendContainer) {
        legendContainer.innerHTML = legendHTML;
        legendContainer.querySelectorAll('.interactive-legend').forEach(item => {
            item.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                if (hiddenSeries.has(id)) hiddenSeries.delete(id);
                else hiddenSeries.add(id);
                renderHistChart(false);
            });
        });
    }

    const activeDatasets = baseDatasets.filter(ds => !hiddenSeries.has(ds.id));
    lastChartDatasets = activeDatasets;
    AgriPricePH.Charts.lineChart(canvas, activeDatasets, {
      labels: AgriPricePH.Data.historicalLabels,
      padding: { top: 20, right: 20, bottom: 36, left: 54 },
      animate: !!animate,
      onPointClick: handleChartPointClick,
    });
  }

  // ================= Click-to-compare summary below the chart =================
  function handleChartPointClick(index, label) {
    const el = document.getElementById('hist-click-summary');
    if (!el) return;

    if (!lastChartDatasets.length) return;

    if (index <= 0) {
      el.innerHTML = `<p class="hist-click-hint">${esc(label)} is the first point in this range — no earlier point to compare it with.</p>`;
      return;
    }

    const rows = lastChartDatasets.map(ds => {
      const cur = ds.data[index];
      const prev = ds.data[index - 1];
      if (cur == null || prev == null || isNaN(cur) || isNaN(prev)) return null;
      const diff = cur - prev;
      const pct = prev !== 0 ? (diff / prev) * 100 : 0;
      return { label: ds.label, color: ds.color, cur, diff, pct };
    }).filter(Boolean);

    if (!rows.length) {
      el.innerHTML = `<p class="hist-click-hint">No comparable data at ${esc(label)}.</p>`;
      return;
    }

    el.innerHTML = `
      <div class="hist-click-head">
        <span class="hist-click-date">${esc(label)}</span>
        <span class="hist-click-sub">vs. the point before it</span>
      </div>
      <div class="hist-click-rows">
        ${rows.map(r => {
          const dir = r.diff > 0 ? 'up' : (r.diff < 0 ? 'down' : 'flat');
          const sign = r.diff > 0 ? '+' : '';
          return `<div class="hist-click-row">
            <span class="hist-click-dot" style="background:${r.color}"></span>
            <span class="hist-click-name">${esc(r.label)}</span>
            <span class="hist-click-val">₱${r.cur.toFixed(2)}</span>
            <span class="hist-click-diff ${dir}">${sign}₱${Math.abs(r.diff).toFixed(2)} (${sign}${Math.abs(r.pct).toFixed(1)}%)</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  // ================= View switcher (Chart & Data Table | Statistics) =================
  function bindViewTabs() {
    document.querySelectorAll('#hist-mode-tabs .hist-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-mode');
        if (mode === currentMode) return;
        currentMode = mode;

        document.querySelectorAll('#hist-mode-tabs .hist-mode-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        document.querySelectorAll('#page-outlet .hist-view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById(mode === 'stats' ? 'hist-view-stats' : 'hist-view-chart');
        if (target) target.classList.add('active');

        if (mode === 'stats') renderStats();
      });
    });
  }

  // ================= Statistics (min/max/avg/median/stdev, distribution, range-by-grade) =================
  // Pulls straight from masterData (the full unsliced dataset) instead of AgriPricePH.Data.historical
  // so the Statistics view has its own independent date range, separate from the chart's period tabs.
  const GRADE_COLORS_LOCAL = { special: '#059669', premium: '#10B981', well_milled: '#34D399', regular: '#6EE7B7' };
  const GRADE_COLORS_IMPORTED = { special: '#4338CA', premium: '#6366F1', well_milled: '#A78BFA', regular: '#C4B5FD' };

  function pickTypeArrayFull(origin, type) {
    const map = {
      local: { special: masterData.locSpecial, premium: masterData.locPremium, well_milled: masterData.locWellMilled, regular: masterData.locRegular },
      imported: { special: masterData.impSpecial, premium: masterData.impPremium, well_milled: masterData.impWellMilled, regular: masterData.impRegular },
    };
    return (map[origin] && map[origin][type]) || [];
  }

  function statsHasGrade() { return statsCategory === 'local' || statsCategory === 'imported'; }

  function getStatsSeries(category, grade) {
    const cat = category || statsCategory;
    if (cat === 'gas') return masterData.fuel || [];
    if (cat === 'currency') return masterData.exchange || [];
    return pickTypeArrayFull(cat, grade || statsGrade);
  }

  function statsRangeSlice(arr) {
    if (!arr || !arr.length) return [];
    if (statsRange === 'all') return arr;
    const n = parseInt(statsRange, 10);
    return arr.slice(-n);
  }

  function statsSeriesColor() {
    if (statsCategory === 'gas') return '#F59E0B';
    if (statsCategory === 'currency') return '#3B82F6';
    const palette = statsCategory === 'imported' ? GRADE_COLORS_IMPORTED : GRADE_COLORS_LOCAL;
    return palette[statsGrade] || AgriPricePH.Charts.COLORS.primary;
  }

  function computeStats(arr) {
    const clean = (arr || []).filter(v => v != null && !isNaN(v));
    const n = clean.length;
    if (!n) return { min: 0, max: 0, avg: 0, median: 0, stdev: 0, count: 0 };
    const sorted = [...clean].sort((a, b) => a - b);
    const min = sorted[0], max = sorted[n - 1];
    const avg = clean.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
    const variance = clean.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / n;
    const stdev = Math.sqrt(variance);
    return { min, max, avg, median, stdev, count: n };
  }

  function renderTypeChips() {
    const el = document.getElementById('hist-type-chips');
    if (!el) return;
    const hasGrade = statsHasGrade();
    el.style.display = hasGrade ? '' : 'none';
    if (!hasGrade) { el.innerHTML = ''; return; }

    el.innerHTML = Object.keys(RICE_TYPE_LABELS).map(key =>
      `<button type="button" class="hist-chip${key === statsGrade ? ' active' : ''}" data-grade="${key}">${esc(RICE_TYPE_LABELS[key])}</button>`
    ).join('');

    el.querySelectorAll('.hist-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        statsGrade = chip.getAttribute('data-grade');
        renderTypeChips();
        renderStats();
      });
    });
  }

  function currentStatsCategoryLabel() {
    const el = document.getElementById('stats-category-label');
    return el ? el.textContent.trim() : 'Local Rice';
  }

  function updateStatsSub() {
    const sub = document.getElementById('hist-stats-sub');
    if (!sub) return;
    const rangeEl = document.querySelector('#hist-srange-tabs .period-tab.active');
    const rangeText = rangeEl ? rangeEl.textContent.trim() : 'selected range';
    const gradeText = statsHasGrade() ? ` · ${RICE_TYPE_LABELS[statsGrade] || statsGrade}` : '';
    sub.textContent = `${currentStatsCategoryLabel()}${gradeText} · ${rangeText}`;
  }

  // Plain-language explanation shown in each stat card's info popover — see infoIcon() above.
  const STAT_INFO = {
    min: 'The lowest price recorded in the selected date range.',
    max: 'The highest price recorded in the selected date range.',
    avg: 'The mean price: every price in range added up, divided by how many there are.',
    median: 'The middle price when every record is sorted low to high — less thrown off by one-off spikes than the average.',
    stdev: 'How much daily prices typically stray from the average. Higher means prices swing around more.',
    count: 'How many daily price records fall inside the selected date range.',
  };

  function renderStatCards() {
    const el = document.getElementById('hist-stat-cards');
    if (!el) return;
    const s = computeStats(statsRangeSlice(getStatsSeries()));
    el.innerHTML = `
      <div class="hist-stat-card"><p class="hist-stat-label">Minimum${infoIcon(STAT_INFO.min)}</p><p class="hist-stat-value">₱${s.min.toFixed(2)}</p></div>
      <div class="hist-stat-card"><p class="hist-stat-label">Maximum${infoIcon(STAT_INFO.max)}</p><p class="hist-stat-value">₱${s.max.toFixed(2)}</p></div>
      <div class="hist-stat-card highlight"><p class="hist-stat-label">Average${infoIcon(STAT_INFO.avg)}</p><p class="hist-stat-value">₱${s.avg.toFixed(2)}</p></div>
      <div class="hist-stat-card"><p class="hist-stat-label">Median${infoIcon(STAT_INFO.median)}</p><p class="hist-stat-value">₱${s.median.toFixed(2)}</p></div>
      <div class="hist-stat-card"><p class="hist-stat-label">Std Deviation${infoIcon(STAT_INFO.stdev)}</p><p class="hist-stat-value">₱${s.stdev.toFixed(2)}</p></div>
      <div class="hist-stat-card"><p class="hist-stat-label">Records${infoIcon(STAT_INFO.count)}</p><p class="hist-stat-value">${s.count.toLocaleString()}</p></div>
    `;
  }

  // Plain-language volatility summary — turns the raw numbers above into something an admin can
  // read at a glance. Split into two short sentences (subject+average, then range+volatility)
  // instead of one long run-on line, with the volatility judgment pulled out as a colored tag.
  function renderStatsInsight() {
    const el = document.getElementById('hist-stats-insight');
    if (!el) return;
    const s = computeStats(statsRangeSlice(getStatsSeries()));
    if (!s.count) {
      el.innerHTML = `<span class="hist-insight-icon">${svgInsight}</span><div class="hist-insight-text"><p>No data available for this selection.</p></div>`;
      return;
    }

    const spread = s.max - s.min;
    const volatility = s.avg ? (s.stdev / s.avg) * 100 : 0;
    const rangeEl = document.querySelector('#hist-srange-tabs .period-tab.active');
    const rangeText = rangeEl ? rangeEl.textContent.trim() : 'this range';
    const gradeText = statsHasGrade() ? ` ${RICE_TYPE_LABELS[statsGrade] || statsGrade}` : '';
    const subject = `${currentStatsCategoryLabel()}${gradeText}`;
    const volWord = volatility < 1.5 ? 'low' : volatility < 4 ? 'moderate' : 'high';

    el.innerHTML = `
      <span class="hist-insight-icon">${svgInsight}</span>
      <div class="hist-insight-text">
        <p><strong>${esc(subject)}</strong> averaged <strong>₱${s.avg.toFixed(2)}</strong> over the past <strong>${esc(rangeText)}</strong>.</p>
        <p>Prices ranged <strong>₱${s.min.toFixed(2)}–₱${s.max.toFixed(2)}</strong> (a ₱${spread.toFixed(2)} spread), with
          <span class="hist-insight-tag ${volWord}">${volWord} volatility</span> day to day (${volatility.toFixed(1)}%).</p>
      </div>`;
  }

  function renderDistributionChart() {
    const canvas = document.getElementById('hist-dist-chart');
    if (!canvas) return;
    const series = statsRangeSlice(getStatsSeries());
    const s = computeStats(series);
    if (!s.count) {
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.onmousemove = null;
      canvas.onmouseleave = null;
      return;
    }
    const binCount = 10;
    const binSize = (s.max - s.min) / binCount || 1;
    const bins = new Array(binCount).fill(0);
    series.forEach(v => {
      if (v == null || isNaN(v)) return;
      let idx = Math.floor((v - s.min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    });
    const labels = bins.map((_, i) => '₱' + (s.min + i * binSize).toFixed(0));
    // Richer per-bar hover: the bin's full price range plus a properly-pluralized day count,
    // instead of just the axis label repeated back.
    const tooltipLabels = bins.map((_, i) => {
      const lo = s.min + i * binSize;
      const hi = i === binCount - 1 ? s.max : s.min + (i + 1) * binSize;
      return `₱${lo.toFixed(2)} – ₱${hi.toFixed(2)}`;
    });
    AgriPricePH.Charts.barChart(canvas, labels, bins, statsSeriesColor(), {
      tooltipLabels,
      valueLabel: (v) => `${v} day${v === 1 ? '' : 's'}`,
    });
  }

  function renderRangeTable() {
    const el = document.getElementById('hist-range-table');
    if (!el) return;
    const hasGrade = statsHasGrade();

    if (hasGrade) {
      const palette = statsCategory === 'imported' ? GRADE_COLORS_IMPORTED : GRADE_COLORS_LOCAL;
      const perGrade = Object.keys(RICE_TYPE_LABELS).map(key => ({
        key, stats: computeStats(statsRangeSlice(getStatsSeries(statsCategory, key))),
      }));
      const globalMin = Math.min(...perGrade.map(g => g.stats.count ? g.stats.min : Infinity));
      const globalMax = Math.max(...perGrade.map(g => g.stats.count ? g.stats.max : -Infinity));
      const span = (isFinite(globalMax - globalMin) ? (globalMax - globalMin) : 0) || 1;

      let rows = '<tr><th>Grade</th><th style="text-align:left;">Range</th><th>Avg</th></tr>';
      perGrade.forEach(g => {
        if (!g.stats.count) { rows += `<tr><td>${esc(RICE_TYPE_LABELS[g.key])}</td><td colspan="2" style="color:var(--text-muted);">No data</td></tr>`; return; }
        const leftPct = ((g.stats.min - globalMin) / span) * 100;
        const widthPct = ((g.stats.max - g.stats.min) / span) * 100;
        const markerPct = ((g.stats.avg - globalMin) / span) * 100;
        const color = palette[g.key];
        rows += `<tr>
          <td>${esc(RICE_TYPE_LABELS[g.key])}</td>
          <td><div class="hist-range-bar-wrap">
            <span class="hist-range-minmax">₱${g.stats.min.toFixed(0)}</span>
            <div class="hist-range-track">
              <div class="hist-range-fill" style="left:${leftPct}%;width:${widthPct}%;background:${color}4D;"></div>
              <div class="hist-range-marker" style="left:${markerPct}%;background:${color};"></div>
            </div>
            <span class="hist-range-minmax" style="text-align:right;">₱${g.stats.max.toFixed(0)}</span>
          </div></td>
          <td class="font-mono">₱${g.stats.avg.toFixed(2)}</td>
        </tr>`;
      });
      el.innerHTML = rows;
    } else {
      const label = statsCategory === 'gas' ? 'Diesel Fuel' : 'USD/PHP';
      const s = computeStats(statsRangeSlice(getStatsSeries()));
      const color = statsSeriesColor();
      if (!s.count) { el.innerHTML = `<tr><th>Category</th><th></th><th>Avg</th></tr><tr><td>${label}</td><td colspan="2" style="color:var(--text-muted);">No data</td></tr>`; return; }
      const markerPct = ((s.avg - s.min) / ((s.max - s.min) || 1)) * 100;
      el.innerHTML = `<tr><th>Category</th><th style="text-align:left;">Range</th><th>Avg</th></tr>
        <tr>
          <td>${label}</td>
          <td><div class="hist-range-bar-wrap">
            <span class="hist-range-minmax">₱${s.min.toFixed(2)}</span>
            <div class="hist-range-track">
              <div class="hist-range-fill" style="left:0%;width:100%;background:${color}4D;"></div>
              <div class="hist-range-marker" style="left:${markerPct}%;background:${color};"></div>
            </div>
            <span class="hist-range-minmax" style="text-align:right;">₱${s.max.toFixed(2)}</span>
          </div></td>
          <td class="font-mono">₱${s.avg.toFixed(2)}</td>
        </tr>`;
    }
  }

  function renderStats() {
    if (!masterData.labels.length) return;
    renderStatCards();
    renderStatsInsight();
    renderDistributionChart();
    renderRangeTable();
    updateStatsSub();
  }

  function bindStatsControls() {
    initOutlookDropdown('stats-category-wrap', 'stats-category', 'stats-category-label', () => {
      statsCategory = document.getElementById('stats-category').value;
      renderTypeChips();
      renderStats();
    });

    document.querySelectorAll('#hist-srange-tabs .period-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('#hist-srange-tabs .period-tab').forEach(t => t.classList.remove('active'));
        e.currentTarget.classList.add('active');
        const r = e.currentTarget.getAttribute('data-srange');
        statsRange = r === 'all' ? 'all' : parseInt(r, 10);
        renderStats();
      });
    });
  }

  function bindTableFilters() {
    initOutlookDropdown('table-rice-type-wrap', 'table-rice-type', 'table-rice-type-label', () => { tablePage = 1; renderTable(); updateTableSub(); });
    initOutlookDropdown('table-frequency-wrap', 'table-frequency', 'table-frequency-label', () => { tablePage = 1; renderTable(); updateTableSub(); });
  }

  function bindCategoryDropdown() {
    initOutlookDropdown('rice-category-wrap', 'rice-category', 'rice-category-label', () => {
        hiddenSeries.clear();
        renderHistChart(true);
        tablePage = 1;
        renderTable();
        updateTableSub();
    });
  }

  function bindPeriodTabs() {
    // Scoped to the chart view only — the Statistics view has its own .period-tab range
    // buttons (#hist-srange-tabs) with independent state (statsRange), wired in bindStatsControls().
    document.querySelectorAll('#hist-view-chart .period-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('#hist-view-chart .period-tab').forEach(t => t.classList.remove('active'));
        e.currentTarget.classList.add('active');

        let days = e.currentTarget.getAttribute('data-days');
        if (!days) {
           const text = e.currentTarget.textContent.trim().toUpperCase();
           if (text === '7D') days = 7;
           else if (text === '1M') days = 30;
           else if (text === '3M') days = 90;
           else if (text === '6M') days = 180;
           else if (text === '1Y') days = 365;
           else if (text === 'ALL') days = 'all';
           else days = 90;
        }

        updateChartForPeriod(days, true);
      });
    });
  }

  function initOutlookDropdown(wrapId, hiddenId, labelId, onChange) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;

    const trigger = wrap.querySelector('.outlook-select-trigger');
    const options = wrap.querySelectorAll('.outlook-option');
    const hidden  = document.getElementById(hiddenId);
    const label   = document.getElementById(labelId);

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close all other open dropdowns first
        document.querySelectorAll('.outlook-select-wrap.open').forEach(el => {
        if (el.id !== wrapId) el.classList.remove('open');
        });
        wrap.classList.toggle('open');
    });

    options.forEach(opt => {
        opt.addEventListener('click', () => {
        options.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        hidden.value = opt.getAttribute('data-value');
        label.textContent = opt.textContent;
        wrap.classList.remove('open');
        if (onChange) onChange();
        });
    });

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) wrap.classList.remove('open');
    });
    }

  const CHART_SERIES_BY_TYPE = {
    local: {
      special: 'loc-sp',
      premium: 'loc-pr',
      well_milled: 'loc-wm',
      regular: 'loc-rg',
    },
    imported: {
      special: 'imp-sp',
      premium: 'imp-pr',
      well_milled: 'imp-wm',
      regular: 'imp-rg',
    },
  };

  function setOutlookValue(wrapId, hiddenId, labelId, value, labelText) {
    const wrap = document.getElementById(wrapId);
    const hidden = document.getElementById(hiddenId);
    const label = document.getElementById(labelId);
    if (!hidden) return;
    hidden.value = value;
    if (label && labelText) label.textContent = labelText;
    wrap?.querySelectorAll('.outlook-option').forEach(opt => {
      opt.classList.toggle('active', opt.getAttribute('data-value') === value);
    });
  }

  function applySearchContext(ctx) {
    if (!ctx) return;

    const finish = () => {
      if (ctx.category) {
        const catLabel = ctx.category === 'imported' ? 'Imported Rice' : 'Local Rice';
        setOutlookValue('rice-category-wrap', 'rice-category', 'rice-category-label', ctx.category, catLabel);
      }
      if (ctx.riceType) {
        setOutlookValue(
          'table-rice-type-wrap',
          'table-rice-type',
          'table-rice-type-label',
          ctx.riceType,
          RICE_TYPE_LABELS[ctx.riceType] || ctx.riceType
        );
        const cat = ctx.category || document.getElementById('rice-category')?.value || 'local';
        const seriesId = CHART_SERIES_BY_TYPE[cat]?.[ctx.riceType];
        if (seriesId) {
          hiddenSeries.clear();
          const allIds = Object.values(CHART_SERIES_BY_TYPE[cat] || {});
          allIds.forEach(id => { if (id !== seriesId) hiddenSeries.add(id); });
        }
      }
      renderHistChart(false);
      tablePage = 1;
      renderTable();
      updateTableSub();
      document.getElementById('hist-main-chart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    if (masterData.labels.length === 0) {
      fetchAndRenderData().then(finish);
    } else {
      finish();
    }
  }

  return { init, applySearchContext };
})();
