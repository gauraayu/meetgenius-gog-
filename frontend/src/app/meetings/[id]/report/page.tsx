'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Calendar, Clock, Video, Users, Download,
  CheckCircle, AlertCircle, TrendingUp, MessageSquare, User, Lightbulb, Sparkles, Mic,
} from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { meetingsApi } from '@/lib/api';

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

  if (loading) return <div className="flex"><Sidebar /><main className="flex-1 p-8">Loading report...</main></div>;

  if (!report) return (
    <div className="flex"><Sidebar />
      <main className="flex-1 p-8">
        <div className="card text-center py-16">
          <div className="inline-block w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin mb-4"></div>
          <h3 className="text-lg font-medium mb-2">Generating Report...</h3>
          <p className="text-text-muted">Gemini is analyzing the transcript. This usually takes 10-30 seconds.</p>
        </div>
      </main>
    </div>
  );

  // ── Attendance logic ──
  const speakers = Object.keys(report.speaker_contribution || {});
  const present = speakers.length;
  const invitedList: string[] = meeting?.attendees || [];
  const totalInvited = Math.max(invitedList.length, present);
  const absent = Math.max(0, totalInvited - present);
  const attendancePct = totalInvited > 0 ? Math.min(100, Math.round((present / totalInvited) * 100)) : 0;

  const SPEAKER_COLORS = ['#22c55e','#3b82f6','#f59e0b','#ec4899','#8b5cf6','#14b8a6','#f97316','#06b6d4'];

  // Calculate join/leave time per speaker from transcript segments
  const speakerTimes: Record<string, { joinSec: number; leaveSec: number }> = {};
  if (report.full_transcript_text) {
    const lines = report.full_transcript_text.split('\n');
    lines.forEach((line: string) => {
      const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+(.+?):/);
      if (match) {
        const h = parseInt(match[1]), m = parseInt(match[2]), s = parseInt(match[3]);
        const secs = h * 3600 + m * 60 + s;
        const spk = match[4].trim();
        if (!speakerTimes[spk]) speakerTimes[spk] = { joinSec: secs, leaveSec: secs };
        else speakerTimes[spk].leaveSec = secs;
      }
    });
  }

  // Convert relative seconds to actual clock time using meeting start
  const meetingStartStr = meeting?.actual_start_time || meeting?.meeting_date + 'T' + (meeting?.start_time || '00:00:00');
  const meetingStartMs = new Date(meetingStartStr).getTime();

  const secToTime = (relSec: number) => {
    const d = new Date(meetingStartMs + relSec * 1000);
    return isNaN(d.getTime()) ? 'N/A' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-6 max-w-6xl overflow-y-auto">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-5">
          <Link href={`/meetings/${meetingId}`} className="text-text-muted hover:text-text text-sm flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" /> Back to Meeting
          </Link>
          <span className="text-xs text-text-dim">
            Report Generated on: {new Date(report.generated_at).toLocaleString('en-IN')}
          </span>
        </div>

        {/* Title */}
        <div className="flex items-center gap-3 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">Meeting Report</h1>
              <span className="badge-success px-3 py-1 text-sm rounded-full">Completed</span>
            </div>
            <p className="text-text-muted text-sm mt-1">AI-Generated Meeting Summary and Insights</p>
          </div>
        </div>

        {/* Meeting Info Card */}
        <div className="card mb-5">
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center">
              <Calendar className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold">{meeting.title}</h2>
              <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">{meeting.meeting_type || 'Internal Meeting'}</span>
              <p className="text-xs text-text-dim mt-1">Meeting ID: {meeting.meeting_code}</p>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-6 border-t border-border pt-4">
            <div>
              <p className="text-xs text-text-muted mb-1 flex items-center gap-1"><Calendar className="w-3 h-3"/> Date & Time</p>
              <p className="text-sm font-semibold">{meeting.meeting_date}</p>
              <p className="text-xs text-text-dim">{meeting.start_time?.slice(0,5)} ({meeting.duration_minutes}m)</p>
            </div>
            <div>
              <p className="text-xs text-text-muted mb-1 flex items-center gap-1"><User className="w-3 h-3"/> Host</p>
              <p className="text-sm font-semibold">{meeting.host_name || 'You'}</p>
            </div>
            <div>
              <p className="text-xs text-text-muted mb-1 flex items-center gap-1"><Video className="w-3 h-3"/> Platform</p>
              <p className="text-sm font-semibold">Google Meet</p>
              <p className="text-xs text-text-dim truncate">{meeting.meet_link}</p>
            </div>
            <div>
              <p className="text-xs text-text-muted mb-1 flex items-center gap-1"><MessageSquare className="w-3 h-3"/> Agenda</p>
              <p className="text-sm font-semibold line-clamp-2">{meeting.agenda || '...'}</p>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-5 gap-4 mb-6">
          {[
            { icon: Users,       label: 'Total Invited', value: totalInvited, color: 'text-text' },
            { icon: CheckCircle, label: 'Present',       value: present,      color: 'text-accent' },
            { icon: AlertCircle, label: 'Absent',        value: absent,       color: absent > 0 ? 'text-red-400' : 'text-text-dim' },
            { icon: TrendingUp,  label: 'Attendance',    value: `${attendancePct}%`, color: 'text-accent' },
            { icon: TrendingUp,  label: 'Engagement',    value: `${report.engagement_score || 0}%`, color: 'text-orange-400' },
          ].map(({ icon: Icon, label, value, color }) => (
            <div key={label} className="card text-center">
              <div className="flex items-center justify-center gap-1 text-text-muted text-xs mb-2">
                <Icon className="w-3.5 h-3.5" /> {label}
              </div>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* 1. AI Summary — full width */}
        <div className="card mb-5">
          <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" /> AI Summary
          </h2>
          <p className="text-sm text-text leading-relaxed mb-4">{report.summary}</p>
          {report.key_points?.length > 0 && (
            <>
              <p className="text-xs font-semibold text-text-muted mb-2">Key Points:</p>
              <ul className="space-y-1.5">
                {report.key_points.map((kp: string, i: number) => (
                  <li key={i} className="flex gap-2 text-sm text-text-muted">
                    <span className="text-accent mt-0.5 shrink-0">•</span> {kp}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* 2. Speaker Contribution — full width */}
        <div className="card mb-5">
          <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
            <Mic className="w-4 h-4 text-accent" /> Speaker Contribution
          </h2>
          {speakers.length === 0 ? (
            <p className="text-sm text-text-dim">No speaker data.</p>
          ) : (
            <div className="space-y-4">
              {Object.entries(report.speaker_contribution || {}).map(([name, data]: any, i) => (
                <div key={name} className="flex items-center gap-4">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }} />
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium">{name}</span>
                      <span className="text-xs text-text-muted">
                        {Math.floor((data.seconds||0) / 60)}m {(data.seconds||0) % 60}s ({data.percentage||0}%)
                      </span>
                    </div>
                    <div className="h-2 bg-bg-card rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${data.percentage||0}%`, backgroundColor: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3. Participants Overview table */}
        <div className="card mb-5">
          <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" /> Participants Overview
          </h2>
          {speakers.length === 0 ? (
            <p className="text-sm text-text-dim">No participant data.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-text-dim">
                      <th className="text-left pb-3 font-medium pr-3">#</th>
                      <th className="text-left pb-3 font-medium pr-4">Participant</th>
                      <th className="text-left pb-3 font-medium pr-4">Department</th>
                      <th className="text-left pb-3 font-medium pr-4">Join Time</th>
                      <th className="text-left pb-3 font-medium pr-4">Leave Time</th>
                      <th className="text-left pb-3 font-medium pr-4">Duration</th>
                      <th className="text-left pb-3 font-medium pr-4 text-accent">Camera ON</th>
                      <th className="text-left pb-3 font-medium pr-4 text-red-400">Camera OFF</th>
                      <th className="text-left pb-3 font-medium text-orange-400">Mic Muted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.speaker_contribution || {}).map(([name, data]: any, i) => {
                      const p = (report.participants_overview || []).find((x: any) => x.name === name) || {};
                      const speakingMins = Math.floor((data.seconds||0) / 60);
                      const speakingSecs = (data.seconds||0) % 60;
                      return (
                        <tr key={name} className="border-b border-border/40 hover:bg-bg-card/30 transition-colors">
                          <td className="py-3 text-text-dim text-xs pr-3">{i+1}</td>
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                                style={{ backgroundColor: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }}>
                                {name.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <span className="font-medium">{name}</span>
                                {(p.is_host || i === 0) && (
                                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent">Host</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-3 text-text-muted pr-4 text-xs">{p.department || 'N/A'}</td>
                          <td className="py-3 text-text-muted pr-4 text-xs">
                            {speakerTimes[name] ? secToTime(speakerTimes[name].joinSec) : (p.join_time || 'N/A')}
                          </td>
                          <td className="py-3 text-text-muted pr-4 text-xs">
                            {speakerTimes[name] ? secToTime(speakerTimes[name].leaveSec) : (p.leave_time || 'N/A')}
                          </td>
                          <td className="py-3 text-text-muted pr-4 text-xs">
                            {speakerTimes[name] ? (() => {
                              const totalSec = speakerTimes[name].leaveSec - speakerTimes[name].joinSec;
                              const dm = Math.floor(totalSec / 60);
                              const ds = totalSec % 60;
                              return dm > 0 ? `${dm}m ${ds}s` : `${ds}s`;
                            })() : (p.duration || `${speakingMins}m ${speakingSecs}s`)}
                          </td>
                          <td className="py-3 pr-4 text-xs text-accent">{p.camera_on || 'N/A'}</td>
                          <td className="py-3 pr-4 text-xs text-red-400">{p.camera_off || 'N/A'}</td>
                          <td className="py-3 text-xs text-orange-400">{p.mic_muted || 'N/A'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(report.absent_participants || []).length > 0 && (
                <p className="text-xs text-text-muted mt-3">
                  <span className="text-red-400 font-medium">{report.absent_participants.length} Absent: </span>
                  {report.absent_participants.join(', ')}
                </p>
              )}
            </>
          )}
        </div>

        {/* 4. Decisions + Action Items */}
        <div className="grid grid-cols-2 gap-5 mb-5">
          <div className="card">
            <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-accent" /> Decisions Taken
            </h2>
            <div className="space-y-2">
              {(report.decisions || []).length === 0
                ? <p className="text-sm text-text-dim">No decisions captured.</p>
                : (report.decisions || []).map((d: any, i: number) => (
                  <div key={i} className="flex gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                    <div>
                      <p>{d.text}</p>
                      {d.context && <p className="text-xs text-text-dim mt-0.5">{d.context}</p>}
                    </div>
                  </div>
                ))}
            </div>
          </div>

          <div className="card">
            <h2 className="text-base font-semibold mb-3">Action Items</h2>
            {(report.action_items || []).length === 0
              ? <p className="text-sm text-text-dim">No action items.</p>
              : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-dim border-b border-border">
                      <th className="text-left pb-2 font-medium">#</th>
                      <th className="text-left pb-2 font-medium">Task</th>
                      <th className="text-left pb-2 font-medium">Assignee</th>
                      <th className="text-left pb-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.action_items || []).map((a: any, i: number) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-2 text-text-dim">{i+1}</td>
                        <td className="py-2 font-medium">{a.task}</td>
                        <td className="py-2 text-text-muted">{a.assignee}</td>
                        <td className="py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            a.status === 'completed'   ? 'bg-green-500/10 text-green-400' :
                            a.status === 'in_progress' ? 'bg-yellow-500/10 text-yellow-400' :
                            'bg-text-dim/10 text-text-dim'
                          }`}>{a.status || 'pending'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </div>

        {/* 5. Highlights */}
        {(report.highlights || []).length > 0 && (
          <div className="card mb-5">
            <h2 className="text-base font-semibold mb-3">Full Transcript (Highlights)</h2>
            <div className="space-y-2">
              {(report.highlights || []).map((h: any, i: number) => (
                <div key={i} className="flex gap-4 text-sm border-l-2 border-accent pl-3 py-1">
                  <span className="text-text-dim w-14 shrink-0 text-xs">{h.timestamp}</span>
                  <div>
                    <span className="text-accent font-medium">{h.speaker}: </span>
                    <span className="text-text-muted">{h.quote}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 6. Next Meeting */}
        {report.next_meeting_suggestion && (
          <div className="card border-accent/30 bg-accent/5 mb-5">
            <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-accent" /> Next Meeting Suggestion
            </h2>
            <div className="grid grid-cols-3 gap-4 mb-2">
              <div><p className="text-xs text-text-muted mb-1">Date</p><p className="font-medium text-sm">{report.next_meeting_suggestion.suggested_date}</p></div>
              <div><p className="text-xs text-text-muted mb-1">Time</p><p className="font-medium text-sm">{report.next_meeting_suggestion.suggested_time}</p></div>
              <div><p className="text-xs text-text-muted mb-1">Topic</p><p className="font-medium text-sm">{report.next_meeting_suggestion.topic}</p></div>
            </div>
            <p className="text-xs text-text-muted">
              <Lightbulb className="w-3.5 h-3.5 inline mr-1 text-yellow-400" />
              {report.next_meeting_suggestion.reasoning}
            </p>
          </div>
        )}

        {/* 7. Full Transcript */}
        {report.full_transcript_text && (
          <details className="card mt-2 mb-6">
            <summary className="cursor-pointer font-semibold text-sm">View Full Transcript</summary>
            <pre className="text-xs text-text-muted whitespace-pre-wrap mt-4 max-h-96 overflow-y-auto bg-bg-input p-4 rounded leading-relaxed">
              {report.full_transcript_text}
            </pre>
          </details>
        )}

      </main>
    </div>
  );
}