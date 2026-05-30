'use client';

/**
 * useSpeechTranscription
 *
 * Wraps the browser Web Speech API with rock-solid continuous transcription.
 *
 * Key reliability fixes vs. the naive approach:
 *
 * 1. FRESH INSTANCE ON EVERY RESTART
 *    Chrome's SpeechRecognition instance is a one-shot object — once it fires
 *    `onend` it cannot be restarted. Calling `.start()` on it again silently
 *    fails, causing the "random stops" bug. We always create a brand-new
 *    instance via `spawnRecognition()`.
 *
 * 2. TRANSIENT ERROR RECOVERY
 *    `network` and `audio-capture` errors are temporary (tab focus change,
 *    brief packet loss, OS audio device switch). We restart after a short
 *    back-off instead of surfacing them to the user.
 *
 * 3. WATCHDOG TIMER
 *    A 10-second watchdog checks that we're still receiving results. If the
 *    recognizer went silent unexpectedly (Chrome internal bug), it spawns a
 *    replacement automatically.
 *
 * Browser support: Chrome, Edge, Safari (webkit prefix). Firefox = no.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

interface UseSpeechTranscriptionOptions {
  language?: string;
  speakerName?: string;
  onFinalSegment?: (segment: {
    text: string;
    speaker_name: string;
    relative_seconds: number;
    confidence: number;
  }) => void;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: { [index: number]: SpeechRecognitionResult; length: number };
}

export function useSpeechTranscription({
  language = 'en-IN',
  speakerName = 'You',
  onFinalSegment,
}: UseSpeechTranscriptionOptions = {}) {
  const [isSupported,  setIsSupported]  = useState(false);
  const [isListening,  setIsListening]  = useState(false);
  const [interimText,  setInterimText]  = useState('');
  const [error,        setError]        = useState<string | null>(null);

  const recognitionRef   = useRef<any>(null);
  const startTimeRef     = useRef<number>(0);
  const shouldRunRef     = useRef(false);   // master "keep running" flag
  const lastResultAtRef  = useRef<number>(0); // timestamp of last result (watchdog)
  const watchdogRef      = useRef<any>(null);
  const restartTimerRef  = useRef<any>(null);

  // ── Refs that hold latest prop values so callbacks don't go stale ──
  const languageRef      = useRef(language);
  const speakerNameRef   = useRef(speakerName);
  const onFinalSegRef    = useRef(onFinalSegment);
  useEffect(() => { languageRef.current     = language;      }, [language]);
  useEffect(() => { speakerNameRef.current  = speakerName;   }, [speakerName]);
  useEffect(() => { onFinalSegRef.current   = onFinalSegment;}, [onFinalSegment]);

  // Check support on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    setIsSupported(!!SR);
  }, []);

  // ── Core: spawn a fresh SpeechRecognition instance ──────────────────
  const spawnRecognition = useCallback(() => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR || !shouldRunRef.current) return;

    // Cleanly dispose any existing instance first
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    const recog = new SR();
    recog.continuous      = true;
    recog.interimResults  = true;
    recog.lang            = languageRef.current;
    recog.maxAlternatives = 1;

    recog.onresult = (event: SpeechRecognitionEvent) => {
      lastResultAtRef.current = Date.now(); // feed the watchdog
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result     = event.results[i];
        const transcript = result[0].transcript;
        const confidence = result[0].confidence || 0;

        if (result.isFinal) {
          const elapsedSec = (Date.now() - startTimeRef.current) / 1000;
          onFinalSegRef.current?.({
            text:            transcript.trim(),
            speaker_name:    speakerNameRef.current,
            relative_seconds: elapsedSec,
            confidence,
          });
          interim = '';
        } else {
          interim += transcript;
        }
      }
      setInterimText(interim);
    };

    recog.onerror = (e: any) => {
      console.warn('[speech] error:', e.error);

      if (e.error === 'not-allowed') {
        // Hard stop — user denied the microphone
        setError('Microphone permission denied. Please allow microphone access and try again.');
        shouldRunRef.current = false;
        setIsListening(false);
        return;
      }

      // Everything else (no-speech, network, audio-capture, aborted) is
      // transient — suppress from UI, let onend handle the restart.
    };

    recog.onend = () => {
      setInterimText('');
      if (!shouldRunRef.current) {
        setIsListening(false);
        return;
      }
      // ── KEY FIX: spawn a BRAND NEW instance after a tiny delay ──────
      // Never call .start() on the instance that just fired onend — Chrome
      // silently ignores it, leaving transcription dead until a page reload.
      restartTimerRef.current = setTimeout(() => {
        if (shouldRunRef.current) spawnRecognition();
      }, 150);
    };

    recognitionRef.current = recog;
    try {
      recog.start();
    } catch (err) {
      console.warn('[speech] start failed:', err);
      // Retry once after a short delay
      restartTimerRef.current = setTimeout(() => {
        if (shouldRunRef.current) spawnRecognition();
      }, 500);
    }
  // spawnRecognition intentionally has no deps — it reads everything via refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Watchdog: restart if we haven't seen a result for 10 s ──────────
  const startWatchdog = useCallback(() => {
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    watchdogRef.current = setInterval(() => {
      if (!shouldRunRef.current) return;
      const silentFor = Date.now() - lastResultAtRef.current;
      // If silent for >10 s while we expect results, the recognizer likely died
      if (silentFor > 10_000) {
        console.warn('[speech] watchdog: recognition appears stalled — restarting');
        spawnRecognition();
      }
    }, 5_000);
  }, [spawnRecognition]);

  const stopWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // ── Public API ───────────────────────────────────────────────────────
  const start = useCallback(() => {
    if (!isSupported) {
      setError('Web Speech API not supported. Use Chrome or Edge.');
      return;
    }
    setError(null);
    startTimeRef.current    = Date.now();
    lastResultAtRef.current = Date.now();
    shouldRunRef.current    = true;
    setIsListening(true);

    spawnRecognition();
    startWatchdog();
  }, [isSupported, spawnRecognition, startWatchdog]);

  const stop = useCallback(() => {
    shouldRunRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    stopWatchdog();
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setIsListening(false);
    setInterimText('');
  }, [stopWatchdog]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRunRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      stopWatchdog();
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }
    };
  }, [stopWatchdog]);

  return { isSupported, isListening, interimText, error, start, stop };
}
