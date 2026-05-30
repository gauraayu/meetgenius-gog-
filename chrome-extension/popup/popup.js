'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const apiBaseEl      = $('apiBase');
const authTokenEl    = $('authToken');
const meetingSelEl   = $('meetingSelect');
const connectBtn     = $('connectBtn');
const refreshBtn     = $('refreshBtn');
const reportBtn      = $('reportBtn');
const stopBtn        = $('stopBtn');
const statusDot      = $('statusDot');
const statusBar      = $('statusBar');
const statusText     = $('statusText');
const setupSection   = $('setupSection');
const liveSection    = $('liveSection');
const segCountEl     = $('segCount');
const speakerCountEl = $('speakerCount');
const elapsedEl      = $('elapsed');
const lastCaptionEl  = $('lastCaption');
const logEl          = $('log');

let elapsedTimer = null;
let startTime    = null;
let segCount     = 0;
let speakers     = new Set();
let allSegments  = []; // local copy for report generation
let currentMeetingId   = null;
let currentMeetingTitle= 'Meeting';

// ─── Logging ──────────────────────────────────────────────────────────────────
function addLog(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  logEl.prepend(el);
  // Limit entries
  while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
}

// ─── Load stored config ───────────────────────────────────────────────────────
async function loadStored() {
  const s = await chrome.storage.local.get(['apiBase', 'authToken', 'meetingId', 'meetingTitle']);
  if (s.apiBase)    apiBaseEl.value    = s.apiBase;
  if (s.authToken)  authTokenEl.value  = s.authToken;
  if (s.meetingId)  currentMeetingId   = s.meetingId;
  if (s.meetingTitle) currentMeetingTitle = s.meetingTitle;
}

// ─── Fetch meetings from GOG OMS ─────────────────────────────────────────────
async function fetchMeetings() {
  const apiBase   = apiBaseEl.value.trim();
  const authToken = authTokenEl.value.trim();
  if (!apiBase || !authToken) return;

  meetingSelEl.innerHTML = '<option value="">Loading...</option>';
  try {
    const res = await fetch(`${apiBase}/meetings/`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const meetings = await res.json();

    meetingSelEl.innerHTML = '<option value="">— select a meeting —</option>';
    meetings
      .filter(m => m.status !== 'completed')
      .forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.title} — ${m.meeting_date} ${m.start_time?.slice(0,5)}`;
        if (m.id == currentMeetingId) opt.selected = true;
        meetingSelEl.appendChild(opt);
      });

    addLog(`Loaded ${meetings.length} meetings`);
  } catch (e) {
    addLog(`Failed to load meetings: ${e.message}`, 'err');
    meetingSelEl.innerHTML = '<option value="">— could not load —</option>';
  }
}

// ─── Connect and send config to content script ───────────────────────────────
async function connect() {
  const apiBase    = apiBaseEl.value.trim();
  const authToken  = authTokenEl.value.trim();
  const meetingId  = meetingSelEl.value;
  const meetingTitle = meetingSelEl.options[meetingSelEl.selectedIndex]?.text || 'Meeting';

  if (!apiBase || !authToken || !meetingId) {
    addLog('Fill in all fields first', 'warn');
    return;
  }

  // Persist
  await chrome.storage.local.set({ apiBase, authToken, meetingId, meetingTitle });
  currentMeetingId    = meetingId;
  currentMeetingTitle = meetingTitle;

  // Send to content script in active Meet tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes('meet.google.com')) {
    addLog('Open a Google Meet tab first', 'warn');
    return;
  }

  chrome.tabs.sendMessage(tab.id, {
    type: 'SET_CONFIG',
    config: { apiBase, authToken, meetingId: Number(meetingId), autoEnable: true },
  }, (resp) => {
    if (chrome.runtime.lastError) {
      addLog('Could not reach content script — reload the Meet tab', 'err');
    } else {
      addLog(`Bot connected to meeting #${meetingId}`, 'ok');
      setActive(true);
    }
  });
}

// ─── UI state ─────────────────────────────────────────────────────────────────
function setActive(active) {
  if (active) {
    setupSection.classList.add('hidden');
    liveSection.classList.remove('hidden');
    statusDot.className = 'dot dot-active';
    statusBar.className = 'status-bar active';
    statusText.textContent = `● Live — ${currentMeetingTitle.slice(0, 40)}`;
    startTime = startTime || Date.now();
    startElapsedTimer();
    addLog('Bot is LIVE', 'ok');
  } else {
    setupSection.classList.remove('hidden');
    liveSection.classList.add('hidden');
    statusDot.className = 'dot dot-idle';
    statusBar.className = 'status-bar idle';
    statusText.textContent = 'Not connected to a meeting';
    stopElapsedTimer();
  }
}

function startElapsedTimer() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(sec / 60), s = sec % 60;
    elapsedEl.textContent = `${m}:${s.toString().padStart(2,'0')}`;
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

// ─── Listen for events from content script ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BOT_ACTIVE') {
    setActive(true);
  }

  if (msg.type === 'BOT_STOPPED') {
    setActive(false);
    addLog('Bot stopped');
  }

  if (msg.type === 'CAPTIONS_ENABLED') {
    statusDot.className = 'dot dot-pending';
    statusBar.className = 'status-bar pending';
    statusText.textContent = '⏳ Captions enabled — waiting for speech...';
    addLog('Captions auto-enabled in Meet', 'ok');
  }

  if (msg.type === 'CAPTION') {
    speakers.add(msg.speaker);
    speakerCountEl.textContent = speakers.size;
    lastCaptionEl.innerHTML =
      `<span class="caption-speaker">${escHtml(msg.speaker)}:</span> ${escHtml(msg.text)}`;
  }

  if (msg.type === 'SEGMENT_SENT') {
    segCount++;
    segCountEl.textContent = segCount;
    allSegments.push({
      speaker: msg.speaker,
      text:    msg.text,
      time:    new Date().toLocaleTimeString(),
    });
    addLog(`[${msg.speaker}] ${msg.text.slice(0, 50)}`, 'ok');
  }

  if (msg.type === 'MEETING_ENDED_AUTO') {
    addLog('Meeting ended — auto-generating report...', 'ok');
    setActive(false);
    // Small delay so final segments are flushed first
    setTimeout(() => generateReport(), 2000);
  }
});

// ─── Stop bot ─────────────────────────────────────────────────────────────────
async function stopBot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP' }, () => {});
  }
  setActive(false);
  addLog('Bot stopped by user');
}

// ─── Generate & download HTML report ─────────────────────────────────────────
async function generateReport() {
  if (allSegments.length === 0) {
    addLog('No segments captured yet', 'warn');
    return;
  }

  reportBtn.disabled = true;
  reportBtn.textContent = 'Generating...';
  addLog('Generating HTML report...', 'ok');

  // Ask backend to generate Gemini summary
  let summary = null;
  const apiBase   = apiBaseEl.value.trim();
  const authToken = authTokenEl.value.trim();

  if (apiBase && authToken && currentMeetingId) {
    try {
      const res = await fetch(`${apiBase}/meetings/${currentMeetingId}/generate-report`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        addLog('Gemini report queued — will embed if ready', 'ok');
        // Poll once after 5s
        await new Promise(r => setTimeout(r, 5000));
        const rep = await fetch(`${apiBase}/meetings/${currentMeetingId}/report`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (rep.ok) summary = await rep.json();
      }
    } catch {}
  }

  const html = buildHtmlReport(allSegments, summary);
  downloadHtml(html, `GOG-Meeting-${currentMeetingId}-${datestamp()}.html`);

  reportBtn.disabled = false;
  reportBtn.textContent = '⬇ Generate Report';
  addLog('Report downloaded!', 'ok');
}

// ─── HTML report builder ──────────────────────────────────────────────────────
function buildHtmlReport(segments, summary) {
  const title = currentMeetingTitle;
  const date  = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' });

  // Speaker colours
  const palette = ['#22c55e','#3b82f6','#f59e0b','#a855f7','#ef4444','#06b6d4','#f97316','#84cc16'];
  const speakerColors = {};
  [...new Set(segments.map(s => s.speaker))].forEach((sp, i) => {
    speakerColors[sp] = palette[i % palette.length];
  });

  // Build transcript HTML
  const transcriptHtml = segments.map(seg => `
    <div class="seg">
      <span class="seg-time">${seg.time}</span>
      <span class="seg-speaker" style="color:${speakerColors[seg.speaker] || '#22c55e'}">${escHtml(seg.speaker)}</span>
      <span class="seg-text">${escHtml(seg.text)}</span>
    </div>`).join('\n');

  // Speaker stats
  const stats = {};
  segments.forEach(s => {
    stats[s.speaker] = (stats[s.speaker] || 0) + 1;
  });
  const statsHtml = Object.entries(stats)
    .sort((a,b) => b[1]-a[1])
    .map(([sp, cnt]) => {
      const pct = Math.round(cnt / segments.length * 100);
      return `
      <div class="stat-row">
        <span class="stat-name" style="color:${speakerColors[sp]}">${escHtml(sp)}</span>
        <div class="stat-bar-wrap">
          <div class="stat-bar" style="width:${pct}%;background:${speakerColors[sp]}"></div>
        </div>
        <span class="stat-pct">${pct}% (${cnt} segments)</span>
      </div>`;
    }).join('');

  // Summary section
  let summaryHtml = '';
  if (summary) {
    const ai = summary;
    summaryHtml = `
    <section class="card">
      <h2>🤖 AI Summary (Gemini)</h2>
      <p class="summary-text">${escHtml(ai.summary || '')}</p>

      ${ai.key_points?.length ? `
      <h3>Key Points</h3>
      <ul>${ai.key_points.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>` : ''}

      ${ai.decisions?.length ? `
      <h3>Decisions</h3>
      <ul>${ai.decisions.map(d => `<li><strong>${escHtml(d.text)}</strong> — ${escHtml(d.context)}</li>`).join('')}</ul>` : ''}

      ${ai.action_items?.length ? `
      <h3>Action Items</h3>
      <table class="action-table">
        <thead><tr><th>Task</th><th>Assignee</th><th>Deadline</th><th>Status</th></tr></thead>
        <tbody>${ai.action_items.map(a => `
          <tr>
            <td>${escHtml(a.task)}</td>
            <td>${escHtml(a.assignee)}</td>
            <td>${escHtml(a.deadline)}</td>
            <td><span class="badge">${escHtml(a.status)}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>` : ''}

      ${ai.sentiment ? `
      <h3>Sentiment</h3>
      <p>Overall: <strong>${escHtml(ai.sentiment.overall)}</strong> — ${escHtml(ai.sentiment.notes || '')}</p>` : ''}
    </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(title)} — GOG OMS Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0d0d0d; color: #e0e0e0; padding: 32px 16px; }
    .container { max-width: 860px; margin: 0 auto; }

    .page-header { text-align: center; margin-bottom: 36px; }
    .logo-badge { display: inline-flex; align-items: center; gap: 10px;
                  background: #1a1a1a; border: 1px solid #2a2a2a;
                  border-radius: 12px; padding: 10px 20px; margin-bottom: 20px; }
    .logo-badge .brand { font-size: 18px; font-weight: 800; color: #22c55e; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 6px; }
    .meta { color: #666; font-size: 13px; }

    .card { background: #111; border: 1px solid #1e1e1e; border-radius: 14px;
            padding: 24px; margin-bottom: 20px; }
    h2 { font-size: 16px; font-weight: 700; color: #fff;
         border-bottom: 1px solid #1e1e1e; padding-bottom: 10px; margin-bottom: 16px; }
    h3 { font-size: 13px; font-weight: 600; color: #aaa;
         text-transform: uppercase; letter-spacing: .05em;
         margin: 16px 0 8px; }

    /* Stats */
    .stat-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .stat-name { width: 140px; font-weight: 600; font-size: 13px; flex-shrink: 0; }
    .stat-bar-wrap { flex: 1; height: 8px; background: #1e1e1e; border-radius: 99px; overflow: hidden; }
    .stat-bar { height: 100%; border-radius: 99px; transition: width .3s; }
    .stat-pct { width: 120px; font-size: 12px; color: #666; text-align: right; flex-shrink: 0; }

    /* Transcript */
    .transcript-wrap { max-height: 520px; overflow-y: auto; }
    .seg { display: grid; grid-template-columns: 70px 130px 1fr;
           gap: 8px; padding: 8px 0; border-bottom: 1px solid #1a1a1a;
           align-items: baseline; }
    .seg:last-child { border-bottom: none; }
    .seg-time    { font-size: 11px; color: #555; font-family: monospace; }
    .seg-speaker { font-size: 13px; font-weight: 700; }
    .seg-text    { font-size: 13px; color: #ccc; line-height: 1.5; }

    /* AI summary */
    .summary-text { color: #bbb; line-height: 1.7; font-size: 14px; margin-bottom: 12px; }
    ul { padding-left: 20px; color: #bbb; line-height: 1.8; font-size: 13px; }
    .action-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
    .action-table th { text-align: left; padding: 8px 10px; background: #1a1a1a;
                       color: #888; font-size: 11px; text-transform: uppercase; }
    .action-table td { padding: 8px 10px; border-top: 1px solid #1e1e1e; color: #ccc; }
    .badge { background: #22c55e22; color: #22c55e; border-radius: 99px;
             padding: 2px 10px; font-size: 11px; font-weight: 600; }

    .footer { text-align: center; color: #333; font-size: 11px; margin-top: 32px; }
  </style>
</head>
<body>
<div class="container">

  <div class="page-header">
    <div class="logo-badge">
      <span class="brand">GOG OMS</span>
      <span style="color:#444">|</span>
      <span style="color:#666;font-size:13px">Meeting Report</span>
    </div>
    <h1>${escHtml(title)}</h1>
    <p class="meta">Generated on ${date} · ${segments.length} segments · ${Object.keys(stats).length} speakers</p>
  </div>

  <!-- Speaker Contribution -->
  <section class="card">
    <h2>👥 Speaker Contribution</h2>
    ${statsHtml}
  </section>

  ${summaryHtml}

  <!-- Full Transcript -->
  <section class="card">
    <h2>📝 Full Transcript</h2>
    <div class="transcript-wrap">
      ${transcriptHtml}
    </div>
  </section>

  <div class="footer">Generated by GOG OMS Caption Bot · ${date}</div>
</div>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function datestamp() {
  return new Date().toISOString().slice(0,10);
}

function downloadHtml(html, filename) {
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Event listeners ──────────────────────────────────────────────────────────
connectBtn.addEventListener('click', connect);
refreshBtn.addEventListener('click', fetchMeetings);
stopBtn.addEventListener('click', stopBot);
reportBtn.addEventListener('click', generateReport);

authTokenEl.addEventListener('change', fetchMeetings);

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadStored();
  if (apiBaseEl.value && authTokenEl.value) {
    await fetchMeetings();
  }

  // Check if bot is already active in current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.includes('meet.google.com')) {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.isActive) {
        startTime = Date.now() - (resp.sessionSec * 1000);
        setActive(true);
      }
    });
  }
})();
