/* AgriPricePH — Reports & Export */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Reports = (function () {

  let _history = [];
  let _bound = false;
  let _busy = false;

  const TYPE_LABELS = {
    prices_csv: 'Price Report CSV',
    metrics_json: 'Model Metrics',
    correlation_xlsx: 'Correlation Data',
    forecast_report: 'Forecast Report',
    csv: 'CSV',
    json: 'JSON',
    xlsx: 'Excel',
    html: 'HTML Report',
  };

  const ICON_COLORS = {
    csv: '#4CAF6E',
    json: '#8B5CF6',
    xlsx: '#F59E0B',
    html: '#3B82F6',
    file: '#64748B',
  };

  function init() {
    bindEvents();
    loadHistory();
  }

  function destroy() {
    _bound = false;
  }

  function bindEvents() {
    if (_bound) return;
    _bound = true;

    document.getElementById('reports-refresh-history')?.addEventListener('click', () => loadHistory());

    document.getElementById('export-cards')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.reports-export-btn');
      if (!btn || _busy) return;
      e.stopPropagation();
      runExport(btn.dataset.exportType);
    });

    document.getElementById('report-history-list')?.addEventListener('click', (e) => {
      const dl = e.target.closest('[data-download]');
      const del = e.target.closest('[data-delete-report]');
      const printBtn = e.target.closest('[data-print-report]');
      if (dl) downloadFile(dl.dataset.download);
      if (del) deleteReport(del.dataset.deleteReport);
      if (printBtn) openPrintableReport(printBtn.dataset.printReport);
    });
  }

  function setBanner(msg) {
    const el = document.getElementById('reports-status-banner');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function showToast(msg, isError) {
    let el = document.getElementById('reports-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'reports-toast';
      el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:1100;padding:12px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-md);max-width:360px;transition:opacity 0.3s;';
      document.body.appendChild(el);
    }
    el.style.background = isError ? '#FEE2E2' : 'var(--color-accent-light)';
    el.style.color = isError ? '#B91C1C' : 'var(--color-accent-dark, #2D8A50)';
    el.style.border = isError ? '1px solid #FECACA' : '1px solid rgba(76,175,110,0.3)';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  function setBusy(busy) {
    _busy = busy;
    document.querySelectorAll('.reports-export-btn').forEach(btn => {
      if (!btn.dataset.defaultLabel) {
        btn.dataset.defaultLabel = btn.textContent.trim();
      }
      btn.disabled = busy;
      btn.textContent = busy ? 'Exporting…' : btn.dataset.defaultLabel;
    });
  }

  async function loadHistory() {
    const list = document.getElementById('report-history-list');
    const empty = document.getElementById('report-history-empty');
    if (!list) return;

    try {
      const data = await AgriPricePH.API.reportsHistory();
      if (data.error && data.ready === false) throw new Error(data.error);
      _history = data.files || [];
      setBanner('');
      renderHistory();
    } catch (e) {
      console.warn('Reports history:', e);
      _history = [];
      setBanner('Cannot load report history — run python api/app.py');
      if (empty) empty.style.display = 'block';
      list.innerHTML = '';
    }
  }

  function renderHistory() {
    const list = document.getElementById('report-history-list');
    const empty = document.getElementById('report-history-empty');
    if (!list) return;

    if (!_history.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = _history.map(f => {
      const color = ICON_COLORS[f.type] || ICON_COLORS.file;
      const label = f.label || TYPE_LABELS[f.type] || f.filename;
      const printBtn = f.type === 'html'
        ? `<button type="button" class="btn btn-ghost btn-sm" data-print-report="${escapeAttr(f.filename)}">Print PDF</button>`
        : '';
      return `
        <div class="report-history-item" data-file-id="${escapeAttr(f.id)}">
          <div class="report-file-icon">${fileIconSvg(color)}</div>
          <div style="flex:1;min-width:0;">
            <div class="report-file-name">${escapeHtml(f.filename)}</div>
            <div class="report-file-meta">${escapeHtml(label)} · ${escapeHtml(f.created_display || '')} · ${escapeHtml(f.size_display || '')}</div>
          </div>
          <div class="report-actions">
            ${printBtn}
            <button type="button" class="btn btn-ghost btn-sm" data-download="${escapeAttr(f.filename)}">Download</button>
            <button type="button" class="btn btn-ghost btn-sm" data-delete-report="${escapeAttr(f.filename)}" style="color:var(--color-danger);">Delete</button>
          </div>
        </div>`;
    }).join('');
  }

  async function runExport(exportType) {
    if (!exportType || _busy) return;
    setBusy(true);
    setBanner('');

    try {
      const res = await AgriPricePH.API.reportsGenerate(exportType);
      if (!res.ok || !res.data?.success) {
        throw new Error(res.data?.error || 'Export failed');
      }

      const file = res.data.file;
      showToast(`${TYPE_LABELS[exportType] || 'Report'} saved: ${file.filename}`);
      downloadFile(file.filename);

      if (exportType === 'forecast_report' && file.type === 'html') {
        setTimeout(() => openPrintableReport(file.filename), 400);
      }

      await loadHistory();
    } catch (e) {
      showToast(e.message || 'Export failed. Is the API server running?', true);
      setBanner(e.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  function downloadUrl(filename) {
    const base = AgriPricePH.API.BASE.replace(/\/$/, '');
    return `${base}/api/reports/download/${encodeURIComponent(filename)}`;
  }

  function downloadFile(filename) {
    if (!filename) return;
    const a = document.createElement('a');
    a.href = downloadUrl(filename);
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openPrintableReport(filename) {
    if (!filename) return;
    const w = window.open(downloadUrl(filename), '_blank');
    if (w) {
      w.addEventListener('load', () => {
        try { w.print(); } catch { /* ignore */ }
      });
    } else {
      showToast('Allow pop-ups to print the forecast report as PDF.', true);
    }
  }

  async function deleteReport(filename) {
    if (!filename || !confirm(`Delete ${filename}?`)) return;
    try {
      const res = await AgriPricePH.API.reportsDelete(filename);
      if (!res.ok) throw new Error(res.data?.error || 'Delete failed');
      _history = _history.filter(f => f.filename !== filename);
      renderHistory();
      showToast('Report deleted.');
    } catch (e) {
      showToast(e.message || 'Could not delete file.', true);
    }
  }

  function fileIconSvg(color) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function applySearchContext() {}

  return { init, destroy, applySearchContext };
})();
