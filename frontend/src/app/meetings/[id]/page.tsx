'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Video, Calendar, Clock, Users, Mic, MicOff,
  Square, Sparkles, ExternalLink, Copy, Check, Camera, CameraOff,
  PanelRightOpen, PanelRightClose, MonitorPlay, AlertTriangle,
  CheckCircle2, StopCircle,
} from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { meetingsApi, transcriptApi } from '@/lib/api';
import { useSpeechTranscription } from '@/hooks/useSpeechTranscription';
import { useAllParticipantsAudio } from '@/hooks/useAllParticipantsAudio';

/* ─── Jitsi External API Component ───────────────────────── */
/**
 * Uses the Jitsi Meet External API (JS SDK) instead of a raw iframe.
 * This gives us real-time events:
 *   - dominantSpeakerChanged → who is talking right now
 *   - participantJoined / participantLeft → headcount
 *
 * The dominantSpeakerChanged event is forwarded to the parent so the
 * all-participants audio capture can label each chunk with the right name.
 */
function JitsiMeeting({
  roomUrl,
  onLeft,
  onDominantSpeakerChanged,
  displayName = 'Host',
}: {
  roomUrl: string;
  onLeft: () => void;
  onDominantSpeakerChanged?: (name: string) => void;
  displayName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef       = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const room = roomUrl.replace('https://meet.jit.si/', '');

    function initApi() {
      if (!(window as any).JitsiMeetExternalAPI) return;
      if (apiRef.current) return; // already initialised

      const api = new (window as any).JitsiMeetExternalAPI('meet.jit.si', {
        roomName: room,
        parentNode: containerRef.current,
        width:  '100%',
        height: '100%',
        configOverwrite: {
          prejoinPageEnabled:   false,
          startWithAudioMuted:  false,
          disableDeepLinking:   true,
          requireDisplayName:   false,
        },
        interfaceConfigOverwrite: {
          SHOW_JITSI_WATERMARK: false,
          TOOLBAR_BUTTONS: ['microphone', 'camera', 'chat', 'raisehand', 'tileview', 'hangup'],
        },
        userInfo: { displayName },
      });

      // Track who is the dominant (loudest) speaker in real time
      api.addListener('dominantSpeakerChanged', ({ id }: { id: string }) => {
        const participants: any[] = api.getParticipantsInfo() || [];
        const match = participants.find((p: any) => p.participantId === id);
        const name  = match?.displayName || displayName;
        onDominantSpeakerChanged?.(name);
      });

      // Treat the host leaving the meeting as "meeting ended"
      api.addListener('readyToClose', onLeft);

      apiRef.current = api;
    }

    if ((window as any).JitsiMeetExternalAPI) {
      initApi();
    } else {
      // Lazy-load the External API script once
      if (!document.querySelector('script[src*="meet.jit.si/external_api"]')) {
        const script = document.createElement('script');
        script.src   = 'https://meet.jit.si/external_api.js';
        script.async = true;
        script.onload = initApi;
        document.head.appendChild(script);
      } else {
        // Script tag already present but not yet loaded — poll briefly
        const interval = setInterval(() => {
          if ((window as any).JitsiMeetExternalAPI) {
            clearInterval(interval);
            initApi();
          }
        }, 200);
      }
    }

    return () => {
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomUrl]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Hint bar */}
      <div style={{
        background: '#1a1a2e',
        border: '1px solid rgba(255,165,0,0.3)',
        borderRadius: '8px 8px 0 0',
        padding: '6px 12px',
        fontSize: 12,
        color: '#f59e0b',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}>
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>
          Allow <strong>microphone &amp; camera</strong> in your browser address bar.
          To transcribe all participants, click <strong>&quot;Capture All Audio&quot;</strong> above.
        </span>
      </div>
      {/* Jitsi mounts here */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────── */
export default function MeetingDetailPage() {
  const params    = useParams();
  const router    = useRouter();
  const meetingId = Number(params.id);

  const [meeting,          setMeeting]         = useState<any>(null);
  const [loading,          setLoading]          = useState(true);
  const [copied,           setCopied]           = useState(false);
  const [segments,         setSegments]         = useState<any[]>([]);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [showJitsi,        setShowJitsi]        = useState(false);
  const jitsiLoadedRef = useRef(false);
  const [showTranscript,   setShowTranscript]   = useState(false); // ← toggle
  const [currentSpeaker,   setCurrentSpeaker]   = useState('Host');

  const [participants, setParticipants] = useState<Record<string, {
    name: string; cameraOn: boolean; micOn: boolean;
  }>>({});

  const cameraLogRef     = useRef<{ name: string; action: string; at: number }[]>([]);
  const bufferRef        = useRef<any[]>([]);
  const flushTimer       = useRef<any>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const startTimeRef     = useRef<number>(0);
  const speakerRef       = useRef('Host');

  const flushBuffer = useCallback(async () => {
    if (!bufferRef.current.length) return;
    const batch = [...bufferRef.current];
    bufferRef.current = [];
    try { await transcriptApi.addBatch(meetingId, batch); }
    catch { bufferRef.current.unshift(...batch); }
  }, [meetingId]);

  const { isSupported, isListening, interimText, error, start, stop } =
    useSpeechTranscription({
      language: 'en-IN',
      speakerName: 'Host',
      onFinalSegment: (seg) => {
        const s = { ...seg, speaker_name: speakerRef.current };
        setSegments(prev => [...prev, s]);
        bufferRef.current.push(s);
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flushBuffer, 2000);
      },
    });

  // All-participants audio capture via getDisplayMedia + Gemini STT
  const { isCapturing, captureError, startCapture, stopCapture } =
    useAllParticipantsAudio({
      meetingId,
      getCurrentSpeaker: () => speakerRef.current,
      onSegment: (seg) => {
        setSegments(prev => [...prev, seg]);
        bufferRef.current.push(seg);
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flushBuffer, 2000);
      },
      onError: (msg) => console.warn('[AllParticipantsAudio]', msg),
    });

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments, interimText]);

  useEffect(() => {
    meetingsApi.get(meetingId)
      .then((m: any) => setMeeting(m))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [meetingId]);

  const handleParticipantJoined = useCallback(({ id, displayName }: any) => {
    setParticipants(p => ({ ...p, [id]: { name: displayName, cameraOn: true, micOn: true } }));
  }, []);

  const handleParticipantLeft = useCallback(({ id }: any) => {
    setParticipants(p => { const n = { ...p }; delete n[id]; return n; });
  }, []);

  const handleSpeakerChanged = useCallback(({ displayName }: any) => {
    speakerRef.current = displayName || 'Participant';
    setCurrentSpeaker(displayName || 'Participant');
  }, []);

  const handleCameraToggled = useCallback(({ id, displayName, muted }: any) => {
    setParticipants(p => ({ ...p, [id]: { ...p[id], name: displayName, cameraOn: !muted } }));
    cameraLogRef.current.push({ name: displayName, action: muted ? 'camera_off' : 'camera_on', at: (Date.now() - startTimeRef.current) / 1000 });
  }, []);

  const handleMicToggled = useCallback(({ id, displayName, muted }: any) => {
    setParticipants(p => ({ ...p, [id]: { ...p[id], name: displayName, micOn: !muted } }));
  }, []);

  const handleStartMeeting = async () => {
    if (!isSupported) { alert('Web Speech API not supported. Please use Chrome or Edge.'); return; }
    try {
      await meetingsApi.start(meetingId);
      startTimeRef.current = Date.now();
      start();
      const platform = meeting?.platform || 'google';
      if (platform === 'jitsi') { setShowJitsi(true); setShowTranscript(true); }
      else if (platform === 'zoom') { window.open(meeting?.zoom_start_url || meeting?.meet_link, '_blank'); }
      else {
        if (meeting?.meet_link) {
          const url = meeting.meet_link.includes('meet.google.com')
            ? `${meeting.meet_link}?gogMeetingId=${meetingId}`
            : meeting.meet_link;
          window.open(url, '_blank');
        }
      }
    } catch (e: any) { alert('Failed to start: ' + e.message); }
  };

  const handleStopMeeting = async () => {
    stop();
    stopCapture();
    setShowJitsi(false);
    setShowTranscript(false);
    await flushBuffer();
    try {
      await meetingsApi.end(meetingId);
      setGeneratingReport(true);
      setTimeout(() => router.push(`/meetings/${meetingId}/report`), 4000);
    } catch (e: any) { alert('Failed to end: ' + e.message); setGeneratingReport(false); }
  };

  const copyLink = () => {
    if (meeting?.meet_link) {
      navigator.clipboard.writeText(meeting.meet_link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) return <div className="flex"><Sidebar /><main className="flex-1 p-8 text-text-muted animate-pulse">Loading...</main></div>;
  if (!meeting) return <div className="flex"><Sidebar /><main className="flex-1 p-8 text-text-muted">Meeting not found</main></div>;

  const platform      = meeting.platform || 'google';
  const platformLabel = platform === 'zoom' ? 'Zoom' : platform === 'jitsi' ? 'Jitsi Meet' : 'Google Meet';
  const PlatformIcon  = platform === 'zoom' ? MonitorPlay : platform === 'jitsi' ? Mic : Video;
  const platformColor = platform === 'zoom' ? 'text-blue-400' : platform === 'jitsi' ? 'text-orange-400' : 'text-accent';

  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-6 max-w-7xl">

        <Link href="/dashboard" className="text-text-muted hover:text-text text-sm flex items-center gap-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Meetings
        </Link>

        {/* ── Header Card ── */}
        <div className="card mb-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-accent-muted flex items-center justify-center">
                <Calendar className="w-6 h-6 text-accent" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">{meeting.title}</h1>
                <p className="text-text-dim text-sm flex items-center gap-1.5">
                  {meeting.meeting_code} · <PlatformIcon className={`w-3.5 h-3.5 ${platformColor}`} /> {platformLabel}
                  {isListening && (
                    <span className="ml-2 text-red-400 inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 recording-dot inline-block" />
                      LIVE
                    </span>
                  )}
                </p>
              </div>
            </div>
            <span className={`badge ${meeting.status === 'live' ? 'badge-warning' : meeting.status === 'completed' ? 'badge-success' : 'badge-success'}`}>
              {meeting.status}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-3 mb-3">
            <InfoBlock icon={Calendar} label="Date"      value={meeting.meeting_date} />
            <InfoBlock icon={Clock}    label="Time"      value={`${meeting.start_time?.slice(0,5)} · ${meeting.duration_minutes}m`} />
            <InfoBlock icon={Video}    label="Platform"  value={platformLabel} />
            <InfoBlock icon={Users}    label="Attendees" value={`${meeting.attendees?.length || 0}`} />
          </div>

          {/* Meeting Link */}
          {meeting.meet_link && (
            <div className="bg-bg-card border border-accent/30 rounded-xl p-4">
              <p className="text-xs text-accent font-mono tracking-widest mb-2">
                // MEETING_LINK — share this with attendees
              </p>
              <div className="flex items-center gap-2">
                <PlatformIcon className={`w-5 h-5 ${platformColor} shrink-0`} />
                <span className="text-sm font-medium flex-1 break-all text-text">{meeting.meet_link}</span>
                <button onClick={copyLink} className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 shrink-0">
                  {copied ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy Link'}
                </button>
                <a
                  href={
                    meeting.meet_link.includes('meet.google.com')
                      ? `${meeting.meet_link}?gogMeetingId=${meetingId}`
                      : meeting.meet_link
                  }
                  target="_blank" rel="noreferrer"
                  className="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5 shrink-0">
                  <ExternalLink className="w-3.5 h-3.5" /> Open
                </a>
              </div>
            </div>
          )}
        </div>

        {/* ── Action Bar: Start/End + Transcript Toggle ── */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {meeting.status !== 'completed' && (
              !isListening ? (
                <button onClick={handleStartMeeting} className="btn-primary">
                  <Mic className="w-4 h-4" /> Start Meeting
                </button>
              ) : (
                <button onClick={handleStopMeeting} disabled={generatingReport}
                  className="inline-flex items-center gap-2 bg-red-500 hover:bg-red-600 text-white font-medium px-4 py-2.5 rounded-lg disabled:opacity-50">
                  <Square className="w-4 h-4" />
                  {generatingReport ? 'Generating report...' : 'End Meeting & Generate Report'}
                </button>
              )
            )}
            {meeting.status === 'completed' && (
              <Link href={`/meetings/${meetingId}/report`} className="btn-primary">
                <Sparkles className="w-4 h-4" /> View Report
              </Link>
            )}
          </div>

          {/* ── Capture All Participants Audio (Jitsi only) ── */}
          {platform === 'jitsi' && isListening && (
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={isCapturing ? stopCapture : startCapture}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all ${
                  isCapturing
                    ? 'bg-red-500/10 border-red-500/50 text-red-400 hover:bg-red-500/20'
                    : 'bg-accent-muted border-accent/50 text-accent hover:bg-accent/20'
                }`}
                title="Captures audio from ALL participants via tab sharing. Chrome only."
              >
                {isCapturing ? (
                  <><MicOff className="w-4 h-4" /> Stop All-Participant Capture</>
                ) : (
                  <><Mic className="w-4 h-4" /> Capture All Audio</>
                )}
                {isCapturing && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 recording-dot" />
                )}
              </button>
              {captureError && (
                <p className="text-xs text-orange-400 max-w-xs text-right">{captureError}</p>
              )}
              {!isCapturing && (
                <p className="text-xs text-text-dim max-w-xs text-right">
                  Transcribes all participants via Gemini · Chrome only · Select tab + tick &quot;Share audio&quot;
                </p>
              )}
            </div>
          )}

          {/* ── Transcript Toggle Button ── */}
          {meeting.enable_transcription && (
            <button
              onClick={() => setShowTranscript(v => !v)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all ${
                showTranscript
                  ? 'bg-accent-muted border-accent text-accent'
                  : 'bg-bg-card border-border text-text-muted hover:border-accent/40 hover:text-text'
              }`}
            >
              {showTranscript
                ? <><PanelRightClose className="w-4 h-4" /> Hide Transcription</>
                : <><PanelRightOpen  className="w-4 h-4" /> View Transcription</>}
              {isListening && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 recording-dot" />
              )}
              {segments.length > 0 && (
                <span className="text-xs bg-accent text-black font-bold px-1.5 py-0.5 rounded-full">
                  {segments.length}
                </span>
              )}
            </button>
          )}
        </div>

        {generatingReport && (
          <div className="card border-accent/30 bg-accent-muted mb-4 flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-accent animate-pulse" />
            <p className="text-sm text-accent">Gemini is generating your meeting report... Redirecting shortly.</p>
          </div>
        )}

        {/* ── Split screen: Meeting (Jitsi) + Transcription panel ── */}
        <div className={`mb-4 ${showTranscript ? 'grid grid-cols-2 gap-4' : ''}`}>

          {/* Jitsi — full width when transcript hidden, half when shown */}
          {showJitsi && meeting.meet_link && (
            <div className="card p-0 overflow-hidden" style={{ height: 560 }}>
              <JitsiMeeting
                roomUrl={meeting.meet_link}
                onLeft={handleStopMeeting}
                displayName={meeting.host_name || 'Host'}
                onDominantSpeakerChanged={(name) => {
                  speakerRef.current = name;
                  setCurrentSpeaker(name);
                }}
              />
            </div>
          )}

          {/* Transcript panel — only when toggled on */}
          {showTranscript && (
            <div className="card flex flex-col" style={{ height: showJitsi ? 560 : 'auto', minHeight: 320 }}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Mic className="w-4 h-4 text-accent" />
                  Live Transcription
                  {isListening && <span className="recording-dot w-2 h-2 rounded-full bg-red-500" />}
                </h2>
                <div className="flex items-center gap-2 text-xs text-text-dim">
                  {isListening && (
                    <span className="text-accent font-mono text-xs">
                      <Mic className="w-3 h-3 inline mr-0.5" /> {currentSpeaker}
                    </span>
                  )}
                  <span>{segments.length} segments</span>
                </div>
              </div>

              {!isSupported && (
                <div className="text-sm text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 mb-3">
                  <AlertTriangle className="w-3.5 h-3.5 inline mr-1" /> Use Chrome or Edge for live transcription.
                </div>
              )}
              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-3">
                  {error}
                </div>
              )}

              {/* Transcript scroll area */}
              <div className="flex-1 bg-bg-input border border-border rounded-lg p-3 overflow-y-auto space-y-2">
                {segments.length === 0 && !interimText && (
                  <p className="text-text-dim text-xs text-center py-8">
                    {isListening ? 'Listening... start speaking.' : 'Start meeting to begin transcription.'}
                  </p>
                )}
                {segments.map((s, i) => (
                  <div key={i} className="text-sm border-l-2 border-accent/40 pl-2">
                    <span className="text-text-dim text-xs mr-1">{formatTime(s.relative_seconds)}</span>
                    <span className="text-accent font-semibold mr-1">{s.speaker_name}:</span>
                    <span className="text-text">{s.text}</span>
                  </div>
                ))}
                {interimText && (
                  <div className="text-sm border-l-2 border-text-dim/20 pl-2 italic text-text-muted">
                    <span className="text-accent/70 font-medium mr-1">{currentSpeaker}:</span>
                    {interimText}
                  </div>
                )}
                <div ref={transcriptEndRef} />
              </div>

              <p className="text-xs text-text-dim mt-2">
                Auto-saving every 2s · {isListening
                  ? <><StopCircle className="w-3 h-3 inline text-red-400 mr-0.5" /> Recording</>
                  : <><StopCircle className="w-3 h-3 inline text-text-dim mr-0.5" /> Stopped</>}
              </p>
            </div>
          )}
        </div>

        {/* ── Participants (only when live) ── */}
        {isListening && Object.keys(participants).length > 0 && (
          <div className="card mb-4">
            <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">Live Participants</h2>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(participants).map(([id, p]) => (
                <div key={id} className="flex items-center gap-2 bg-bg-card border border-border rounded-lg px-3 py-2">
                  <div className="w-7 h-7 rounded-full bg-accent-muted flex items-center justify-center text-xs font-bold text-accent">
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm flex-1 truncate">{p.name}</span>
                  <div className="flex gap-1">
                    {p.micOn    ? <Mic       className="w-3.5 h-3.5 text-accent"   /> : <MicOff    className="w-3.5 h-3.5 text-text-dim" />}
                    {p.cameraOn ? <Camera    className="w-3.5 h-3.5 text-accent"   /> : <CameraOff className="w-3.5 h-3.5 text-text-dim" />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Attendees ── */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-3">Attendees ({meeting.attendees?.length || 0})</h2>
          <div className="grid grid-cols-2 gap-2">
            {meeting.attendees?.map((a: any) => (
              <div key={a.id} className="flex items-center gap-3 bg-bg-card border border-border rounded-lg p-3">
                <div className="w-8 h-8 rounded-full bg-accent-muted flex items-center justify-center text-xs text-accent font-medium">
                  {(a.name || a.email).charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{a.name || a.email}</p>
                  <p className="text-xs text-text-dim truncate">{a.email}</p>
                </div>
                <span className={`badge ${a.invitation_sent ? 'badge-success' : 'bg-text-dim/10 text-text-dim'}`}>
                  {a.invitation_sent ? <><Check className="w-3 h-3 inline mr-0.5" />Invited</> : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}

function InfoBlock({ icon: Icon, label, value }: any) {
  return (
    <div className="bg-bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 text-text-dim text-xs mb-1">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds ?? 0);
  const m = Math.floor(s / 60);
  return `${m.toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;
}