'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Calendar, Video, Users, Download,
  CheckCircle, AlertCircle, TrendingUp, MessageSquare, User, Lightbulb, Sparkles,
} from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { meetingsApi } from '@/lib/api';

// ── Speaker colour palette ────────────────────────────────────────────────────
const SPEAKER_COLORS = [
  '#4ade80', // green
  '#60a5fa', // blue
  '#f472b6', // pink
  '#fb923c', // orange
  '#a78bfa', // purple
  '#34d399', // teal
  '#fbbf24', // amber
  '#f87171', // red
];

// ── Dedup helpers (mirrors backend logic) ────────────────────────────────────
function isContinuation(prev: string, current: string): boolean {
  if (!prev || !current) return false;
  if (current.startsWith(prev)) return true;
  if (prev.length > 15 && current.slice(0, Math.floor(current.length * 0.85)).includes(prev)) return true;
  return false;
}

function extractNewText(prev: string, current: string): string {
  if (current.startsWith(prev)) return current.slice(prev.length).trim();
  const idx = current.indexOf(prev);
  if (idx !== -1) return current.slice(idx + prev.length).trim();
  return current;
}

// Parse "[00:02:17] SPEAKER NAME: text" and deduplicate cumulative Web Speech repeats
function parseTranscriptLines(raw: string) {
  const lineRegex = /^\[(\d{2}:\d{2}:\d{2})\]\s+(.+?):\s+(.+)$/;
  const parsed = raw
    .split('\n')
    .map((line) => {
      const m = line.match(lineRegex);
      if (!m) return null;
      return { timestamp: m[1], speaker: m[2].trim(), text: m[3].trim() };
    })
    .filter(Boolean) as { timestamp: string; speaker: string; text: string }[];

  // Dedup: remove cumulative repetitions per speaker
  const lastTextBySpeaker: Record<string, string> = {};
  const deduped: { timestamp: string; speaker: string; text: string }[] = [];

  for (const line of parsed) {
    const prev = lastTextBySpeaker[line.speaker] ?? '';
    if (prev && isContinuation(prev, line.text)) {
      const newPart = extractNewText(prev, line.text);
      if (newPart && newPart.split(' ').length >= 2) {
        deduped.push({ ...line, text: newPart });
      }
      lastTextBySpeaker[line.speaker] = line.text;
    } else {
      deduped.push(line);
      lastTextBySpeaker[line.speaker] = line.text;
    }
  }

  return deduped;
}

function downloadTranscript(raw: string, meetingTitle: string) {
  const lines = parseTranscriptLines(raw);
  const content = lines
    .map(l => `[${l.timestamp}]  ${l.speaker}: ${l.text}`)
    .join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript-${meetingTitle.replace(/\s+/g, '-').toLowerCase()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function TranscriptViewer({ raw, meetingTitle }: { raw: string; meetingTitle: string }) {
  const lines = parseTranscriptLines(raw);

  // Build stable speaker → colour map
  const speakerMap = new Map<string, string>();
  lines.forEach(({ speaker }) => {
    if (!speakerMap.has(speaker)) {
      speakerMap.set(speaker, SPEAKER_COLORS[speakerMap.size % SPEAKER_COLORS.length]);
    }
  });

  if (lines.length === 0) {
    return (
      <pre className="text-xs text-text-muted whitespace-pre-wrap mt-4 max-h-96 overflow-y-auto bg-bg-input p-4 rounded">
        {raw}
      </pre>
    );
  }

  return (
    <div
      className="mt-4 rounded-lg overflow-hidden"
      style={{ background: '#0f1117', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* ── Top bar: legend + download ── */}
      <div
        className="flex items-center justify-between px-5 py-2.5 sticky top-0 z-10"
        style={{
          background: 'rgba(15,17,23,0.97)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {/* Speaker legend */}
        <div className="flex items-center gap-4 flex-wrap">
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: 'rgba(255,255,255,0.25)' }}
          >
            Speakers
          </span>
          {Array.from(speakerMap.entries()).map(([name, color]) => (
            <span key={name} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: color }}
              />
              <span className="text-xs font-semibold" style={{ color }}>
                {name}
              </span>
            </span>
          ))}
        </div>

        {/* Download button */}
        <button
          onClick={() => downloadTranscript(raw, meetingTitle)}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors"
          style={{
            color: 'rgba(255,255,255,0.6)',
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.04)',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
        >
          <Download className="w-3.5 h-3.5" />
          Download Transcript
        </button>
      </div>

      {/* ── Transcript lines ── */}
      <div
        className="max-h-[520px] overflow-y-auto"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.08) transparent' }}
      >
        {lines.map((line, i) => {
          const color = speakerMap.get(line.speaker)!;
          return (
            <div
              key={i}
              className="flex items-start gap-4 px-5 py-2.5"
              style={{
                borderLeft: `3px solid ${color}`,
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              {/* Timestamp */}
              <span
                className="shrink-0 text-xs font-mono tabular-nums mt-0.5"
                style={{ color: 'rgba(255,255,255,0.28)', minWidth: '4.5rem' }}
              >
                {line.timestamp}
              </span>

              {/* Speaker bold + text */}
              <span className="text-sm leading-relaxed">
                <span className="font-bold mr-1" style={{ color }}>
                  {line.speaker}:
                </span>
                <span style={{ color: 'rgba(255,255,255,0.82)' }}>
                  {line.text}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ReportPage() {
  const params = useParams();
  const meetingId = Number(params.id);

  const [meeting, setMeeting] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  const fetchData = async () => {
    try {
      const m: any = await meetingsApi.get(meetingId);
      setMeeting(m);
      try {
        const r: any = await meetingsApi.getReport(meetingId);
        setReport(r);
        setPolling(false);
      } catch {
        setPolling(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [meetingId]);
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(fetchData, 4000);
    return () => clearInterval(t);
  }, [polling, meetingId]);

  if (loading) return (
    <div className="flex"><Sidebar /><main className="flex-1 p-8">Loading report...</main></div>
  );

  if (!report) return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-8">
        <div className="card text-center py-16">
          <div className="inline-block w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin mb-4" />
          <h3 className="text-lg font-medium mb-2">Generating Report...</h3>
          <p className="text-text-muted">Gemini is analyzing the transcript. This usually takes 10–30 seconds.</p>
        </div>
      </main>
    </div>
  );

  const totalAttendees = meeting?.attendees?.length || 0;
  const speakers = Object.keys(report.speaker_contribution || {});
  const present = speakers.length;
  const absent = totalAttendees - present;

  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-8 max-w-6xl">
        <div className="flex items-center justify-between mb-4">
          <Link href={`/meetings/${meetingId}`} className="text-text-muted hover:text-text text-sm flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" /> Back to Meeting
          </Link>
          <span className="text-xs text-text-dim">
            Report Generated on: {new Date(report.generated_at).toLocaleString('en-IN')}
          </span>
        </div>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <h1 className="text-3xl font-bold">Meeting Report</h1>
            <span className="badge-success">Completed</span>
          </div>
          <p className="text-text-muted">AI-Generated Meeting Summary and Insights</p>
        </div>

        {/* Meeting Overview */}
        <div className="card mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-accent-muted flex items-center justify-center">
              <Calendar className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold">{meeting.title}</h2>
              <span className="badge-success mt-1">{meeting.meeting_type}</span>
              <p className="text-xs text-text-dim mt-1">Meeting ID: {meeting.meeting_code}</p>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <Block icon={Calendar} label="Date & Time" value={`${meeting.meeting_date}\n${meeting.start_time.slice(0,5)} (${meeting.duration_minutes}m)`} />
            <Block icon={Users} label="Host" value={meeting.host_name || 'You'} />
            <Block icon={Video} label="Platform" value="Google Meet" subValue={meeting.meet_link} />
            <Block icon={MessageSquare} label="Agenda" value={(meeting.agenda || '').substring(0, 60) + '...'} />
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-5 gap-4 mb-6">
          <StatCard icon={Users} label="Total Invited" value={totalAttendees} />
          <StatCard icon={CheckCircle} label="Present" value={present} color="text-accent" />
          <StatCard icon={AlertCircle} label="Absent" value={absent} color="text-red-500" />
          <StatCard icon={TrendingUp} label="Attendance" value={`${report.attendance_percentage}%`} color="text-accent" />
          <StatCard icon={TrendingUp} label="Engagement" value={`${report.engagement_score}%`} color="text-orange-500" />
        </div>

        {/* AI Summary */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" /> AI Summary
          </h2>
          <p className="text-text whitespace-pre-wrap leading-relaxed">{report.summary}</p>
          {report.key_points?.length > 0 && (
            <div className="mt-4">
              <p className="font-medium mb-2">Key Points:</p>
              <ul className="space-y-1 text-sm text-text-muted">
                {report.key_points.map((kp: string, i: number) => (
                  <li key={i} className="flex gap-2"><span className="text-accent">•</span> {kp}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Decisions + Action Items */}
        <div className="grid grid-cols-2 gap-6 mb-6">
          <div className="card">
            <h2 className="text-lg font-semibold mb-3">Decisions Taken</h2>
            <div className="space-y-3">
              {(report.decisions || []).map((d: any, i: number) => (
                <div key={i} className="flex gap-3">
                  <CheckCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm">{d.text}</p>
                    {d.context && <p className="text-xs text-text-dim mt-1">{d.context}</p>}
                  </div>
                </div>
              ))}
              {(!report.decisions || report.decisions.length === 0) && (
                <p className="text-sm text-text-dim">No decisions captured.</p>
              )}
            </div>
          </div>
          <div className="card">
            <h2 className="text-lg font-semibold mb-3">Action Items</h2>
            <div className="space-y-2">
              {(report.action_items || []).map((a: any, i: number) => (
                <div key={i} className="bg-bg-card border border-border rounded-lg p-3">
                  <p className="text-sm font-medium">{a.task}</p>
                  <div className="flex items-center justify-between mt-2 text-xs text-text-muted">
                    <span className="flex items-center gap-1"><User className="w-3 h-3" /> {a.assignee}</span>
                    <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {a.deadline}</span>
                    <span className={`badge ${a.status === 'completed' ? 'badge-success' : a.status === 'in_progress' ? 'badge-warning' : 'bg-text-dim/10 text-text-dim'}`}>{a.status}</span>
                  </div>
                </div>
              ))}
              {(!report.action_items || report.action_items.length === 0) && (
                <p className="text-sm text-text-dim">No action items.</p>
              )}
            </div>
          </div>
        </div>

        {/* Speaker contribution */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Speaker Contribution</h2>
          <div className="space-y-3">
            {Object.entries(report.speaker_contribution || {}).map(([name, data]: any) => (
              <div key={name}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{name}</span>
                  <span className="text-sm text-text-muted">{Math.floor(data.seconds / 60)}m {data.seconds % 60}s ({data.percentage}%)</span>
                </div>
                <div className="h-2 bg-bg-card rounded-full overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${data.percentage}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Highlights */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-3">Highlights from the Discussion</h2>
          <div className="space-y-2">
            {(report.highlights || []).map((h: any, i: number) => (
              <div key={i} className="flex gap-4 text-sm border-l-2 border-accent pl-3 py-1">
                <span className="text-text-dim w-16 shrink-0">{h.timestamp}</span>
                <div>
                  <span className="text-accent font-medium">{h.speaker}: </span>
                  <span>{h.quote}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Next meeting suggestion */}
        {report.next_meeting_suggestion && (
          <div className="card border-accent/30 bg-accent-muted">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Calendar className="w-5 h-5 text-accent" /> Next Meeting Suggestion
            </h2>
            <div className="grid grid-cols-3 gap-4">
              <div><p className="text-xs text-text-muted mb-1">Suggested Date</p><p className="font-medium">{report.next_meeting_suggestion.suggested_date}</p></div>
              <div><p className="text-xs text-text-muted mb-1">Time</p><p className="font-medium">{report.next_meeting_suggestion.suggested_time}</p></div>
              <div><p className="text-xs text-text-muted mb-1">Topic</p><p className="font-medium">{report.next_meeting_suggestion.topic}</p></div>
            </div>
            <p className="text-xs text-text-muted mt-3">
              <Lightbulb className="w-3.5 h-3.5 inline mr-1 text-yellow-400" />{report.next_meeting_suggestion.reasoning}
            </p>
          </div>
        )}

        {/* ── Full Transcript ── */}
        {report.full_transcript_text && (
          <details className="card mt-6" open>
            <summary className="cursor-pointer font-semibold select-none flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-accent" /> View Full Transcript
            </summary>
            <TranscriptViewer
              raw={report.full_transcript_text}
              meetingTitle={meeting.title}
            />
          </details>
        )}
      </main>
    </div>
  );
}

function Block({ icon: Icon, label, value, subValue }: any) {
  return (
    <div>
      <div className="flex items-center gap-2 text-text-dim text-xs mb-1"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <p className="text-sm font-medium whitespace-pre-line">{value}</p>
      {subValue && <p className="text-xs text-text-dim truncate">{subValue}</p>}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color = 'text-text' }: any) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-text-muted text-xs mb-2"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}