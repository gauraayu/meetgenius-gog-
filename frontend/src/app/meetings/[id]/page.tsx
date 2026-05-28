'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Video, Calendar, Clock, Users, Mic, MicOff,
  Square, Sparkles, ExternalLink, Copy, Check, Camera, CameraOff,
  PanelRightOpen, PanelRightClose,
} from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { meetingsApi, transcriptApi } from '@/lib/api';
import { useSpeechTranscription } from '@/hooks/useSpeechTranscription';

/* ─── Jitsi Embedded Component ───────────────────────────── */
interface JitsiProps {
  roomUrl: string;
  onLeft: () => void;
}

function JitsiMeeting({ roomUrl, onLeft }: Pick<JitsiProps, 'roomUrl' | 'onLeft'>) {
  // Simple iframe embed — most reliable approach
  // roomUrl = https://meet.jit.si/GOG-roomname
  const room = roomUrl.replace('https://meet.jit.si/', '');
  const src  = `https://meet.jit.si/${room}#config.prejoinPageEnabled=false&config.startWithAudioMuted=false&config.disableDeepLinking=true&interfaceConfig.SHOW_JITSI_WATERMARK=false&interfaceConfig.TOOLBAR_BUTTONS=["microphone","camera","chat","raisehand","tileview","hangup"]`;

  return (
    <iframe
      src={src}
      allow="camera; microphone; display-capture; autoplay; clipboard-write"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        borderRadius: 12,
      }}
      title="Jitsi Meeting"
    />
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
      else { if (meeting?.meet_link) window.open(meeting.meet_link, '_blank'); }
    } catch (e: any) { alert('Failed to start: ' + e.message); }
  };

  const handleStopMeeting = async () => {
    stop();
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
  const platformEmoji = platform === 'zoom' ? '🔵' : platform === 'jitsi' ? '🎥' : '📹';

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
                <p className="text-text-dim text-sm">
                  {meeting.meeting_code} · {platformEmoji} {platformLabel}
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
                <span className="text-xl">{platformEmoji}</span>
                <span className="text-sm font-medium flex-1 break-all text-text">{meeting.meet_link}</span>
                <button onClick={copyLink} className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 shrink-0">
                  {copied ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy Link'}
                </button>
                <a href={meeting.meet_link} target="_blank" rel="noreferrer"
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
                      🎙 {currentSpeaker}
                    </span>
                  )}
                  <span>{segments.length} segments</span>
                </div>
              </div>

              {!isSupported && (
                <div className="text-sm text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 mb-3">
                  ⚠️ Use Chrome or Edge for live transcription.
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
                Auto-saving every 2s · {isListening ? '🔴 Recording' : '⚫ Stopped'}
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
                  {a.invitation_sent ? '✓ Invited' : 'Pending'}
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