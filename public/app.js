/* ════════════════════════════════════════════════════════════════════════════
   Shape Studio — Multi-Agent Dashboard
   Tabs: Maya · Dana · Tomer · Barak · Health
   ════════════════════════════════════════════════════════════════════════════ */

/* ── State ─────────────────────────────────────────────────────────────────── */
let allLeads     = [];
let activeFilter = 'all';
let refreshTimer = null;

/* ── Server ping ────────────────────────────────────────────────────────────── */
async function pingServer() {
  try {
    await fetch('/health');
    document.querySelector('.status-dot').classList.add('live');
    document.getElementById('status-label').textContent = 'מערכת פעילה';
  } catch {
    document.querySelector('.status-dot').classList.remove('live');
    document.getElementById('status-label').textContent = 'לא מחובר';
  }
}

/* ── Tab switching ──────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    switch (btn.dataset.tab) {
      case 'maya':        loadMayaStats();       break;
      case 'barak':       loadBarakPanel(); loadArboxOverview(); break;
      case 'tomer':       loadTomerQueue(); loadTomerSegments(); break;
      case 'health':      loadHealth();          break;
      case 'sandbox':     initSandbox();         break;
      case 'whatsapp':    loadWaThreads(); connectWaSSE(); break;
      case 'automations': loadAutomations();     break;
      case 'knowledge':   loadKnowledge();       break;
    }
  });
});

/* ── Filter buttons (Barak tab) ─────────────────────────────────────────────── */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderBarakTable(allLeads);
  });
});

/* ── Seed / Reset ───────────────────────────────────────────────────────────── */
document.getElementById('btn-seed').addEventListener('click', async () => {
  const r = await fetch('/api/store/seed', { method: 'POST' });
  const { count } = await r.json();
  toast(`✅ נטענו ${count} לידי דמו`);
  loadBarakPanel();
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!confirm('למחוק את כל נתוני הלידים?')) return;
  await fetch('/api/store/reset', { method: 'POST' });
  toast('🗑️ הנתונים נמחקו');
  loadBarakPanel();
  loadMayaStats();
});

/* ══════════════════════════════════════════════════════════════════════════════
   MAYA TAB
   ══════════════════════════════════════════════════════════════════════════════ */

async function loadMayaStats() {
  try {
    const [statsRes, summaryRes] = await Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/maya/summary').then(r => r.json()),
    ]);
    renderMayaStats(statsRes.daily);
    renderExecSummary(summaryRes);
  } catch (e) { console.error('loadMayaStats', e); }
}

function renderExecSummary(data) {
  if (!data) return;
  const { funnel = {}, today = {}, members = {}, health = {} } = data;

  setTxt('ef-leads',    funnel.leads    ?? '—');
  setTxt('ef-hot',      funnel.hot      ?? '—');
  setTxt('ef-intro',    funnel.introSent ?? '—');
  setTxt('ef-redeemed', funnel.introRedeemed ?? '—');
  setTxt('ef-booked',   funnel.converted ?? '—');
  setTxt('ef-conv',     `המרה: ${funnel.convRate ?? 0}%`);

  setTxt('em-active',  members.active  ?? '—');
  setTxt('em-risk',    members.atRisk  ?? '—');
  setTxt('em-churned', members.churned ?? '—');

  setTxt('et-new',   today.newLeads   ?? '—');
  setTxt('et-in',    today.messagesIn  ?? '—');
  setTxt('et-reng',  today.reEngaged   ?? '—');
  setTxt('et-score', health.avgScore != null ? health.avgScore + '/10' : '—');
}

function renderMayaStats(d) {
  const el = document.getElementById('maya-stats');
  if (!el) return;
  const cards = [
    { cls: '',       icon: '👥', val: d.totalLeads,      label: 'סה"כ לידים' },
    { cls: 'hot',    icon: '🔥', val: d.hotLeadsTotal,   label: 'לידים חמים' },
    { cls: 'warm',   icon: '🌡️', val: d.warmLeadsTotal,  label: 'לידים פושרים' },
    { cls: '',       icon: '💬', val: d.messagesIn,       label: 'הודעות נכנסות' },
    { cls: '',       icon: '🎯', val: d.introOffersSent,  label: 'הצעות שנשלחו' },
    { cls: '',       icon: '🔁', val: d.reEngagedToday,   label: 'שומרו היום' },
    d.crisisActive > 0
      ? { cls: 'crisis', icon: '🚨', val: d.crisisActive, label: 'משבר פעיל' }
      : null,
  ].filter(Boolean);
  el.innerHTML = cards.map(c => `
    <div class="stat-card ${c.cls}">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-value">${c.val}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join('');
}

/* Maya full chat ──────────────────────────────────────────────────────────────*/
const chatEl  = document.getElementById('chat-messages');
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

async function sendMayaMsg(text) {
  text = text.trim();
  if (!text) return;
  inputEl.value = '';
  sendBtn.disabled = true;
  appendMsg(chatEl, 'user', text);
  const tid = addTyping(chatEl);
  try {
    const { reply, error } = await post('/api/maya/chat', { message: text });
    removeEl(tid);
    appendMsg(chatEl, 'maya', error ? `שגיאה: ${error}` : reply);
  } catch {
    removeEl(tid);
    appendMsg(chatEl, 'maya', 'שגיאה בחיבור לשרת');
  } finally {
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

sendBtn.addEventListener('click',  () => sendMayaMsg(inputEl.value));
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) sendMayaMsg(inputEl.value); });
document.querySelectorAll('.quick-btn').forEach(btn =>
  btn.addEventListener('click', () => sendMayaMsg(btn.dataset.prompt))
);

/* ══════════════════════════════════════════════════════════════════════════════
   DANA TAB — Content + Video Analysis
   ══════════════════════════════════════════════════════════════════════════════ */

/* Content Pack ────────────────────────────────────────────────────────────────*/
document.getElementById('btn-content-pack').addEventListener('click', async () => {
  const btn      = document.getElementById('btn-content-pack');
  const resultEl = document.getElementById('cp-result');
  const cls      = document.getElementById('cp-class').value || undefined;
  btn.disabled   = true;
  btn.textContent = 'יוצר... ✨';
  resultEl.style.display = 'none';
  try {
    const { pack, focusClass, error } = await post('/api/dana/content-pack', { focusClass: cls });
    if (error) throw new Error(error);
    resultEl.textContent = `פוקוס: ${focusClass}\n\n${pack}`;
    resultEl.style.display = 'block';
  } catch (err) { toast(`❌ ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = '✨ צרי חבילת תוכן'; }
});

/* Ad Copy ─────────────────────────────────────────────────────────────────────*/
document.getElementById('btn-ad-copy').addEventListener('click', async () => {
  const btn      = document.getElementById('btn-ad-copy');
  const resultEl = document.getElementById('ac-result');
  btn.disabled   = true;
  btn.textContent = 'יוצר... 📝';
  resultEl.style.display = 'none';
  try {
    const format    = document.getElementById('ac-format').value;
    const objective = document.getElementById('ac-obj').value;
    const { copy, error } = await post('/api/dana/ad-copy', { format, objective });
    if (error) throw new Error(error);
    resultEl.textContent = copy;
    resultEl.style.display = 'block';
  } catch (err) { toast(`❌ ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = '📝 צרי קופי'; }
});

/* Video Analysis ──────────────────────────────────────────────────────────────*/
const vaSubmit = document.getElementById('va-submit');

vaSubmit.addEventListener('click', submitVideoAnalysis);
document.getElementById('va-desc').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) submitVideoAnalysis();
});

async function submitVideoAnalysis() {
  const title  = document.getElementById('va-title').value.trim() || 'סרטון ללא כותרת';
  const desc   = document.getElementById('va-desc').value.trim();
  const format = document.getElementById('va-format').value;
  const goal   = document.getElementById('va-goal').value;
  if (!desc) { toast('⚠️ יש להכניס תיאור לפני הניתוח'); return; }

  vaSubmit.disabled    = true;
  vaSubmit.innerHTML   = `מנתח... <span class="va-spinner"></span>`;

  const emptyEl   = document.getElementById('va-empty-state');
  const contentEl = document.getElementById('va-result-content');
  emptyEl.style.display   = 'flex';
  contentEl.style.display = 'none';
  emptyEl.innerHTML = `
    <div class="va-empty-icon" style="animation:va-spin 1.2s linear infinite">⚙️</div>
    <div class="va-empty-title">מנתח...</div>
    <div class="va-empty-sub">דנה קוראת את מסגרת מוסרי ומנקדת את הפריט שלך</div>`;

  try {
    const res = await fetch('/api/dana/analyze-video', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: desc, format, goal }),
    });
    if (!res.ok) { const b = await res.json().catch(()=>({})); throw new Error(b.error || `HTTP ${res.status}`); }
    const data = await res.json();

    emptyEl.style.display = 'none';
    contentEl.innerHTML   = renderResultHTML(data);
    contentEl.style.display = 'flex';

    contentEl.querySelectorAll('.fix-copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(btn.getAttribute('data-copy')); } catch {}
        const orig = btn.textContent;
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = orig; }, 1400);
      });
    });
    contentEl.querySelector('.va-review-toggle')?.addEventListener('click', function () {
      const body = contentEl.querySelector('.va-review-body');
      const open = body.classList.toggle('open');
      this.querySelector('.toggle-arrow').textContent = open ? '▲' : '▼';
    });
    contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    emptyEl.innerHTML = `<div class="va-empty-icon">❌</div><div class="va-empty-title">שגיאה</div><div class="va-empty-sub">${esc(err.message)}</div>`;
    toast(`❌ ${err.message}`);
  } finally {
    vaSubmit.disabled = false;
    vaSubmit.innerHTML = '🔍 נתח לפי מוסרי (טקסט)';
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   VIDEO UPLOAD & FULL ANALYSIS — Dana
   ══════════════════════════════════════════════════════════════════════════════ */

(function initVideoUpload() {
  const dropZone      = document.getElementById('vup-drop-zone');
  const fileInput     = document.getElementById('vup-file-input');
  const previewWrap   = document.getElementById('vup-preview-wrap');
  const previewEl     = document.getElementById('vup-preview');
  const fileInfoEl    = document.getElementById('vup-file-info');
  const clearBtn      = document.getElementById('vup-clear');
  const contextGrid   = document.getElementById('vup-context-grid');
  const submitBtn     = document.getElementById('vup-submit');
  const progressEl    = document.getElementById('vup-progress');
  const progressNote  = document.getElementById('vup-progress-note');
  const errorEl       = document.getElementById('vup-error');
  const errorMsgEl    = document.getElementById('vup-error-msg');
  const retryBtn      = document.getElementById('vup-retry');
  const reportPanel   = document.getElementById('vup-report-panel');
  const historyPanel  = document.getElementById('vup-history-panel');
  const historyList   = document.getElementById('vup-history-list');
  const histRefresh   = document.getElementById('vup-history-refresh');
  const prevWrap      = document.getElementById('vup-prev-wrap');
  const prevSel       = document.getElementById('vup-prev');

  let currentFile     = null;
  let currentAnalysisId = null;

  // ── Allowed formats ─────────────────────────────────────────────────────────
  const ALLOWED_TYPES  = new Set(['video/mp4','video/quicktime','video/webm','video/x-msvideo','video/x-matroska']);
  const MAX_SIZE_BYTES = 150 * 1024 * 1024;  // must match multer server limit
  const MAX_SIZE_LABEL = '150 MB';

  // ── Drop-zone events ─────────────────────────────────────────────────────────
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()=> dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFileSelected(f);
  });
  dropZone.addEventListener('click',    () => fileInput.click());
  dropZone.addEventListener('keydown',  e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change',  () => { if (fileInput.files[0]) handleFileSelected(fileInput.files[0]); });

  // ── Clear ────────────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    currentFile = null;
    fileInput.value = '';
    URL.revokeObjectURL(previewEl.src);
    previewEl.src = '';
    previewWrap.style.display  = 'none';
    contextGrid.style.display  = 'none';
    dropZone.style.display     = '';
    hideError();
  });

  retryBtn.addEventListener('click', () => {
    hideError();
    if (currentFile) showContextGrid();
  });

  // ── File selected ────────────────────────────────────────────────────────────
  function handleFileSelected(file) {
    if (!ALLOWED_TYPES.has(file.type) && !file.name.match(/\.(mp4|mov|webm|avi|mkv)$/i)) {
      showError(`פורמט לא נתמך: ${file.type || file.name}. נתמכים: mp4, mov, webm, avi, mkv`);
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      // 150 MB client cap — same as multer server limit (no base64 overhead)
      showError(`הקובץ גדול מדי (${(file.size / 1024 / 1024).toFixed(0)} MB). מגבלה: ${MAX_SIZE_LABEL}`);
      return;
    }
    currentFile = file;
    hideError();

    // Video preview
    const url = URL.createObjectURL(file);
    previewEl.src = url;
    fileInfoEl.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    previewWrap.style.display = '';
    dropZone.style.display    = 'none';
    showContextGrid();
  }

  function showContextGrid() {
    contextGrid.style.display = '';
    // Auto-fill title from filename
    const titleEl = document.getElementById('vup-title');
    if (currentFile && !titleEl.value) {
      titleEl.value = currentFile.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    }
    // Load history for version comparison selector
    loadHistoryForSelector();
  }

  // ── Load history into selector ───────────────────────────────────────────────
  async function loadHistoryForSelector() {
    try {
      const { analyses = [] } = await fetch('/api/dana/video-history').then(r => r.json());
      if (analyses.length === 0) { prevWrap.style.display = 'none'; return; }
      prevSel.innerHTML = '<option value="">בלי השוואה</option>' +
        analyses.slice(0, 10).map(a =>
          `<option value="${esc(a.id)}">${esc(a.title)} — ${a.readiness ?? '?'}/100 (${new Date(a.createdAt).toLocaleDateString('he-IL')})</option>`
        ).join('');
      prevWrap.style.display = '';
    } catch {}
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  submitBtn.addEventListener('click', startAnalysis);

  // Current active job ID — survives page actions (not full reload)
  let activeJobId = null;
  let pollTimer   = null;

  async function startAnalysis() {
    if (!currentFile) return;
    hideError();
    submitBtn.disabled = true;
    stopPolling();

    contextGrid.style.display  = 'none';
    previewWrap.style.display  = 'none';
    progressEl.style.display   = '';
    reportPanel.style.display  = 'none';
    setStage('upload');
    progressNote.textContent   = 'שולח קובץ...';

    try {
      // ── Upload via multipart/form-data (no base64 overhead) ───────────────
      // Client-side cap: 150 MB (server enforces the same, multer rejects larger)
      const MAX_MB = 150;
      if (currentFile.size > MAX_MB * 1024 * 1024) {
        throw new Error(`הקובץ גדול מדי (${(currentFile.size/1024/1024).toFixed(0)} MB). מגבלה: ${MAX_MB} MB.`);
      }

      const formData = new FormData();
      formData.append('video',           currentFile);
      formData.append('title',           document.getElementById('vup-title').value.trim()   || currentFile.name);
      formData.append('goal',            document.getElementById('vup-goal').value);
      formData.append('format',          document.getElementById('vup-format').value);
      formData.append('audience',        document.getElementById('vup-audience').value.trim());
      formData.append('organic_or_paid', document.getElementById('vup-paid').value);
      formData.append('message',         document.getElementById('vup-message').value.trim());
      formData.append('focus_notes',     document.getElementById('vup-focus').value.trim());
      if (prevSel.value) formData.append('previousVersionId', prevSel.value);

      const uploadRes = await fetch('/api/dana/analyze-video-upload', {
        method: 'POST',
        body:   formData,   // Content-Type set automatically by browser
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error(err.error || `שגיאת העלאה ${uploadRes.status}`);
      }

      const { jobId } = await uploadRes.json();
      activeJobId = jobId;
      setStage('process');
      progressNote.textContent = 'הקובץ הועלה — מחלץ פריימים ושמע...';

      // ── Poll job status every 3 s ─────────────────────────────────────────
      await pollJobUntilDone(jobId);

    } catch (err) {
      stopPolling();
      progressEl.style.display = 'none';
      showError(err.message || 'שגיאה לא ידועה');
      previewWrap.style.display = '';
      contextGrid.style.display = '';
      submitBtn.disabled = false;
    }
  }

  async function pollJobUntilDone(jobId) {
    return new Promise((resolve, reject) => {
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/dana/analysis-job/${jobId}`);
          if (!res.ok) {
            clearInterval(pollTimer);
            return reject(new Error(`Poll שגיאה: ${res.status}`));
          }
          const job = await res.json();

          // Update progress UI from live job status
          const stageMap = {
            queued:   'upload',  meta:     'process', frames: 'process',
            audio:    'process', analyze:  'analyze', scoring: 'analyze',
            done:     'done',    error:    'analyze',
          };
          setStage(stageMap[job.stage] ?? 'analyze');
          progressNote.textContent = job.note || 'מעבד...';

          if (job.status === 'completed') {
            clearInterval(pollTimer);
            setStage('done');
            progressNote.textContent = `ניתוח הושלם — ציון ${job.report?.readiness ?? '—'}/100`;
            await new Promise(r => setTimeout(r, 600));

            progressEl.style.display = 'none';
            reportPanel.innerHTML    = renderFullReport(job.report);
            reportPanel.style.display = '';
            reportPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            loadHistory();
            resolve();

          } else if (job.status === 'failed') {
            clearInterval(pollTimer);
            reject(new Error(job.error || 'הניתוח נכשל'));
          }
          // else: still running — keep polling
        } catch (err) {
          clearInterval(pollTimer);
          reject(err);
        }
      }, 3000);
    });
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── Stages ───────────────────────────────────────────────────────────────────
  const STAGES = ['upload', 'process', 'analyze', 'done'];
  function setStage(active) {
    STAGES.forEach(s => {
      const el = document.getElementById('vstage-' + s);
      if (!el) return;
      el.classList.remove('active', 'done');
      const idx = STAGES.indexOf(s);
      const actIdx = STAGES.indexOf(active);
      if (idx < actIdx) el.classList.add('done');
      else if (idx === actIdx) el.classList.add('active');
    });
  }

  // ── Error helpers ─────────────────────────────────────────────────────────────
  function showError(msg) {
    errorMsgEl.textContent = '❌ ' + msg;
    errorEl.style.display  = '';
  }
  function hideError() { errorEl.style.display = 'none'; }

  // ── History ───────────────────────────────────────────────────────────────────
  if (histRefresh) histRefresh.addEventListener('click', loadHistory);

  async function loadHistory() {
    try {
      const { analyses = [] } = await fetch('/api/dana/video-history').then(r => r.json());
      if (analyses.length === 0) {
        historyPanel.style.display = 'none';
        return;
      }
      historyPanel.style.display = '';
      historyList.innerHTML = analyses.map(a => {
        const score = a.readiness ?? 0;
        const cls   = score >= 75 ? 'high' : score >= 50 ? 'mid' : 'low';
        const emo   = a.verdict?.includes('לפרסם') ? '✅' : a.verdict?.includes('לגנוז') ? '🚫' : '⚠️';
        const ver   = a.version > 1 ? ` v${a.version}` : '';
        return `<div class="vup-history-item" data-id="${esc(a.id)}">
          <div class="vup-history-verdict">${emo}</div>
          <div class="vup-history-info">
            <div class="vup-history-title">${esc(a.title)}${ver}</div>
            <div class="vup-history-meta">${new Date(a.createdAt).toLocaleString('he-IL')} · ${esc(a.format ?? '')} · ${esc(a.goal ?? '')}</div>
          </div>
          <div class="vup-history-score ${cls}">${score}</div>
        </div>`;
      }).join('');

      historyList.querySelectorAll('.vup-history-item').forEach(item => {
        item.addEventListener('click', async () => {
          try {
            const id  = item.dataset.id;
            const rpt = await fetch(`/api/dana/video-history/${id}`).then(r => r.json());
            reportPanel.innerHTML   = renderFullReport(rpt);
            reportPanel.style.display = '';
            reportPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (e) { toast('❌ לא ניתן לטעון ניתוח: ' + e.message); }
        });
      });
    } catch {}
  }

  // Load history when Dana tab is opened
  const danaTabBtn = document.querySelector('[data-tab="dana"]');
  if (danaTabBtn) {
    danaTabBtn.addEventListener('click', () => {
      loadHistory();
      loadHistoryForSelector();
    });
  }

  // Load and display a report by ID (used by stale-report "פתח דוח חדש" links)
  window.loadReportById = async function(id) {
    try {
      const rpt = await fetch(`/api/dana/video-history/${id}`).then(r => r.json());
      reportPanel.innerHTML   = renderFullReport(rpt);
      reportPanel.style.display = '';
      reportPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { alert('שגיאה בטעינת הדוח: ' + e.message); }
  };

  // ── Report renderer ───────────────────────────────────────────────────────────
  function renderVideoPlayer(id) {
    if (!id) return '';
    const src = `/api/dana/video/${encodeURIComponent(id)}`;
    return `
      <details class="vup-video-section" style="margin-bottom:16px">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--muted);padding:8px 0;user-select:none">
          🎬 צפייה בסרטון המקורי
        </summary>
        <div style="margin-top:8px">
          <video
            controls playsinline preload="metadata"
            style="width:100%;max-height:480px;border-radius:8px;background:#000"
            onerror="this.parentElement.innerHTML='<p style=&quot;font-size:12px;color:var(--muted);padding:8px&quot;>הסרטון אינו זמין בנפח הקבוע (נמחק או לא נשמר).</p>'"
          >
            <source src="${src}" type="video/mp4">
            <source src="${src}" type="video/quicktime">
          </video>
          <p style="font-size:11px;color:var(--muted);margin-top:4px">
            צפייה בסרטון המקורי שנשמר בשרת — נפרד מהדוח ואינו תנאי להצגתו.
          </p>
        </div>
      </details>`;
  }

  function renderFullReport(r) {
    const readiness  = r.readiness ?? 0;
    const verdictKey = r.verdict?.includes('לפרסם') ? 'publish' : r.verdict?.includes('לגנוז') ? 'shelve' : 'fix';
    const verdictEmoji = verdictKey === 'publish' ? '✅' : verdictKey === 'shelve' ? '🚫' : '⚠️';
    const scoreClass = readiness >= 75 ? 'high' : readiness >= 50 ? 'mid' : 'low';

    // Stale-score notice — covers two distinct bug types, shown before the report
    function staleLink(newId) {
      if (!newId) return '';
      return ` <a href="#" onclick="event.preventDefault();loadReportById('${esc(newId)}')" style="font-weight:600">פתח דוח חדש ›</a>`;
    }
    const staleNotice = r.scoreScaleInvalid
      ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">
           ⚠️ <strong>ציוני C1–C7 בדוח זה אינם תקפים</strong> — הוחזרו בסקאלה 0-100 במקום 0-5 (באג שתוקן). ציון המוכנות שגוי.
           ${staleLink(r.replacedByJobId)} <em>מומלץ לנתח מחדש.</em>
         </div>`
      : r.staleSchemaAnchored
        ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">
             ⚠️ <strong>ציוני C1–C7 בדוח זה הושפעו מהטיית-דוגמה</strong> — המודל העתיק ערכי placeholder מהתבנית (באג שתוקן ב-commit 354b17a). הציון לא משקף את הסרטון.
             ${staleLink(r.replacedByJobId)} <em>מומלץ לנתח מחדש.</em>
           </div>`
        : '';

    // Review text from output-format.md (cite_check verified)
    const citeOk  = r.cite_check?.cite_check_applicable === false
      ? '' // not applicable — no citations to check
      : (r.cite_check?.passed === false ? ' ⚠️ ציטוטים לא אומתו' : '');

    // Normalize incomplete_recommendations: may be array (new) or string (legacy reports)
    const incompleteRecs = Array.isArray(r.incomplete_recommendations)
      ? r.incomplete_recommendations
      : (r.review_incomplete && r.incomplete_recommendations ? [{ originalCode: '?', excludeReason: String(r.incomplete_recommendations) }] : []);
    const incompleteHtml = (incompleteRecs.length > 0 || r.review_incomplete)
      ? `<div style="background:#fff3e0;border:1px solid #ff9800;border-radius:6px;padding:8px 12px;margin-top:8px;font-size:12px">
           ⚠️ <strong>ביקורת חלקית</strong>${incompleteRecs.length > 0 ? ` — ${incompleteRecs.length} המלצות לא הוצגו` : ''}<br>
           ${r.review_incomplete_note ? `<em>${esc(r.review_incomplete_note)}</em><br>` : ''}
           ${incompleteRecs.map(x => `• ${esc(x.originalCode ?? '?')}: ${esc(x.excludeReason ?? '')}`).join('<br>')}
         </div>` : '';
    const reviewTextHtml = r.review_text
      ? `<details class="vup-review-text panel" style="margin-bottom:16px">
           <summary style="cursor:pointer;font-size:13px;font-weight:600;padding:8px 0;user-select:none">
             📋 ביקורת לפי מוסרי — פורמט מלא${citeOk}
           </summary>
           <pre style="white-space:pre-wrap;font-size:12px;padding:12px;background:#f8fafc;border-radius:6px;direction:rtl">${esc(r.review_text)}</pre>
           ${incompleteHtml}
         </details>`
      : '';

    const sections = [
      staleNotice,
      renderDecisionBanner(r, readiness, verdictKey, verdictEmoji, scoreClass),
      reviewTextHtml,
      renderVideoPlayer(r.id),          // ← video player, separate from report
      r.warnings?.length ? renderWarnings(r.warnings) : '',
      renderHighlights(r.report_strengths ?? r.strengths ?? [], r.report_problems ?? []),
      r.sections         ? renderSections(r.sections)        : '',
      r.timestamps?.length ? renderTimestamps(r.timestamps)  : '',
      r.mosseri_scores   ? renderMosseriScores(r.mosseri_scores, r.reasonings ?? {}) : '',
      renderImprovements(r),
      renderCreative(r),
      r.edit_plan?.length ? renderEditPlan(r.edit_plan)      : '',
      r.comparison        ? renderComparison(r.comparison)   : '',
    ].filter(Boolean).join('');

    return `<div class="vup-report-wrap panel">${sections}</div>`;
  }

  function renderDecisionBanner(r, readiness, verdictKey, verdictEmoji, scoreClass) {
    const metaStr = [
      r.format && `פורמט: ${r.format}`,
      r.goal   && `מטרה: ${r.goal}`,
      r.organic_or_paid,
      r.version > 1 ? `גרסה ${r.version}` : '',
    ].filter(Boolean).join(' · ');

    return `<div class="vup-decision">
      <div class="vup-decision-row">
        <div class="vup-verdict-badge ${verdictKey}">${verdictEmoji} ${esc(r.verdict ?? '')}</div>
        <div class="vup-score-ring ${scoreClass}">${readiness}</div>
        <div class="vup-decision-text">
          <div style="font-weight:600;font-size:15px">${esc(r.title ?? '')}</div>
          <div class="vup-perceived-msg">מה דנה מבינה: ${esc(r.perceived_message ?? '')}</div>
          ${metaStr ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">${esc(metaStr)}</div>` : ''}
        </div>
      </div>
      ${r.recommendation ? `<div style="margin-top:12px;font-size:13px;padding:8px 12px;background:#f8fafc;border-radius:8px;">💡 ${esc(r.recommendation)}</div>` : ''}
      ${r.share_direction ? `<div style="margin-top:8px;font-size:12px;color:var(--muted)">${esc(r.share_direction)}</div>` : ''}
      ${r.accuracy ? `<div style="margin-top:4px;font-size:11px;color:var(--muted)">${esc(r.accuracy)}</div>` : ''}
    </div>`;
  }

  function renderWarnings(warnings) {
    return `<div class="vup-warnings">${warnings.map(w => `⚠️ ${esc(w)}`).join('<br>')}</div>`;
  }

  function renderHighlights(strengths, problems) {
    if (!strengths.length && !problems.length) return '';
    const strHtml = strengths.length
      ? `<ul class="vup-hl-list strengths">${strengths.slice(0,3).map(s=>`<li>✅ ${esc(s)}</li>`).join('')}</ul>` : '';
    const probHtml = problems.length
      ? `<ul class="vup-hl-list problems">${problems.slice(0,3).map(p=>`<li>⚠️ ${esc(p)}</li>`).join('')}</ul>` : '';
    return `<div class="vup-highlights">
      <div class="vup-hl-block"><h4>חוזקות</h4>${strHtml}</div>
      <div class="vup-hl-block"><h4>בעיות עיקריות</h4>${probHtml}</div>
    </div>`;
  }

  const SECTION_LABELS = {
    hook: '🎣 פתיחה והוק', message: '💬 מסר ותסריט', content: '🎬 תוכן מצולם',
    editing: '✂️ עריכה', captions: '📝 כתוביות', audio: '🔊 שמע',
    visuals: '📸 צילום ונראות', cta: '🚀 סיום והנעה', platform: '📱 התאמה לאינסטגרם',
  };

  function renderSections(sections) {
    const cards = Object.entries(sections).map(([key, sec]) => {
      if (!sec) return '';
      const label = SECTION_LABELS[key] ?? key;
      const score = sec.score;
      const isUnverified = sec.unverified;
      const badgeCls = isUnverified ? '' : score >= 7 ? 'good' : score >= 5 ? 'ok' : 'bad';
      const badgeTxt = isUnverified ? 'לא נבדק' : score != null ? `${score}/10` : '—';
      return `<div class="vup-section-card">
        <div class="vup-section-card-header">
          <span class="vup-section-name">${label}</span>
          <span class="vup-section-score-badge ${badgeCls}">${badgeTxt}</span>
        </div>
        <div class="vup-section-finding">${esc(sec.finding ?? '')}</div>
      </div>`;
    }).filter(Boolean).join('');
    return `<div class="vup-sections">${cards}</div>`;
  }

  function renderTimestamps(timestamps) {
    if (!timestamps.length) return '';
    const rows = timestamps.map(t => `<tr>
      <td>${esc(t.range ?? '')}${t.approximate ? '<span class="vup-ts-approx">(משוער)</span>' : ''}</td>
      <td>${esc(t.observation ?? '')}</td>
      <td>${esc(t.works ?? '')}</td>
      <td>${esc(t.problem ?? '')}</td>
      <td>${esc(t.suggestion ?? '')}</td>
    </tr>`).join('');
    return `<div class="vup-timestamps">
      <h4>⏱️ הערות לפי זמן</h4>
      <table class="vup-ts-table">
        <thead><tr><th>זמן</th><th>מה קורה</th><th>עובד</th><th>בעיה</th><th>הצעה</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const MOSSERI_LABELS = { C1: 'הוק ×25%', C2: 'שליחות ×20%', C3: 'ערך לזר ×20%',
                           C4: 'מבנה ×15%',  C5: 'מקוריות ×10%', C6: 'קריאות ×5%', C7: 'נושא ×5%' };

  function renderMosseriScores(scores, reasonings) {
    const cards = Object.entries(scores).map(([k, v]) => {
      const pct = Math.round((v / 5) * 100);
      const reason = reasonings[k] ?? '';
      return `<div class="vup-m-score" title="${esc(reason)}">
        <span class="vup-m-code">${k}</span>
        <span style="font-size:11px;color:var(--muted);flex:1">${MOSSERI_LABELS[k] ?? k}</span>
        <div class="vup-m-bar"><div class="vup-m-fill" style="width:${pct}%"></div></div>
        <span class="vup-m-val">${v}/5</span>
      </div>`;
    }).join('');
    return `<div class="vup-mosseri"><h4>📊 ציוני מוסרי C1-C7</h4><div class="vup-mosseri-grid">${cards}</div></div>`;
  }

  function renderImprovements(r) {
    const must = r.improvements_must ?? [];
    const rec  = r.improvements_recommended ?? [];
    const exp  = r.improvements_experiments ?? [];
    if (!must.length && !rec.length && !exp.length) return '';
    return `<div class="vup-improvements">
      <h4>🔧 שיפורים מומלצים</h4>
      ${must.length ? `<div class="vup-imp-group">
        <div class="vup-imp-group-label">🔴 חובה לפני פרסום</div>
        <ul class="vup-imp-list must">${must.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>
      </div>` : ''}
      ${rec.length ? `<div class="vup-imp-group">
        <div class="vup-imp-group-label">🟡 שיפורים מומלצים</div>
        <ul class="vup-imp-list recommended">${rec.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>
      </div>` : ''}
      ${exp.length ? `<div class="vup-imp-group">
        <div class="vup-imp-group-label">🔵 ניסויים לגרסה נוספת</div>
        <ul class="vup-imp-list experiments">${exp.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>
      </div>` : ''}
    </div>`;
  }

  function renderCreative(r) {
    const hooks = r.hook_alternatives ?? [];
    const ctas  = r.cta_options       ?? [];
    if (!hooks.length && !ctas.length) return '';
    return `<div class="vup-creative">
      <div>
        <h4>🎣 אפשרויות הוק חלופיות</h4>
        <ul class="vup-alt-list">${hooks.map((h,i)=>`<li><strong>${i+1}.</strong> ${esc(h)}</li>`).join('')}</ul>
      </div>
      <div>
        <h4>🚀 אפשרויות CTA</h4>
        <ul class="vup-alt-list">${ctas.map((c,i)=>`<li><strong>${i+1}.</strong> ${esc(c)}</li>`).join('')}</ul>
      </div>
    </div>`;
  }

  function renderEditPlan(plan) {
    if (!plan.length) return '';
    const items = plan.map((step, i) => `<li>
      <div class="vup-ep-num">${i+1}</div>
      <div>
        <span>${esc(step.segment ?? '')}</span>
        ${step.duration ? `<span class="vup-ep-dur">${esc(step.duration)}</span>` : ''}
      </div>
    </li>`).join('');
    return `<div class="vup-edit-plan"><h4>🗂️ מתווה עריכה מוצע</h4><ul class="vup-ep-list">${items}</ul></div>`;
  }

  function renderComparison(c) {
    if (!c) return '';
    const delta = c.score_change ?? 0;
    const cls   = delta > 0 ? 'better' : delta < 0 ? 'worse' : 'same';
    const sign  = delta > 0 ? '+' : '';
    return `<div class="vup-comparison">
      <h4>📈 השוואה לגרסה קודמת</h4>
      <div class="vup-comp-score-change ${cls}">${sign}${delta} נקודות</div>
      <div class="vup-comp-lists">
        <div class="vup-comp-list"><h5>✅ מה השתפר</h5><ul>${(c.improved??[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="vup-comp-list"><h5>🔧 עדיין דורש עבודה</h5><ul>${(c.still_needs_work??[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="vup-comp-list"><h5>⚠️ בעיות חדשות</h5><ul>${(c.new_issues??[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
    </div>`;
  }

})(); // end initVideoUpload

/* Video result rendering ──────────────────────────────────────────────────────*/
function renderResultHTML(data) {
  const { readiness=0, verdict='', scores={}, flags=[], strengths=[], fixes=[], review='', share_direction, accuracy, reasonings={} } = data;
  const vKey = vaVerdictKey(verdict);
  return [
    renderVAHeader(readiness, verdict, vKey, share_direction, accuracy),
    renderCriteriaPanel(scores, reasonings),
    strengths.length ? renderStrengthsPanel(strengths) : '',
    fixes.length     ? renderFixesPanel(fixes)          : '',
    renderFlagsPanel(flags),
    renderMosseriQuotePanel(review),
    renderFullReviewPanel(review),
  ].filter(Boolean).join('');
}

function vaVerdictKey(v) {
  if (!v) return 'fix';
  if (v.includes('לפרסם')) return 'publish';
  if (v.includes('לגנוז')) return 'shelve';
  return 'fix';
}

function renderVAHeader(readiness, verdict, vKey, share_direction, accuracy) {
  const r = readiness ?? 0;
  const circ = 263.9;
  const offset = (circ * (1 - r / 100)).toFixed(1);
  const color = r >= 75 ? 'var(--green)' : r >= 50 ? 'var(--warm)' : 'var(--hot)';
  const label = { publish:'✅ לפרסם', fix:'⚠️ לתקן קודם', shelve:'🚫 לגנוז' }[vKey] ?? verdict;
  return `
  <div class="va-header-row">
    <div class="score-ring-wrap">
      <svg class="score-ring" viewBox="0 0 100 100">
        <circle class="ring-track" cx="50" cy="50" r="42"/>
        <circle class="ring-fill" cx="50" cy="50" r="42"
          style="stroke:${color};stroke-dasharray:${circ};stroke-dashoffset:${offset}"/>
      </svg>
      <div class="score-number" style="color:${color}">${r}</div>
    </div>
    <div class="va-verdict-block">
      <div class="va-verdict-lbl">פסק דין</div>
      <div class="va-verdict ${vKey}">${label}</div>
      ${share_direction ? `<div class="va-share">${esc(share_direction)}</div>` : ''}
      ${accuracy        ? `<div class="va-accuracy">${esc(accuracy)}</div>`      : ''}
    </div>
  </div>`;
}

function renderCriteriaPanel(scores, reasonings) {
  if (!scores) return '';
  const META = [['C1','הוק',25],['C2','שליחות',20],['C3','ערך לזר',20],['C4','מבנה',15],['C5','מקוריות',10],['C6','קריאות',5],['C7','נושא',5]];
  const rows = META.map(([k,lbl,wt]) => {
    const v = scores[k] ?? 0;
    const pct = (v/5*100).toFixed(0);
    const color = v>=4?'var(--green)':v>=3?'var(--warm)':'var(--hot)';
    const note = reasonings[k] ? `<div class="criteria-reasoning">${esc(reasonings[k])}</div>` : '';
    return `<div class="criteria-row">
      <div class="criteria-key">${k}</div>
      <div class="criteria-label">${lbl} <span class="criteria-wt">×${wt}%</span></div>
      <div class="criteria-track"><div class="criteria-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="criteria-score" style="color:${color}">${v}/5</div>
    </div>${note}`;
  }).join('');
  return `<div class="va-criteria-panel panel"><div class="panel-header"><h2>ציוני 7 הקריטריונים</h2></div><div style="padding:14px 20px 4px">${rows}</div></div>`;
}

function renderStrengthsPanel(strengths) {
  const items = strengths.map(s=>`<div class="strength-item"><span class="strength-bullet">✓</span><span>${esc(s)}</span></div>`).join('');
  return `<div class="va-strengths-panel panel"><div class="panel-header"><h2>מה עובד</h2></div><div style="padding:0 20px 12px">${items}</div></div>`;
}

function renderFixesPanel(fixes) {
  const cards = fixes.slice(0,3).map((fix,i) => {
    const cite = fix.citation ? `<div class="fix-citation">מוסרי, ${esc(fix.citation.date)}: "${esc(fix.citation.quote)}"</div>` : '';
    const rw = fix.suggestedRewrite ?? '';
    return `<div class="fix-card">
      <div class="fix-header">
        <div class="fix-num">${i+1}</div>
        <div class="fix-name">${esc(fix.name??'')}</div>
        ${fix.principleCode?`<span class="fix-principle">${esc(fix.principleCode)}</span>`:''}
      </div>
      <div class="fix-body">
        <div><div class="fix-lbl">עכשיו</div><div class="fix-text">${esc(fix.currentText??'')}</div></div>
        <div><div class="fix-lbl">במקום</div>
          <div class="fix-text rewrite">${esc(rw)}<button class="fix-copy-btn" data-copy="${esc(rw)}">העתק</button></div>
        </div>
        <div><div class="fix-lbl">למה</div><div class="fix-why">${esc(fix.explanation??'')}</div>${cite}</div>
      </div>
    </div>`;
  }).join('');
  return `<div class="va-fixes-panel panel"><div class="panel-header"><h2>${fixes.length===3?'3':fixes.length} התיקונים הכי חשובים</h2></div><div style="padding:14px 20px">${cards}</div></div>`;
}

function renderFlagsPanel(flags) {
  const HARD = new Set(['wordmark','aggregated','reupload']);
  const LABELS = { wordmark:'סימן מים (−15)', aggregated:'תוכן מצובר (−15)', reupload:'העלאה חוזרת (−20)', unpaid_promise:'הבטחה לא ממומשת (−10)', ai_slick:'AI חלק מדי (−5)' };
  const chips = (!flags||!flags.length)
    ? `<span class="flag-chip none">✅ אין דגלי סיכון</span>`
    : flags.map(f=>`<span class="flag-chip ${HARD.has(f)?'hard':'soft'}">⚠ ${LABELS[f]??f}</span>`).join('');
  return `<div class="va-flags-panel panel"><div class="panel-header"><h2>דגלי סיכון</h2></div><div style="padding:10px 20px 14px"><div class="flags-row">${chips}</div></div></div>`;
}

function renderMosseriQuotePanel(reviewText) {
  const lines = (reviewText??'').split('\n');
  const idx   = lines.findIndex(l=>l.includes('מה מוסרי היה אומר'));
  if (idx<0) return '';
  const quote = lines.slice(idx+1).filter(l=>l.trim()).join(' ').trim();
  if (!quote) return '';
  return `<div class="va-quote-panel">
    <div class="va-section-title" style="color:var(--primary);margin-bottom:10px">מה מוסרי היה אומר</div>
    <div class="va-quote-text">${esc(quote)}</div>
  </div>`;
}

function renderFullReviewPanel(reviewText) {
  if (!reviewText) return '';
  return `<div class="panel"><button class="va-review-toggle"><span>📋 ביקורת מלאה להעתקה</span><span class="toggle-arrow" style="font-size:11px">▼</span></button><pre class="va-review-body">${esc(reviewText)}</pre></div>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   TOMER TAB — Retention
   ══════════════════════════════════════════════════════════════════════════════ */

/* Tomer segment sub-nav (5 retention tabs) ────────────────────────────────────*/
let activeTomerSeg = 'onboarding';

document.querySelectorAll('[data-tseg]').forEach(btn => {
  btn.addEventListener('click', () => {
    // Deactivate only the Tomer segment buttons (not other panels' subnav-btns)
    document.querySelectorAll('[data-tseg]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTomerSeg = btn.dataset.tseg;
    document.querySelectorAll('.tseg-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById('tseg-' + activeTomerSeg);
    if (panel) panel.style.display = '';
  });
});

document.getElementById('btn-tomer-refresh').addEventListener('click', () => {
  loadTomerQueue();      // sidebar mini-stats (dormant leads, intro offers)
  loadTomerSegments();   // main 5-panel from live Arbox
});

document.getElementById('btn-tomer-checks').addEventListener('click', async () => {
  const btn    = document.getElementById('btn-tomer-checks');
  const result = document.getElementById('tomer-checks-result');
  btn.disabled = true;
  btn.textContent = 'מריץ...';
  result.style.display = 'none';
  try {
    const data = await post('/api/tomer/run-checks', {});
    result.textContent = `הושלם ✅\nרי-אנגייג'מנט: ${data.reEngaged ?? 0}\nפולו-אפ הצעות: ${data.introFollowUps ?? 0}\nדלגו: ${data.skipped ?? 0}\nשגיאות: ${data.errors ?? 0}`;
    result.style.display = 'block';
    toast('✅ הבדיקות הושלמו');
    loadTomerQueue();
  } catch (err) { toast(`❌ ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = '▶ הרץ בדיקות יומיות'; }
});

async function loadTomerQueue() {
  const btn = document.getElementById('btn-tomer-refresh');
  if (btn) btn.textContent = 'טוען...';

  try {
    const [queueRes, statsRes] = await Promise.all([
      fetch('/api/tomer/queue'),
      fetch('/api/stats'),
    ]);
    const queue   = await queueRes.json();
    const { daily } = await statsRes.json();

    // Update mini stats
    const dormant  = queue.dormant  ?? [];
    const intro    = queue.introNotRedeemed ?? [];
    setTxt('ts-dormant', dormant.length);
    setTxt('ts-intro',   intro.length);
    setTxt('ts-today',   daily.reEngagedToday ?? 0);

    // Merge + deduplicate by phone
    const seen = new Set();
    const all  = [...dormant, ...intro].filter(l => {
      if (seen.has(l.phone)) return false;
      seen.add(l.phone);
      return true;
    });

    renderTomerQueue(all);
    const upEl = document.getElementById('tomer-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + now();
  } catch (err) {
    setTBody('tomer-queue-tbody', 6, `שגיאה: ${esc(err.message)}`);
  } finally {
    if (btn) btn.textContent = '🔄 רענן';
  }
}

function renderTomerQueue(leads) {
  const tbody = document.getElementById('tomer-queue-tbody');
  if (!tbody) return; // element removed in new 5-panel layout
  if (!leads?.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">אין לידים בתור — הכל מטופל 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = leads.map(l => {
    const days  = l.lastActivity ? Math.floor((Date.now() - new Date(l.lastActivity).getTime()) / 86400000) : '?';
    const tier  = l.score >= 8 ? 'hot' : l.score >= 5 ? 'warm' : 'cold';
    const color = days > 7 ? 'var(--hot)' : 'var(--warm)';
    const introIcon = l.introOfferSent ? (l.introOfferRedeemed ? '✅ נוצלה' : '⏳ ממתינה') : '—';
    return `<tr>
      <td><span class="lead-name">${esc(l.name ?? '—')}</span></td>
      <td><div class="score-cell"><span class="score-num">${l.score}</span><div class="score-track"><div class="score-fill ${tier}" style="width:${l.score*10}%"></div></div></div></td>
      <td><span class="badge ${l.status||'new'}">${statusLabel(l.status)}</span></td>
      <td style="text-align:center;font-weight:700;color:${color}">${days}ד</td>
      <td style="text-align:center">${l.reEngagementCount ?? 0}</td>
      <td style="font-size:12px">${introIcon}</td>
    </tr>`;
  }).join('');
}

async function loadTomerMembers() {
  try {
    const data = await fetch('/api/tomer/members').then(r => r.json());
    const { inactive = [], stats = {} } = data;

    setTxt('tm-active',  stats.active  ?? '—');
    setTxt('tm-risk',    stats.atRisk  ?? '—');
    setTxt('tm-churned', stats.churned ?? '—');

    renderMembersTable(inactive);
    const upEl = document.getElementById('tomer-members-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + now();
  } catch (err) {
    setTBody('tomer-members-tbody', 5, `שגיאה: ${esc(err.message)}`);
  }
}

function renderMembersTable(members) {
  const tbody = document.getElementById('tomer-members-tbody');
  if (!tbody) return; // element removed in new 5-panel layout
  if (!members?.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">אין חברות בסיכון 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = members.map(m => {
    const days  = m.lastAttendance
      ? Math.floor((Date.now() - new Date(m.lastAttendance).getTime()) / 86400000)
      : '∞';
    const statusMap = { active: 'active', at_risk: 'warm', churned: 'crisis' };
    const labelMap  = { active: '✅ פעילה', at_risk: '⚠️ בסיכון', churned: '🚨 עזבה' };
    const cls = statusMap[m.status] ?? 'cold';
    const color = days > 30 ? 'var(--hot)' : days > 14 ? 'var(--warm)' : 'var(--text)';
    return `<tr>
      <td><span class="lead-name">${esc(m.name ?? '—')}</span></td>
      <td style="font-size:12px;color:var(--muted)">${esc(m.planType ?? '—')}</td>
      <td style="text-align:center;font-weight:700;color:${color}">${days}ד</td>
      <td style="text-align:center">${m.attendanceMonth ?? 0}</td>
      <td><span class="badge ${cls}">${labelMap[m.status] ?? m.status}</span></td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════════════
   TOMER — 5-SEGMENT CUSTOMER SUCCESS PANEL
   ══════════════════════════════════════════════════════════════════════════════ */

let _tomerSegs = null; // cached response from /api/tomer/segments

async function loadTomerSegments() {
  const btn = document.getElementById('btn-tomer-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ טוען...'; }
  try {
    _tomerSegs = await fetch('/api/tomer/segments').then(r => r.json());
    if (_tomerSegs.error) throw new Error(_tomerSegs.error);

    // Update badge counts on sub-tabs
    _setBadge('badge-onboarding', _tomerSegs.onboarding?.count ?? 0);
    _setBadge('badge-churn',      _tomerSegs.churnRisk?.count  ?? 0, 'risk');
    _setBadge('badge-renewals',   _tomerSegs.renewals?.count   ?? 0);
    _setBadge('badge-birthdays',  _tomerSegs.birthdays?.count  ?? 0);
    _setBadge('badge-winback',    _tomerSegs.winBack?.count    ?? 0);

    // Render whichever tab is currently active
    _renderTomerSeg(activeTomerSeg);

    const upEl = document.getElementById('tomer-seg-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + now();
  } catch (err) {
    console.error('loadTomerSegments', err);
    toast(`❌ שגיאה בטעינת סגמנטים: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 רענן'; }
  }
}

function _setBadge(id, count, extraClass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = count;
  if (extraClass) el.classList.add(extraClass);
}

function _renderTomerSeg(seg) {
  if (seg === 'activity') { loadTomerActivity(); return; }
  if (!_tomerSegs) return;
  switch (seg) {
    case 'onboarding': _renderOnboarding(_tomerSegs.onboarding?.members ?? []); break;
    case 'churn_risk': _renderChurnRisk(_tomerSegs.churnRisk?.members  ?? []); break;
    case 'renewals':   _renderRenewals(_tomerSegs.renewals);                    break;
    case 'birthdays':  _renderBirthdays(_tomerSegs.birthdays);                  break;
    case 'win_back':   _renderWinBack(_tomerSegs.winBack?.members      ?? []); break;
  }
}

/* Tomer Activity & Monitor ─────────────────────────────────────────────────*/
function _setElText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

async function loadTomerActivity() {
  try {
    const data = await fetch('/api/tomer/activity').then(r => r.json());
    _setElText('tact-silenced',  data.stats?.silenced  ?? '—');
    _setElText('tact-responded', data.stats?.responded ?? '—');
    _setElText('tact-auto',      data.stats?.autoSent  ?? '—');
    _setBadge('badge-activity', (data.stats?.responded ?? 0) + (data.stats?.autoSent ?? 0));
    _renderKnownMembers(data.knownMembers ?? { list: [] });
    _renderActivityFeed(data.events ?? []);
    const upEl = document.getElementById('tact-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + now();
  } catch (err) {
    console.error('loadTomerActivity', err);
    toast('❌ שגיאה בטעינת פעילות תומר: ' + err.message);
  }
}

function _renderKnownMembers(km) {
  const wrap = document.getElementById('km-list');
  if (!wrap) return;
  if (!km.list || !km.list.length) {
    wrap.innerHTML = '<span style="color:var(--muted);font-size:12px">אין לקוחות ידועים מוגדרים</span>';
    return;
  }
  wrap.innerHTML = km.list.map(m =>
    `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:3px 10px;margin:3px;font-size:12px">
       ${esc(m.name ?? m.phone)}
       <button onclick="removeKnownMember('${esc(m.phone)}')" style="border:none;background:none;cursor:pointer;color:var(--muted);font-size:11px;padding:0 2px" title="הסר">✕</button>
     </span>`
  ).join('');
}

function _renderActivityFeed(events) {
  const tbody = document.getElementById('tact-feed-tbody');
  if (!tbody) return;
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">אין פעילות עדיין</td></tr>';
    return;
  }
  const DEC = {
    tomer_silent:     '<span style="color:var(--muted);font-size:11px">🤫 שתיקה</span>',
    tomer_responded:  '<span style="color:#10b981;font-size:11px">💬 תשובה</span>',
    're_engagement_sent': '<span style="color:#f59e0b;font-size:11px">📤 אוטו׳</span>',
    tomer_action_sent:'<span style="color:#f59e0b;font-size:11px">📤 אוטו׳</span>',
  };
  tbody.innerHTML = events.slice(0, 50).map(e => {
    const ts     = e.ts ? new Date(e.ts).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}) : '—';
    const dec    = DEC[e.type] ?? `<span style="font-size:11px">${esc(e.type)}</span>`;
    const sender = esc(e.data?.senderName ?? e.phone ?? '—');
    const reason = esc(e.data?.reason ?? '—');
    const prev   = esc((e.data?.preview ?? '').slice(0, 50));
    return `<tr><td style="font-size:11px;color:var(--muted)">${ts}</td><td>${sender}</td><td>${dec}</td><td style="font-size:11px;color:var(--muted)">${reason}</td><td style="font-size:11px">${prev}</td></tr>`;
  }).join('');
}

async function removeKnownMember(phone) {
  if (!confirm(`הסר ${phone} מרשימת הלקוחות הידועים?`)) return;
  try {
    await fetch(`/api/members/known/${encodeURIComponent(phone)}`, { method: 'DELETE' });
    await loadTomerActivity();
    toast('✅ הוסר מהרשימה');
  } catch (err) { toast(`❌ ${err.message}`); }
}

document.getElementById('btn-km-add')?.addEventListener('click', async () => {
  const phone = document.getElementById('km-phone-input')?.value?.trim();
  const name  = document.getElementById('km-name-input')?.value?.trim() || null;
  if (!phone) { toast('נדרש מספר טלפון'); return; }
  try {
    await post('/api/members/known', { phone, name });
    document.getElementById('km-phone-input').value = '';
    document.getElementById('km-name-input').value  = '';
    await loadTomerActivity();
    toast('✅ נוסף לרשימת הלקוחות הידועים');
  } catch (err) { toast(`❌ ${err.message}`); }
});

// ── Render helpers ────────────────────────────────────────────────────────────

function _memberActionBtn(segment, phone, name, ctxJson) {
  if (!phone || String(phone).includes('•')) return '<span style="color:var(--muted);font-size:11px">טלפון מוסתר</span>';
  const ctxStr = esc(JSON.stringify(ctxJson ?? {}));
  return `<button class="btn-seg-action" onclick="sendTomerAction('${segment}','${esc(phone)}','${esc(name)}',${ctxStr})">💬 שלח הודעה</button>`;
}

function _renderOnboarding(members) {
  const tbody = document.getElementById('tseg-onboarding-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty-state">אין חברים חדשים ב-14 הימים האחרונים</td></tr>`; return; }
  tbody.innerHTML = members.map(m => `<tr>
    <td><span class="lead-name">${esc(m.name)}</span></td>
    <td style="font-weight:600">${m.daysSince != null ? `לפני ${m.daysSince} ימים` : '—'}</td>
    <td style="font-size:12px;color:var(--muted)">${esc(m.memberSince ?? '—')}</td>
    <td>${_memberActionBtn('onboarding', m.phone, m.name, {})}</td>
  </tr>`).join('');
}

function _renderChurnRisk(members) {
  const tbody = document.getElementById('tseg-churn_risk-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty-state">אין חברים בסיכון נטישה 🎉</td></tr>`; return; }
  tbody.innerHTML = members.map(m => {
    const riskCls   = m.risk === 'red' ? 'hot' : 'warm';
    const riskLabel = m.risk === 'red' ? '🔴 גבוה' : '🟡 בינוני';
    const info = m.reason === 'expiring'
      ? `פג בעוד <strong>${m.daysLeft}ד</strong>`
      : m.daysSince != null
        ? `${m.daysSince}ד ללא ביקור`
        : '—';
    const ctx = m.reason === 'expiring' ? { daysLeft: m.daysLeft } : { daysSince: m.daysSince };
    return `<tr>
      <td><span class="lead-name">${esc(m.name)}</span></td>
      <td style="font-size:13px">${info}</td>
      <td><span class="badge ${riskCls}">${riskLabel}</span></td>
      <td>${_memberActionBtn('churn_risk', m.phone, m.name, ctx)}</td>
    </tr>`;
  }).join('');
}

function _renderRenewals(data) {
  const soon    = data?.expiringSoon    ?? [];
  const expired = data?.recentlyExpired ?? [];

  const soonTbody = document.getElementById('tseg-renew-soon-tbody');
  if (soonTbody) {
    if (!soon.length) { soonTbody.innerHTML = `<tr><td colspan="4" class="empty-state">אין מנויים שפגים תוך 30 ימים</td></tr>`; }
    else soonTbody.innerHTML = soon.map(m => `<tr>
      <td><span class="lead-name">${esc(m.name)}</span></td>
      <td style="font-size:12px">${esc(m.memberEnd ?? '—')}</td>
      <td style="font-weight:700;color:${(m.daysLeft ?? 99) <= 7 ? 'var(--hot)' : 'var(--warm)'}">${m.daysLeft != null ? m.daysLeft + 'ד' : '—'}</td>
      <td>${_memberActionBtn('renewal', m.phone, m.name, { daysLeft: m.daysLeft })}</td>
    </tr>`).join('');
  }

  const expTbody = document.getElementById('tseg-renew-expired-tbody');
  if (expTbody) {
    if (!expired.length) { expTbody.innerHTML = `<tr><td colspan="4" class="empty-state">אין מנויים שפגו לאחרונה</td></tr>`; }
    else expTbody.innerHTML = expired.map(m => `<tr>
      <td><span class="lead-name">${esc(m.name)}</span></td>
      <td style="font-size:12px">${esc(m.memberEnd ?? '—')}</td>
      <td style="font-weight:700;color:var(--hot)">${m.daysGone != null ? m.daysGone + 'ד' : '—'}</td>
      <td>${_memberActionBtn('win_back', m.phone, m.name, {})}</td>
    </tr>`).join('');
  }
}

function _renderBirthdays(data) {
  const noteEl = document.getElementById('tseg-birthday-note');
  const tbody  = document.getElementById('tseg-birthdays-tbody');
  if (data?.note && noteEl) { noteEl.textContent = data.note; noteEl.style.display = ''; }
  if (!tbody) return;
  const members = data?.members ?? [];
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="3" class="empty-state">אין ימי הולדת החודש${data?.note ? ' — ' + data.note : ''}</td></tr>`; return; }
  tbody.innerHTML = members.map(m => `<tr>
    <td><span class="lead-name">${esc(m.name)}</span></td>
    <td style="font-size:12px">${esc(m.dob ?? '—')}</td>
    <td>${_memberActionBtn('birthday', m.phone, m.name, {})}</td>
  </tr>`).join('');
}

function _renderWinBack(members) {
  const tbody = document.getElementById('tseg-winback-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty-state">אין חברים לשימור חוזר כרגע</td></tr>`; return; }
  tbody.innerHTML = members.map(m => `<tr>
    <td><span class="lead-name">${esc(m.name)}</span></td>
    <td style="font-size:12px">${esc(m.memberEnd ?? '—')}</td>
    <td style="font-weight:700;color:var(--hot)">${m.daysGone != null ? m.daysGone + 'ד' : '—'}</td>
    <td>${_memberActionBtn('win_back', m.phone, m.name, {})}</td>
  </tr>`).join('');
}

// ── Proactive action — send WhatsApp per segment ──────────────────────────────
async function sendTomerAction(segment, phone, name, context) {
  if (!phone || String(phone).includes('•')) { toast('⚠️ מספר טלפון מוסתר — לא ניתן לשלוח'); return; }
  try {
    const r = await post('/api/tomer/action', { segment, phone, name, context });
    if (r.error) throw new Error(r.error);
    toast(`✅ הודעה נשלחה ל-${esc(name || phone)}`);
    store.logEvent?.('tomer_action_sent', phone, { segment });
  } catch (err) {
    toast(`❌ שליחה נכשלה — ${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   BARAK TAB — CRM & Arbox Management
   ══════════════════════════════════════════════════════════════════════════════ */

// ── Barak sub-navigation ──────────────────────────────────────────────────────
let activeBarakView = 'pipeline';

document.querySelectorAll('.barak-sv-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.barak-sv-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeBarakView = btn.dataset.bview;
    document.querySelectorAll('[id^="barak-view-"]').forEach(v => v.style.display = 'none');
    const viewEl = document.getElementById('barak-view-' + activeBarakView);
    if (viewEl) viewEl.style.display = '';
    if (activeBarakView === 'members')      loadArboxMembers();
    if (activeBarakView === 'memberships')  loadMemberships();
    if (activeBarakView === 'attendance')   loadAttendance();
    if (activeBarakView === 'staff')        loadStaff();
    if (activeBarakView === 'retention')    loadRetention();
    if (activeBarakView === 'arbox-leads')  loadArboxLeads();
    if (activeBarakView === 'schedule')     loadArboxSchedule();
  });
});

// ── Arbox overview bar ────────────────────────────────────────────────────────
async function loadArboxOverview() {
  try {
    const d = await fetch('/api/arbox/overview').then(r => r.json());
    setTxt('aov-members', d.members?.active ?? '—');            // 148 — active clients
    setTxt('aov-leads',   d.leads?.total ?? '—');
    setTxt('aov-today',   d.schedule?.todayBookings > 0 ? d.schedule.todayBookings : (d.schedule?.today ?? '—')); // 53 bookings
    setTxt('aov-week',    d.schedule?.total ?? '—');
    // Update memberships summary bar if it's loaded
    if (d.members?.activeMemberships != null) {
      const msAgg = document.getElementById('ms-agg');
      if (msAgg) msAgg.textContent = d.members.activeMemberships;
    }
    if (d.members?.expiringSoon != null) {
      const msExp = document.getElementById('ms-expiring');
      if (msExp && msExp.textContent === '—') msExp.textContent = d.members.expiringSoon;
    }
    const badge = document.getElementById('arbox-conn-badge');
    if (badge) {
      badge.textContent = d.connection?.ok
        ? `✅ ${d.connection.location?.name ?? 'Arbox'} — ${d.connection.latencyMs}ms`
        : `❌ ${d.connection?.error ?? 'לא מחובר'}`;
      badge.style.color = d.connection?.ok ? 'var(--green)' : 'var(--hot)';
    }
  } catch { /* silent */ }
}

document.getElementById('btn-arbox-refresh')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-arbox-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ טוען...'; }
  membershipData = null; // clear cache so fresh data is fetched
  await Promise.all([
    loadArboxOverview(),
    activeBarakView === 'members'      ? loadArboxMembers()      : Promise.resolve(),
    activeBarakView === 'arbox-leads'  ? loadArboxLeads()        : Promise.resolve(),
    activeBarakView === 'schedule'     ? loadArboxSchedule()     : Promise.resolve(),
    activeBarakView === 'pipeline'     ? loadBarakPanel()        : Promise.resolve(),
  ]);
  if (btn) { btn.disabled = false; btn.textContent = '🔄 רענן Arbox'; }
  toast('✅ נתוני Arbox עודכנו');
});

// ── Memberships (detailed — client + aggregatorMember) ───────────────────────

let membershipData   = null;
let activeMsTab      = 'activeClients';

async function loadMemberships() {
  const tbody = document.getElementById('memberships-tbody');
  if (!membershipData) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-state">טוען מ-Arbox...</td></tr>`;
    try {
      membershipData = await fetch('/api/arbox/classify').then(r => r.json());
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-state">שגיאה: ${esc(err.message)}</td></tr>`;
      return;
    }
  }
  const s = membershipData.summary ?? {};
  setTxt('ms-active',   s.activeClients     ?? s.totalActive ?? '—'); // 148
  setTxt('ms-expiring', s.expiringSoon      ?? '—');                 // 9
  setTxt('ms-expired',  s.recentlyExpired   ?? '—');
  setTxt('ms-archived', s.archivedExpired   ?? '—');
  setTxt('ms-agg',      s.activeMemberships ?? s.aggregators ?? '—'); // 161
  const upEl = document.getElementById('memberships-updated');
  if (upEl) upEl.textContent = 'עודכן: ' + now();
  renderMembershipTab(activeMsTab);
}

const MS_TAB_TITLES = {
  activeClients:   'לקוחות פעילים — active=1 (מדד קובע)',
  expiringSoon:    'פגים בקרוב (active=1, end_date ≤30 ימים)',
  recentlyExpired: 'פגו לאחרונה — ≤90 ימים (מועמדים לחזרה)',
  archivedExpired: 'ארכיון היסטורי — >90 ימים (לא דורש פעולה)',
  deactivated:     'בוטלו ידנית (active=0, ללא end_date)',
  aggregators:     'Aggregator פעילים (ClassPass / Gympass)',
  leads:           'לידים עם טלפון תקין',
};

function renderMembershipTab(tab) {
  activeMsTab = tab;
  if (!membershipData) return;
  const titleEl = document.getElementById('ms-table-title');
  if (titleEl) titleEl.textContent = MS_TAB_TITLES[tab] ?? tab;

  const rows = membershipData.categories?.[tab] ?? [];
  const tbody = document.getElementById('memberships-tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">אין רשומות בקטגוריה זו</td></tr>`;
    return;
  }

  const STATUS_MAP = {
    active:          { cls:'ms-badge-active',   lbl:'✅ פעיל' },
    expiringSoon:    { cls:'ms-badge-expiring', lbl:'⏳ פג בקרוב' },
    recentlyExpired: { cls:'ms-badge-expired',  lbl:'📉 פג לאחרונה' },
    archivedExpired: { cls:'',                  lbl:'🗄️ ארכיון' },
    deactivated:     { cls:'ms-badge-expired',  lbl:'🚫 בוטל' },
    aggregator:      { cls:'ms-badge-active',   lbl:'🤝 Aggregator' },
    lead:            { cls:'',                  lbl:'🎯 ליד' },
  };
  const ROLE_HE = { client:'לקוח ישיר', aggregatorMember:'Aggregator', lead:'ליד', staffMember:'צוות' };

  tbody.innerHTML = rows.map(m => {
    const { cls, lbl } = STATUS_MAP[m.status] ?? { cls:'', lbl: m.status };
    const roleLbl = ROLE_HE[m.role] ?? m.role;
    const daysCell = m.daysLeft != null
      ? `<span style="color:${m.daysLeft >= 0 ? 'var(--warm)' : 'var(--hot)'};font-weight:700">${Math.abs(m.daysLeft)}ד</span>`
      : '—';
    return `<tr>
      <td><span class="lead-name">${esc(m.name || '—')}</span></td>
      <td style="direction:ltr;font-variant-numeric:tabular-nums;font-size:12px">${esc(m.phone || '—')}</td>
      <td style="font-size:12px">${esc(roleLbl)}</td>
      <td style="font-size:12px">${esc(m.memberSince || '—')}</td>
      <td style="font-size:12px;color:${m.status==='expired'?'var(--hot)':'var(--text)'}">${esc(m.memberEnd || '—')}</td>
      <td style="text-align:center">${daysCell}</td>
      <td><span class="ms-badge ${cls}">${lbl}</span></td>
    </tr>`;
  }).join('');
}

// Membership sub-tab switching
document.querySelectorAll('.ms-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ms-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMembershipTab(btn.dataset.mstab);
  });
});

// ── Attendance & No-Shows ─────────────────────────────────────────────────────

async function loadAttendance() {
  const tbody = document.getElementById('attendance-risk-tbody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">טוען...</td></tr>`;
  try {
    const d = await fetch('/api/arbox/attendance').then(r => r.json());
    renderAttendanceToday(d.todayClasses ?? []);
    renderAttendanceRisk(d.atRisk14d ?? []);
    const upEl = document.getElementById('attendance-updated');
    if (upEl) upEl.textContent = `${(d.atRisk14d ?? []).length} בסיכון | עודכן: ${now()}`;
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">שגיאה: ${esc(err.message)}</td></tr>`;
  }
}

function renderAttendanceToday(classes) {
  const el = document.getElementById('attendance-today-list');
  if (!el) return;
  if (!classes.length) { el.innerHTML = '<div class="empty-state">אין שיעורים היום</div>'; return; }
  el.innerHTML = classes.map(c => `
    <div class="att-class-row">
      <div class="att-time">${esc(c.start)}</div>
      <div class="att-info">
        <div class="att-name">${esc(c.name)}</div>
        <div class="att-staff">${esc(c.staff)}</div>
      </div>
      <div class="att-spots">${c.maxParticipants} מקומות</div>
      ${c.registrationLink ? `<a href="${esc(c.registrationLink)}" target="_blank" class="att-link">📅 הרשמה</a>` : ''}
    </div>`).join('');
}

function renderAttendanceRisk(members) {
  const tbody = document.getElementById('attendance-risk-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-state">אין חברים בסיכון 🎉</td></tr>`; return; }
  tbody.innerHTML = members.map(m => {
    const days  = m.daysSince ?? '∞';
    const color = days > 30 ? 'var(--hot)' : 'var(--warm)';
    const statusMap = { at_risk: 'warm', churned: 'crisis', active: 'active' };
    const cls = statusMap[m.status] ?? 'cold';
    return `<tr>
      <td><span class="lead-name">${esc(m.name || '—')}</span></td>
      <td style="font-size:12px;color:var(--muted)">${esc(m.planType || '—')}</td>
      <td style="font-size:12px">${esc(m.lastAttendance ? new Date(m.lastAttendance).toLocaleDateString('he-IL') : '—')}</td>
      <td style="text-align:center;font-weight:700;color:${color}">${days}ד</td>
      <td><span class="badge ${cls}">${{'at_risk':'⚠️ בסיכון','churned':'🚨 עזב','active':'✅ פעיל'}[m.status]??m.status}</span></td>
    </tr>`;
  }).join('');
}

// ── Staff Directory ────────────────────────────────────────────────────────────

async function loadStaff() {
  const grid = document.getElementById('staff-grid');
  if (grid) grid.innerHTML = '<div class="empty-state">טוען מ-Arbox...</div>';
  try {
    const d = await fetch('/api/arbox/staff').then(r => r.json());
    renderStaffGrid(d.staff ?? []);
    const upEl = document.getElementById('staff-updated');
    if (upEl) upEl.textContent = `${d.total} חברי צוות | עודכן: ${now()}`;
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty-state">שגיאה: ${esc(err.message)}</div>`;
  }
}

function renderStaffGrid(staff) {
  const grid = document.getElementById('staff-grid');
  if (!grid) return;
  if (!staff.length) { grid.innerHTML = '<div class="empty-state">אין נתוני צוות</div>'; return; }
  const COLORS = ['#4f46e5','#ec4899','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16'];
  grid.innerHTML = staff.map((s, i) => {
    const initials = (s.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const color    = COLORS[i % COLORS.length];
    return `<div class="staff-card">
      <div class="staff-avatar" style="background:${color}">${initials}</div>
      <div class="staff-name">${esc(s.name || '—')}</div>
      <div class="staff-phone">${esc(s.phone || '—')}</div>
      <div class="staff-status">${s.active ? '<span style="color:var(--green)">● פעיל</span>' : '<span style="color:var(--muted)">○ לא פעיל</span>'}</div>
      ${s.joinedDate ? `<div class="staff-since">מ-${esc(s.joinedDate)}</div>` : ''}
    </div>`;
  }).join('');
}

// ── Retention & Health ────────────────────────────────────────────────────────

async function loadRetention() {
  const kpiRow = document.getElementById('retention-kpi-row');
  if (kpiRow) kpiRow.innerHTML = '<div class="empty-state">טוען...</div>';
  try {
    const d = await fetch('/api/arbox/retention').then(r => r.json());
    renderRetentionKPIs(d.summary ?? {});
    renderRetentionRecs(d.recommendations ?? []);
    renderExpiringTable(d.expiringClients ?? []);
    renderExpiredTable(d.expiredClients ?? []);
  } catch (err) {
    if (kpiRow) kpiRow.innerHTML = `<div class="empty-state">שגיאה: ${esc(err.message)}</div>`;
  }
}

function renderRetentionKPIs(s) {
  const el = document.getElementById('retention-kpi-row');
  if (!el) return;
  const kpis = [
    { icon:'👥', val: s.clients ?? '—',         lbl:'לקוחות ישירים',    cls:'' },
    { icon:'🤝', val: s.aggregators ?? '—',      lbl:'Aggregator',       cls:'' },
    { icon:'👩‍🏫', val: s.staff ?? '—',            lbl:'צוות',             cls:'' },
    { icon:'📈', val: s.retentionRate ?? '—',    lbl:'שימור',            cls:'green' },
    { icon:'📉', val: s.churnRate ?? '—',        lbl:'נשירה',            cls:'hot' },
    { icon:'⏳', val: s.expiringClients ?? '—',  lbl:'פגים תוך 30ד',    cls: s.expiringClients > 0 ? 'warm' : '' },
    { icon:'❌', val: s.expiredClients ?? '—',   lbl:'פגו',              cls: s.expiredClients > 3 ? 'hot' : '' },
    { icon:'🎯', val: s.arboxLeads ?? '—',       lbl:'לידים ב-Arbox',    cls:'' },
  ];
  el.innerHTML = kpis.map(k => `
    <div class="ret-kpi-card">
      <div class="ret-kpi-icon">${k.icon}</div>
      <div class="ret-kpi-val${k.cls ? ' ' + k.cls : ''}">${k.val}</div>
      <div class="ret-kpi-lbl">${k.lbl}</div>
    </div>`).join('');
}

function renderRetentionRecs(recs) {
  const el = document.getElementById('retention-recs');
  if (!el) return;
  if (!recs.length) { el.innerHTML = '<div class="empty-state">אין המלצות</div>'; return; }
  el.innerHTML = recs.map(r => `<div class="ret-rec-row">${esc(r)}</div>`).join('');
}

function renderExpiringTable(members) {
  const tbody = document.getElementById('expiring-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty-state">אין פגים בקרוב 🎉</td></tr>`; return; }
  tbody.innerHTML = members.map(m => `<tr>
    <td><span class="lead-name">${esc(m.name || '—')}</span></td>
    <td style="direction:ltr">${esc(m.phone || '—')}</td>
    <td style="font-size:12px">${esc(m.endDate || '—')}</td>
    <td style="text-align:center;color:var(--warm);font-weight:700">${m.daysLeft}ד</td>
  </tr>`).join('');
}

function renderExpiredTable(members) {
  const tbody = document.getElementById('expired-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="3" class="empty-state">אין פגויים</td></tr>`; return; }
  tbody.innerHTML = members.map(m => `<tr>
    <td><span class="lead-name">${esc(m.name || '—')}</span></td>
    <td style="direction:ltr">${esc(m.phone || '—')}</td>
    <td style="font-size:12px;color:var(--hot)">${esc(m.endDate || '—')}</td>
  </tr>`).join('');
}

// ── Arbox members panel ───────────────────────────────────────────────────────
async function loadArboxMembers() {
  const tbody = document.getElementById('arbox-members-tbody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-state">טוען מ-Arbox...</td></tr>`;
  try {
    const d = await fetch('/api/arbox/members').then(r => r.json());
    renderArboxMembers(d.members ?? []);
    const upEl = document.getElementById('arbox-members-updated');
    if (upEl) upEl.textContent = `${d.totalActive ?? d.members?.filter(m=>m.active).length ?? 0} פעילים | עודכן: ${now()}`;
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-state">שגיאה: ${esc(err.message)}</td></tr>`;
  }
}

function renderArboxMembers(members) {
  const tbody = document.getElementById('arbox-members-tbody');
  if (!tbody) return;
  if (!members.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-state">אין חברים</td></tr>`; return; }
  tbody.innerHTML = members.map(m => `<tr>
    <td><span class="lead-name">${esc(m.name || '—')}</span></td>
    <td style="direction:ltr;font-variant-numeric:tabular-nums">${esc(m.phone || '—')}</td>
    <td style="font-size:12px;color:var(--muted)">${esc(roleHe(m.role))}</td>
    <td style="font-size:12px">${esc(m.memberSince || '—')}</td>
    <td style="font-size:12px;color:var(--muted)">${esc(m.memberEnd || 'ללא תאריך סיום')}</td>
    <td style="text-align:center">${m.active ? '<span style="color:var(--green);font-weight:700">● פעיל</span>' : '<span style="color:var(--muted)">○ לא פעיל</span>'}</td>
  </tr>`).join('');
}

function roleHe(role) {
  return { staffMember: 'צוות', member: 'חבר', admin: 'מנהל' }[role] ?? role ?? '—';
}

// ── Arbox leads panel ─────────────────────────────────────────────────────────
async function loadArboxLeads() {
  const tbody = document.getElementById('arbox-leads-tbody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">טוען מ-Arbox...</td></tr>`;
  try {
    const d = await fetch('/api/arbox/leads').then(r => r.json());
    renderArboxLeads(d.leads ?? []);
    const upEl = document.getElementById('arbox-leads-updated');
    if (upEl) upEl.textContent = `${d.total} לידים | עודכן: ${now()}`;
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">שגיאה: ${esc(err.message)}</td></tr>`;
  }
}

function renderArboxLeads(leads) {
  const tbody = document.getElementById('arbox-leads-tbody');
  if (!tbody) return;
  if (!leads.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-state">אין לידים</td></tr>`; return; }
  tbody.innerHTML = leads.map(l => {
    const statusColor = { 'לא נוצר קשר': 'var(--muted)', 'ללא מענה 2': 'var(--warm)', 'סגור': 'var(--green)' }[l.status] ?? 'var(--text)';
    return `<tr>
      <td><span class="lead-name">${esc(l.name || '—')}</span></td>
      <td style="direction:ltr;font-variant-numeric:tabular-nums">${esc(l.phone || '—')}</td>
      <td><span style="color:${statusColor};font-size:12px;font-weight:600">${esc(l.status || '—')}</span></td>
      <td style="font-size:12px;color:var(--muted)">${esc(l.source || '—')}</td>
      <td style="font-size:12px;color:var(--muted)">${esc(l.created || '—')}</td>
    </tr>`;
  }).join('');
}

// Lookup tool
document.getElementById('btn-arbox-lookup')?.addEventListener('click', async () => {
  const q = document.getElementById('arbox-lookup-input')?.value.trim();
  if (!q) return;
  const resEl = document.getElementById('arbox-lookup-result');
  if (resEl) resEl.textContent = 'מחפש...';
  try {
    const d = await post('/api/barak/lookup-client', { query: q });
    if (resEl) resEl.textContent = d.total > 0
      ? `נמצאו ${d.total}: ${d.results.map(r => r.name || r.phone).join(', ')}`
      : 'לא נמצא';
    if (d.results?.length) renderArboxLeads(d.results.map(r => ({
      name: r.name, phone: r.phone,
      status: r.leadStatus || (r.active ? 'חבר פעיל' : '—'),
      source: r.type === 'member' ? 'חבר סטודיו' : r.leadSource,
      created: r.createdTime || r.memberSince,
    })));
  } catch (err) { if (resEl) resEl.textContent = `שגיאה: ${esc(err.message)}`; }
});

document.getElementById('arbox-lookup-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-arbox-lookup')?.click();
});

// ── Arbox schedule panel ──────────────────────────────────────────────────────
async function loadArboxSchedule() {
  const grid = document.getElementById('arbox-schedule-grid');
  if (grid) grid.innerHTML = '<div class="empty-state">טוען מ-Arbox...</div>';
  try {
    const d = await fetch('/api/arbox/schedule?days=7').then(r => r.json());
    renderScheduleGrid(d.classes ?? []);
    const upEl = document.getElementById('arbox-sched-updated');
    if (upEl) upEl.textContent = `${d.total} שיעורים | עודכן: ${now()}`;
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty-state">שגיאה: ${esc(err.message)}</div>`;
  }
}

function renderScheduleGrid(classes) {
  const grid = document.getElementById('arbox-schedule-grid');
  if (!grid) return;
  if (!classes.length) { grid.innerHTML = '<div class="empty-state">אין שיעורים ב-7 ימים הקרובים</div>'; return; }

  // Group by date
  const byDate = {};
  classes.forEach(c => { (byDate[c.date] = byDate[c.date] || []).push(c); });

  const DAY_HE = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  grid.innerHTML = Object.entries(byDate).map(([date, cls]) => {
    const d   = new Date(date);
    const day = DAY_HE[d.getDay()];
    const rows = cls.map(c => `
      <div class="sched-row">
        <span class="sched-time">${esc(c.start)}</span>
        <span class="sched-name">${esc(c.name)}</span>
        <span class="sched-staff">${esc(c.staff)}</span>
        <span class="sched-spots">${c.maxParticipants} מקומות</span>
      </div>`).join('');
    return `<div class="sched-day-card">
      <div class="sched-day-header"><span class="sched-day-name">יום ${day}</span><span class="sched-day-date">${date}</span></div>
      ${rows}
    </div>`;
  }).join('');
}

// Data integrity validation
document.getElementById('btn-validate-data')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-validate-data');
  if (btn) { btn.disabled = true; btn.textContent = '🔍 בודק...'; }
  try {
    const d = await post('/api/barak/validate-data', {});
    renderIntegrityReport(d);
    toast(`ציון תקינות: ${d.integrityScore}/100 — ${d.verdict}`);
  } catch (err) { toast(`❌ ${err.message}`); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🔍 בדיקת תקינות נתונים'; } }
});

function renderIntegrityReport(d) {
  const box     = document.getElementById('integrity-report-box');
  const scoreEl = document.getElementById('ir-score');
  const verEl   = document.getElementById('ir-verdict');
  const sumEl   = document.getElementById('ir-summary');
  const issEl   = document.getElementById('ir-issues-list');
  if (!box) return;

  box.style.display = 'block';
  const score  = d.integrityScore ?? 0;
  const color  = score >= 90 ? 'var(--green)' : score >= 70 ? 'var(--warm)' : 'var(--hot)';
  if (scoreEl) { scoreEl.textContent = score + '/100'; scoreEl.style.color = color; }
  if (verEl)   verEl.textContent = d.verdict ?? '—';

  const s = d.summary ?? {};
  if (sumEl) sumEl.innerHTML = [
    `<span class="ir-stat">בדקנו: <b>${s.totalChecked}</b></span>`,
    `<span class="ir-stat" style="color:var(--hot)">טלפון לא תקין: <b>${s.invalidPhones}</b></span>`,
    `<span class="ir-stat" style="color:var(--warm)">כפולים: <b>${s.duplicatePhones}</b></span>`,
    `<span class="ir-stat" style="color:var(--warm)">רפאים: <b>${s.ghostSyncRecords}</b></span>`,
    `<span class="ir-stat" style="color:var(--hot)">אי-התאמה: <b>${s.statusMismatches}</b></span>`,
  ].join('');

  const issues = d.issues ?? [];
  if (issEl) {
    const ISSUE_LABELS = {
      invalid_phone:    { icon:'📵', label:'טלפון לא תקין' },
      duplicate_phone:  { icon:'👥', label:'כפילות טלפון' },
      ghost_sync:       { icon:'👻', label:'רשומת רפאים' },
      status_mismatch:  { icon:'⚠️', label:'אי-התאמת סטטוס' },
      test_record:      { icon:'🧪', label:'רשומת בדיקה' },
    };
    const SEV_COLOR = { high:'var(--hot)', medium:'var(--warm)', low:'var(--muted)' };
    issEl.innerHTML = issues.length === 0
      ? '<div style="padding:12px;color:var(--green);font-weight:600">✅ לא נמצאו בעיות</div>'
      : issues.map(iss => {
          const { icon, label } = ISSUE_LABELS[iss.type] ?? { icon:'⚠', label: iss.type };
          const detail = iss.note || iss.duplicateOf || iss.arboxEndDate || '';
          return `<div class="ir-issue-row">
            <span class="ir-issue-icon">${icon}</span>
            <span class="ir-issue-label" style="color:${SEV_COLOR[iss.severity]??'var(--text)'}">${label}</span>
            <span class="ir-issue-name">${esc(iss.name||'—')}</span>
            <span class="ir-issue-phone">${esc(iss.phone||'—')}</span>
            ${detail ? `<span class="ir-issue-note">${esc(String(detail))}</span>` : ''}
          </div>`;
        }).join('');
  }
}

// Pull Arbox leads into local store
document.getElementById('btn-pull-arbox-leads')?.addEventListener('click', async () => {
  const btn    = document.getElementById('btn-pull-arbox-leads');
  const result = document.getElementById('barak-sync-result');
  if (btn) { btn.disabled = true; btn.textContent = '⬇ מייבא...'; }
  if (result) result.style.display = 'none';
  try {
    const d = await post('/api/barak/sync-leads', {});
    const txt = d.error
      ? `❌ ${d.error}`
      : `✅ יובאו ${d.imported} חדשים | עודכנו ${d.updated} | דולגו ${d.skipped}`;
    if (result) { result.textContent = txt; result.style.display = 'block'; }
    toast('✅ ייבוא לידים מ-Arbox הושלם');
    loadBarakPanel();
  } catch (err) { toast(`❌ ${err.message}`); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '⬇ ייבא לידים מ-Arbox'; } }
});

async function loadBarakPanel() {
  try {
    const [leadsRes, statsRes, aptsRes] = await Promise.all([
      fetch('/api/leads'),
      fetch('/api/stats'),
      fetch('/api/admin/appointments?limit=50').catch(() => ({ json: () => ({ appointments: [] }) })),
    ]);
    allLeads         = await leadsRes.json();
    const { daily }  = await statsRes.json();
    const aptsData   = await aptsRes.json();
    renderBarakStats(daily);
    renderBarakTable(allLeads);
    renderCallbackPanel(allLeads, aptsData.appointments ?? []);
    const upEl = document.getElementById('barak-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + now();
  } catch (e) { console.error('loadBarakPanel', e); }
}

// maskPhone mirrors server.js maskPhone: slice(0,5) + '••••' + slice(-3)
function maskPhone(p) {
  if (!p || p.length < 7) return p ?? '—';
  return p.slice(0, 5) + '••••' + p.slice(-3);
}

function fmtCallbackTime(apt, qualData) {
  // Prefer parsed scheduledAt (Asia/Jerusalem) over raw text; fall back to rawTime / callTimeGiven
  if (apt?.scheduledAt) {
    try {
      const d = new Date(apt.scheduledAt);
      return d.toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {}
  }
  return qualData?.callTimeGiven ?? apt?.rawTime ?? '—';
}

function cbStatusLabel(leadStatus, aptStatus, qualData) {
  if (aptStatus === 'completed')       return { label: 'הושלם',             cls: 'muted' };
  if (aptStatus === 'cancelled')       return { label: 'בוטל',              cls: 'muted' };
  if (aptStatus === 'no_show')         return { label: 'לא ענה',            cls: 'hot'   };
  if (aptStatus === 'confirmed')       return { label: 'מאושר',             cls: 'green' };
  if (qualData?.nameAsked && !qualData?.confirmedName)
                                       return { label: 'ממתין לשם',         cls: 'warm'  };
  if (aptStatus === 'callback_pending') return { label: 'בקשת שיחה',        cls: 'warm'  };
  if (leadStatus === 'call_scheduled') return { label: 'מתוזמן (ישן)',      cls: 'green' };
  return                                      { label: 'בקשת שיחה',         cls: 'warm'  };
}

function renderCallbackPanel(leads, apts) {
  const bodyEl  = document.getElementById('barak-callbacks-body');
  const badgeEl = document.getElementById('barak-callbacks-badge');
  if (!bodyEl) return;

  const cbLeads = leads.filter(l =>
    l.status === 'callback_requested' || l.status === 'call_scheduled'
  );

  // ── Index appointments by MASKED phone ───────────────────────────────────────
  // /api/leads masks phones; /api/admin/appointments stores full phones.
  // Build the lookup with both masked and full phone as keys so either works.
  const aptByPhone = {};
  for (const a of apts) {
    const full   = a.leadPhone;
    const masked = maskPhone(full);
    const existing = aptByPhone[full] ?? aptByPhone[masked];
    if (!existing || new Date(a.createdAt) > new Date(existing.createdAt)) {
      aptByPhone[full]   = a;
      aptByPhone[masked] = a;
    }
  }

  if (!cbLeads.length) {
    if (badgeEl) badgeEl.textContent = '';
    bodyEl.innerHTML = `<div class="empty-state" style="padding:12px">אין שיחות ממתינות</div>`;
    return;
  }

  if (badgeEl) badgeEl.textContent = cbLeads.length;

  const rows = cbLeads.map(l => {
    const qd        = l.meta?.qualData ?? {};
    const apt       = aptByPhone[l.phone];
    const alertSt   = l.meta?.handoffAlertStatus;
    const alertIdMsg = l.meta?.handoffAlertIdMessage ? ` · idMsg: ${l.meta.handoffAlertIdMessage}` : '';
    const alertTime  = l.meta?.handoffAlertSentAt
      ? ` · שנשלח: ${new Date(l.meta.handoffAlertSentAt).toLocaleTimeString('he-IL',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit'})}`
      : (l.meta?.handoffAlertFailedAt ? ' · נכשל' : '');
    const alertTip  = alertSt === 'sent'
      ? `ספק אישר קבלה${alertIdMsg}${alertTime}`
      : alertSt === 'failed' ? `שליחה נכשלה${alertTime}` : 'לא נשלחה';
    const alertIcon =
      alertSt === 'sent'    ? `<span style="color:var(--green)" title="${alertTip}">✅</span>` :
      alertSt === 'failed'  ? `<span style="color:var(--hot)"   title="${alertTip}">❌</span>` :
      alertSt === 'pending' ? `<span style="color:var(--warm)"  title="${alertTip}">⏳</span>` :
                              `<span style="color:var(--muted)" title="${alertTip}">—</span>`;

    const reminderSent = apt?.reminderSent;
    const reminderSentTo = apt?.reminderSentTo ?? [];
    const reminderTip = reminderSent
      ? `תזכורת נשלחה ל-${reminderSentTo.length} נמענ/ים`
      : (apt ? 'תזכורת טרם נשלחה' : 'אין רשומת תור');
    const reminderIcon = reminderSent
      ? `<span style="color:var(--green)" title="${reminderTip}">🔔</span>`
      : `<span style="color:var(--muted)" title="${reminderTip}">🔕</span>`;

    const scoreNum   = l.score ?? '—';
    const scoreTip   = `ציון כשירות ליד (1-10): מודד אותות רכישה, לא איכות שיחה\n${l.meta?.qualProfile?.readinessEvidence ?? ''}`;
    const scoreColor = l.score >= 8 ? 'var(--hot)' : l.score >= 5 ? 'var(--warm)' : 'var(--muted)';

    const st         = cbStatusLabel(l.status, apt?.status, qd);
    const stColor    = st.cls === 'green' ? 'var(--green)' : st.cls === 'warm' ? 'var(--warm)' : st.cls === 'hot' ? 'var(--hot)' : 'var(--muted)';

    const dispName   = l.name && l.name.trim() ? l.name : null;
    const confirmedN = qd.confirmedName && qd.confirmedName.trim() ? qd.confirmedName : null;
    const nameDisplay = confirmedN ?? dispName ?? `<span style="color:var(--hot);font-size:11px">שם חסר</span>`;
    const nameLabel  = confirmedN ? `✓ ${esc(confirmedN)}` : (dispName ? esc(dispName) : nameDisplay);

    const dispPhone  = l.phone.startsWith('972') ? '0' + l.phone.slice(3) : l.phone;
    // WhatsApp link uses the masked phone format for display, full E.164 for WA link
    const waPhone    = l.phone.replace(/[^0-9]/g, '');
    const waLink     = `https://wa.me/${waPhone}`;

    const timeLabel  = fmtCallbackTime(apt, qd);

    // Assigned representative (from aptStore — full phone is unmasked there)
    const assignee   = apt?.assignedStaffId ?? '—';

    const convoSum   = l.meta?.qualProfile?.qualificationReason ?? l.meta?.leadBrief?.notes ?? '';
    const readySt    = l.meta?.qualProfile?.readiness;
    const readyEmoji = readySt === 'HIGH' ? '🔥' : readySt === 'MEDIUM' ? '🌡️' : readySt === 'LOW' ? '❄️' : '';
    const interests  = [qd.fitnessInterest, qd.goal, qd.location].filter(Boolean).join(' · ');

    // Action buttons — POST to appointments API if apt exists
    const aptId   = apt?.id ?? '';
    const actions = aptId ? `
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">
        <button onclick="cbAction('${aptId}','complete')"   style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border)">✔ הושלם</button>
        <button onclick="cbAction('${aptId}','no_answer')"  style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border)">📵 לא ענה</button>
        <button onclick="cbAction('${aptId}','cancel')"     style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border)">🚫 בטל</button>
      </div>` : '';

    return `<div class="callback-row" style="padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="display:grid;grid-template-columns:160px 130px 1fr 56px 28px 28px 28px;gap:8px;align-items:start">
        <div>
          <div style="font-weight:600;font-size:13px">${nameLabel}</div>
          <div style="font-size:11px;color:var(--muted);direction:ltr">${esc(dispPhone)}</div>
          <a href="${waLink}" target="_blank" style="font-size:10px;color:var(--accent);text-decoration:none">💬 WhatsApp</a>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text);font-weight:500">${esc(timeLabel)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">נציג: ${esc(assignee)}</div>
          <div style="font-size:11px;font-weight:600;color:${stColor};margin-top:2px">${esc(st.label)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(convoSum)}">${readyEmoji} ${esc(convoSum || interests || '—')}</div>
          ${actions}
        </div>
        <div><span style="font-weight:700;color:${scoreColor}" title="${scoreTip}">${scoreNum}/10</span></div>
        <div title="${alertTip}">${alertIcon}</div>
        <div title="${reminderTip}">${reminderIcon}</div>
        <div title="היסטוריית שיחה"><button onclick="openThread('${waPhone}')" style="font-size:10px;padding:2px 4px;cursor:pointer;border-radius:3px;border:1px solid var(--border)">💬</button></div>
      </div>
    </div>`;
  }).join('');

  bodyEl.innerHTML = `
    <div style="display:grid;grid-template-columns:160px 130px 1fr 56px 28px 28px 28px;gap:8px;padding:6px 16px;font-size:11px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border)">
      <div>שם / טלפון</div><div>זמן / נציג / סטטוס</div><div>סיכום שיחה</div><div>ציון ליד</div><div>🔔</div><div>✅</div><div>💬</div>
    </div>
    ${rows}`;
}

// ── Callback action handlers ──────────────────────────────────────────────────

async function cbAction(aptId, action) {
  if (!aptId) return;
  let url, body;
  if (action === 'complete') {
    url = `/api/admin/appointments/${aptId}/complete`;
    body = {};
  } else if (action === 'cancel') {
    url = `/api/admin/appointments/${aptId}/cancel`;
    body = {};
  } else if (action === 'no_answer') {
    // Reschedule as no_show without auto-messaging; staff manually follows up
    url = `/api/admin/appointments/${aptId}`;
    body = { status: 'no_show' };
  } else {
    return;
  }
  try {
    const method = (action === 'no_answer') ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    await loadBarakPanel(); // refresh
  } catch (e) {
    alert('שגיאה: ' + e.message);
  }
}

function openThread(phone) {
  // Open the conversations tab filtered to this phone
  const tab = document.querySelector('[data-tab="conversations"]') ?? document.querySelector('[data-panel="conversations"]');
  if (tab) tab.click();
  // Brief delay to let the tab render, then filter
  setTimeout(() => {
    const filter = document.getElementById('conv-filter') ?? document.querySelector('input[placeholder*="חיפוש"]');
    if (filter) { filter.value = phone.slice(-4); filter.dispatchEvent(new Event('input')); }
  }, 200);
}

function renderBarakStats(d) {
  const el = document.getElementById('barak-stats');
  if (!el) return;
  const cards = [
    { cls: '',       icon: '👥', val: d.totalLeads,     label: 'סה"כ לידים' },
    { cls: 'hot',    icon: '🔥', val: d.hotLeadsTotal,  label: 'חמים' },
    { cls: 'warm',   icon: '🌡️', val: d.warmLeadsTotal, label: 'פושרים' },
    { cls: '',       icon: '🎯', val: d.introOffersSent, label: 'הצעות שנשלחו' },
    { cls: '',       icon: '📊', val: d.unsyncedLeads,  label: 'לא מסונכרן' },
    d.crisisActive > 0 ? { cls: 'crisis', icon: '🚨', val: d.crisisActive, label: 'משבר' } : null,
  ].filter(Boolean);
  el.innerHTML = cards.map(c => `
    <div class="stat-card ${c.cls}">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-value">${c.val}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join('');
}

function renderBarakTable(leads) {
  const rows  = activeFilter === 'all' ? leads : leads.filter(l => l.status === activeFilter);
  const tbody = document.getElementById('barak-leads-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">אין לידים להצגה</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(l => {
    const tier = l.score >= 8 ? 'hot' : l.score >= 5 ? 'warm' : 'cold';
    const arbox = l.arboxSynced
      ? `<span style="color:var(--green);font-size:12px">✅ ${l.arboxId ?? ''}</span>`
      : `<span style="color:var(--muted);font-size:12px">—</span>`;
    // qualProfile — computed on every AI turn, stored in meta.qualProfile
    const qp = l.meta?.qualProfile;
    const nextAction = qp?.nextBestAction ?? '—';
    const qualReason = qp?.qualificationReason ?? '';
    const readyEmoji = qp?.readiness === 'HIGH' ? '🔥' : qp?.readiness === 'MEDIUM' ? '🌡️' : qp?.readiness === 'LOW' ? '❄️' : '';
    // Status badge: show qualification reason as tooltip
    const statusTitle = qualReason ? ` title="${esc(qualReason)}"` : '';
    return `<tr>
      <td><span class="lead-name">${esc(l.name ?? '—')}</span></td>
      <td style="direction:ltr;text-align:right;font-variant-numeric:tabular-nums">${esc(l.phone)}</td>
      <td><div class="score-cell"><span class="score-num">${l.score}</span><div class="score-track"><div class="score-fill ${tier}" style="width:${l.score*10}%"></div></div></div></td>
      <td><span class="badge ${l.status||'new'}"${statusTitle}>${statusLabel(l.status)}</span></td>
      <td>${l.messageCount}</td>
      <td style="text-align:center">${l.introOfferSent ? '✅' : '—'}</td>
      <td>${arbox}</td>
      <td style="color:var(--muted)">${timeSince(l.lastActivity)}</td>
      <td style="font-size:12px;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(nextAction)}">${readyEmoji} ${esc(nextAction)}</td>
    </tr>`;
  }).join('');
}

/* Arbox sync ──────────────────────────────────────────────────────────────────*/
document.getElementById('btn-sync-arbox').addEventListener('click', async () => {
  const btn    = document.getElementById('btn-sync-arbox');
  const result = document.getElementById('barak-sync-result');
  btn.disabled = true;
  btn.textContent = '🔄 מסנכרן...';
  result.style.display = 'none';
  try {
    const data = await post('/api/barak/sync-arbox', {});
    const txt  = data.error
      ? `❌ ${data.error}`
      : `✅ מסונכרנו: ${data.synced ?? 0} | דלגו: ${data.skipped ?? 0} | שגיאות: ${(data.errors ?? []).length}`;
    result.textContent    = txt;
    result.style.display  = 'block';
    toast('סנכרון הושלם');
    loadBarakPanel();
  } catch (err) { toast(`❌ ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = '🔄 סנכרן הכל'; }
});

document.getElementById('btn-sync-status').addEventListener('click', async () => {
  const statusEl = document.getElementById('barak-sync-status');
  statusEl.textContent = 'טוען...';
  try {
    const data = await fetch('/api/barak/sync-status').then(r => r.json());
    statusEl.textContent =
      `סה"כ: ${data.total} | מסונכרן: ${data.synced} | ממתין: ${data.pending}` +
      (data.pendingLeads?.length
        ? '\n\nממתין לסנכרון:\n' + data.pendingLeads.map(l => `• ${l.name ?? l.phone} (${l.score}/10)`).join('\n')
        : '');
  } catch (err) { statusEl.textContent = `שגיאה: ${err.message}`; }
});

/* ══════════════════════════════════════════════════════════════════════════════
   HEALTH TAB
   ══════════════════════════════════════════════════════════════════════════════ */

async function loadHealth() {
  try {
    const res  = await fetch('/api/system');
    const data = await res.json();

    const agentCards = Object.values(data.agents).map(a => `
      <div class="health-card">
        <div class="health-card-top">
          <span class="health-card-name">${esc(a.name)}</span>
          <span class="hstatus active">● פעיל</span>
        </div>
        <div class="health-card-detail">${esc(a.role)}</div>
      </div>`).join('');

    const storeCard = `
      <div class="health-card">
        <div class="health-card-top">
          <span class="health-card-name">Lead Store</span>
          <span class="hstatus active">● פעיל</span>
        </div>
        <div class="health-card-detail">
          ${data.store.totalLeads} לידים בזיכרון | ממוצע ציון: ${data.store.avgScore}/10
          ${data.store.crisisActive > 0 ? `<br><strong style="color:var(--crisis)">⚠ ${data.store.crisisActive} משבר</strong>` : ''}
        </div>
      </div>`;

    const svcLabels = { whatsapp: 'WhatsApp Business', arbox: 'Arbox CRM', openai: 'OpenAI' };
    const svcCards  = Object.entries(data.services).map(([k, v]) => `
      <div class="health-card">
        <div class="health-card-top">
          <span class="health-card-name">${svcLabels[k] ?? k}</span>
          <span class="hstatus ${v.configured ? 'configured' : 'pending'}">${v.configured ? '● מוגדר' : '⚠ לא מוגדר'}</span>
        </div>
        <div class="health-card-detail">שירות חיצוני</div>
      </div>`).join('');

    document.getElementById('health-grid').innerHTML = agentCards + storeCard + svcCards;

    const evEl = document.getElementById('events-list');
    if (!data.events?.length) {
      evEl.innerHTML = '<div class="empty-state">אין אירועים עדיין</div>';
    } else {
      evEl.innerHTML = data.events.map(e => `
        <div class="event-row">
          <span class="event-type ${e.type}">${translateEvent(e.type)}</span>
          <span class="event-phone">${esc(e.phone?.slice(0,8) ?? '—')}•••</span>
          <span class="event-detail">${esc(e.data?.name ?? e.data?.preview ?? e.data?.title ?? '')}</span>
          <span class="event-time">${timeSince(e.ts)}</span>
        </div>`).join('');
    }

    const upEl = document.getElementById('health-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + new Date().toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  } catch (e) { console.error('loadHealth', e); }
}

function translateEvent(type) {
  return ({
    message_in:           '📩 הודעה נכנסת',
    message_out:          '📤 הודעה יוצאת',
    intro_offer_sent:     '🎯 הצעת היכרות',
    crisis:               '🚨 משבר',
    score_update:         '📊 עדכון ציון',
    re_engagement_sent:   '💌 ריאנגייג\'מנט',
    arbox_sync:           '🔗 סנכרון Arbox',
    booking_confirmed:    '📅 הזמנה אושרה',
    content_pack_generated:'🎨 חבילת תוכן',
    ad_copy_generated:    '📐 קופי פרסומת',
    video_analysis:       '🎬 ניתוח וידאו',
    meta_lead_webhook:    '📱 ליד Meta',
    manual_whatsapp:      '💬 WhatsApp ידני',
  })[type] ?? type;
}

/* ══════════════════════════════════════════════════════════════════════════════
   MINI CHAT FACTORY
   ══════════════════════════════════════════════════════════════════════════════ */

function initMiniChat(inputId, sendBtnId, msgsId, endpoint) {
  const input  = document.getElementById(inputId);
  const btn    = document.getElementById(sendBtnId);
  const msgs   = document.getElementById(msgsId);
  if (!input || !btn || !msgs) return;

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value   = '';
    btn.disabled  = true;
    appendMiniMsg(msgs, 'user', text);
    const tid = addMiniTyping(msgs);
    try {
      const { reply, error } = await post(endpoint, { message: text });
      removeEl(tid);
      appendMiniMsg(msgs, 'agent', error ? `שגיאה: ${error}` : reply);
    } catch {
      removeEl(tid);
      appendMiniMsg(msgs, 'agent', 'שגיאה בחיבור לשרת');
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  btn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

function appendMiniMsg(container, role, text) {
  const div = document.createElement('div');
  div.className = `mini-msg ${role === 'agent' ? 'mini-agent' : 'mini-user'}`;
  const safe = esc(text).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
  div.innerHTML = `<div class="mini-bubble">${safe}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addMiniTyping(container) {
  const id  = 'mt-' + Date.now();
  const div = document.createElement('div');
  div.id = id; div.className = 'mini-msg mini-agent';
  div.innerHTML = `<div class="mini-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAYA FULL CHAT HELPERS
   ══════════════════════════════════════════════════════════════════════════════ */

function appendMsg(container, role, text) {
  const div  = document.createElement('div');
  div.className = `chat-msg ${role === 'maya' ? 'maya-msg' : 'user-msg'}`;
  const safe = esc(text).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
  const t    = new Date().toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  div.innerHTML = `<div class="msg-bubble">${safe}</div><div class="msg-time">${t}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addTyping(container) {
  const id  = 'ty-' + Date.now();
  const div = document.createElement('div');
  div.id = id; div.className = 'chat-msg maya-msg typing';
  div.innerHTML = `<div class="msg-bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

/* ── Utilities ──────────────────────────────────────────────────────────────── */

function removeEl(id) { document.getElementById(id)?.remove(); }

function setTxt(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function setTBody(tbodyId, cols, msg) {
  const el = document.getElementById(tbodyId);
  if (el) el.innerHTML = `<tr><td colspan="${cols}" class="empty-state">${msg}</td></tr>`;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

function statusLabel(status) {
  return { hot:'🔥 חם', warm:'🌡️ פושר', cold:'❄️ קר', crisis:'🚨 משבר', new:'🆕 חדש' }[status] ?? status ?? '—';
}

function timeSince(date) {
  if (!date) return '—';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 30)    return 'עכשיו';
  if (s < 3600)  return `לפני ${Math.floor(s/60)||1} ד'`;
  if (s < 86400) return `לפני ${Math.floor(s/3600)} שע'`;
  return `לפני ${Math.floor(s/86400)} ימ'`;
}

function now() {
  return new Date().toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg) {
  const el = document.createElement('div');
  el.className   = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ══════════════════════════════════════════════════════════════════════════════
   SANDBOX TAB — Interactive Agent Testing
   ══════════════════════════════════════════════════════════════════════════════ */

let activeAgent    = 'maya';
let sandboxReady   = false;

const AGENT_META = {
  maya:  { label: 'מאיה', color: '#4f46e5', icon: '🏢' },
  dana:  { label: 'דנה',  color: '#ec4899', icon: '🎨' },
  tomer: { label: 'תומר', color: '#10b981', icon: '💌' },
  barak: { label: 'ברק',  color: '#f59e0b', icon: '📊' },
};

async function initSandbox() {
  if (sandboxReady) return;
  sandboxReady = true;

  // Load preset scenarios
  try {
    const { scenarios } = await fetch('/api/sandbox/scenarios').then(r => r.json());
    renderScenarios(scenarios);
  } catch { /* silent */ }

  // Agent selector
  document.querySelectorAll('.agent-sel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.agent-sel-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAgent = btn.dataset.agent;
    });
  });

  // Run button
  document.getElementById('sb-run')?.addEventListener('click', () => {
    const msg = document.getElementById('sb-input')?.value.trim();
    if (msg) runSandbox({ message: msg });
  });

  // Ctrl+Enter in textarea
  document.getElementById('sb-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) {
      const msg = e.target.value.trim();
      if (msg) runSandbox({ message: msg });
    }
  });
}

function renderScenarios(scenarios) {
  const el = document.getElementById('scenario-list');
  if (!el) return;
  el.innerHTML = scenarios.map(s => `
    <button class="scenario-btn" data-id="${esc(s.id)}" data-agent="${esc(s.agent)}">
      <span class="sc-icon">${s.icon}</span>
      <span class="sc-label">${esc(s.label)}</span>
      <span class="sc-agent" style="color:${AGENT_META[s.agent]?.color ?? '#64748b'}">${AGENT_META[s.agent]?.label ?? s.agent}</span>
    </button>`).join('');
  el.querySelectorAll('.scenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Switch to that agent
      activeAgent = btn.dataset.agent;
      document.querySelectorAll('.agent-sel-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.agent === activeAgent);
      });
      runSandbox({ scenario: btn.dataset.id });
    });
  });
}

async function runSandbox({ message, scenario } = {}) {
  const btn = document.getElementById('sb-run');
  const emEl = document.getElementById('sb-empty');
  const resEl = document.getElementById('sb-result');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מריץ...'; }
  if (emEl) emEl.style.display = 'flex';
  if (resEl) resEl.style.display = 'none';
  if (emEl) emEl.innerHTML = `
    <div class="va-empty-icon" style="animation:va-spin 1s linear infinite">⚙️</div>
    <div class="va-empty-title">מריץ סימולציה...</div>
    <div class="va-empty-sub">${AGENT_META[activeAgent]?.icon} ${AGENT_META[activeAgent]?.label} עונה...</div>`;

  try {
    const data = await post('/api/sandbox/simulate', { agent: activeAgent, message, scenario });
    renderSandboxResult(data);
  } catch (err) {
    if (emEl) emEl.innerHTML = `<div class="va-empty-icon">❌</div><div class="va-empty-title">שגיאה</div><div class="va-empty-sub">${esc(err.message)}</div>`;
    toast(`❌ ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ הרץ סימולציה'; }
  }
}

function renderSandboxResult(data) {
  const emEl  = document.getElementById('sb-empty');
  const resEl = document.getElementById('sb-result');
  const meta  = AGENT_META[data.agent] ?? {};

  if (emEl) emEl.style.display = 'none';
  if (resEl) resEl.style.display = 'block';

  setTxt('sb-elapsed', `${data.elapsed ?? 0}ms`);

  const badge = document.getElementById('sb-agent-label');
  if (badge) {
    badge.textContent = `${meta.icon ?? ''} ${meta.label ?? data.agent}`;
    badge.style.background = meta.color ?? '#64748b';
  }
  const tag = document.getElementById('sb-scenario-tag');
  if (tag) {
    tag.textContent = data.scenario ? `תרחיש: ${data.scenario}` : '';
    tag.style.display = data.scenario ? '' : 'none';
  }

  const promptEl = document.getElementById('sb-prompt-display');
  if (promptEl) promptEl.textContent = data.prompt ?? '';

  const replyEl = document.getElementById('sb-reply-display');
  if (replyEl) {
    const safe = esc(data.reply ?? '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    replyEl.innerHTML = safe;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   AUTOMATIONS TAB — Rules & Worker Control Panel
   ══════════════════════════════════════════════════════════════════════════════ */

const TRIGGER_LABELS = {
  lead_silent:          'ליד שקט',
  intro_not_redeemed:   'הצעה לא מומשת',
  lead_score_hot:       'ליד חם',
  member_inactive:      'חברה לא פעילה',
  lead_unsynced:        'ליד לא מסונכרן',
  meta_lead_webhook:    'ליד מ-Meta',
};
const ACTION_LABELS = {
  send_whatsapp: '💬 WhatsApp',
  alert_owner:   '🚨 התראת מנהל',
  arbox_sync:    '🔗 סנכרון Arbox',
  barak_ingest:  '📥 קליטת ליד',
};

async function loadAutomations() {
  try {
    const data = await fetch('/api/automations').then(r => r.json());
    renderWorkerCards(data.workers ?? []);
    renderRulesTable(data.rules ?? []);
  } catch (e) { console.error('loadAutomations', e); }

  try {
    const logData = await fetch('/api/automations/log').then(r => r.json());
    renderAutoLog(logData.log ?? []);
  } catch { /* silent */ }
}

function renderWorkerCards(workers) {
  const el = document.getElementById('auto-workers-grid');
  if (!el) return;
  el.innerHTML = workers.map(w => {
    const color = AGENT_META[w.agent]?.color ?? '#64748b';
    const lastRun = w.lastRun ? timeSince(w.lastRun) : 'טרם רץ';
    return `<div class="auto-worker-card panel">
      <div class="awc-top">
        <div class="awc-badge" style="background:${color}">${AGENT_META[w.agent]?.icon ?? '🤖'}</div>
        <div class="awc-info">
          <div class="awc-name">${esc(w.name)}</div>
          <div class="awc-sched">${esc(w.schedule)}</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" class="worker-toggle" data-id="${esc(w.id)}" ${w.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="awc-stats">
        <span class="awc-status ${w.enabled ? 'active' : 'paused'}">${w.enabled ? '● פעיל' : '⏸ מושהה'}</span>
        <span class="awc-runs">הרצות: ${w.runCount ?? 0}</span>
        <span class="awc-last">אחרון: ${lastRun}</span>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.worker-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.id;
      try {
        await post('/api/automations/toggle-worker', { id, enabled: cb.checked });
        toast(cb.checked ? '✅ Worker הופעל' : '⏸ Worker הושהה');
      } catch { cb.checked = !cb.checked; toast('❌ שגיאה בשינוי worker'); }
    });
  });
}

function renderRulesTable(rules) {
  const tbody = document.getElementById('auto-rules-tbody');
  if (!tbody) return;
  tbody.innerHTML = rules.map(r => {
    const tLbl = TRIGGER_LABELS[r.trigger?.type] ?? r.trigger?.type ?? '—';
    const aLbl = ACTION_LABELS[r.action?.type]   ?? r.action?.type  ?? '—';
    const agentColor = AGENT_META[r.action?.agent]?.color ?? '#64748b';
    const lastRun = r.lastRun ? timeSince(r.lastRun) : '—';
    return `<tr>
      <td style="text-align:center">
        <label class="toggle-switch">
          <input type="checkbox" class="rule-toggle" data-id="${esc(r.id)}" ${r.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td><span class="lead-name">${esc(r.name)}</span></td>
      <td><span class="badge warm" style="font-size:11px">${esc(tLbl)}</span></td>
      <td style="font-size:12px">${aLbl}</td>
      <td><span class="awc-badge" style="background:${agentColor};width:28px;height:14px;font-size:9px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;color:#fff">${AGENT_META[r.action?.agent]?.label ?? r.action?.agent ?? '—'}</span></td>
      <td style="text-align:center">${r.executionCount ?? 0}</td>
      <td style="color:var(--muted);font-size:12px">${lastRun}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.rule-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.id;
      try {
        await post('/api/automations/toggle-rule', { id, enabled: cb.checked });
        toast(cb.checked ? '✅ כלל הופעל' : '⏸ כלל הושהה');
      } catch { cb.checked = !cb.checked; toast('❌ שגיאה'); }
    });
  });
}

function renderAutoLog(log) {
  const el = document.getElementById('auto-log-list');
  if (!el) return;
  if (!log?.length) { el.innerHTML = '<div class="empty-state">אין הרצות עדיין</div>'; return; }
  el.innerHTML = log.map(entry => {
    const action = entry.result?.action ?? entry.result?.type ?? '';
    const detail = entry.result?.enabled !== undefined
      ? (entry.result.enabled ? 'הופעל' : 'הושהה')
      : (entry.result?.phone ? maskPhone(entry.result.phone) : '');
    return `<div class="feed-item">
      <div class="feed-agent-badge" style="background:#64748b;font-size:9px">אוטו</div>
      <div class="feed-body">
        <div class="feed-event">${esc(entry.name ?? entry.id)}</div>
        ${detail ? `<div class="feed-detail">${esc(String(detail))}</div>` : ''}
      </div>
      <div class="feed-time">${timeSince(entry.ts)}</div>
    </div>`;
  }).join('');
}

function maskPhone(p) {
  if (!p || p.length < 7) return p ?? '—';
  return p.slice(0, 5) + '••••' + p.slice(-3);
}

document.getElementById('btn-auto-refresh')?.addEventListener('click', loadAutomations);

/* ══════════════════════════════════════════════════════════════════════════════
   AGENT ACTIVITY FEED — real-time autonomous action log
   ══════════════════════════════════════════════════════════════════════════════ */

const AGENT_COLORS = {
  tomer: '#10b981', barak: '#f59e0b', dana: '#ec4899', maya: '#4f46e5',
};
const AGENT_LABELS = { tomer: 'תומר', barak: 'ברק', dana: 'דנה', maya: 'מאיה' };

const FEED_EVENT_LABELS = {
  tomer_followup_queued:  'פולו-אפ ליד — בתור',
  tomer_member_check:     'בדיקת חבר סטודיו',
  tomer_scan_complete:    'סריקת שימור הושלמה',
  tomer_message_sent:     'הודעה נשלחה',
  tomer_message_queued:   'הודעה בתור',
  barak_ingestion_complete:'בדיקת CRM הושלמה',
  barak_phone_invalid:    'מספר טלפון לא תקין',
  barak_duplicate_flag:   'ליד כפול זוהה',
  barak_high_value_pending:'ליד חם ללא הצעה',
  maya_daily_briefing:    'סיכום יומי',
  arbox_sync:             'סנכרון Arbox',
  content_pack_generated: 'חבילת תוכן נוצרה',
  ad_copy_generated:      'קופי פרסומת נוצר',
  video_analysis:         'ניתוח וידאו',
  meta_lead_webhook:      'ליד מ-Meta',
  re_engagement_sent:     'ריאנגייג\'מנט נשלח',
  intro_offer_sent:       'הצעת היכרות נשלחה',
  booking_confirmed:      'הזמנה אושרה',
  crisis:                 'משבר זוהה',
  message_in:             'הודעה נכנסת',
  message_out:            'הודעה יוצאת',
  arbox_full_sync:        'סנכרון Arbox מלא',
  manual_whatsapp:        'WhatsApp ידני',
};

async function loadAgentFeed() {
  try {
    const { events = [] } = await fetch('/api/system/events').then(r => r.json());
    renderAgentFeed(events);
    const upEl = document.getElementById('feed-updated');
    if (upEl) upEl.textContent = 'עודכן: ' + now();
  } catch (e) { /* silent fail — feed is non-critical */ }
}

function renderAgentFeed(events) {
  const container = document.getElementById('agent-feed-list');
  if (!container) return;
  if (!events?.length) {
    container.innerHTML = '<div class="empty-state">אין פעולות עדיין — הסוכנים מחכים לנתונים</div>';
    return;
  }
  container.innerHTML = events.map(e => {
    const agent  = e.data?.agent ?? guessAgent(e.type);
    const color  = AGENT_COLORS[agent] ?? '#64748b';
    const label  = AGENT_LABELS[agent] ?? agent ?? '—';
    const evLbl  = FEED_EVENT_LABELS[e.type] ?? e.type;
    const detail = feedDetail(e);
    const t      = timeSince(e.ts);
    return `<div class="feed-item">
      <div class="feed-agent-badge" style="background:${color}">${esc(label)}</div>
      <div class="feed-body">
        <div class="feed-event">${esc(evLbl)}</div>
        ${detail ? `<div class="feed-detail">${detail}</div>` : ''}
      </div>
      <div class="feed-time">${t}</div>
    </div>`;
  }).join('');
}

function guessAgent(type) {
  if (!type) return null;
  if (type.startsWith('tomer')) return 'tomer';
  if (type.startsWith('barak') || type === 'arbox_sync' || type === 'arbox_full_sync') return 'barak';
  if (type.startsWith('dana') || type === 'content_pack_generated' || type === 'ad_copy_generated' || type === 'video_analysis') return 'dana';
  if (type.startsWith('maya')) return 'maya';
  return null;
}

function feedDetail(e) {
  const d = e.data ?? {};
  if (d.headline)   return esc(d.headline);
  if (d.preview)    return esc(d.preview);
  if (d.name && d.touch)
    return `${esc(d.name)} — נגיעה #${d.touch} (${d.silent ?? '?'}ד שקט)`;
  if (d.name && d.daysSince !== undefined)
    return `${esc(d.name)} — ${d.daysSince}ד ללא ביקור (${esc(d.planType ?? '')})`;
  if (d.name && d.issue)
    return `${esc(d.name)}: ${esc(d.issue)}`;
  if (d.total !== undefined && d.actionsQueued !== undefined)
    return `${d.dormantLeads ?? 0} לידים + ${d.inactiveMembers ?? 0} חברות → ${d.actionsQueued} פעולות`;
  if (d.total !== undefined && d.pendingSync !== undefined)
    return `${d.total} לידים נבדקו | ${d.invalid} לא תקינים | ${d.pendingSync} ממתינים לסנכרון`;
  if (d.name)       return esc(d.name);
  if (e.phone)      return esc(e.phone.slice(0, 8) + '•••');
  return '';
}

/* ══════════════════════════════════════════════════════════════════════════════
   WHATSAPP LIVE — Threaded Chat Interface
   ══════════════════════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────────────────
let waThreads      = [];    // cached thread summaries
let waActivePhone  = null;  // phone of currently open thread
let waActiveThread = null;  // full thread data with messages
let waSearchQuery  = '';    // search filter text
let waSSE          = null;  // EventSource for real-time updates

// ── Intent / route label maps ─────────────────────────────────────────────────
const WA_INTENT = {
  cancellation:          { label: 'ביטול',       cls: 'cancellation'   },
  booking:               { label: 'הזמנה',       cls: 'booking'        },
  fixed_booking:         { label: 'שיבוץ קבוע', cls: 'fixed_booking'  },
  reschedule:            { label: 'שינוי מועד',  cls: 'booking'        },
  representative:        { label: 'נציג',         cls: 'booking'        },
  schedule_query:        { label: 'לוח שיעורים',cls: 'schedule_query' },
  general:               { label: 'כללי',         cls: 'general'        },
};

const WA_ROUTE = {
  barak:                   { label: 'ברק',         cls: 'barak'      },
  lead_agent:              { label: 'ליד-סוכן',   cls: 'lead_agent' },
  tomer:                   { label: 'תומר',        cls: 'barak'      },
  appointment_created:     { label: 'פגישה',       cls: 'booking'    },
  appointment_rescheduled: { label: 'שינוי פגישה',cls: 'booking'    },
  reschedule_prompt:       { label: 'שינוי מועד', cls: 'booking'    },
  unhandled:               { label: 'לא נוצל',    cls: 'general'    },
};

const AVATAR_COLORS = ['#4f46e5','#ec4899','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16'];
function avatarColor(str) {
  let h = 0;
  for (let i = 0; i < (str||'').length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function formatThreadTime(ts) {
  if (!ts) return '';
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}

// ── SSE connection ────────────────────────────────────────────────────────────
function connectWaSSE() {
  if (waSSE) return;
  const dot = document.getElementById('wa-sse-dot');
  try {
    waSSE = new EventSource('/api/whatsapp/stream');

    waSSE.onopen = () => {
      if (dot) { dot.classList.remove('disconnected'); dot.classList.add('connected'); dot.title = 'מחובר — בזמן אמת'; }
    };
    waSSE.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.event === 'message') {
          loadWaThreads(false);
          if (waActivePhone && waActivePhone === data.phone) loadActiveThread(data.phone);
        }

        if (data.event === 'sync_complete') {
          // Green API sync finished (startup or manual) — refresh thread list
          loadWaThreads(!waActivePhone); // auto-select first only if nothing open
          const dot = document.getElementById('wa-sse-dot');
          if (dot) dot.title = `מסונכרן — ${data.messages ?? 0} הודעות מ-${data.chats ?? 0} שיחות`;
        }

        if (data.event === 'new_lead') {
          // A Meta Ads lead just landed in the CRM — refresh all lead panels instantly
          // without waiting for the 5-second polling interval.
          loadBarakPanel();
          loadMayaStats();
          loadAgentFeed();
        }
      } catch {}
    };
    waSSE.onerror = () => {
      if (dot) { dot.classList.remove('connected'); dot.classList.add('disconnected'); dot.title = 'לא מחובר'; }
      waSSE.close(); waSSE = null;
      setTimeout(connectWaSSE, 5000);
    };
  } catch {
    if (dot) { dot.classList.add('disconnected'); dot.title = 'SSE לא נתמך'; }
  }
}

// ── Load threads ─────────────────────────────────────────────────────────────
async function loadWaThreads(autoSelectFirst = true) {
  try {
    const [threadsData, statsData] = await Promise.all([
      fetch('/api/whatsapp/threads?limit=60').then(r => r.json()),
      fetch('/api/whatsapp/stats').then(r => r.json()),
    ]);
    waThreads = threadsData.threads ?? [];
    renderWaThreadStats(threadsData, statsData);
    renderWaThreadList();
    if (autoSelectFirst && !waActivePhone && waThreads.length > 0) {
      selectWaThread(waThreads[0].phone);
    }
  } catch (e) { console.error('loadWaThreads', e); }
}

// Alias for the refresh timer and any other callers
function loadWhatsAppInbox() { loadWaThreads(false); }

// ── Stats chips ───────────────────────────────────────────────────────────────
function renderWaThreadStats(threadsData, statsData) {
  setTxt('ws-total',  threadsData.threads?.length ?? 0);
  setTxt('ws-unread', threadsData.unread ?? 0);

  const ic = statsData.intentCounts ?? {};
  setTxt('ws-sched',  (ic.schedule_query ?? 0) + (ic.booking ?? 0) + (ic.fixed_booking ?? 0));
  setTxt('ws-cancel', ic.cancellation ?? 0);

  const clientCount = (threadsData.threads ?? []).filter(t => t.clientMatch?.matchType === 'member').length;
  const leadCount   = (threadsData.threads ?? []).filter(t => t.clientMatch?.matchType === 'lead').length;
  setTxt('ws-client', clientCount);
  setTxt('ws-lead',   leadCount);
}

// ── Thread list rendering ─────────────────────────────────────────────────────
function renderWaThreadList() {
  const el = document.getElementById('wa-threads-list');
  if (!el) return;

  const q = waSearchQuery.toLowerCase().trim();
  const filtered = q
    ? waThreads.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.phone || '').includes(q) ||
        (t.fromIsraeli || '').includes(q)
      )
    : waThreads;

  if (!filtered.length) {
    el.innerHTML = `<div class="wa-threads-empty">${q ? 'לא נמצאו תוצאות' : 'אין שיחות עדיין'}</div>`;
    return;
  }

  el.innerHTML = filtered.map(t => {
    const isActive  = t.phone === waActivePhone;
    const hasUnread = t.unreadCount > 0;
    const display   = t.name || t.fromIsraeli || t.phone;
    const color     = avatarColor(display);
    const timeStr   = formatThreadTime(t.lastAt);
    const cm        = t.clientMatch;
    const badgeCls  = cm?.matchType === 'member' ? 'member' : cm?.matchType === 'lead' ? 'lead' : '';

    return `
    <div class="wa-thread-item${isActive ? ' active' : ''}${hasUnread ? ' has-unread' : ''}"
         onclick="selectWaThread('${esc(t.phone)}')">
      <div class="wa-thread-avatar" style="background:${color}">${initials(display)}</div>
      <div class="wa-thread-info">
        <div class="wa-thread-row1">
          <span class="wa-thread-name">${esc(display)}</span>
          <span class="wa-thread-time">${esc(timeStr)}</span>
        </div>
        <div class="wa-thread-row2">
          <span class="wa-thread-preview">${esc((t.lastText || '').slice(0, 48))}</span>
          ${hasUnread ? `<span class="wa-thread-badge">${t.unreadCount}</span>` : ''}
        </div>
        ${badgeCls ? `<div class="wa-thread-row3"><span class="wa-client-badge ${badgeCls}">${cm.matchType === 'member' ? '✅ לקוח' : '🎯 ליד'}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Select & open thread ──────────────────────────────────────────────────────
async function selectWaThread(phone) {
  waActivePhone = phone;
  renderWaThreadList();

  document.getElementById('wa-chat-pane-empty')?.style.setProperty('display', 'none');
  const tv = document.getElementById('wa-thread-view');
  if (tv) tv.style.display = 'flex';

  await loadActiveThread(phone);
}

async function loadActiveThread(phone) {
  try {
    const d = await fetch(`/api/whatsapp/threads/${encodeURIComponent(phone)}`).then(r => r.json());
    if (d.error) return;
    waActiveThread = d.thread;

    const t = waThreads.find(x => x.phone === phone);
    if (t) t.unreadCount = 0;
    renderWaThreadList();

    renderWaThreadHeader(d.thread);
    renderWaThreadMessages(d.thread.messages ?? []);
  } catch (e) { console.error('loadActiveThread', e); }
}

// ── Thread header ─────────────────────────────────────────────────────────────
function renderWaThreadHeader(thread) {
  const el = document.getElementById('wa-thread-header');
  if (!el) return;

  const display = thread.name || thread.phone;
  const phone   = thread.fromIsraeli || thread.phone;
  const color   = avatarColor(display);
  const cm      = thread.clientMatch;

  el.innerHTML = `
    <div class="wa-thdr-avatar" style="background:${color}">${initials(display)}</div>
    <div class="wa-thdr-info">
      <div class="wa-thdr-name">${esc(display)}</div>
      <div class="wa-thdr-phone" dir="ltr">${esc(phone)}</div>
    </div>
    <div class="wa-thdr-actions">
      ${cm?.found && cm.matchType === 'member'
        ? `<span class="wa-client-badge member">✅ לקוח Arbox</span>`
        : cm?.found && cm.matchType === 'lead'
        ? `<span class="wa-client-badge lead">🎯 ליד Arbox</span>`
        : ''}
      <span class="wa-msg-count-badge">${thread.messages?.length ?? 0} הודעות</span>
      <a class="wa-open-link" href="https://wa.me/${thread.phone}" target="_blank">📱 פתח</a>
    </div>`;
}

// ── Messages rendering ────────────────────────────────────────────────────────
function renderWaThreadMessages(messages) {
  const el = document.getElementById('wa-thread-messages');
  if (!el) return;

  if (!messages.length) {
    el.innerHTML = `<div class="wa-msgs-empty">אין הודעות בשיחה זו</div>`;
    return;
  }

  let currentDate = null;
  const parts = [];

  messages.forEach(m => {
    const ts   = m.timestamp ? new Date(m.timestamp) : new Date();
    const dStr = ts.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

    if (dStr !== currentDate) {
      currentDate = dStr;
      parts.push(`<div class="wa-date-divider"><span>${esc(dStr)}</span></div>`);
    }

    const isOut   = m.direction === 'out';
    const timeStr = ts.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

    const agentLabel = isOut
      ? m.agentId === 'barak'  ? '🤖 ברק'
      : m.agentId === 'tomer'  ? '💚 תומר'
      : m.agentId === 'manual' ? '✍️ ידני'
      : m.agentId              ? esc(m.agentId) : 'שלחנו'
      : null;

    const intentInfo = !isOut && m.intent && WA_INTENT[m.intent] ? WA_INTENT[m.intent] : null;

    const mediaTag = !isOut && m.mediaType && m.mediaType !== 'text'
      ? `<span class="bubble-media-tag">${({'image':'🖼️','video':'🎥','audio':'🎵','voice':'🎤','document':'📄'}[m.mediaType]??'📎')} ${m.mediaType}</span>`
      : '';

    parts.push(`
      <div class="wa-msg-row ${isOut ? 'wa-msg-out' : 'wa-msg-in'}">
        <div class="wa-bubble ${isOut ? 'bubble-out' : 'bubble-in'}">
          ${mediaTag}
          <div class="bubble-text">${esc(m.text || (m.mediaType ? `[${m.mediaType}]` : '—'))}</div>
          <div class="bubble-footer">
            ${agentLabel ? `<span class="bubble-agent">${agentLabel}</span>` : ''}
            ${intentInfo ? `<span class="wa-intent-tag ${intentInfo.cls}" style="font-size:10px;padding:1px 6px">${intentInfo.label}</span>` : ''}
            <span class="bubble-time">${timeStr}</span>
          </div>
        </div>
      </div>`);
  });

  el.innerHTML = parts.join('');
  el.scrollTop = el.scrollHeight;
}

// ── Reply ─────────────────────────────────────────────────────────────────────
async function sendWaReply() {
  const input = document.getElementById('wa-reply-input');
  const btn   = document.getElementById('wa-reply-send');
  const text  = input?.value.trim();
  if (!text)          { toast('⚠️ הזן הודעה'); return; }
  if (!waActivePhone) { toast('⚠️ בחר שיחה תחילה'); return; }

  btn.disabled = true; btn.textContent = '⏳';
  try {
    await post(`/api/whatsapp/threads/${encodeURIComponent(waActivePhone)}/send`, {
      text, name: waActiveThread?.name ?? null,
    });
    input.value = '';
    await loadActiveThread(waActivePhone);
    toast('✅ הודעה נשלחה');
  } catch (err) {
    toast(`❌ שליחה נכשלה — ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'שלח ›';
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────
document.getElementById('btn-wa-refresh')?.addEventListener('click', () => loadWaThreads(false));

// ── Green API history sync ────────────────────────────────────────────────────
document.getElementById('btn-sync-green')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync-green');
  if (!btn) return;

  // Check status first to show a helpful message if not configured
  try {
    const status = await fetch('/api/whatsapp/sync-green').then(r => r.json());
    if (!status.configured) {
      toast('⚠️ Green API לא מוגדר — הגדר GREEN_API_URL / INSTANCE_ID / TOKEN');
      return;
    }
  } catch { /* non-fatal — proceed to sync */ }

  btn.disabled  = true;
  btn.textContent = '⏳';
  btn.title       = 'מסנכרן...';

  try {
    const d = await post('/api/whatsapp/sync-green', {});
    if (!d.ok) throw new Error(d.reason ?? 'Sync failed');

    toast(`✅ Green API: ${d.messages} הודעות סונכרנו מ-${d.chats} שיחות`);
    await loadWaThreads(!waActivePhone); // auto-select if nothing open yet
  } catch (err) {
    toast(`❌ Green API סנכרון נכשל — ${err.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = '📲';
    btn.title       = 'סנכרן היסטוריה מ-Green API';
  }
});

document.getElementById('btn-wa-read-all')?.addEventListener('click', async () => {
  await fetch('/api/whatsapp/inbox/read-all', { method: 'POST' });
  waThreads.forEach(t => { t.unreadCount = 0; });
  renderWaThreadList();
  toast('✅ כל ההודעות סומנו כנקרא');
});

document.getElementById('wa-thread-search')?.addEventListener('input', (e) => {
  waSearchQuery = e.target.value;
  renderWaThreadList();
});

document.getElementById('wa-reply-send')?.addEventListener('click', sendWaReply);
document.getElementById('wa-reply-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendWaReply(); }
});

// Collapsible simulator toggle
document.getElementById('wa-sim-toggle')?.addEventListener('click', () => {
  const body = document.getElementById('wa-sim-expanded');
  const btn  = document.getElementById('wa-sim-toggle');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  btn.textContent = `🧪 כלי בדיקה — סימולציית הודעה נכנסת ${open ? '▾' : '▴'}`;
});

// Example pills
document.querySelectorAll('.wa-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const input = document.getElementById('wa-sim-text');
    if (input) { input.value = pill.dataset.txt; input.focus(); }
  });
});

// ── Simulate send ─────────────────────────────────────────────────────────────
document.getElementById('btn-wa-sim')?.addEventListener('click', runWaSimulate);
document.getElementById('wa-sim-text')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') runWaSimulate();
});

async function runWaSimulate() {
  const btn    = document.getElementById('btn-wa-sim');
  const result = document.getElementById('wa-sim-result');
  const phone  = document.getElementById('wa-sim-phone')?.value.trim() || '0521111111';
  const name   = document.getElementById('wa-sim-name')?.value.trim()  || 'בדיקה';
  const text   = document.getElementById('wa-sim-text')?.value.trim();
  if (!text) { toast('⚠️ יש להזין תוכן הודעה'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  if (result) result.style.display = 'none';

  try {
    const d = await post('/api/whatsapp/simulate', { from: phone, name, text });
    if (result) {
      const intent = WA_INTENT[d.intent] ?? WA_INTENT.general;
      const route  = WA_ROUTE[d.route]   ?? WA_ROUTE.unhandled;
      const cMatch = d.clientMatch ?? {};
      result.innerHTML = `
        <div class="wa-sim-result-grid">
          <div class="wa-sim-result-chip"><b>כוונה</b><span class="wa-intent-tag ${intent.cls}">${intent.label}</span></div>
          <div class="wa-sim-result-chip"><b>ניתוב</b><span class="wa-route-badge ${route.cls}">${route.label}</span></div>
          <div class="wa-sim-result-chip"><b>Arbox</b>${cMatch.found ? esc(cMatch.arboxName ?? '—') : 'לא נמצא'}</div>
          <div class="wa-sim-result-chip"><b>Inbox ID</b><span style="color:var(--muted);font-size:11px">${esc((d.inboxId ?? '').slice(-8))}</span></div>
        </div>
        ${d.barakReply ? `<div style="margin-top:10px;padding:12px;background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;font-size:13px;white-space:pre-wrap"><strong style="font-size:11px;color:#92400e;display:block;margin-bottom:6px">🤖 תשובת ברק</strong>${esc(d.barakReply)}</div>` : ''}`;
      result.style.display = 'block';
    }
    toast('✅ הודעת בדיקה נשלחה');
    if (document.querySelector('.tab-btn.active')?.dataset?.tab === 'whatsapp') {
      setTimeout(() => loadWaThreads(false), 600);
    }
  } catch (err) {
    toast(`❌ ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ שלח'; }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   KNOWLEDGE TAB — Staff directory, subscription packages, agent sync
   ══════════════════════════════════════════════════════════════════════════════ */

let knowledgeData   = null;   // cached raw data from /api/admin/knowledge
let studioAssetsData = null;  // cached raw data from /api/admin/studio-assets
let activeKnView    = 'staff';

// ── Sub-nav wiring ────────────────────────────────────────────────────────────
document.querySelectorAll('.kn-sv-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.kn-sv-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeKnView = btn.dataset.knview;
    showKnView(activeKnView);
  });
});

function showKnView(view) {
  ['staff', 'packages', 'classes', 'verify', 'assets'].forEach(v => {
    const el = document.getElementById(`kn-view-${v}`);
    if (el) el.style.display = v === view ? '' : 'none';
  });
  // Lazy-load assets data the first time the panel is opened
  if (view === 'assets' && !studioAssetsData) loadStudioAssets();
}

// ── Load knowledge from server ────────────────────────────────────────────────
async function loadKnowledge(force = false) {
  if (knowledgeData && !force) { renderKnowledge(knowledgeData); return; }
  try {
    // Fetch knowledge + studio assets in parallel; asset failures are non-fatal
    const [d] = await Promise.all([
      fetch('/api/admin/knowledge').then(r => r.json()),
      loadStudioAssets(),
    ]);
    knowledgeData = d;
    renderKnowledge(d);
  } catch (err) {
    toast(`❌ שגיאה בטעינת ידע: ${err.message}`);
  }
}

// ── Studio Assets ─────────────────────────────────────────────────────────────
async function loadStudioAssets() {
  try {
    const d = await fetch('/api/admin/studio-assets').then(r => r.json());
    if (!d.ok) return;
    studioAssetsData = d;
    renderStudioAssets(d);
  } catch { /* non-fatal — panel may not be visible yet */ }
}

function renderStudioAssets(d) {
  // Waze URL field
  const wazeEl    = document.getElementById('asset-waze-url');
  const previewEl = document.getElementById('asset-waze-preview');
  if (wazeEl) wazeEl.value = d.wazeUrl ?? '';
  if (previewEl) previewEl.href = d.wazeUrl || '#';

  // Timetable URL field (optional fallback)
  const timetableUrlEl = document.getElementById('asset-timetable-url');
  if (timetableUrlEl) timetableUrlEl.value = d.timetableUrl ?? '';

  // Helper: render one timetable image block
  function renderTimetableBlock(uploaded, apiPath, wrapId, imgId, statusId) {
    const wrap   = document.getElementById(wrapId);
    const img    = document.getElementById(imgId);
    const status = document.getElementById(statusId);
    if (uploaded) {
      if (img)    { img.src = `${apiPath}?t=${Date.now()}`; img.style.display = 'block'; }
      if (wrap)   wrap.style.display = '';
      if (status) { status.textContent = '✅ תמונה מועלת — ברק ישלח אותה ישירות'; status.style.color = 'var(--success, #22c55e)'; }
    } else {
      if (wrap)   wrap.style.display = 'none';
      if (status) { status.textContent = 'לא הועלתה תמונה'; status.style.color = 'var(--muted, #888)'; }
    }
  }

  renderTimetableBlock(d.timetableImageUploaded,  '/api/admin/timetable-image',  'timetable-current-wrap',  'timetable-preview',  'timetable-upload-status');
  renderTimetableBlock(d.timetable2ImageUploaded, '/api/admin/timetable2-image', 'timetable2-current-wrap', 'timetable2-preview', 'timetable2-upload-status');
}

// Update Waze preview link as the user types
document.getElementById('asset-waze-url')?.addEventListener('input', e => {
  const preview = document.getElementById('asset-waze-preview');
  if (preview) preview.href = e.target.value.trim() || '#';
});

// Timetable file picker — auto-upload on selection
document.getElementById('asset-timetable-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const nameEl    = document.getElementById('timetable-file-name');
  const spinner   = document.getElementById('timetable-upload-spinner');
  const statusEl  = document.getElementById('timetable-upload-status');
  const previewImg = document.getElementById('timetable-preview');
  const previewWrap = document.getElementById('timetable-current-wrap');

  if (nameEl)  nameEl.textContent  = file.name;
  if (spinner) spinner.style.display = '';

  const reader = new FileReader();
  reader.onload = async (ev) => {
    // Show local preview immediately
    if (previewImg) { previewImg.src = ev.target.result; previewImg.style.display = 'block'; }
    if (previewWrap) previewWrap.style.display = '';

    try {
      const d = await post('/api/admin/studio-assets/timetable', { imageData: ev.target.result });
      if (!d.ok) throw new Error(d.error ?? 'unknown error');
      toast('✅ מערכת שעות הועלתה — ברק ישלח אותה ישירות');
      if (statusEl) { statusEl.textContent = '✅ תמונה מועלת — ברק ישלח אותה ישירות'; statusEl.style.color = 'var(--success, #22c55e)'; }
      // Refresh server data
      const fresh = await fetch('/api/admin/studio-assets').then(r => r.json());
      if (fresh.ok) studioAssetsData = fresh;
    } catch (err) {
      toast(`❌ שגיאה בהעלאה: ${err.message}`);
      if (statusEl) { statusEl.textContent = `❌ ${err.message}`; statusEl.style.color = 'var(--hot, #ef4444)'; }
    } finally {
      if (spinner) spinner.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
});

// Timetable 2 file picker — same pattern as timetable 1
document.getElementById('asset-timetable2-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const nameEl    = document.getElementById('timetable2-file-name');
  const spinner   = document.getElementById('timetable2-upload-spinner');
  const statusEl  = document.getElementById('timetable2-upload-status');
  const previewImg  = document.getElementById('timetable2-preview');
  const previewWrap = document.getElementById('timetable2-current-wrap');

  if (nameEl)  nameEl.textContent  = file.name;
  if (spinner) spinner.style.display = '';

  const reader = new FileReader();
  reader.onload = async (ev) => {
    if (previewImg) { previewImg.src = ev.target.result; previewImg.style.display = 'block'; }
    if (previewWrap) previewWrap.style.display = '';
    try {
      const d = await post('/api/admin/studio-assets/timetable2', { imageData: ev.target.result });
      if (!d.ok) throw new Error(d.error ?? 'unknown error');
      toast('✅ תמונת מערכת שעות 2 הועלתה');
      if (statusEl) { statusEl.textContent = '✅ תמונה מועלת — ברק ישלח אותה ישירות'; statusEl.style.color = 'var(--success, #22c55e)'; }
      const fresh = await fetch('/api/admin/studio-assets').then(r => r.json());
      if (fresh.ok) studioAssetsData = fresh;
    } catch (err) {
      toast(`❌ שגיאה בהעלאה: ${err.message}`);
      if (statusEl) { statusEl.textContent = `❌ ${err.message}`; statusEl.style.color = 'var(--hot, #ef4444)'; }
    } finally {
      if (spinner) spinner.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
});

// Save assets button (saves Waze URL + timetable URL text fields)
document.getElementById('btn-save-assets')?.addEventListener('click', async () => {
  const wazeUrl      = document.getElementById('asset-waze-url')?.value.trim()      ?? '';
  const timetableUrl = document.getElementById('asset-timetable-url')?.value.trim() ?? '';
  const btn      = document.getElementById('btn-save-assets');
  const statusEl = document.getElementById('assets-save-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ שומר...'; }
  try {
    const d = await post('/api/admin/studio-assets', { wazeUrl, timetableUrl });
    if (!d.ok) throw new Error(d.error ?? 'unknown error');
    studioAssetsData = d;
    renderStudioAssets(d);
    toast('✅ נכסים נשמרו — ברק ישתמש בהם מיד');
    if (statusEl) { statusEl.textContent = `✅ נשמר — ${new Date().toLocaleTimeString('he-IL')}`; statusEl.style.display = ''; }
  } catch (err) {
    toast(`❌ שגיאה בשמירה: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 שמור שינויים'; }
  }
});

function renderKnowledge(d) {
  renderStaffTable(d.staff?.instructors ?? []);
  renderPackages(d.packages ?? {});
  renderClassesTable(d.classes ?? {});
  showKnView(activeKnView);
}

// ── Staff table ───────────────────────────────────────────────────────────────
function renderStaffTable(instructors) {
  const tbody = document.getElementById('kn-staff-tbody');
  if (!tbody) return;
  if (!instructors.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">אין מדריכים בספרייה</td></tr>`;
    return;
  }
  tbody.innerHTML = instructors.map((s, i) => {
    const specs = (s.specialties ?? []).join(', ');
    const bio   = s.bio ?? '';
    return `
      <tr data-idx="${i}">
        <td style="font-weight:600;white-space:nowrap">${esc(s.name_he)}<br><span style="font-size:11px;color:var(--muted)">${esc(s.name_en ?? '')}</span></td>
        <td><input class="kn-edit-input kn-spec" data-idx="${i}" value="${esc(specs)}" placeholder="פילאטיס, שיקומי..." style="min-width:160px"/></td>
        <td style="text-align:center">
          <button class="kn-toggle-btn ${s.rehab ? 'on' : 'off'}" data-idx="${i}" data-field="rehab" title="${s.rehab ? 'שיקומי ✓' : 'לא שיקומי'}">
            ${s.rehab ? '✅' : '⬜'}
          </button>
        </td>
        <td style="text-align:center">
          <button class="kn-toggle-btn ${s.pre_postnatal ? 'on' : 'off'}" data-idx="${i}" data-field="pre_postnatal" title="${s.pre_postnatal ? 'לידה ✓' : 'לא לידה'}">
            ${s.pre_postnatal ? '✅' : '⬜'}
          </button>
        </td>
        <td><input class="kn-edit-input kn-bio" data-idx="${i}" value="${esc(bio)}" placeholder="תיאור קצר..." style="min-width:180px"/></td>
      </tr>`;
  }).join('');

  // Toggle buttons
  tbody.querySelectorAll('.kn-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx   = parseInt(btn.dataset.idx, 10);
      const field = btn.dataset.field;
      knowledgeData.staff.instructors[idx][field] = !knowledgeData.staff.instructors[idx][field];
      renderStaffTable(knowledgeData.staff.instructors);
    });
  });

  // Live-sync text inputs into knowledgeData
  tbody.querySelectorAll('.kn-spec').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      knowledgeData.staff.instructors[idx].specialties =
        inp.value.split(',').map(s => s.trim()).filter(Boolean);
    });
  });
  tbody.querySelectorAll('.kn-bio').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      knowledgeData.staff.instructors[idx].bio = inp.value.trim();
    });
  });

  const upEl = document.getElementById('kn-staff-updated');
  if (upEl) upEl.textContent = 'עודכן: ' + now();
}

// ── Packages panel ────────────────────────────────────────────────────────────
function renderPackages(pkg) {
  // Trial
  const trialFields = document.getElementById('kn-trial-fields');
  if (trialFields && pkg.trial) {
    const t = pkg.trial;
    trialFields.innerHTML = `
      <label>כניסות: <input class="kn-edit-input" id="kn-trial-entries" value="${esc(String(t.entries ?? 2))}" style="max-width:60px"/></label>
      <label>מחיר ₪: <input class="kn-edit-input" id="kn-trial-price" type="number" value="${t.price_ils ?? ''}" placeholder="60" style="max-width:80px"/></label>
      <label>תיאור: <input class="kn-edit-input" id="kn-trial-desc" value="${esc(t.description ?? '')}" style="min-width:220px"/></label>
    `;
    document.getElementById('kn-trial-entries')?.addEventListener('change', e => { knowledgeData.packages.trial.entries = parseInt(e.target.value) || 2; });
    document.getElementById('kn-trial-price')?.addEventListener('change',   e => { knowledgeData.packages.trial.price_ils = e.target.value ? parseFloat(e.target.value) : null; });
    document.getElementById('kn-trial-desc')?.addEventListener('change',   e => { knowledgeData.packages.trial.description = e.target.value.trim(); });
  }

  // Monthly packages
  const tbody = document.getElementById('kn-pkg-tbody');
  if (!tbody) return;
  const packages = pkg.packages ?? [];
  if (!packages.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">אין חבילות מנוי</td></tr>`;
    return;
  }
  tbody.innerHTML = packages.map((p, i) => `
    <tr data-idx="${i}">
      <td><input class="kn-edit-input kn-pkg-name" data-idx="${i}" value="${esc(p.name ?? '')}" /></td>
      <td style="text-align:center">${p.entries_per_month != null ? p.entries_per_month : '∞'}</td>
      <td><input class="kn-edit-input kn-pkg-price" data-idx="${i}" type="number" value="${p.price_ils ?? ''}" placeholder="לפי בקשה" style="max-width:100px"/></td>
      <td><input class="kn-edit-input kn-pkg-best" data-idx="${i}" value="${esc(p.best_for ?? '')}" /></td>
      <td><input class="kn-edit-input kn-pkg-desc" data-idx="${i}" value="${esc(p.description ?? '')}" style="min-width:180px"/></td>
    </tr>`).join('');

  tbody.querySelectorAll('.kn-pkg-name').forEach(inp => {
    inp.addEventListener('change', () => { knowledgeData.packages.packages[parseInt(inp.dataset.idx)].name = inp.value.trim(); });
  });
  tbody.querySelectorAll('.kn-pkg-price').forEach(inp => {
    inp.addEventListener('change', () => {
      knowledgeData.packages.packages[parseInt(inp.dataset.idx)].price_ils = inp.value ? parseFloat(inp.value) : null;
    });
  });
  tbody.querySelectorAll('.kn-pkg-best').forEach(inp => {
    inp.addEventListener('change', () => { knowledgeData.packages.packages[parseInt(inp.dataset.idx)].best_for = inp.value.trim(); });
  });
  tbody.querySelectorAll('.kn-pkg-desc').forEach(inp => {
    inp.addEventListener('change', () => { knowledgeData.packages.packages[parseInt(inp.dataset.idx)].description = inp.value.trim(); });
  });

  const upEl = document.getElementById('kn-pkg-updated');
  if (upEl) upEl.textContent = 'עודכן: ' + now();
}

// ── Classes / Workouts table ──────────────────────────────────────────────────

function renderClassesTable(classesData) {
  const tbody = document.getElementById('kn-classes-tbody');
  if (!tbody) return;
  const list = classesData.classes ?? [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">אין שיעורים מוגדרים</td></tr>';
    return;
  }

  // Ensure knowledgeData.classes exists for live sync
  if (knowledgeData && !knowledgeData.classes) knowledgeData.classes = classesData;

  tbody.innerHTML = list.map((c, idx) => `
    <tr>
      <td style="font-weight:600;font-size:13px">${esc(c.name_he)}<br><span style="font-size:11px;color:var(--muted)">${esc(c.name_en ?? '')}</span></td>
      <td style="text-align:center">
        <input type="number" min="1" max="30" class="kn-edit-input kn-cls-cap" data-idx="${idx}" value="${c.capacity ?? ''}" style="width:52px;text-align:center"/>
      </td>
      <td>
        <input type="text" class="kn-edit-input kn-cls-int" data-idx="${idx}" value="${esc(c.intensity ?? '')}" style="width:100%"/>
      </td>
      <td>
        <input type="text" class="kn-edit-input kn-cls-pitch" data-idx="${idx}" value="${esc(c.pitch ?? '')}" style="width:100%"/>
      </td>
      <td>
        <input type="text" class="kn-edit-input kn-cls-best" data-idx="${idx}" value="${esc(c.best_for ?? '')}" style="width:100%"/>
      </td>
      <td>
        <input type="text" class="kn-edit-input kn-cls-notes" data-idx="${idx}" value="${esc(c.notes ?? '')}" style="width:100%"/>
      </td>
    </tr>`).join('');

  // Live-sync edits back to knowledgeData.classes.classes
  tbody.querySelectorAll('.kn-cls-cap,.kn-cls-int,.kn-cls-pitch,.kn-cls-best,.kn-cls-notes')
    .forEach(input => {
      input.addEventListener('input', () => {
        const i = parseInt(input.dataset.idx, 10);
        const field = input.classList.contains('kn-cls-cap')   ? 'capacity'
                    : input.classList.contains('kn-cls-int')   ? 'intensity'
                    : input.classList.contains('kn-cls-pitch') ? 'pitch'
                    : input.classList.contains('kn-cls-best')  ? 'best_for'
                    :                                            'notes';
        if (knowledgeData?.classes?.classes?.[i]) {
          knowledgeData.classes.classes[i][field] = field === 'capacity' ? parseInt(input.value, 10) : input.value;
        }
      });
    });

  const upEl = document.getElementById('kn-classes-updated');
  if (upEl) upEl.textContent = 'עודכן: ' + now();
}

document.getElementById('btn-save-classes')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-classes');
  btn.disabled = true; btn.textContent = '⏳ שומר...';
  try {
    const data = knowledgeData?.classes;
    if (!data) throw new Error('אין נתוני שיעורים בזיכרון');
    await post('/api/admin/knowledge/classes', data);
    await triggerSync(false);
    toast('✅ פרטי השיעורים נשמרו ו-Agent עודכן');
  } catch (err) {
    toast(`❌ שגיאה: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '💾 שמור שינויים';
  }
});

// ── Save staff ────────────────────────────────────────────────────────────────
document.getElementById('btn-save-staff')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-staff');
  btn.disabled = true; btn.textContent = '⏳ שומר...';
  try {
    const r = await post('/api/admin/knowledge/staff', knowledgeData.staff);
    if (!r.ok) throw new Error(r.error);
    // Trigger full reload so contexts rebuild
    await triggerSync(false);
    toast('✅ פרטי צוות נשמרו ו-Agent עודכן');
  } catch (err) {
    toast(`❌ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '💾 שמור שינויים';
  }
});

// ── Save packages ─────────────────────────────────────────────────────────────
document.getElementById('btn-save-packages')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-packages');
  btn.disabled = true; btn.textContent = '⏳ שומר...';
  try {
    const r = await post('/api/admin/knowledge/packages', knowledgeData.packages);
    if (!r.ok) throw new Error(r.error);
    await triggerSync(false);
    toast('✅ פרטי מנויים נשמרו ו-Agent עודכן');
  } catch (err) {
    toast(`❌ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '💾 שמור שינויים';
  }
});

// ── Sync button (top banner) ──────────────────────────────────────────────────
document.getElementById('btn-sync-knowledge')?.addEventListener('click', async () => {
  await triggerSync(true);
});

async function triggerSync(showDetails = true) {
  const btn    = document.getElementById('btn-sync-knowledge');
  const result = document.getElementById('kn-sync-result');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מסנכרן...'; }
  if (result) result.style.display = 'none';

  try {
    const d = await post('/api/admin/sync-agent-knowledge', {});
    if (!d.ok) throw new Error(d.error);

    // Refresh local cache
    knowledgeData = null;
    await loadKnowledge(true);

    const ts  = new Date(d.reloaded_at).toLocaleTimeString('he-IL');
    const sub = document.getElementById('kn-last-synced');
    if (sub) sub.textContent = `סונכרן ב-${ts} | ${d.staff_count} מדריכים · ${d.packages_count} חבילות`;

    if (showDetails && result) {
      const checks = (d.verification ?? []).map(c =>
        `${c.passed ? '✅' : '❌'} ${c.test}${c.sample ? ` — ${c.sample.slice(0,80)}` : ''}${c.rehab_instructors?.length ? ` | שיקומי: ${c.rehab_instructors.join(', ')}` : ''}`
      ).join('\n');
      result.className = 'knowledge-sync-result';
      result.innerHTML = `<strong>✅ הסוכן עודכן בהצלחה</strong> — ${ts}<br><pre style="margin:8px 0 0;font-size:12px;white-space:pre-wrap">${esc(checks)}</pre>`;
      result.style.display = '';
    }
    toast('✅ זיכרון סוכן רוענן');
  } catch (err) {
    if (result) {
      result.className = 'knowledge-sync-result error';
      result.textContent = `❌ שגיאה: ${err.message}`;
      result.style.display = '';
    }
    toast(`❌ ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 רענן זיכרון סוכן'; }
  }
}

// ── Verification buttons ──────────────────────────────────────────────────────
document.querySelectorAll('.kn-verify-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const q      = btn.dataset.q;
    const label  = btn.dataset.label;
    const result = document.getElementById('kn-verify-result');
    result.style.display = '';
    result.innerHTML = `<div class="vr-intent">⏳ שולח: "${esc(q)}"...</div>`;

    try {
      const d = await post('/api/whatsapp/simulate', { from: '972500000001', name: 'בדיקה', text: q });
      const intent = d.intent ?? '—';
      const route  = d.route  ?? '—';
      const reply  = d.barakReply;
      result.innerHTML = `
        <div class="vr-intent">📋 <strong>${esc(label)}</strong> | כוונה: <code>${esc(intent)}</code> · ניתוב: <code>${esc(route)}</code></div>
        ${reply
          ? `<div class="vr-reply" style="margin-top:8px;white-space:pre-wrap">${esc(reply)}</div>`
          : `<div class="vr-lead-ai" style="margin-top:8px">↳ נשלח ל-lead_agent (תשובת AI בוואטסאפ ישירות)</div>`}`;
    } catch (err) {
      result.innerHTML = `<div class="vr-intent" style="color:var(--hot)">❌ ${esc(err.message)}</div>`;
    }
  });
});

/* ── Boot ───────────────────────────────────────────────────────────────────── */
pingServer();
loadMayaStats();
loadAgentFeed();
loadBarakPanel();

// Connect SSE immediately at boot — not just when the WhatsApp tab is opened.
// Without this the server's startup sync_complete event (fired 2s after cold start)
// is broadcast to zero clients and the thread list stays empty until the user
// manually clicks the WhatsApp tab.
connectWaSSE();

// Pre-fetch threads in the background so the WhatsApp tab shows real data
// the moment it is clicked instead of an empty list.
loadWaThreads(false);

refreshTimer = setInterval(() => {
  const active = document.querySelector('.tab-btn.active')?.dataset?.tab;
  if (active === 'maya' || active === 'barak') loadBarakPanel();
  if (active === 'maya') { loadMayaStats(); loadAgentFeed(); }
  if (active === 'whatsapp') loadWaThreads(false);
}, 5000);

// Feed auto-refresh every 10s regardless of active tab
setInterval(loadAgentFeed, 10000);

// Wire mini chats
initMiniChat('dana-chat-input',  'dana-send',  'dana-chat-msgs',  '/api/dana/chat');
initMiniChat('tomer-chat-input', 'tomer-send', 'tomer-chat-msgs', '/api/tomer/chat');
initMiniChat('barak-chat-input', 'barak-send', 'barak-chat-msgs', '/api/barak/chat');
