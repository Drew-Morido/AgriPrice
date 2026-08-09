/* ============================================
   AgriPricePH - Historical Data Logic
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.HistoricalData = (function () {
  let masterData = { labels: [], impSpecial: [], impPremium: [], impWellMilled: [], impRegular: [], locSpecial: [], locPremium: [], locWellMilled: [], locRegular: [], fuel: [], exchange: [] };
  let currentPeriod = 90;
  let hiddenSeries = new Set(); 

  // --- SVG ICONS PARA SA MODAL (No Emojis) ---
  const svgWarning = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const svgSuccess = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#4CAF6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;

  async function init() {
    const tabsContainer = document.querySelector('.period-tabs');
    if (tabsContainer) {
        let newContainer = tabsContainer.cloneNode(true);
        tabsContainer.parentNode.replaceChild(newContainer, tabsContainer);
    }

    bindPeriodTabs();
    bindCategoryDropdown();
    bindTableFilters();
    bindExportBtn(); 

    if (masterData.labels.length === 0) {
       await fetchAndRenderData();
    } else {
       updateChartForPeriod(currentPeriod);
    }
  }

  async function fetchAndRenderData() {
    try {
      const response = await fetch(`${AgriPricePH.API?.BASE || 'http://127.0.0.1:5000'}/api/historical-data`);
      if (!response.ok) throw new Error("Backend connection failed.");
      
      const realData = await response.json();
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

      updateChartForPeriod(currentPeriod);
      
    } catch (error) {
      console.error("Backend offline or error:", error);
    }
  }

  function updateChartForPeriod(days) {
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

    renderHistChart();
    renderTable(); 
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
    const btn = document.querySelector('.section-header .filter-bar button');
    if(!btn) return;
    
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    
    newBtn.addEventListener('click', () => {
        const typeSelect = document.getElementById('table-rice-type');
        const freqSelect = document.getElementById('table-frequency');
        const riceLabel = document.getElementById('table-rice-type-label');
        const freqLabel = document.getElementById('table-frequency-label');
        const riceName  = riceLabel ? riceLabel.textContent.trim() : 'Rice Data';
        const freqName  = freqLabel ? freqLabel.textContent.trim() : 'Daily';
        
        showModal({
            icon: svgWarning,
            title: 'Export to System Folder',
            text: `Are you sure you want to save the <strong>${freqName}</strong> historical data for <strong>${riceName}</strong> into the system's document folder?`,
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

  function renderTable() {
    const tbody = document.getElementById('historical-tbody');
    if (!tbody) return;

    const category = document.getElementById('table-category') ? document.getElementById('table-category').value : 'local';
    const type = document.getElementById('table-rice-type') ? document.getElementById('table-rice-type').value : 'well_milled';
    const frequency = document.getElementById('table-frequency') ? document.getElementById('table-frequency').value : 'daily';
    
    let priceArray = [];
    let typeName = "";
    
    if (category === 'local') {
        if (type === 'special') { priceArray = AgriPricePH.Data.historical.locSpecial; typeName = "Local Special"; }
        else if (type === 'premium') { priceArray = AgriPricePH.Data.historical.locPremium; typeName = "Local Premium"; }
        else if (type === 'well_milled') { priceArray = AgriPricePH.Data.historical.locWellMilled; typeName = "Local Well Milled"; }
        else if (type === 'regular') { priceArray = AgriPricePH.Data.historical.locRegular; typeName = "Local Regular"; }
    } else {
        if (type === 'special') { priceArray = AgriPricePH.Data.historical.impSpecial; typeName = "Imported Special"; }
        else if (type === 'premium') { priceArray = AgriPricePH.Data.historical.impPremium; typeName = "Imported Premium"; }
        else if (type === 'well_milled') { priceArray = AgriPricePH.Data.historical.impWellMilled; typeName = "Imported Well Milled"; }
        else if (type === 'regular') { priceArray = AgriPricePH.Data.historical.impRegular; typeName = "Imported Regular"; }
    }

    const labels = AgriPricePH.Data.historicalLabels;
    const fuel = AgriPricePH.Data.historical.fuel;
    const usd = AgriPricePH.Data.historical.exchange;

    const groupedData = groupDataByFrequency(labels, priceArray, fuel, usd, frequency);

    const limit = Math.min(groupedData.length, 100); 
    let html = '';

    for (let i = groupedData.length - 1; i >= Math.max(0, groupedData.length - limit); i--) {
        let rowData = groupedData[i];
        let prevPrice = (i > 0) ? groupedData[i - 1].price : rowData.price;
        let change = rowData.price - prevPrice;
        
        let pillClass = change > 0 ? 'pill-orange' : (change < 0 ? 'pill-green' : 'pill-gray');
        let changeSign = change > 0 ? '+' : '';
        let changeText = change === 0 ? '₱0.00' : `${changeSign}₱${Math.abs(change).toFixed(2)}`;

        html += `<tr>
          <td>${rowData.label}</td>
          <td>${typeName}</td>
          <td class="font-mono">₱${rowData.price.toFixed(2)}</td>
          <td class="font-mono">₱${rowData.fuel.toFixed(2)}</td>
          <td class="font-mono">₱${rowData.usd.toFixed(2)}</td>
          <td><span class="pill ${pillClass}">${changeText}</span></td>
        </tr>`;
    }
    tbody.innerHTML = html;
  }

  function renderHistChart() {
    const canvas = document.getElementById('hist-main-chart');
    if (!canvas) return;
    
    const category = document.getElementById('rice-category') ? document.getElementById('rice-category').value : 'local';
    let baseDatasets = [];

    if (category === 'local') {
        baseDatasets = [
          { id: 'loc-sp', label: 'Local Special', data: AgriPricePH.Data.historical.locSpecial, color: '#059669', fill: false, lineWidth: 2 },
          { id: 'loc-pr', label: 'Local Premium', data: AgriPricePH.Data.historical.locPremium, color: '#10B981', fill: false, lineWidth: 2 },
          { id: 'loc-wm', label: 'Local Well Milled', data: AgriPricePH.Data.historical.locWellMilled, color: '#34D399', fill: false, lineWidth: 2 },
          { id: 'loc-rg', label: 'Local Regular', data: AgriPricePH.Data.historical.locRegular, color: '#6EE7B7', fill: false, lineWidth: 2 },
          { id: 'fuel',   label: 'Diesel Fuel', data: AgriPricePH.Data.historical.fuel, color: '#F59E0B', fill: false, lineWidth: 1.5, dashed: true },
          { id: 'usd',    label: 'USD/PHP', data: AgriPricePH.Data.historical.exchange, color: '#3B82F6', fill: false, lineWidth: 1.5, dashed: true }
        ];
    } else {
        baseDatasets = [
          { id: 'imp-sp', label: 'Imported Special', data: AgriPricePH.Data.historical.impSpecial, color: '#4338CA', fill: false, lineWidth: 2 },
          { id: 'imp-pr', label: 'Imported Premium', data: AgriPricePH.Data.historical.impPremium, color: '#6366F1', fill: false, lineWidth: 2 },
          { id: 'imp-wm', label: 'Imported Well Milled', data: AgriPricePH.Data.historical.impWellMilled, color: '#A78BFA', fill: false, lineWidth: 2 },
          { id: 'imp-rg', label: 'Imported Regular', data: AgriPricePH.Data.historical.impRegular, color: '#C4B5FD', fill: false, lineWidth: 2 },
          { id: 'fuel',   label: 'Diesel Fuel', data: AgriPricePH.Data.historical.fuel, color: '#F59E0B', fill: false, lineWidth: 1.5, dashed: true },
          { id: 'usd',    label: 'USD/PHP', data: AgriPricePH.Data.historical.exchange, color: '#3B82F6', fill: false, lineWidth: 1.5, dashed: true }
        ];
    }

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
                renderHistChart(); 
            });
        });
    }

    const activeDatasets = baseDatasets.filter(ds => !hiddenSeries.has(ds.id));
    AgriPricePH.Charts.lineChart(canvas, activeDatasets, { labels: AgriPricePH.Data.historicalLabels, padding: { top: 20, right: 20, bottom: 36, left: 54 } });
  }


  function bindTableFilters() {
    initOutlookDropdown('table-category-wrap',   'table-category',   'table-category-label',   renderTable);
    initOutlookDropdown('table-rice-type-wrap',  'table-rice-type',  'table-rice-type-label',  renderTable);
    initOutlookDropdown('table-frequency-wrap',  'table-frequency',  'table-frequency-label',  renderTable);
    }

  function bindCategoryDropdown() {
    initOutlookDropdown('rice-category-wrap', 'rice-category', 'rice-category-label', () => {
        hiddenSeries.clear();
        renderHistChart();
    });
    }

  function bindPeriodTabs() {
    document.querySelectorAll('#page-outlet .period-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('#page-outlet .period-tab').forEach(t => t.classList.remove('active'));
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

        updateChartForPeriod(days);
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

  const RICE_TYPE_LABELS = {
    special: 'Special',
    premium: 'Premium',
    well_milled: 'Well Milled',
    regular: 'Regular',
  };

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
        setOutlookValue('table-category-wrap', 'table-category', 'table-category-label', ctx.category, catLabel);
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
          const allIds = Object.values(CHART_SERIES_BY_TYPE[cat] || {}).concat(['fuel', 'usd']);
          allIds.forEach(id => { if (id !== seriesId) hiddenSeries.add(id); });
        }
      }
      renderHistChart();
      renderTable();
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