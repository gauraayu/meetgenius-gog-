'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Calendar, Clock, Video, Users, Search, MonitorPlay, Mic } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { meetingsApi } from '@/lib/api';

export default function MeetingsPage() {
  const [grouped, setGrouped] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    meetingsApi.groupedByDate()
      .then(setGrouped)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const allMeetings = Object.values(grouped).flat();
  const filtered = search
    ? allMeetings.filter(m =>
        m.title?.toLowerCase().includes(search.toLowerCase()) ||
        m.meeting_code?.toLowerCase().includes(search.toLowerCase())
      )
    : null;

  const dates = Object.keys(grouped).sort().reverse();

  const statusBadge = (s: string) =>
    s === 'live'      ? 'badge-warning' :
    s === 'completed' ? 'badge-success' :
    s === 'cancelled' ? 'badge-danger'  : 'bg-text-dim/10 text-text-dim';

  const PlatformIcon = ({ p }: { p: string }) =>
    p === 'zoom'   ? <MonitorPlay className="w-5 h-5 text-blue-400" /> :
    p === 'jitsi'  ? <Mic         className="w-5 h-5 text-orange-400" /> :
                     <Video       className="w-5 h-5 text-accent" />;

  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-8 max-w-5xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Meetings</h1>
            <p className="text-text-muted text-sm mt-1">All your scheduled meetings</p>
          </div>
          <Link href="/meetings/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Schedule Meeting
          </Link>
        </div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-dim" />
          <input
            className="input pl-9 w-full max-w-sm"
            placeholder="Search meetings..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="text-text-muted animate-pulse">Loading meetings...</div>
        ) : allMeetings.length === 0 ? (
          <div className="card text-center py-16">
            <Calendar className="w-12 h-12 text-text-dim mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No meetings yet</h3>
            <p className="text-text-muted mb-6">Schedule your first meeting to get started.</p>
            <Link href="/meetings/new" className="btn-primary">
              <Plus className="w-4 h-4" /> Schedule Meeting
            </Link>
          </div>
        ) : search && filtered ? (
          /* Search results */
          <div className="space-y-2">
            <p className="text-xs text-text-dim mb-3">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</p>
            {filtered.map(m => (
              <MeetingRow key={m.id} m={m} statusBadge={statusBadge} PlatformIcon={PlatformIcon} />
            ))}
          </div>
        ) : (
          /* Grouped by date */
          <div className="space-y-6">
            {dates.map(date => (
              <div key={date}>
                <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  {formatDate(date)}
                  <span className="text-text-dim font-normal">
                    · {grouped[date].length} meeting{grouped[date].length > 1 ? 's' : ''}
                  </span>
                </h2>
                <div className="space-y-2">
                  {grouped[date].map(m => (
                    <MeetingRow key={m.id} m={m} statusBadge={statusBadge} PlatformIcon={PlatformIcon} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function MeetingRow({ m, statusBadge, PlatformIcon }: any) {
  return (
    <Link href={`/meetings/${m.id}`}
      className="card hover:border-accent transition-colors block">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-accent-muted flex items-center justify-center">
            <PlatformIcon p={m.platform || 'google'} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{m.title}</h3>
              {m.series_id && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-bg-card text-text-dim">recurring</span>
              )}
            </div>
            <p className="text-xs text-text-dim">{m.meeting_code}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm text-text-muted">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {m.start_time?.slice(0,5)} · {m.duration_minutes}m
          </span>
          <span className={`badge ${statusBadge(m.status)}`}>{m.status}</span>
          {m.has_report && (
            <span className="badge bg-purple-500/10 text-purple-400">Report ready</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = (d.getTime() - today.getTime()) / 86400000;
  if (diff === 0)  return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1)  return 'Tomorrow';
  return d.toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}