'use client';

/**
 * useAllParticipantsAudio
 *
 * Captures the full audio mix from a Jitsi meeting (all participants) via
 * the browser's getDisplayMedia API, then periodically sends 5-second chunks
 * to the backend for Gemini transcription.
 *
 * How it works:
 *  1. User clicks "Capture All Audio" → getDisplayMedia prompt appears
 *  2. User picks the Jitsi tab and MUST check "Share audio" (Chrome on Mac)
 *  3. We discard the video track and keep only the audio track
 *  4. MediaRecorder records in 5-second chunks (audio/webm)
 *  5. Each chunk is POSTed to /api/v1/meetings/{id}/transcribe-audio-chunk
 *  6. Gemini returns the transcribed text; we call onSegment with speaker label
 *
 * The current dominant speaker name is passed in as `currentSpeaker` and
 * updated live via Jitsi External API dominantSpeakerChanged events in the
 * parent component.
 *
 * Browser support: Chrome (required for getDisplayMedia + audio).
 * Safari does NOT support audio capture via getDisplayMedia.
 */

import { useRef, useState, useCallback } from 'react';

interface AudioSegment {
  text: string;
  speaker_name: string;
  relative_seconds: number;
  confidence: number;
}

interface UseAllParticipantsAudioOptions {
  meetingId: number;
  getCurrentSpeaker: () => string;
  onSegment: (seg: AudioSegment) => void;
  onError?: (msg: string) => void;
}

export function useAllParticipantsAudio({
  meetingId,
  getCurrentSpeaker,
  onSegment,
  onError,
}: UseAllParticipantsAudioOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const streamRef    = useRef<MediaStream | null>(null);
  const recorderRef  = useRef<MediaRecorder | null>(null);
  const startTimeRef = useRef<number>(0);

  const stopCapture = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch {}
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current  = null;
    recorderRef.current = null;
    setIsCapturing(false);
  }, []);

  const startCapture = useCallback(async () => {
    setCaptureError(null);

    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        // Ask for a browser tab so "Share audio" checkbox is available
        video: { displaySurface: 'browser' } as MediaTrackConstraints,
        audio: true,
      });
    } catch (err: any) {
      // User cancelled or permission denied — not an error worth showing
      if (err.name === 'AbortError' || err.name === 'NotAllowedError') return;
      const msg = 'Could not start screen capture: ' + err.message;
      setCaptureError(msg);
      onError?.(msg);
      return;
    }

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      // User forgot to check "Share audio" in the dialog
      displayStream.getTracks().forEach(t => t.stop());
      const msg =
        'No audio captured. In the sharing dialog, select the Jitsi tab and tick "Share audio".';
      setCaptureError(msg);
      onError?.(msg);
      return;
    }

    // Drop the video track — we only need audio
    displayStream.getVideoTracks().forEach(t => t.stop());

    const audioStream = new MediaStream(audioTracks);
    streamRef.current = audioStream;
    startTimeRef.current = Date.now();

    // Prefer opus-in-webm; fall back to whatever the browser offers
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : '';

    const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    recorder.ondataavailable = async (e: BlobEvent) => {
      if (!e.data || e.data.size < 500) return; // skip silence / tiny chunks

      const elapsedSec = (Date.now() - startTimeRef.current) / 1000;
      const speaker    = getCurrentSpeaker();

      const formData = new FormData();
      formData.append('audio', e.data, 'chunk.webm');
      formData.append('speaker', speaker);
      formData.append('relative_seconds', String(elapsedSec));

      try {
        const token = localStorage.getItem('token');
        const res = await fetch(
          `/api/v1/meetings/${meetingId}/transcribe-audio-chunk`,
          {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
          }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.text) {
          onSegment({
            text:             data.text,
            speaker_name:     data.speaker || speaker,
            relative_seconds: elapsedSec,
            confidence:       0.95,
          });
        }
      } catch {
        // Network error — silently drop; meeting continues
      }
    };

    // Auto-stop if the user ends the screen share from the browser UI
    audioTracks[0].onended = () => stopCapture();

    recorder.start(5000); // fire ondataavailable every 5 seconds
    setIsCapturing(true);
  }, [meetingId, getCurrentSpeaker, onSegment, onError, stopCapture]);

  return { isCapturing, captureError, startCapture, stopCapture };
}
