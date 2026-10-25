(() => {
  'use strict';

  const STORAGE_KEY = 'redukcja_pro_state_v1';

  // Helper: format date YYYY-MM-DD
  function toIsoDate(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Helper: get first Saturday on or after given YYYY-MM-DD
  function getFirstSaturday(isoDateStr) {
    const parts = (isoDateStr || toIsoDate(new Date())).split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    const dayOfWeek = d.getDay(); // 0 = Sun, 6 = Sat
    const diffToSat = (6 - dayOfWeek + 7) % 7;
    // If start date is already Saturday, first weigh-in milestone is next Saturday (7 days) so Week 1 is a full week,
    // or if start is Mon-Fri, first Saturday is the upcoming Saturday.
    const daysToAdd = diffToSat === 0 ? 7 : diffToSat;
    d.setDate(d.getDate() + daysToAdd);
    return d;
  }

  function addWeeks(dateObj, weeks) {
    const d = new Date(dateObj.getTime());
    d.setDate(d.getDate() + weeks * 7);
    return d;
  }

  function formatPlDate(isoDateStr) {
    if (!isoDateStr) return '';
    const [y, m, d] = isoDateStr.split('-');
    return `${d}.${m}.${y}`;
  }

  // Default initial state (with a realistic 4-week history including a Saturday slippage in Week 3)
  function createDefaultState(withSampleCheckins = true) {
    const today = new Date();
    // Set start date 3.5 weeks ago so user immediately sees past Saturdays + upcoming Saturdays
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 25, 12, 0, 0);
    const startDateIso = toIsoDate(start);

    const basePlan = {
      age: 34,
      startDate: startDateIso,
      startWeight: 92.0,
      startBf: 24.0,
      targetBf: 15.0,
      durationWeeks: 12,
      correctionMode: 'recalculate_rate', // 'recalculate_rate' | 'extend_time'
      tolerance: 0.15
    };

    const checkins = withSampleCheckins
      ? {
          1: { weight: 91.1, bf: 23.2, note: 'Pierwsza sobota w punkt, pełna dyscyplina', updatedAt: new Date().toISOString() },
          2: { weight: 90.2, bf: 22.5, note: 'Zgodnie z planem, 4 treningi siłowe', updatedAt: new Date().toISOString() },
          3: { weight: 90.0, bf: 22.3, note: 'Wyjazd weekendowy – obsunięcie o +0.65 kg względem planu', updatedAt: new Date().toISOString() }
        }
      : {};

    return {
      plan: basePlan,
      checkins,
      chartMode: 'weight' // 'weight' | 'bf'
    };
  }

  let state = loadState();
  let deferredInstallPrompt = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const initial = createDefaultState(true);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
        return initial;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.plan) return createDefaultState(true);
      return {
        plan: {
          age: Number(parsed.plan.age) || 34,
          startDate: parsed.plan.startDate || toIsoDate(new Date()),
          startWeight: Number(parsed.plan.startWeight) || 92.0,
          startBf: Number(parsed.plan.startBf) || 24.0,
          targetBf: Number(parsed.plan.targetBf) || 15.0,
          durationWeeks: Math.max(1, parseInt(parsed.plan.durationWeeks, 10) || 12),
          correctionMode: parsed.plan.correctionMode || 'recalculate_rate',
          tolerance: parsed.plan.tolerance !== undefined ? Number(parsed.plan.tolerance) : 0.15
        },
        checkins: parsed.checkins || {},
        chartMode: parsed.chartMode || 'weight'
      };
    } catch (err) {
      console.error('Błąd odczytu localStorage:', err);
      return createDefaultState(true);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Błąd zapisu localStorage:', err);
    }
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  /**
   * Core Mathematical Engine for Body Fat Reduction & Saturday Milestone Goal Correction
   */
  function computePlanModel() {
    const p = state.plan;
    const startWeight = Math.max(30, Number(p.startWeight));
    const startBf = Math.min(75, Math.max(3, Number(p.startBf)));
    const targetBf = Math.min(startBf - 0.5, Math.max(3, Number(p.targetBf)));
    const durationWeeks = Math.max(1, parseInt(p.durationWeeks, 10));
    const tolerance = Math.max(0, Number(p.tolerance || 0.15));

    // Lean Body Mass (Beztłuszczowa masa ciała) assuming 100% LBM retention
    const lbm = startWeight * (1 - startBf / 100);
    const startFatMass = startWeight - lbm;
    const targetWeight = lbm / (1 - targetBf / 100);
    const targetFatMass = targetWeight - lbm;
    const totalWeightToLose = Math.max(0, startWeight - targetWeight);
    const plannedWeeklyLoss = totalWeightToLose / durationWeeks;

    // Estimate BF% for any given weight assuming constant LBM
    const estimateBfFromWeight = (w) => {
      if (w <= lbm) return 3.0;
      return ((w - lbm) / w) * 100;
    };

    const firstSat = getFirstSaturday(p.startDate);

    // Find all recorded week indices sorted ascending
    const recordedWeeks = Object.keys(state.checkins)
      .map((k) => parseInt(k, 10))
      .filter((k) => !isNaN(k) && k >= 1 && state.checkins[k] && state.checkins[k].weight > 0)
      .sort((a, b) => a - b);

    const lastMeasuredWeek = recordedWeeks.length > 0 ? recordedWeeks[recordedWeeks.length - 1] : 0;

    // Step-by-step simulation of dynamic targets week by week so each Saturday knows:
    // 1. Base target (original plan without any slippages)
    // 2. Corrected target that was active for that week
    // 3. Actual weigh-in (if recorded) and whether milestone was achieved or slipped
    let currentAnchorWeek = 0;
    let currentAnchorWeight = startWeight;
    let activeTotalWeeks = durationWeeks;

    // Pre-calculate how many total weeks we need if extend_time mode is active
    if (p.correctionMode === 'extend_time' && lastMeasuredWeek > 0) {
      const lastActualW = Number(state.checkins[lastMeasuredWeek].weight);
      const remainingToLose = Math.max(0, lastActualW - targetWeight);
      const weeksNeededFromLast = plannedWeeklyLoss > 0.001
        ? Math.ceil((remainingToLose - 0.02) / plannedWeeklyLoss)
        : 0;
      activeTotalWeeks = Math.max(durationWeeks, lastMeasuredWeek + weeksNeededFromLast);
    }

    const totalMilestonesCount = Math.max(durationWeeks, activeTotalWeeks, lastMeasuredWeek);
    const milestones = [];

    for (let w = 1; w <= totalMilestonesCount; w++) {
      const satDate = addWeeks(firstSat, w - 1);
      const isoDate = toIsoDate(satDate);

      // Base plan target (only up to durationWeeks; after that it stays at targetWeight)
      const baseFraction = Math.min(1, w / durationWeeks);
      const baseWeight = startWeight - totalWeightToLose * baseFraction;
      const baseBf = estimateBfFromWeight(baseWeight);

      // Corrected target for week `w` based on the latest anchor before `w`
      let correctedWeight;
      if (p.correctionMode === 'recalculate_rate') {
        const remWeeksFromAnchor = Math.max(1, durationWeeks - currentAnchorWeek);
        const stepsFromAnchor = w - currentAnchorWeek;
        const rateFromAnchor = (currentAnchorWeight - targetWeight) / remWeeksFromAnchor;
        correctedWeight = Math.max(targetWeight, currentAnchorWeight - rateFromAnchor * stepsFromAnchor);
      } else {
        // extend_time: keep plannedWeeklyLoss from currentAnchorWeight
        const stepsFromAnchor = w - currentAnchorWeek;
        correctedWeight = Math.max(targetWeight, currentAnchorWeight - plannedWeeklyLoss * stepsFromAnchor);
      }
      const correctedBf = estimateBfFromWeight(correctedWeight);

      const checkin = state.checkins[w] || null;
      let actualWeight = null;
      let actualBf = null;
      let diffFromCorrected = null;
      let diffFromBase = null;
      let status = 'upcoming'; // 'achieved' | 'slipped' | 'next' | 'upcoming'

      if (checkin && checkin.weight > 0) {
        actualWeight = Number(checkin.weight);
        actualBf = checkin.bf && Number(checkin.bf) > 0
          ? Number(checkin.bf)
          : estimateBfFromWeight(actualWeight);

        diffFromCorrected = actualWeight - correctedWeight;
        diffFromBase = actualWeight - baseWeight;

        if (diffFromCorrected <= tolerance) {
          status = 'achieved';
        } else {
          status = 'slipped';
        }

        // Update anchor for subsequent weeks!
        currentAnchorWeek = w;
        currentAnchorWeight = actualWeight;
      }

      milestones.push({
        week: w,
        dateIso: isoDate,
        dateFormatted: formatPlDate(isoDate),
        isExtraWeek: w > durationWeeks,
        baseWeight,
        baseBf,
        correctedWeight,
        correctedBf,
        actualWeight,
        actualBf,
        note: checkin ? checkin.note || '' : '',
        diffFromCorrected,
        diffFromBase,
        status
      });
    }

    // Mark the first unmeasured week as 'next'
    const nextMilestone = milestones.find((m) => m.actualWeight === null) || milestones[milestones.length - 1];
    if (nextMilestone && nextMilestone.actualWeight === null) {
      nextMilestone.status = 'next';
    }

    // Calculate current metrics based on latest measurement (or start)
    const latestMeasured = lastMeasuredWeek > 0 ? milestones[lastMeasuredWeek - 1] : null;
    const currentWeight = latestMeasured ? latestMeasured.actualWeight : startWeight;
    const currentBf = latestMeasured ? latestMeasured.actualBf : startBf;
    const remainingWeightToLose = Math.max(0, currentWeight - targetWeight);
    const remainingWeeksInBasePlan = Math.max(0, durationWeeks - lastMeasuredWeek);

    const correctedWeeklyLoss = remainingWeeksInBasePlan > 0
      ? remainingWeightToLose / remainingWeeksInBasePlan
      : remainingWeightToLose;

    const activeWeeklyLoss = p.correctionMode === 'recalculate_rate'
      ? correctedWeeklyLoss
      : plannedWeeklyLoss;

    // 1 kg of body fat tissue ~= 7700 kcal; age slightly modulates BMR/safety threshold
    const ageFactor = p.age >= 50 ? 1.05 : 1.0;
    const dailyCalorieDeficit = Math.round(((activeWeeklyLoss * 7700) / 7) * ageFactor);
    const weeklyPctBodyWeight = (activeWeeklyLoss / currentWeight) * 100;

    const achievedCount = milestones.filter((m) => m.status === 'achieved').length;
    const slippedCount = milestones.filter((m) => m.status === 'slipped').length;
    const extraWeeksAdded = Math.max(0, totalMilestonesCount - durationWeeks);

    return {
      plan: p,
      lbm,
      startFatMass,
      targetWeight,
      targetFatMass,
      totalWeightToLose,
      plannedWeeklyLoss,
      currentWeight,
      currentBf,
      remainingWeightToLose,
      remainingWeeksInBasePlan,
      correctedWeeklyLoss,
      activeWeeklyLoss,
      dailyCalorieDeficit,
      weeklyPctBodyWeight,
      lastMeasuredWeek,
      latestMeasured,
      nextMilestone,
      achievedCount,
      slippedCount,
      extraWeeksAdded,
      milestones
    };
  }

  /**
   * Render Status / Goal Correction Banner
   */
  function renderCorrectionBanner(model) {
    const el = document.getElementById('correctionBanner');
    if (!el) return;

    if (!model.latestMeasured) {
      el.className = 'status-banner status-ok';
      el.innerHTML = `
        <div>
          <div class="banner-title">🚀 Plan gotowy do startu – pierwsze sobotnie ważenie: ${model.nextMilestone ? model.nextMilestone.dateFormatted : ''}</div>
          <div class="banner-desc">
            Twój cel to zejście z <strong>${model.plan.startWeight.toFixed(1)} kg (${model.plan.startBf.toFixed(1)}% BF)</strong> do
            <strong>${model.targetWeight.toFixed(1)} kg (${model.plan.targetBf.toFixed(1)}% BF)</strong> w ciągu <strong>${model.plan.durationWeeks} sobót</strong>
            (tempo: <strong>-${model.plannedWeeklyLoss.toFixed(2)} kg / tydz.</strong>).
          </div>
        </div>
      `;
      return;
    }

    const last = model.latestMeasured;
    const slipVsBase = last.diffFromBase; // positive means heavier than original plan
    const isBehindBase = slipVsBase > model.plan.tolerance;

    if (!isBehindBase) {
      el.className = 'status-banner status-ok';
      el.innerHTML = `
        <div>
          <div class="banner-title">✅ Kamienie milowe w normie (Tydzień ${last.week} – ${last.dateFormatted})</div>
          <div class="banner-desc">
            Ostatnia waga sobotnia: <strong>${last.actualWeight.toFixed(1)} kg (${last.actualBf.toFixed(1)}% BF)</strong>
            (${slipVsBase <= 0 ? slipVsBase.toFixed(2) : '+' + slipVsBase.toFixed(2)} kg względem planu bazowego).
            Wymagane tempo na kolejne soboty: <strong>-${model.activeWeeklyLoss.toFixed(2)} kg/tydz.</strong> (ok. ${model.dailyCalorieDeficit} kcal deficytu dziennie).
          </div>
        </div>
      `;
    } else {
      const isAggressive = model.weeklyPctBodyWeight > 1.05;
      el.className = `status-banner ${isAggressive ? 'status-danger' : 'status-slip'}`;
      const modeExplain = model.plan.correctionMode === 'recalculate_rate'
        ? `Aby zdążyć w pierwotnym terminie (${model.remainingWeeksInBasePlan} poz. sobót), skorygowane tempo wzrosło z <strong>-${model.plannedWeeklyLoss.toFixed(2)} kg/tydz.</strong> do <strong>-${model.correctedWeeklyLoss.toFixed(2)} kg/tydz.</strong> (${model.dailyCalorieDeficit} kcal/dzień deficytu).`
        : `Zachowano bezpieczne tempo <strong>-${model.plannedWeeklyLoss.toFixed(2)} kg/tydz.</strong>, a harmonogram został automatycznie wydłużony o <strong>+${model.extraWeeksAdded} sobotę/soboty</strong>.`;

      el.innerHTML = `
        <div>
          <div class="banner-title">
            ⚠️ Aktywna korekcja celu po sobotnim ważeniu (Tydzień ${last.week}: +${slipVsBase.toFixed(2)} kg względem planu bazowego)
          </div>
          <div class="banner-desc">
            ${modeExplain}
            ${isAggressive ? '<br/><strong>Uwaga zdrowotna:</strong> Wymagane tempo przekracza 1% masy ciała tygodniowo. Rozważ przełączenie na „Korekcję terminu (stałe tempo)”.' : ''}
          </div>
        </div>
      `;
    }
  }

  /**
   * Render KPI Grid
   */
  function renderKpis(model) {
    const grid = document.getElementById('kpiGrid');
    if (!grid) return;

    const lostSoFar = model.plan.startWeight - model.currentWeight;
    const progressPct = model.totalWeightToLose > 0
      ? Math.min(100, Math.max(0, (lostSoFar / model.totalWeightToLose) * 100))
      : 100;

    grid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Aktualna Waga i BF%</div>
        <div class="kpi-value">${model.currentWeight.toFixed(1)} kg <span style="font-size:0.95rem;color:var(--accent-cyan);">(${model.currentBf.toFixed(1)}%)</span></div>
        <div class="kpi-sub">Start: ${model.plan.startWeight.toFixed(1)} kg (${model.plan.startBf.toFixed(1)}% BF)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Cel Docelowy (Zachowane LBM)</div>
        <div class="kpi-value">${model.targetWeight.toFixed(1)} kg <span style="font-size:0.95rem;color:var(--accent-primary);">(${model.plan.targetBf.toFixed(1)}%)</span></div>
        <div class="kpi-sub">Pozostało: <strong>-${model.remainingWeightToLose.toFixed(2)} kg</strong> (${progressPct.toFixed(0)}% za Tobą)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Tygodniowy Cel (Po Korekcji)</div>
        <div class="kpi-value">-${model.activeWeeklyLoss.toFixed(2)} kg/tydz.</div>
        <div class="kpi-sub">Plan bazowy: -${model.plannedWeeklyLoss.toFixed(2)} kg/tydz. &bull; ~${model.dailyCalorieDeficit} kcal/d</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Sobotnie Kamienie Milowe</div>
        <div class="kpi-value">${model.achievedCount} ✅ / ${model.slippedCount} ⚠️</div>
        <div class="kpi-sub">Wykonano ${model.lastMeasuredWeek} z ${model.milestones.length} sobotnich ważeń</div>
      </div>
    `;
  }

  /**
   * Render Next Saturday Spotlight Card
   */
  function renderNextSaturdaySpotlight(model) {
    const card = document.getElementById('nextSaturdayCard');
    if (!card) return;

    const next = model.nextMilestone;
    if (!next) return;

    const isAllDone = next.actualWeight !== null;
    if (isAllDone) {
      card.innerHTML = `
        <div>
          <span class="spotlight-badge">🎉 Plan Zakończony</span>
          <h2>Wszystkie sobotnie kamienie milowe zostały zarejestrowane!</h2>
          <p class="text-muted" style="margin-bottom:0;">Ostatni zapisany pomiar: ${next.actualWeight.toFixed(1)} kg (${next.actualBf.toFixed(1)}% BF). Możesz zaktualizować cel w zakładce Parametry.</p>
        </div>
      `;
      return;
    }

    const diffCorrection = next.correctedWeight - next.baseWeight;
    const correctionTag = Math.abs(diffCorrection) >= 0.05
      ? `<span class="badge badge-warn">Skorygowano o ${diffCorrection > 0 ? '+' : ''}${diffCorrection.toFixed(2)} kg względem planu pierwotnego</span>`
      : `<span class="badge badge-success">Zgodnie z planem pierwotnym</span>`;

    card.innerHTML = `
      <div>
        <span class="spotlight-badge">📅 Najbliższe Sobotnie Ważenie &bull; Tydzień ${next.week}</span>
        <h2>Sobota, ${next.dateFormatted} ${correctionTag}</h2>
        <div class="spotlight-metrics">
          <div class="spotlight-metric">
            <span>Docelowa waga w sobotę (po korekcji)</span>
            <strong style="color:var(--accent-cyan);">${next.correctedWeight.toFixed(2)} kg</strong>
          </div>
          <div class="spotlight-metric">
            <span>Docelowy poziom tkanki tłuszczowej</span>
            <strong style="color:var(--accent-primary);">${next.correctedBf.toFixed(1)} %</strong>
          </div>
          <div class="spotlight-metric">
            <span>Cel z planu pierwotnego</span>
            <strong>${next.baseWeight.toFixed(2)} kg (${next.baseBf.toFixed(1)}%)</strong>
          </div>
        </div>
      </div>
      <div>
        <button type="button" class="btn btn-primary" data-open-checkin-week="${next.week}">
          ⚖️ Wpisz wynik ważenia (Tydz. ${next.week})
        </button>
      </div>
    `;

    const btn = card.querySelector('[data-open-checkin-week]');
    if (btn) {
      btn.addEventListener('click', () => {
        openCheckinForWeek(next.week);
      });
    }
  }

  /**
   * Render Canvas Progress Chart (Base Plan, Corrected Trajectory, Actual Measurements)
   */
  function renderChart(model) {
    const canvas = document.getElementById('progressChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, rect.width || 760);
    const height = Math.max(240, rect.height || 290);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const isWeight = state.chartMode !== 'bf';
    const unit = isWeight ? 'kg' : '%';

    // Build points array including Week 0 (Start)
    const points = [
      {
        week: 0,
        label: 'Start',
        base: isWeight ? model.plan.startWeight : model.plan.startBf,
        corrected: isWeight ? model.plan.startWeight : model.plan.startBf,
        actual: isWeight ? model.plan.startWeight : model.plan.startBf,
        status: 'achieved'
      },
      ...model.milestones.map((m) => ({
        week: m.week,
        label: `T${m.week}`,
        base: isWeight ? m.baseWeight : m.baseBf,
        corrected: isWeight ? m.correctedWeight : m.correctedBf,
        actual: m.actualWeight !== null ? (isWeight ? m.actualWeight : m.actualBf) : null,
        status: m.status
      }))
    ];

    const allValues = [];
    points.forEach((pt) => {
      allValues.push(pt.base, pt.corrected);
      if (pt.actual !== null) allValues.push(pt.actual);
    });

    const minVal = Math.min(...allValues) - (isWeight ? 1.2 : 1.0);
    const maxVal = Math.max(...allValues) + (isWeight ? 1.2 : 1.0);

    const padLeft = 52;
    const padRight = 22;
    const padTop = 22;
    const padBottom = 34;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const getX = (idx) => padLeft + (idx / Math.max(1, points.length - 1)) * plotW;
    const getY = (val) => padTop + ((maxVal - val) / Math.max(0.1, maxVal - minVal)) * plotH;

    // Horizontal grid lines
    const gridSteps = 5;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';

    for (let i = 0; i <= gridSteps; i++) {
      const val = maxVal - (i / gridSteps) * (maxVal - minVal);
      const y = getY(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      ctx.fillText(`${val.toFixed(1)}${unit}`, padLeft - 8, y + 4);
    }

    // X-axis week labels
    ctx.textAlign = 'center';
    const stepX = points.length > 16 ? 2 : 1;
    points.forEach((pt, idx) => {
      if (idx % stepX === 0 || idx === points.length - 1) {
        const x = getX(idx);
        ctx.fillText(pt.label, x, height - 10);
      }
    });

    // 1. Base plan line (dashed grey)
    ctx.save();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = getX(idx);
      const y = getY(pt.base);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    // 2. Corrected plan line (cyan)
    ctx.save();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = getX(idx);
      const y = getY(pt.corrected);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    // 3. Actual measurements line (emerald)
    const measuredPoints = points
      .map((pt, idx) => ({ ...pt, idx }))
      .filter((pt) => pt.actual !== null);

    if (measuredPoints.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 3;
      ctx.beginPath();
      measuredPoints.forEach((pt, i) => {
        const x = getX(pt.idx);
        const y = getY(pt.actual);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }

    // Draw Corrected target nodes
    points.forEach((pt, idx) => {
      if (pt.actual === null) {
        const x = getX(idx);
        const y = getY(pt.corrected);
        ctx.fillStyle = '#06b6d4';
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Draw Actual measurement dots (Green for achieved, Amber for slipped)
    measuredPoints.forEach((pt) => {
      const x = getX(pt.idx);
      const y = getY(pt.actual);
      ctx.fillStyle = pt.status === 'slipped' ? '#f59e0b' : '#10b981';
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0b1120';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  /**
   * Render Milestones Schedule Table
   */
  function renderMilestonesTable(model) {
    const tbody = document.getElementById('milestonesTableBody');
    const quickSelect = document.getElementById('quickCorrectionMode');
    if (quickSelect) {
      quickSelect.value = model.plan.correctionMode;
    }
    if (!tbody) return;

    tbody.innerHTML = model.milestones
      .map((m) => {
        let statusBadge = '';
        if (m.status === 'achieved') {
          statusBadge = `<span class="badge badge-success">✅ Osiągnięty</span>`;
        } else if (m.status === 'slipped') {
          statusBadge = `<span class="badge badge-warn">⚠️ Obsunięcie (Korekcja)</span>`;
        } else if (m.status === 'next') {
          statusBadge = `<span class="badge badge-next">⏳ Najbliższa sobota</span>`;
        } else {
          statusBadge = `<span class="badge badge-pending">Zaplanowano</span>`;
        }

        const actualCell = m.actualWeight !== null
          ? `<strong>${m.actualWeight.toFixed(2)} kg</strong> <span style="color:var(--text-muted);">(${m.actualBf.toFixed(1)}%)</span>`
          : `<span style="color:var(--text-muted);">—</span>`;

        let diffCell = `<span style="color:var(--text-muted);">—</span>`;
        if (m.diffFromCorrected !== null) {
          const sign = m.diffFromCorrected > 0 ? '+' : '';
          const color = m.status === 'slipped' ? '#fbbf24' : '#34d399';
          diffCell = `<strong style="color:${color};">${sign}${m.diffFromCorrected.toFixed(2)} kg</strong>`;
        }

        const rowClass = m.status === 'next' ? 'row-next' : m.isExtraWeek ? 'row-extra' : '';
        const weekLabel = m.isExtraWeek ? `${m.week} <small style="color:#fbbf24;">(+Korekcja)</small>` : `${m.week}`;

        return `
          <tr class="${rowClass}">
            <td><strong>Tydz. ${weekLabel}</strong></td>
            <td>Sob, ${m.dateFormatted}</td>
            <td>${m.baseWeight.toFixed(2)} kg <small style="color:var(--text-muted);">(${m.baseBf.toFixed(1)}%)</small></td>
            <td><strong style="color:var(--accent-cyan);">${m.correctedWeight.toFixed(2)} kg</strong> <small>(${m.correctedBf.toFixed(1)}%)</small></td>
            <td>${actualCell}</td>
            <td>${diffCell}</td>
            <td>${statusBadge}</td>
            <td>
              <button type="button" class="btn btn-outline btn-xs" data-table-week="${m.week}">
                ${m.actualWeight !== null ? 'Edytuj' : 'Wpisz'}
              </button>
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('[data-table-week]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = parseInt(btn.getAttribute('data-table-week'), 10);
        openCheckinForWeek(w);
      });
    });
  }

  /**
   * Populate Saturday Check-in Form & History List
   */
  function renderCheckinTab(model, selectedWeekOverride) {
    const select = document.getElementById('checkinWeekSelect');
    const historyList = document.getElementById('checkinsHistoryList');
    if (!select) return;

    const currentSelected = selectedWeekOverride || parseInt(select.value, 10) || (model.nextMilestone ? model.nextMilestone.week : 1);

    select.innerHTML = model.milestones
      .map((m) => {
        const tag = m.actualWeight !== null
          ? `✅ Zapisano: ${m.actualWeight.toFixed(1)} kg`
          : m.status === 'next'
          ? '⏳ Najbliższe ważenie'
          : 'Nadchodząca sobota';
        return `<option value="${m.week}" ${m.week === currentSelected ? 'selected' : ''}>Tydzień ${m.week} – Sobota ${m.dateFormatted} (${tag})</option>`;
      })
      .join('');

    updateCheckinFormFields(model, currentSelected);

    // History list
    const measured = model.milestones.filter((m) => m.actualWeight !== null).reverse();
    if (historyList) {
      if (measured.length === 0) {
        historyList.innerHTML = `<p class="text-muted">Brak zapisanych sobotnich ważeń. Wprowadź pierwszy pomiar w formularzu obok.</p>`;
      } else {
        historyList.innerHTML = measured
          .map((m) => {
            const diffSign = m.diffFromCorrected > 0 ? '+' : '';
            const badgeClass = m.status === 'slipped' ? 'badge-warn' : 'badge-success';
            const badgeText = m.status === 'slipped'
              ? `Obsunięcie ${diffSign}${m.diffFromCorrected.toFixed(2)} kg`
              : `Cel osiągnięty (${diffSign}${m.diffFromCorrected.toFixed(2)} kg)`;

            return `
              <div class="history-item">
                <div>
                  <div><strong>Tydzień ${m.week} (${m.dateFormatted})</strong> &bull; <span class="badge ${badgeClass}">${badgeText}</span></div>
                  <div style="font-size:0.86rem;color:var(--text-secondary);margin-top:3px;">
                    Zmierzono: <strong>${m.actualWeight.toFixed(2)} kg</strong> (${m.actualBf.toFixed(1)}% BF) |
                    Cel obowiązywał: ${m.correctedWeight.toFixed(2)} kg
                  </div>
                  ${m.note ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">💬 „${m.note}”</div>` : ''}
                </div>
                <button type="button" class="btn btn-outline btn-xs" data-edit-history-week="${m.week}">Edytuj</button>
              </div>
            `;
          })
          .join('');

        historyList.querySelectorAll('[data-edit-history-week]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const w = parseInt(btn.getAttribute('data-edit-history-week'), 10);
            renderCheckinTab(model, w);
          });
        });
      }
    }
  }

  function updateCheckinFormFields(model, weekNum) {
    const m = model.milestones.find((item) => item.week === weekNum) || model.milestones[0];
    if (!m) return;

    const preview = document.getElementById('checkinTargetPreview');
    const weightInput = document.getElementById('checkinWeight');
    const bfInput = document.getElementById('checkinBf');
    const noteInput = document.getElementById('checkinNote');
    const deleteBtn = document.getElementById('btnDeleteCheckin');

    if (preview) {
      preview.innerHTML = `
        <div><strong>Cel na Sobotę ${m.dateFormatted} (Tydzień ${m.week}):</strong></div>
        <div style="margin-top:4px;">
          🎯 Waga docelowa po korekcji: <strong style="color:var(--accent-cyan);">${m.correctedWeight.toFixed(2)} kg</strong>
          (tolerancja do ${(m.correctedWeight + model.plan.tolerance).toFixed(2)} kg) &bull;
          Docelowy BF: <strong>${m.correctedBf.toFixed(1)}%</strong>
        </div>
      `;
    }

    const existing = state.checkins[m.week];
    if (existing) {
      weightInput.value = existing.weight;
      bfInput.value = existing.bf || '';
      noteInput.value = existing.note || '';
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
      weightInput.value = m.correctedWeight.toFixed(1);
      bfInput.value = '';
      noteInput.value = '';
      if (deleteBtn) deleteBtn.style.display = 'none';
    }
  }

  /**
   * Populate Plan Configuration Tab & Body Composition Summary
   */
  function renderPlanTab(model) {
    const p = model.plan;
    document.getElementById('inputAge').value = p.age;
    document.getElementById('inputStartDate').value = p.startDate;
    document.getElementById('inputStartWeight').value = p.startWeight;
    document.getElementById('inputStartBf').value = p.startBf;
    document.getElementById('inputTargetBf').value = p.targetBf;
    document.getElementById('inputDurationWeeks').value = p.durationWeeks;
    document.getElementById('inputCorrectionMode').value = p.correctionMode;
    document.getElementById('inputTolerance').value = p.tolerance;

    const summary = document.getElementById('bodyCompositionSummary');
    if (summary) {
      summary.innerHTML = `
        <div class="comp-row">
          <span>Wiek użytkownika</span>
          <strong>${p.age} lat</strong>
        </div>
        <div class="comp-row">
          <span>Beztłuszczowa masa ciała (LBM / mięśnie + kości)</span>
          <strong style="color:var(--accent-cyan);">${model.lbm.toFixed(2)} kg</strong>
        </div>
        <div class="comp-row">
          <span>Początkowa masa tkanki tłuszczowej</span>
          <strong>${model.startFatMass.toFixed(2)} kg (${p.startBf.toFixed(1)}%)</strong>
        </div>
        <div class="comp-row">
          <span>Docelowa masa tkanki tłuszczowej</span>
          <strong style="color:var(--accent-primary);">${model.targetFatMass.toFixed(2)} kg (${p.targetBf.toFixed(1)}%)</strong>
        </div>
        <div class="comp-row">
          <span>Docelowa waga końcowa (przy zachowaniu 100% LBM)</span>
          <strong style="color:var(--accent-primary);">${model.targetWeight.toFixed(2)} kg</strong>
        </div>
        <div class="comp-row">
          <span>Całkowity tłuszcz do zredukowania</span>
          <strong>-${model.totalWeightToLose.toFixed(2)} kg</strong>
        </div>
        <div class="comp-row">
          <span>Pierwotne tempo tygodniowe</span>
          <strong>-${model.plannedWeeklyLoss.toFixed(2)} kg / tydz.</strong>
        </div>
        <div class="comp-row">
          <span>Aktualne tempo po korekcji obsunięć</span>
          <strong style="color:#fbbf24;">-${model.activeWeeklyLoss.toFixed(2)} kg / tydz. (${model.weeklyPctBodyWeight.toFixed(2)}% masy ciała)</strong>
        </div>
        <div class="comp-row">
          <span>Szacowany wymagany deficyt kaloryczny</span>
          <strong>~${model.dailyCalorieDeficit} kcal / dzień</strong>
        </div>
      `;
    }
  }

  /**
   * Render Storage Status in Data Tab
   */
  function renderDataTab(model) {
    const box = document.getElementById('storageStatusBox');
    if (!box) return;
    const count = Object.keys(state.checkins).length;
    box.innerHTML = `
      <div>✅ <strong>Status pamięci lokalnej (localStorage):</strong> Aktywna</div>
      <div style="margin-top:4px;color:var(--text-secondary);">
        Zapisanych sobotnich pomiarów: <strong>${count}</strong> &bull;
        Ostatni tydzień z pomiarem: <strong>${model.lastMeasuredWeek || 'Brak'}</strong>
      </div>
    `;
  }

  /**
   * Switch active tab
   */
  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
    if (tabName === 'dashboard') {
      const model = computePlanModel();
      renderChart(model);
    }
  }

  function openCheckinForWeek(weekNum) {
    switchTab('checkin');
    const model = computePlanModel();
    renderCheckinTab(model, weekNum);
  }

  /**
   * Full UI Render
   */
  function renderAll() {
    const model = computePlanModel();
    renderCorrectionBanner(model);
    renderKpis(model);
    renderNextSaturdaySpotlight(model);
    renderChart(model);
    renderMilestonesTable(model);
    renderCheckinTab(model);
    renderPlanTab(model);
    renderDataTab(model);
  }

  /**
   * Event Listeners initialization
   */
  function initEvents() {
    // Tabs navigation
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    // Chart metric toggle
    document.querySelectorAll('[data-chart-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartMode = btn.getAttribute('data-chart-mode');
        document.querySelectorAll('[data-chart-mode]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-chart-mode') === state.chartMode);
        });
        saveState();
        renderChart(computePlanModel());
      });
    });

    // Quick correction strategy selector on Dashboard
    const quickCorrection = document.getElementById('quickCorrectionMode');
    if (quickCorrection) {
      quickCorrection.addEventListener('change', () => {
        state.plan.correctionMode = quickCorrection.value;
        saveState();
        renderAll();
        showToast('Zmieniono strategię korekcji kamieni milowych.');
      });
    }

    // Check-in week selector change
    const checkinSelect = document.getElementById('checkinWeekSelect');
    if (checkinSelect) {
      checkinSelect.addEventListener('change', () => {
        const w = parseInt(checkinSelect.value, 10);
        updateCheckinFormFields(computePlanModel(), w);
      });
    }

    // Save Saturday Check-in Form
    const checkinForm = document.getElementById('checkinForm');
    if (checkinForm) {
      checkinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const w = parseInt(document.getElementById('checkinWeekSelect').value, 10);
        const weightVal = parseFloat(document.getElementById('checkinWeight').value);
        const bfRaw = document.getElementById('checkinBf').value;
        const bfVal = bfRaw ? parseFloat(bfRaw) : null;
        const noteVal = document.getElementById('checkinNote').value.trim();

        if (isNaN(w) || isNaN(weightVal) || weightVal <= 25) {
          showToast('Podaj prawidłową wagę w kilogramach.');
          return;
        }

        state.checkins[w] = {
          weight: weightVal,
          bf: bfVal,
          note: noteVal,
          updatedAt: new Date().toISOString()
        };

        saveState();
        renderAll();
        switchTab('dashboard');
        showToast(`Zapisano ważenie z Tygodnia ${w} i przeliczono kolejne soboty!`);
      });
    }

    // Delete Saturday Check-in
    const btnDeleteCheckin = document.getElementById('btnDeleteCheckin');
    if (btnDeleteCheckin) {
      btnDeleteCheckin.addEventListener('click', () => {
        const w = parseInt(document.getElementById('checkinWeekSelect').value, 10);
        if (state.checkins[w]) {
          delete state.checkins[w];
          saveState();
          renderAll();
          showToast(`Usunięto pomiar z Tygodnia ${w}.`);
        }
      });
    }

    // Save Plan Parameters Form
    const planForm = document.getElementById('planForm');
    if (planForm) {
      planForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const age = parseInt(document.getElementById('inputAge').value, 10);
        const startDate = document.getElementById('inputStartDate').value;
        const startWeight = parseFloat(document.getElementById('inputStartWeight').value);
        const startBf = parseFloat(document.getElementById('inputStartBf').value);
        const targetBf = parseFloat(document.getElementById('inputTargetBf').value);
        const durationWeeks = parseInt(document.getElementById('inputDurationWeeks').value, 10);
        const correctionMode = document.getElementById('inputCorrectionMode').value;
        const tolerance = parseFloat(document.getElementById('inputTolerance').value);

        if (targetBf >= startBf) {
          showToast('Docelowy % tkanki tłuszczowej musi być niższy niż aktualny!');
          return;
        }

        state.plan = {
          age: Math.max(14, age || 30),
          startDate: startDate || toIsoDate(new Date()),
          startWeight: Math.max(35, startWeight || 85),
          startBf: Math.max(4, startBf || 22),
          targetBf: Math.max(3, targetBf || 14),
          durationWeeks: Math.max(1, durationWeeks || 12),
          correctionMode: correctionMode || 'recalculate_rate',
          tolerance: isNaN(tolerance) ? 0.15 : tolerance
        };

        saveState();
        renderAll();
        switchTab('dashboard');
        showToast('Zaktualizowano parametry planu i kamienie milowe!');
      });
    }

    // Demo Data Button
    const btnDemo = document.getElementById('btnDemoData');
    if (btnDemo) {
      btnDemo.addEventListener('click', () => {
        state = createDefaultState(true);
        saveState();
        renderAll();
        switchTab('dashboard');
        showToast('Wczytano przykładowy plan z obsunięciem w 3. tygodniu.');
      });
    }

    // Export JSON
    const btnExportJson = document.getElementById('btnExportJson');
    if (btnExportJson) {
      btnExportJson.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `redukcja-pro-backup-${toIsoDate(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Pobrano kopię zapasową JSON.');
      });
    }

    // Export CSV
    const btnExportCsv = document.getElementById('btnExportCsv');
    if (btnExportCsv) {
      btnExportCsv.addEventListener('click', () => {
        const model = computePlanModel();
        const headers = ['Tydzien', 'Data_Sobota', 'Plan_Pierwotny_kg', 'Cel_Skorygowany_kg', 'Cel_Skorygowany_BF%', 'Zmierzona_Waga_kg', 'Zmierzony_BF%', 'Odchylenie_kg', 'Status', 'Notatka'];
        const rows = model.milestones.map((m) => [
          m.week,
          m.dateFormatted,
          m.baseWeight.toFixed(2),
          m.correctedWeight.toFixed(2),
          m.correctedBf.toFixed(1),
          m.actualWeight !== null ? m.actualWeight.toFixed(2) : '',
          m.actualBf !== null ? m.actualBf.toFixed(1) : '',
          m.diffFromCorrected !== null ? m.diffFromCorrected.toFixed(2) : '',
          m.status,
          `"${(m.note || '').replace(/"/g, '""')}"`
        ]);
        const csvContent = '\uFEFF' + [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `redukcja-pro-pomiary-${toIsoDate(new Date())}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Wyeksportowano tabelę pomiarów CSV.');
      });
    }

    // Import JSON
    const inputImportJson = document.getElementById('inputImportJson');
    if (inputImportJson) {
      inputImportJson.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(reader.result);
            if (!parsed || !parsed.plan) throw new Error('Nieprawidłowy format pliku');
            localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
            state = loadState();
            renderAll();
            switchTab('dashboard');
            showToast('Pomyślnie wczytano dane z kopii zapasowej!');
          } catch (err) {
            showToast('Błąd wczytywania pliku JSON.');
          }
        };
        reader.readAsText(file);
      });
    }

    // Reset all check-ins
    const btnResetAll = document.getElementById('btnResetAll');
    if (btnResetAll) {
      btnResetAll.addEventListener('click', () => {
        if (confirm('Czy na pewno chcesz wyczyścić zapisane pomiary i rozpocząć czysty plan?')) {
          state = createDefaultState(false);
          saveState();
          renderAll();
          switchTab('plan');
          showToast('Wyczyszczono pomiary. Skonfiguruj swój własny cel.');
        }
      });
    }

    // Android PWA Install handling
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
    });

    const btnInstallPwa = document.getElementById('btnInstallPwa');
    const installModal = document.getElementById('installModal');
    const closeModal = () => {
      if (installModal) installModal.hidden = true;
    };

    if (btnInstallPwa) {
      btnInstallPwa.addEventListener('click', async () => {
        if (deferredInstallPrompt) {
          deferredInstallPrompt.prompt();
          await deferredInstallPrompt.userChoice;
          deferredInstallPrompt = null;
        } else if (installModal) {
          installModal.hidden = false;
        }
      });
    }

    document.getElementById('btnCloseModal')?.addEventListener('click', closeModal);
    document.getElementById('btnModalOk')?.addEventListener('click', closeModal);

    window.addEventListener('resize', () => {
      renderChart(computePlanModel());
    });
  }

  // Register Service Worker for Android PWA offline & installation support
  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Rejestracja Service Workera nie powiodła się:', err);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    renderAll();
    registerServiceWorker();
  });
})();
