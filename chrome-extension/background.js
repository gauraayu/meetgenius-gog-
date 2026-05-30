/**
 * GOG OMS — Background Service Worker
 * Tracks active Meet tabs, relays messages between content script and popup,
 * and updates the extension badge.
 * 
 * IMPORTANT: All fetch calls to localhost are proxied through here
 * because Chrome blocks direct localhost access from HTTPS pages (Meet).
 */

'use strict';

// Track which tabs have the bot active
const activeTabs = new Map(); // tabId → { meetingId, segmentCount, startTime }

// ─── Badge helpers ────────────────────────────────────────────────────────────
function setBadge(tabId, text, color = '#22c55e') {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: '', tabId });
}

// ─── FETCH PROXY — content script can't reach localhost, background can ───────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Proxy fetch requests through background (bypasses Chrome's loopback block)
  if (msg.type === 'FETCH_PROXY') {
    fetch(msg.url, {
      method:  msg.method || 'GET',
      headers: msg.headers || {},
      body:    msg.body ? JSON.stringify(msg.body) : undefined,
    })
      .then(async res => {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body: text });
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  if (!tabId) return;

  if (msg.type === 'BOT_ACTIVE') {
    activeTabs.set(tabId, {
      meetingId:    msg.meetingId || null,
      segmentCount: 0,
      startTime:    Date.now(),
    });
    setBadge(tabId, 'ON');
  }

  if (msg.type === 'BOT_STOPPED') {
    activeTabs.delete(tabId);
    clearBadge(tabId);
  }

  if (msg.type === 'SEGMENT_SENT') {
    const state = activeTabs.get(tabId);
    if (state) {
      state.segmentCount++;
      setBadge(tabId, String(state.segmentCount));
    }
  }

  if (msg.type === 'CAPTIONS_ENABLED') {
    setBadge(tabId, '...', '#f59e0b');
  }
});

// ─── Clean up when a Meet tab closes ─────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
});

// ─── On install: show a welcome notification ──────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({
      apiBase:    'http://localhost:8000/api/v1',
      autoEnable: true,
      debug:      false,
    });
    console.log('[GOG-Bot] Extension installed');
  }
});