# GOG OMS — Meet Caption Bot (Chrome Extension)

A fully automated Chrome extension that joins any Google Meet, auto-enables captions, captures every word with the speaker's name, and generates a formatted HTML report with an AI summary — no hosting required.

---

## How to Install (one-time, 2 minutes)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** ON (top-right switch)
3. Click **Load unpacked**
4. Select this folder: `meetgenius-main/chrome-extension/`
5. The GOG OMS bot icon appears in your Chrome toolbar

---

## How to Use

1. **Start your GOG OMS backend** (`uvicorn app.main:app --reload --port 8000`)
2. **Open a Google Meet** link in Chrome
3. **Click the GOG OMS icon** in the toolbar
4. Paste your **Auth Token** (from GOG OMS → browser DevTools → Application → localStorage → `token`)
5. Select the **active meeting** from the dropdown
6. Click **Connect & Start Bot**

The bot will:
- ✅ Automatically click "Turn on captions" in Meet
- ✅ Capture every caption with the speaker's name
- ✅ Save segments to your GOG OMS backend in real time
- ✅ Show live count of segments and speakers in the popup

When the meeting ends:
- Click **Generate Report** in the popup
- A formatted HTML file downloads automatically with full transcript + Gemini AI summary

---

## What the HTML Report Contains

- **Speaker contribution** — who spoke how much (% bar chart)
- **Full transcript** — every segment, timestamped, colour-coded by speaker
- **AI Summary** — Gemini-generated executive summary
- **Key points, decisions, action items** — extracted by Gemini
- **Sentiment analysis**

---

## How it handles Google Meet DOM changes

Google Meet obfuscates class names (`.a4cQT`, `.zs7s8d`, etc.) and changes them periodically. The bot uses **5 fallback strategies** in order:

1. Known class name selectors (updated list for 2023–2025 builds)
2. `aria-label` attribute matching (most stable — Google needs this for accessibility)
3. `jsname` attribute matching
4. Structural heuristic — finds elements with (short text = speaker) + (longer text = caption) pattern
5. Full-text newline splitting as last resort

If Google changes their DOM, the bot continues working via strategies 2–5 even if strategy 1 breaks.

---

## Files

```
chrome-extension/
├── manifest.json       Chrome extension config (MV3)
├── content.js          Caption scraper — runs inside Meet tab
├── background.js       Service worker — badge, tab tracking
├── popup/
│   ├── popup.html      Extension popup UI
│   ├── popup.js        Popup logic, report generation
│   └── popup.css       Dark theme styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## No hosting needed

This extension runs entirely locally. It only makes two types of network requests:
- `meet.google.com` — to read captions from the DOM (no request, just DOM access)
- `localhost:8000` — to save segments to your GOG OMS backend

Nothing goes to any third-party server.
