/* ============================================
   AgriPricePH - Chart Utilities (Canvas)
   ============================================ */

window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.Charts = (function () {
  const COLORS = {
    primary:   '#4CAF6E', secondary: '#3B82F6', danger:    '#EF4444',
    warning:   '#F59E0B', purple:    '#8B5CF6', teal:      '#14B8A6',
    muted:     '#CBD5E1', grid:      '#E2EAE4', bg:        '#FFFFFF',
  };

  function clearCanvas(ctx, canvas) { ctx.clearRect(0, 0, canvas.width, canvas.height); }

  function setupDPI(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    canvas._logicalWidth  = rect.width;
    canvas._logicalHeight = rect.height;
    return ctx;
  }

  function drawGrid(ctx, x0, y0, w, h, rows, cols) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= rows; i++) {
      const y = y0 + (h / rows) * i;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
    }
    for (let j = 0; j <= cols; j++) {
      const x = x0 + (w / cols) * j;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke();
    }
  }

  function normalise(arr) {
    const mn = Math.min(...arr), mx = Math.max(...arr);
    return arr.map(v => mx === mn ? 0.5 : (v - mn) / (mx - mn));
  }

  // ==== Animated-transition helpers (opt-in via opts.animate, see lineChart) ====
  const ANIM_SAMPLES = 48;   // fixed virtual point count so ranges with different real point
                              // counts (7D vs 1Y vs All) still morph smoothly into each other
  const ANIM_MS = 650;

  // Resample an array to exactly `n` evenly-spaced values via linear interpolation over its own
  // index range — lets us "morph" between two datasets of different lengths.
  function resample(arr, n) {
    if (!arr || !arr.length) return new Array(n).fill(0);
    if (arr.length === 1) return new Array(n).fill(arr[0]);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const pos = (i / (n - 1)) * (arr.length - 1);
      const lo = Math.floor(pos), hi = Math.min(arr.length - 1, lo + 1);
      const frac = pos - lo;
      out[i] = arr[lo] * (1 - frac) + arr[hi] * frac;
    }
    return out;
  }

  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  // A stripped-down single-frame line draw used only while a transition is in flight — grid +
  // lines, no fill/tooltip/click wiring (those only matter once the chart is at rest).
  function drawSimpleFrame(canvasEl, series, opts, minV, maxV) {
    const ctx = setupDPI(canvasEl);
    const W = canvasEl._logicalWidth, H = canvasEl._logicalHeight;
    const pad = opts.padding || { top: 20, right: 20, bottom: 32, left: 48 };
    const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;
    clearCanvas(ctx, canvasEl);
    if (!W || !H || plotW <= 0 || plotH <= 0) return;
    const range = (maxV - minV) || 1;
    function valToY(v) { return pad.top + plotH - ((v - minV) / range) * plotH; }
    function idxToX(i, total) { return pad.left + (i / Math.max(total - 1, 1)) * plotW; }
    drawGrid(ctx, pad.left, pad.top, plotW, plotH, 4, 6);
    series.forEach(s => {
      ctx.beginPath();
      ctx.strokeStyle = s.color || COLORS.primary;
      ctx.lineWidth = s.lineWidth || 2;
      ctx.lineJoin = 'round';
      if (s.dashed) ctx.setLineDash([5, 3]); else ctx.setLineDash([]);
      s.data.forEach((v, i) => {
        const x = idxToX(i, s.data.length), y = valToY(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // Morphs from the canvas's previously-rendered series to `active` over ANIM_MS, then calls
  // onDone() to hand off to the real (crisp, fully-wired) static render. Each sample point drifts
  // through a decaying sine ripple on top of its straight-line interpolation — phase-offset per
  // series so multiple lines visibly twist around each other in transit, like strands settling
  // into a double helix, fading to nothing by the final frame.
  function animateTransition(canvasEl, active, opts, minV, maxV, onDone) {
    const prevSeries = canvasEl._lastSeries || [];
    const prevById = {};
    prevSeries.forEach(p => { if (p.id) prevById[p.id] = p.data; });

    const ranges = active.map(ds => {
      const mn = Math.min(...ds.data), mx = Math.max(...ds.data);
      return (mx - mn) || Math.max(Math.abs(mx), 1);
    });
    const oldSamples = active.map((ds, i) => {
      const oldArr = (ds.id && prevById[ds.id]) || (prevSeries[i] && prevSeries[i].data) || ds.data;
      return resample(oldArr, ANIM_SAMPLES);
    });
    const newSamples = active.map(ds => resample(ds.data, ANIM_SAMPLES));

    if (canvasEl._animRAF) cancelAnimationFrame(canvasEl._animRAF);
    const start = performance.now();

    function frame(now) {
      const t = Math.min(1, (now - start) / ANIM_MS);
      const eased = easeInOutCubic(t);
      const waveEnvelope = 1 - t; // ripple decays to 0 as the transition finishes
      const frameSeries = active.map((ds, si) => {
        const phase = si * 1.15;
        const oldA = oldSamples[si], newA = newSamples[si];
        const amp = ranges[si] * 0.02;
        const pts = new Array(ANIM_SAMPLES);
        for (let i = 0; i < ANIM_SAMPLES; i++) {
          const base = oldA[i] * (1 - eased) + newA[i] * eased;
          const ripple = Math.sin(i * 0.55 + t * Math.PI * 3 + phase) * waveEnvelope * amp;
          pts[i] = base + ripple;
        }
        return { color: ds.color, lineWidth: ds.lineWidth, dashed: ds.dashed, data: pts };
      });
      drawSimpleFrame(canvasEl, frameSeries, opts, minV, maxV);
      if (t < 1) {
        canvasEl._animRAF = requestAnimationFrame(frame);
      } else {
        canvasEl._animRAF = null;
        onDone();
      }
    }
    canvasEl._animRAF = requestAnimationFrame(frame);
  }

  // ==== MAIN LINE CHART WITH TOOLTIP ====
  // opts.animate: true morphs from the previous render on this canvas instead of snapping
  // straight to the new data (see animateTransition above) — opt-in, every existing caller that
  // doesn't pass it renders exactly as before, synchronously, with no behavior change.
  // opts.onPointClick(index, label, values): if provided, clicking the chart calls it with the
  // nearest point's index/label/per-series values (same hit-testing as the hover tooltip).
  function lineChart(canvasEl, datasets, opts = {}) {
    const active = datasets.filter(ds => ds.data && ds.data.length);

    function renderFinal(minVOverride, maxVOverride) {
      const ctx = setupDPI(canvasEl);
      const W = canvasEl._logicalWidth;
      const H = canvasEl._logicalHeight;
      const pad = opts.padding || { top: 20, right: 20, bottom: 32, left: 48 };
      const plotW = W - pad.left - pad.right;
      const plotH = H - pad.top  - pad.bottom;

      clearCanvas(ctx, canvasEl);

      if (!active.length) return;
      if (!W || !H || plotW <= 0 || plotH <= 0) return;

      let allVals = [];
      active.forEach(ds => allVals.push(...ds.data));
      const yDec = opts.yDecimals != null
        ? opts.yDecimals
        : (Math.max(...allVals) < 0.01 ? 4 : Math.max(...allVals) < 1 ? 3 : 1);

      let minV = minVOverride !== undefined ? minVOverride : opts.minY;
      let maxV = maxVOverride !== undefined ? maxVOverride : opts.maxY;
      if (minV === undefined || maxV === undefined) {
        const rawMin = Math.min(...allVals);
        const rawMax = Math.max(...allVals);
        const span = rawMax - rawMin || Math.max(rawMax * 0.1, 0.0001);
        const margin = span * 0.08;
        if (minV === undefined) minV = Math.max(0, rawMin - margin);
        if (maxV === undefined) maxV = rawMax + margin;
      }
      const range = maxV - minV || 1;

      function valToY(v) { return pad.top + plotH - ((v - minV) / range) * plotH; }
      function idxToX(i, total) { return pad.left + (i / Math.max(total - 1, 1)) * plotW; }

      drawGrid(ctx, pad.left, pad.top, plotW, plotH, 4, 6);

      ctx.font = '10px DM Mono, monospace';
      ctx.fillStyle = '#8FA896';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const v = minV + (range / 4) * i;
        ctx.fillText(v.toFixed(yDec), pad.left - 6, valToY(v) + 3);
      }

      if (opts.labels) {
        ctx.textAlign = 'center';
        const step = Math.ceil(opts.labels.length / 7);
        opts.labels.forEach((lb, i) => {
          if (i % step === 0) ctx.fillText(lb, idxToX(i, opts.labels.length), H - 6);
        });
      }

      active.forEach(ds => {
        const data = ds.data;
        const color = ds.color || COLORS.primary;

        if (ds.fill) {
          ctx.beginPath();
          data.forEach((v, i) => {
            const x = idxToX(i, data.length), y = valToY(v);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.lineTo(idxToX(data.length - 1, data.length), pad.top + plotH);
          ctx.lineTo(idxToX(0, data.length), pad.top + plotH);
          ctx.closePath();
          const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
          grad.addColorStop(0, color + '30');
          grad.addColorStop(1, color + '00');
          ctx.fillStyle = grad;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = ds.lineWidth || 2;
        ctx.lineJoin = 'round';
        if (ds.dashed) ctx.setLineDash([5, 3]); else ctx.setLineDash([]);
        data.forEach((v, i) => {
          const x = idxToX(i, data.length), y = valToY(v);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });

      // ==========================================
      // TOOLTIP POP-UP LOGIC
      // ==========================================
      let tooltip = document.getElementById('agri-tooltip');
      if (!tooltip) {
          tooltip = document.createElement('div');
          tooltip.id = 'agri-tooltip';
          tooltip.style.position = 'absolute';
          tooltip.style.background = 'rgba(13, 31, 20, 0.95)';
          tooltip.style.color = '#fff';
          tooltip.style.padding = '12px';
          tooltip.style.borderRadius = '8px';
          tooltip.style.pointerEvents = 'none';
          tooltip.style.display = 'none';
          tooltip.style.zIndex = '1000';
          tooltip.style.fontSize = '12px';
          tooltip.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
          tooltip.style.border = '1px solid rgba(76,175,110,0.3)';
          document.body.appendChild(tooltip);
      }

      // A dataset can opt out of the hover tooltip (ds.tooltip === false) while still drawing its
      // line — for flat reference bands (a floor/ceiling) that would otherwise clutter every
      // tooltip with a value that never changes. Existing callers that don't set this are unaffected.
      const tooltipDatasets = active.filter(ds => ds.tooltip !== false);
      // A dataset list can carry richer per-point tooltip titles (e.g. a full date range) separate
      // from the short axis labels; falls back to opts.labels when not provided.
      const tooltipLabels = opts.tooltipLabels || opts.labels;

      const totalPoints = opts.labels ? opts.labels.length : active[0].data.length;
      let hoverData = [];
      for(let i=0; i<totalPoints; i++) {
          let pointValues = [];
          tooltipDatasets.forEach(ds => {
              if(ds.data[i] !== undefined) {
                  pointValues.push({ label: ds.label || 'Value', val: ds.data[i], color: ds.color });
              }
          });
          hoverData.push({ x: idxToX(i, totalPoints), label: tooltipLabels ? tooltipLabels[i] : i, values: pointValues });
      }

      canvasEl.onmousemove = function(e) {
          if (hoverData.length === 0) return;
          const rect = canvasEl.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;

          let closest = hoverData[0];
          let minDist = Infinity;
          hoverData.forEach(pt => {
              const dist = Math.abs(pt.x - mouseX);
              if (dist < minDist) { minDist = dist; closest = pt; }
          });

          if (minDist > 30) {
              tooltip.style.display = 'none';
              return;
          }

          let html = `<div style="font-weight:bold; margin-bottom:8px; color:#A78BFA; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px;">${closest.label}</div>`;
          closest.values.forEach(v => {
             html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:4px;">
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="width:8px; height:8px; border-radius:50%; background:${v.color}"></span>
                  <span style="color:#C5D9CA">${v.label}</span>
                </div>
                <span style="font-family:monospace; font-weight:bold;">${v.val.toFixed(2)}</span>
             </div>`;
          });

          tooltip.innerHTML = html;
          tooltip.style.display = 'block';
          const tooltipWidth = tooltip.offsetWidth || 180;
          const tooltipX = (e.clientX + tooltipWidth + 50 > window.innerWidth)
            ? e.pageX - tooltipWidth - 15
            : e.pageX + 15;

          tooltip.style.left = tooltipX + 'px';
          tooltip.style.top  = (e.pageY - 20) + 'px';
              };

      canvasEl.onmouseleave = function() {
          tooltip.style.display = 'none';
      };

      canvasEl.onclick = function(e) {
          if (typeof opts.onPointClick !== 'function' || hoverData.length === 0) return;
          const rect = canvasEl.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          let closestIdx = 0, minDist = Infinity;
          hoverData.forEach((pt, i) => {
              const dist = Math.abs(pt.x - mouseX);
              if (dist < minDist) { minDist = dist; closestIdx = i; }
          });
          if (minDist > 30) return;
          opts.onPointClick(closestIdx, hoverData[closestIdx].label, hoverData[closestIdx].values);
      };
    }

    if (opts.animate && canvasEl._lastSeries && canvasEl._lastSeries.length && active.length) {
      let allVals = [];
      active.forEach(ds => allVals.push(...ds.data));
      canvasEl._lastSeries.forEach(p => allVals.push(...(p.data || [])));
      let minV = opts.minY, maxV = opts.maxY;
      if (minV === undefined || maxV === undefined) {
        const rawMin = Math.min(...allVals), rawMax = Math.max(...allVals);
        const span = rawMax - rawMin || Math.max(rawMax * 0.1, 0.0001);
        const margin = span * 0.08;
        if (minV === undefined) minV = Math.max(0, rawMin - margin);
        if (maxV === undefined) maxV = rawMax + margin;
      }
      animateTransition(canvasEl, active, opts, minV, maxV, () => renderFinal(minV, maxV));
    } else {
      renderFinal();
    }

    canvasEl._lastSeries = active.map(ds => ({ id: ds.id, data: ds.data.slice() }));
  }

  // ==== OTHER CHART TYPES ====
  function sparkline(canvasEl, data, color = COLORS.primary, filled = true) {
    const ctx = setupDPI(canvasEl);
    const W = canvasEl._logicalWidth, H = canvasEl._logicalHeight;
    clearCanvas(ctx, canvasEl);
    const norm = normalise(data);
    const pts  = norm.map((v, i) => ({ x: (i / Math.max(data.length - 1, 1)) * W, y: H - v * H * 0.85 - H * 0.075 }));
    if (filled) {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, color + '40'); grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad; ctx.fill();
    }
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }

  // opts.tooltipLabels: richer per-bar title shown on hover (falls back to `labels`).
  // opts.valueLabel(v): formats the value line in the hover tooltip (falls back to the raw number).
  function barChart(canvasEl, labels, values, colors, opts = {}) {
    const ctx = setupDPI(canvasEl);
    const W = canvasEl._logicalWidth, H = canvasEl._logicalHeight;
    const pad = { top: 16, right: 16, bottom: 40, left: 48 };
    const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;
    clearCanvas(ctx, canvasEl);

    if (!values || !values.length) {
      canvasEl.onmousemove = null;
      canvasEl.onmouseleave = null;
      return;
    }

    const maxV = Math.max(...values) * 1.1 || 1;
    const barW = (plotW / values.length) * 0.6, gap = (plotW / values.length) * 0.4;
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
    }
    ctx.font = '10px DM Mono, monospace'; ctx.fillStyle = '#8FA896'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = maxV - (maxV / 4) * i;
      ctx.fillText(v.toFixed(2), pad.left - 6, pad.top + (plotH / 4) * i + 3);
    }

    // Hit-boxes for the hover tooltip below — full bar-slot width/height (not just the drawn bar
    // pixels) so hovering the empty space above a short bar still shows its tooltip.
    const hitBoxes = [];
    values.forEach((v, i) => {
      const slotX = pad.left + i * (barW + gap);
      const x = slotX + gap / 2, bH = (v / maxV) * plotH, y = pad.top + plotH - bH;
      const col = Array.isArray(colors) ? colors[i % colors.length] : (colors || COLORS.primary);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, barW, bH, 4) : ctx.rect(x, y, barW, bH);
      ctx.fillStyle = col; ctx.fill();
      ctx.fillStyle = '#8FA896'; ctx.textAlign = 'center'; ctx.font = '10px DM Sans, sans-serif';
      ctx.fillText(labels[i], x + barW / 2, H - 8);
      hitBoxes.push({
        x0: slotX, x1: slotX + barW + gap, y0: pad.top, y1: pad.top + plotH,
        value: v, color: col,
        title: (opts.tooltipLabels && opts.tooltipLabels[i]) || labels[i],
      });
    });

    // ==== Hover tooltip — reuses the same #agri-tooltip element lineChart() shares ====
    let tooltip = document.getElementById('agri-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'agri-tooltip';
      tooltip.style.position = 'absolute';
      tooltip.style.background = 'rgba(13, 31, 20, 0.95)';
      tooltip.style.color = '#fff';
      tooltip.style.padding = '10px 12px';
      tooltip.style.borderRadius = '8px';
      tooltip.style.pointerEvents = 'none';
      tooltip.style.display = 'none';
      tooltip.style.zIndex = '1000';
      tooltip.style.fontSize = '12px';
      tooltip.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
      tooltip.style.border = '1px solid rgba(76,175,110,0.3)';
      document.body.appendChild(tooltip);
    }

    canvasEl.onmousemove = function (e) {
      const rect = canvasEl.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const hit = hitBoxes.find(b => mouseX >= b.x0 && mouseX <= b.x1 && mouseY >= b.y0 && mouseY <= b.y1);
      if (!hit) { tooltip.style.display = 'none'; return; }

      const valueText = typeof opts.valueLabel === 'function' ? opts.valueLabel(hit.value) : String(hit.value);
      tooltip.innerHTML = `<div style="font-weight:bold; margin-bottom:6px; color:#A78BFA;">${hit.title}</div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="width:8px; height:8px; border-radius:50%; background:${hit.color}"></span>
          <span style="font-family:monospace; font-weight:bold;">${valueText}</span>
        </div>`;
      tooltip.style.display = 'block';
      const tooltipWidth = tooltip.offsetWidth || 160;
      const tooltipX = (e.clientX + tooltipWidth + 30 > window.innerWidth)
        ? e.pageX - tooltipWidth - 15
        : e.pageX + 15;
      tooltip.style.left = tooltipX + 'px';
      tooltip.style.top = (e.pageY - 20) + 'px';
    };
    canvasEl.onmouseleave = function () { tooltip.style.display = 'none'; };
    canvasEl.style.cursor = 'pointer';
  }

  function correlationHeatmap(canvasEl, matrix, labels) {
    const ctx = setupDPI(canvasEl);
    const W = canvasEl._logicalWidth, H = canvasEl._logicalHeight;
    clearCanvas(ctx, canvasEl);
    const n = labels.length, pad = 60, cell = Math.min((W - pad) / n, (H - pad) / n);
    function valColor(v) {
      const t = (v + 1) / 2;
      return t >= 0.5 ? `rgba(76, 175, 110, ${0.2 + (t - 0.5) * 2 * 0.75})` : `rgba(239, 68, 68, ${0.2 + (0.5 - t) * 2 * 0.75})`;
    }
    ctx.font = '9px DM Sans, sans-serif'; ctx.fillStyle = '#8FA896'; ctx.textAlign = 'center';
    labels.forEach((lb, j) => ctx.fillText(lb.slice(0, 6), pad + j * cell + cell / 2, pad - 6));
    ctx.textAlign = 'right';
    labels.forEach((lb, i) => ctx.fillText(lb.slice(0, 9), pad - 6, pad + i * cell + cell / 2 + 3));
    matrix.forEach((row, i) => {
      row.forEach((val, j) => {
        const x = pad + j * cell, y = pad + i * cell;
        ctx.fillStyle = valColor(val); ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x + 2, y + 2, cell - 4, cell - 4, 4) : ctx.rect(x + 2, y + 2, cell - 4, cell - 4);
        ctx.fill();
        ctx.fillStyle = Math.abs(val) > 0.5 ? 'white' : '#1C2B1E'; ctx.textAlign = 'center'; ctx.font = '9px DM Mono, monospace';
        ctx.fillText(val.toFixed(2), x + cell / 2, y + cell / 2 + 3);
      });
    });
  }

  function lossCurve(canvasEl, trainLoss, valLoss) {
    const train = trainLoss || [];
    const val   = valLoss || [];
    if (!train.length && !val.length) {
      lineChart(canvasEl, []);
      return;
    }
    const n = Math.max(train.length, val.length);
    const labels = Array.from({ length: n }, (_, i) => String(i + 1));
    const series = [];
    if (train.length) {
      series.push({ data: train, color: COLORS.primary, fill: true, lineWidth: 2, label: 'Train Loss' });
    }
    if (val.length) {
      series.push({ data: val, color: COLORS.secondary, fill: false, lineWidth: 2, dashed: true, label: 'Val Loss' });
    }
    lineChart(canvasEl, series, { labels });
  }

  return { lineChart, sparkline, barChart, correlationHeatmap, lossCurve, COLORS };
})();
