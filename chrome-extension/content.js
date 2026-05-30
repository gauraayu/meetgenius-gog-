/**
 * GOG OMS — Google Meet Caption Bot
 * content.js — runs inside every meet.google.com tab
 *
 * What this does (fully automated, zero user interaction needed):
 *  1. Waits for Google Meet to fully load
 *  2. Automatically clicks "Turn on captions" button
 *  3. Detects the caption container using MULTIPLE strategies so it works
 *     even when Google changes their class names
 *  4. Watches captions via MutationObserver — captures speaker + text
 *  5. Buffers interim captions, flushes final segments to GOG OMS backend
 *  6. Posts to /api/v1/transcripts/{meetingId}/segments/batch
 */

'use strict';

// ─── Config (overridden from chrome.storage) ──────────────────────────────────
let CFG = {
  apiBase:    'http://localhost:8000/api/v1',
  meetingId:  null,
  authToken:  null,
  autoEnable: true,
  debug:      true,
};

// ─── Known selectors — Google Meet caption DOM ────────────────────────────────
// Google obfuscates class names but they follow patterns. We try all known
// variants in order; first match wins. Updated list covers 2023-2025 builds.
const SEL = {
  // Caption ON/OFF toggle button
  captionBtn: [
    '[aria-label="Turn on captions (c)"]',
    '[aria-label="Turn on captions"]',
    '[aria-label="Captions (c)"]',
    '[data-tooltip="Turn on captions (c)"]',
    '[data-tooltip="Turn on captions"]',
    'button[jsname="r8qRAd"]',
    'button[jsname="BOHaEe"]',
  ],

  // Outer wrapper that holds all caption lines
  captionRoot: [
    '.ygicle',    // 2025 live (detected)
    '.a4cQT',     // 2023
    '.TBMuR',     // 2023 alt
    '.CNusmb',    // 2024
    '.iOzk7',     // 2024 alt
    '.bYevB',     // 2025
    '[jsname="tgaKEf"]',
    '[jsname="YSxPC"]',
    '[data-caption-surface]',
    'div[role="region"][aria-label*="caption" i]',
    'div[role="region"][aria-label*="Caption" i]',
  ],

  // Speaker name within a caption item
  speakerName: [
    '.zs7s8d',    // 2023
    '.NWpY0',     // 2023 alt
    '.KcIKyf',    // 2024
    '.cS7aqe',    // 2024 alt
    '.Mz6pEf',    // 2025
    '.notranslate', // 2025 live (speaker name)
    '[data-self-name]',
    '[data-sender-name]',
  ],

  // Caption text within a caption item
  captionText: [
    '.VbkSUe',    // 2025 live (detected!)
    '.iTTPOb',    // 2023
    '.bj29ob',    // 2024
    '.dJSI0',     // 2025 alt
    '[jsname="YSxPC"] span',
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────
let captionRootEl   = null;   // the found caption container element
let rootObserver    = null;   // MutationObserver on caption root
let bodyObserver    = null;   // fallback observer on document.body
let sessionStart    = Date.now();
let isActive        = false;

// Per-speaker buffer: we accumulate interim text, flush when speaker changes
// or after a silence timeout
const speakerBuffer = {};   // { speakerName: { text, timer, startSec } }
const flushedHashes = new Set(); // dedup identical segments

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(...args)  { if (CFG.debug) console.log('[GOG-Bot]', ...args); }
function warn(...args) { console.warn('[GOG-Bot]', ...args); }

// ─── Utility: try a list of selectors, return first match ────────────────────
function trySelectors(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {}
  }
  return null;
}

function trySelectorsAll(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const els = root.querySelectorAll(sel);
      if (els.length > 0) return [...els];
    } catch {}
  }
  return [];
}

// ─── Step 1: Wait for Meet to finish loading ──────────────────────────────────
function waitForMeetReady(cb) {
  log('Waiting for Meet to load...');
  let attempts = 0;
  const iv = setInterval(() => {
    attempts++;
    // Meet is "ready" when the bottom toolbar appears (microphone button)
    const ready =
      document.querySelector('[aria-label*="microphone" i][role="button"]') ||
      document.querySelector('[data-is-muted]') ||
      document.querySelector('.crqnQb') ||
      document.querySelector('[jsname="Qx7uuf"]');

    if (ready) {
      clearInterval(iv);
      log('Meet ready after', attempts, 'checks');
      // Extra delay — Meet continues rendering after toolbar appears
      setTimeout(cb, 2500);
    }
    if (attempts > 120) { // 2 min timeout
      clearInterval(iv);
      warn('Meet load timeout — trying anyway');
      cb();
    }
  }, 1000);
}

// ─── Step 2: Auto-enable captions ─────────────────────────────────────────────
let captionEnableAttempts = 0;
let captionEnableTimer    = null;

function autoEnableCaptions() {
  if (!CFG.autoEnable) return;
  captionEnableAttempts = 0;
  tryEnableCaptions();
}

function tryEnableCaptions() {
  captionEnableAttempts++;

  // Already on? Check if captions container exists
  const alreadyOn = trySelectors(SEL.captionRoot) ||
    document.querySelector('[data-caption-surface]') ||
    [...document.querySelectorAll('button,[role="button"]')].some(el =>
      (el.getAttribute('aria-label') || '').toLowerCase().includes('turn off caption')
    );

  if (alreadyOn) {
    log('Captions already active');
    notifyPopup({ type: 'CAPTIONS_ENABLED' });
    return;
  }

  // Strategy 1: known selectors
  let btn = trySelectors(SEL.captionBtn);

  // Strategy 2: any button/role=button with "caption" in aria-label (excluding "turn off")
  if (!btn) {
    btn = [...document.querySelectorAll('button,[role="button"]')].find(el => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').toLowerCase();
      return label.includes('caption') && !label.includes('turn off');
    });
  }

  // Strategy 3: look inside the More Options (⋮) panel — captions might be nested
  if (!btn) {
    const moreBtn = [...document.querySelectorAll('button,[role="button"]')].find(el =>
      (el.getAttribute('aria-label') || '').toLowerCase().includes('more options')
    );
    if (moreBtn) {
      moreBtn.click();
      setTimeout(() => {
        const menuItem = [...document.querySelectorAll('[role="menuitem"],[role="option"]')].find(el =>
          (el.textContent || '').toLowerCase().includes('caption')
        );
        if (menuItem) {
          menuItem.click();
          log('Captions enabled via More Options menu');
          notifyPopup({ type: 'CAPTIONS_ENABLED' });
          return;
        }
        // Close menu if caption not found there
        document.body.click();
      }, 600);
    }
  }

  if (btn) {
    log('Found caption button (attempt ' + captionEnableAttempts + '):', btn.getAttribute('aria-label') || btn.className);
    btn.click();
    log('Captions click fired');
    notifyPopup({ type: 'CAPTIONS_ENABLED' });
    // Verify after 2s — if captions root still not found, try keyboard shortcut
    setTimeout(() => {
      if (!trySelectors(SEL.captionRoot)) {
        log('Click may not have worked — trying keyboard shortcut c');
        pressKey('c');
      }
    }, 2000);
    return;
  }

  // Strategy 4: keyboard shortcut — 'c' toggles captions in every Meet build
  if (captionEnableAttempts <= 3) {
    log('Button not found (attempt ' + captionEnableAttempts + ') — trying keyboard shortcut c');
    pressKey('c');
    notifyPopup({ type: 'CAPTIONS_ENABLED' });
  }

  // Retry up to 10 times (every 3s for 30s) in case toolbar is still rendering
  if (captionEnableAttempts < 10) {
    captionEnableTimer = setTimeout(tryEnableCaptions, 3000);
  } else {
    warn('Could not auto-enable captions after 10 attempts — please press C in Meet manually');
  }
}

function pressKey(key) {
  // Dispatch keydown + keyup on the Meet video element or document body
  const target = document.querySelector('video') || document.body;
  ['keydown', 'keyup'].forEach(type => {
    target.dispatchEvent(new KeyboardEvent(type, {
      key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0),
      bubbles: true, cancelable: true,
    }));
  });
}

// ─── Step 3: Find caption container ───────────────────────────────────────────
// ONLY use known CSS/jsname selectors — NO position heuristic.
// The heuristic was finding random bottom-of-screen elements (toolbar buttons,
// reaction bars) and attaching an observer to them, causing 0 captions captured.
function findCaptionRoot() {
  const bySelector = trySelectors(SEL.captionRoot);
  if (bySelector) {
    log('Caption root found via known selector:', bySelector.className || bySelector.tagName);
    return bySelector;
  }
  return null;
}

// ─── Step 4: Extract speaker + text from a caption node ───────────────────────
function extractCaption(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;

  // Strategy A: known speaker/text selectors
  const speakerEl = trySelectors(SEL.speakerName, node);
  const textEl    = trySelectors(SEL.captionText, node);
  if (textEl) {
    const tx = textEl.innerText?.trim();
    const sp = speakerEl?.innerText?.trim() || 'Speaker';
    if (tx) return { speaker: sp, text: tx };
  }

  // Strategy A2: direct .VbkSUe match on node itself
  if (node.classList && node.classList.contains('VbkSUe')) {
    const tx = node.innerText?.trim();
    if (tx) return { speaker: 'Speaker', text: tx };
  }
  // Check children for .VbkSUe
  const vbk = node.querySelector('.VbkSUe');
  if (vbk) {
    const tx = vbk.innerText?.trim();
    if (tx) return { speaker: 'Speaker', text: tx };
  }

  // Strategy B: structural leaf scan — first short leaf = speaker, rest = text
  const leaves = [...node.querySelectorAll('*')].filter(
    el => el.children.length === 0 && (el.innerText?.trim().length > 0)
  );
  if (leaves.length >= 2) {
    const first = leaves[0].innerText?.trim();
    const rest  = leaves.slice(1).map(l => l.innerText?.trim()).join(' ').trim();
    if (first && rest && first.length < 60 && first.split(' ').length <= 5 && rest.length > 1) {
      return { speaker: first, text: rest };
    }
  }

  // Strategy C: newline split
  const fullText = node.innerText?.trim();
  if (fullText && fullText.includes('\n')) {
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2 && lines[0].length < 60 && lines[0].split(' ').length <= 5) {
      return { speaker: lines[0], text: lines.slice(1).join(' ') };
    }
  }

  // Strategy D: sibling scan — node's parent might hold [speaker-span, text-span]
  const parent = node.parentElement;
  if (parent) {
    const siblings = [...parent.children].filter(c => c.innerText?.trim().length > 0);
    if (siblings.length >= 2) {
      const first = siblings[0].innerText?.trim();
      const rest  = siblings.slice(1).map(s => s.innerText?.trim()).join(' ').trim();
      if (first && rest && first.length < 60 && first.split(' ').length <= 5 && rest.length > 1) {
        return { speaker: first, text: rest };
      }
    }
  }

  return null;
}

// ─── Step 5: Handle a new/updated caption ─────────────────────────────────────
function handleCaption(speaker, text) {
  if (!text || text.trim().length < 1) return;
  speaker = speaker || 'Speaker';
  if (!CFG.meetingId || !CFG.authToken) return;

  log(`[${speaker}]: ${text}`);

  // Buffer per speaker — Google Meet updates the same line incrementally
  if (!speakerBuffer[speaker]) {
    speakerBuffer[speaker] = {
      text,
      startSec: (Date.now() - sessionStart) / 1000,
      timer: null,
    };
  } else {
    speakerBuffer[speaker].text = text; // update with latest interim
    clearTimeout(speakerBuffer[speaker].timer);
  }

  // Flush 1.5s after last update (natural speech pause)
  speakerBuffer[speaker].timer = setTimeout(() => {
    flushSpeaker(speaker);
  }, 1500);

  notifyPopup({ type: 'CAPTION', speaker, text });
}

function flushSpeaker(speaker) {
  const buf = speakerBuffer[speaker];
  if (!buf || !buf.text?.trim()) return;

  const text     = buf.text.trim();
  const relative = buf.startSec;

  // Deduplicate
  const hash = `${speaker}|${text}`;
  if (flushedHashes.has(hash)) {
    delete speakerBuffer[speaker];
    return;
  }
  flushedHashes.add(hash);
  // Limit dedup set size
  if (flushedHashes.size > 500) {
    const first = flushedHashes.values().next().value;
    flushedHashes.delete(first);
  }

  delete speakerBuffer[speaker];

  sendSegment({ speaker, text, relative });
}

function flushAll() {
  Object.keys(speakerBuffer).forEach(flushSpeaker);
}

// ─── Step 6: Send segment to GOG OMS backend ─────────────────────────────────
async function sendSegment({ speaker, text, relative }) {
  const url = `${CFG.apiBase}/transcripts/${CFG.meetingId}/segments`;
  const payload = {
    speaker_name:     speaker,
    speaker_email:    null,
    text,
    relative_seconds: relative,
    confidence:       0.95,
    is_final:         true,
  };

  try {
    // Use background service worker as proxy — Chrome blocks direct localhost
    // fetch from HTTPS pages (Private Network Access policy)
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type:    'FETCH_PROXY',
        url,
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${CFG.authToken}`,
        },
        body: payload,
      }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });

    if (res && res.ok) {
      log(`Sent: [${speaker}] ${text.slice(0, 40)}...`);
      notifyPopup({ type: 'SEGMENT_SENT', speaker, text });
    } else {
      warn('Send failed:', res?.status, res?.body);
    }
  } catch (e) {
    warn('Network error:', e.message);
  }
}

// ─── MutationObserver on caption root ────────────────────────────────────────
function attachObserverToRoot(root) {
  if (rootObserver) rootObserver.disconnect();

  rootObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Nodes added — new caption line appeared
      for (const node of m.addedNodes) {
        const data = extractCaption(node);
        if (data?.speaker && data?.text) {
          handleCaption(data.speaker, data.text);
        }
      }

      // Character data changed — ongoing caption being updated
      if (m.type === 'characterData') {
        const container = m.target.parentElement?.closest(
          SEL.captionRoot.join(',')
        ) || m.target.parentElement;
        if (container) {
          const data = extractCaption(container);
          if (data?.speaker && data?.text) {
            handleCaption(data.speaker, data.text);
          }
        }
      }

      // Attributes changed (some Meet versions update aria-label with text)
      if (m.type === 'attributes') {
        const data = extractCaption(m.target);
        if (data?.speaker && data?.text) {
          handleCaption(data.speaker, data.text);
        }
      }
    }
  });

  rootObserver.observe(root, {
    childList:     true,
    subtree:       true,
    characterData: true,
    attributes:    true,
  });

  log('Observer attached to caption root:', root.className || root.tagName);
  isActive = true;
  notifyPopup({ type: 'BOT_ACTIVE' });
}

// ─── Fallback: watch ENTIRE body for captions (brute-force) ──────────────────
// Instead of hunting for a specific root element, we intercept ALL DOM mutations
// and pull caption content out of any node that matches the caption pattern.
// This works even when Google Meet changes their class names entirely.
function watchBodyForCaptionRoot() {
  if (bodyObserver) return;

  // Mark bot as active immediately so the popup shows LIVE
  if (!isActive && CFG.meetingId && CFG.authToken) {
    isActive = true;
    notifyPopup({ type: 'BOT_ACTIVE' });
  }

  bodyObserver = new MutationObserver((mutations) => {
    // Strategy 1: try to also lock onto a specific root for efficiency
    // But NEVER disconnect bodyObserver — keep brute-force running as backup
    if (!captionRootEl) {
      const root = findCaptionRoot();
      if (root) {
        captionRootEl = root;
        attachObserverToRoot(root); // runs in parallel with bodyObserver
      }
    }

    // Strategy 2: brute-force — check every mutation directly for caption content
    for (const m of mutations) {
      // Text node changed — walk up ancestors and try to extract caption
      if (m.type === 'characterData') {
        let el = m.target.parentElement;
        for (let depth = 0; depth < 6 && el; depth++, el = el.parentElement) {
          const data = extractCaption(el);
          if (data?.speaker && data?.text && data.text.length > 1) {
            handleCaption(data.speaker, data.text);
            break;
          }
        }
      }

      // New nodes added — check them and their children
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Direct extraction
        const data = extractCaption(node);
        if (data?.speaker && data?.text && data.text.length > 1) {
          handleCaption(data.speaker, data.text);
          continue;
        }

        // Check immediate children too (Google Meet wraps in extra divs)
        for (const child of node.children) {
          const childData = extractCaption(child);
          if (childData?.speaker && childData?.text && childData.text.length > 1) {
            handleCaption(childData.speaker, childData.text);
            break;
          }
        }
      }
    }
  });

  bodyObserver.observe(document.body, {
    childList:     true,
    subtree:       true,
    characterData: true,
  });

  log('Brute-force body observer active — will capture captions from any DOM structure');

  // Periodic scanner: every 2s scan the lower DOM for caption elements
  // Catches cases where MutationObserver misses incremental text updates
  startPeriodicScan();
}

let periodicScanStarted = false;
function startPeriodicScan() {
  if (periodicScanStarted) return;
  periodicScanStarted = true;

  // Track last seen text per element key to avoid duplicate sends
  const lastSeen = new Map();

  setInterval(() => {
    if (!isActive) return;

    const viewH = window.innerHeight;

    for (const el of document.querySelectorAll('div, span')) {
      try {
        const rect = el.getBoundingClientRect();
        // Visible anywhere on screen (captions can be in many positions)
        if (rect.bottom <= 0 || rect.top >= viewH) continue;
        if (rect.width < 60 || rect.height < 8) continue;

        const text = el.innerText?.trim();
        if (!text || text.length < 3 || text.length > 800) continue;

        // Skip if this exact text from this element was already processed
        const key = el.tagName + '|' + (el.className || '') + '|' + (el.getAttribute('jsname') || '');
        if (lastSeen.get(key) === text) continue;
        lastSeen.set(key, text);
        if (lastSeen.size > 300) {
          // Prune oldest entries
          const first = lastSeen.keys().next().value;
          lastSeen.delete(first);
        }

        const data = extractCaption(el);
        if (data?.speaker && data?.text && data.text.length > 1) {
          log('Periodic scan found caption:', data.speaker, data.text.slice(0, 30));
          handleCaption(data.speaker, data.text);
        }
      } catch { /* skip bad elements */ }
    }
  }, 800);
}

// ─── Communicate with popup ───────────────────────────────────────────────────
function notifyPopup(msg) {
  chrome.runtime.sendMessage({ ...msg, tabId: chrome.runtime.id }).catch(() => {});
}

// ─── Listen for messages from popup ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'GET_STATUS') {
    reply({
      isActive,
      meetingId:  CFG.meetingId,
      sessionSec: Math.floor((Date.now() - sessionStart) / 1000),
    });
  }
  if (msg.type === 'SET_CONFIG') {
    Object.assign(CFG, msg.config);
    log('Config updated from popup:', CFG.meetingId);
    if (!isActive && CFG.meetingId && CFG.authToken) {
      startBot();
    }
    reply({ ok: true });
  }
  if (msg.type === 'FLUSH') {
    flushAll();
    reply({ ok: true });
  }
  if (msg.type === 'STOP') {
    stopBot();
    reply({ ok: true });
  }
  return true; // keep channel open for async reply
});

// ─── Start / Stop ─────────────────────────────────────────────────────────────
function startBot() {
  log('Starting caption bot for meeting:', CFG.meetingId);
  isActive = true;
  sessionStart = Date.now();
  notifyPopup({ type: 'BOT_ACTIVE' });

  // Try to click captions button
  autoEnableCaptions();

  // Always start brute-force body observer + periodic scan immediately.
  // The body observer is the primary capture mechanism regardless of whether
  // we find a specific caption root (the root-specific observer is just an
  // efficiency optimisation on top).
  watchBodyForCaptionRoot();
  startPeriodicScan();

  // Also try to lock onto a specific root after DOM settles (for efficiency)
  setTimeout(() => {
    const root = findCaptionRoot();
    if (root) {
      captionRootEl = root;
      attachObserverToRoot(root); // runs IN ADDITION to body observer
    }
  }, 1500);

  // Watch for meeting ending (early exit, host ends for all, timer runs out)
  watchForMeetingEnd();
}

function stopBot() {
  flushAll();
  rootObserver?.disconnect();
  bodyObserver?.disconnect();
  meetingEndObserver?.disconnect();
  rootObserver = null;
  bodyObserver = null;
  meetingEndObserver = null;
  isActive = false;
  log('Bot stopped');
  notifyPopup({ type: 'BOT_STOPPED' });
}

// ─── Meeting-end detection ────────────────────────────────────────────────────
// Google Meet shows a "You've left the meeting" / "Return to home screen" page
// when the call ends — whether the host ends it for everyone OR the scheduled
// time is up OR you leave early. We watch for those DOM signals.
let meetingEndObserver = null;

const MEETING_END_PHRASES = [
  'you left the meeting',
  "you've left the meeting",
  'return to home screen',
  'the meeting has ended',
  'meeting ended',
  'rejoin',                // "Rejoin" button only appears post-call
];

function isMeetingEndNode(node) {
  const text = (node.textContent || '').toLowerCase();
  return MEETING_END_PHRASES.some(p => text.includes(p));
}

function checkForMeetingEnd() {
  // Strategy 1: look for known post-call DOM phrases
  const allText = document.body?.textContent?.toLowerCase() || '';
  if (MEETING_END_PHRASES.some(p => allText.includes(p))) return true;

  // Strategy 2: URL changed away from a room code (room codes are xxx-xxxx-xxx)
  const roomPattern = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;
  if (!roomPattern.test(window.location.href)) return true;

  return false;
}

function watchForMeetingEnd() {
  if (meetingEndObserver) return; // already watching

  meetingEndObserver = new MutationObserver(() => {
    if (!isActive) return;
    if (checkForMeetingEnd()) {
      log('Meeting ended — auto-generating report');
      meetingEndObserver.disconnect();
      meetingEndObserver = null;
      handleAutoEnd();
    }
  });

  meetingEndObserver.observe(document.body, { childList: true, subtree: true });

  // Also watch URL changes (SPA navigation)
  let lastHref = window.location.href;
  const urlPoller = setInterval(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      if (!isActive) { clearInterval(urlPoller); return; }
      if (checkForMeetingEnd()) {
        log('Meeting ended (URL change) — auto-generating report');
        clearInterval(urlPoller);
        handleAutoEnd();
      }
    }
  }, 2000);
}

async function handleAutoEnd() {
  if (!isActive) return;
  stopBot();

  // Notify popup so it can trigger report generation automatically
  notifyPopup({ type: 'MEETING_ENDED_AUTO' });

  // If we have a meetingId + token, also call the backend to end the meeting
  if (CFG.meetingId && CFG.authToken) {
    try {
      await fetch(`${CFG.apiBase}/meetings/${CFG.meetingId}/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CFG.authToken}` },
      });
      log('Meeting marked as ended on backend');
    } catch (e) {
      log('Could not call /end on backend: ' + e.message);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  // Load config from storage
  const stored = await chrome.storage.local.get(['meetingId', 'authToken', 'apiBase', 'autoEnable', 'debug']);
  if (stored.meetingId)  CFG.meetingId  = stored.meetingId;
  if (stored.authToken)  CFG.authToken  = stored.authToken;
  if (stored.apiBase)    CFG.apiBase    = stored.apiBase;
  if (stored.autoEnable !== undefined) CFG.autoEnable = stored.autoEnable;
  if (stored.debug      !== undefined) CFG.debug      = stored.debug;

  // ── Auto-detect meeting ID from URL param (set by GOG OMS app) ──
  // When GOG OMS opens a Meet link it appends ?gogMeetingId=<id>
  // so the extension can auto-connect without any popup interaction.
  const urlParams    = new URLSearchParams(window.location.search);
  const urlMeetingId = urlParams.get('gogMeetingId');
  if (urlMeetingId) {
    CFG.meetingId = Number(urlMeetingId);
    log('Auto-detected meeting ID from URL:', CFG.meetingId);
    // Persist for this session so badge / popup stay in sync
    chrome.storage.local.set({ meetingId: CFG.meetingId });
  }

  log('Config loaded:', { meetingId: CFG.meetingId, apiBase: CFG.apiBase });

  if (!CFG.meetingId || !CFG.authToken) {
    log('No meeting configured — open the GOG OMS popup to connect.');
    // Still watch captions so we're ready when popup sets the meeting
    waitForMeetReady(() => {
      autoEnableCaptions();
      watchBodyForCaptionRoot();
    });
    return;
  }

  waitForMeetReady(startBot);
}

// ─── Direct fallback: watch .VbkSUe elements globally ────────────────────────
// This catches captions even if the root container isn't found
function watchVbkSUeDirectly() {
  const seen = new WeakSet();
  const obs = new MutationObserver(() => {
    document.querySelectorAll('.VbkSUe').forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      const text = el.innerText?.trim();
      if (text && text.length > 1) {
        // Try to find speaker in parent
        let speaker = 'Speaker';
        const parent = el.closest('.ygicle') || el.parentElement?.parentElement;
        if (parent) {
          const sp = parent.querySelector('.notranslate');
          if (sp && sp.innerText?.trim()) speaker = sp.innerText.trim();
        }
        handleCaption(speaker, text);
      }
    });
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  log('Direct VbkSUe observer started');
}

// Start direct observer immediately
document.addEventListener('DOMContentLoaded', watchVbkSUeDirectly);
if (document.body) watchVbkSUeDirectly();

boot();