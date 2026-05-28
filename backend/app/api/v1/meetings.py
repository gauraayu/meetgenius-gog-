"""
Meeting endpoints - schedule, list, fetch, update.

Schedule flow:
1. Validate input
2. Create MeetingSeries (if recurring)
3. Create Meeting row(s)
4. Call Google Calendar API -> get Meet link + send invites
5. Save attendees
6. Return full meeting object
"""
from datetime import datetime, timedelta, date as date_cls
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from sqlalchemy.orm import Session
from sqlalchemy import and_

from app.db.session import get_db
from app.models.user import User
from app.models.meeting import Meeting, MeetingSeries, MeetingAttendee
from app.models.transcript import MeetingReport
from app.schemas.meeting import (
    MeetingCreate, MeetingOut, MeetingListItem, AttendeeOut
)
from app.services import google_calendar, email_service
from app.services import zoom_service, jitsi_service
from app.core.security import get_current_user
from app.core.config import settings


router = APIRouter(prefix="/meetings", tags=["meetings"])

def _generate_report_task(meeting_id: int, db_url: str):
    """Auto-generate Gemini report after meeting ends"""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.services.gemini_ai import generate_meeting_report
    from app.models.transcript import TranscriptSegment, MeetingReport

    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False} if "sqlite" in db_url else {}
    )
    db = sessionmaker(bind=engine)()
    try:
        meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
        if not meeting:
            print(f"[report] meeting {meeting_id} not found")
            return

        # Get transcript segments
        segs = db.query(TranscriptSegment).filter(
            TranscriptSegment.meeting_id == meeting_id
        ).order_by(TranscriptSegment.id).all()

        # Format segments as list of dicts (matching gemini_ai function signature)
        transcript_segments = [
            {
                "speaker_name": s.speaker_name or "Host",
                "text":         s.text,
                "relative_seconds": s.relative_seconds or 0,
            }
            for s in segs
        ]

        if not transcript_segments:
            transcript_segments = [{"speaker_name": "Host", "text": "No transcript recorded.", "relative_seconds": 0}]

        # Meeting metadata
        attendees = [a.name or a.email for a in meeting.attendees]
        meeting_metadata = {
            "title":            meeting.title,
            "date":             str(meeting.meeting_date),
            "duration_minutes": meeting.duration_minutes,
            "attendees":        attendees,
            "agenda":           meeting.agenda or "",
            "purpose":          meeting.purpose or "",
        }

        print(f"[report] Generating for meeting {meeting_id} — {len(transcript_segments)} segments")

        # Call gemini (sync function — NOT async)
        result = generate_meeting_report(
            transcript_segments=transcript_segments,
            meeting_metadata=meeting_metadata,
        )

        # Save report
        report = db.query(MeetingReport).filter(
            MeetingReport.meeting_id == meeting_id
        ).first()
        if not report:
            report = MeetingReport(meeting_id=meeting_id)
            db.add(report)

        report.summary                = result.get("summary", "")
        report.key_points             = result.get("key_points", [])
        report.decisions              = result.get("decisions", [])
        report.action_items           = result.get("action_items", [])
        report.speaker_contribution   = result.get("speaker_contribution", {})
        report.topics                 = result.get("topics", [])
        report.sentiment              = result.get("sentiment", {})
        report.engagement_score       = result.get("engagement_score", 0)
        report.highlights             = result.get("highlights", [])
        report.next_meeting_suggestion= result.get("next_meeting_suggestion")
        report.full_transcript_text   = result.get("full_transcript_text", "")
        report.attendance_percentage  = result.get("attendance_percentage", 0)
        report.generated_at           = datetime.utcnow()
        db.commit()
        print(f"[report] ✓ Done for meeting {meeting_id}")

    except Exception as e:
        import traceback
        print(f"[report] ✗ Error for meeting {meeting_id}: {e}")
        traceback.print_exc()
    finally:
        db.close()


def _generate_meeting_code(db: Session, mdate: date_cls) -> str:
    """MEET-YYYY-MMDD-NNN"""
    prefix = f"MEET-{mdate.strftime('%Y-%m%d')}"
    count = db.query(Meeting).filter(Meeting.meeting_date == mdate).count() + 1
    return f"{prefix}-{count:03d}"



@router.get("/generate-link")
async def generate_meeting_link(
    platform: str = "jitsi",
    title: str = "Meeting",
    user: User = Depends(get_current_user),
):
    """Generate a meeting link without creating a full meeting"""
    import uuid, re
    if platform == "jitsi":
        slug = re.sub(r"[^a-zA-Z0-9]", "", title.replace(" ", "-"))[:20] or "Meeting"
        room = f"GOG-{slug}-{uuid.uuid4().hex[:6].upper()}"
        return {"platform": "jitsi", "link": f"https://meet.jit.si/{room}"}
    elif platform == "zoom":
        return {"platform": "zoom", "link": "", "message": "Zoom link will be generated on scheduling"}
    else:
        return {"platform": "google", "link": "", "message": "Google Meet link will be generated on scheduling"}


@router.post("", response_model=MeetingOut)
async def create_meeting(
    payload: MeetingCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not user.google_refresh_token:
        raise HTTPException(400, "Connect Google account first to create meetings")

    # 1. Create series if recurring
    series = None
    if payload.is_recurring and payload.recurrence_type:
        series = MeetingSeries(
            title=payload.title,
            purpose=payload.purpose,
            default_agenda=payload.agenda,
            recurrence_type=payload.recurrence_type,
            default_start_time=payload.start_time,
            default_duration_minutes=payload.duration_minutes,
            default_timezone=payload.timezone,
            host_user_id=user.id,
        )
        db.add(series)
        db.flush()

    # 2. Create meeting row
    meeting = Meeting(
        meeting_code=_generate_meeting_code(db, payload.meeting_date),
        series_id=series.id if series else None,
        title=payload.title,
        meeting_type=payload.meeting_type,
        purpose=payload.purpose,
        agenda=payload.agenda,
        meeting_date=payload.meeting_date,
        start_time=payload.start_time,
        duration_minutes=payload.duration_minutes,
        timezone=payload.timezone,
        priority=payload.priority,
        enable_transcription=payload.enable_transcription,
        enable_speaker_id=payload.enable_speaker_id,
        enable_action_detection=payload.enable_action_detection,
        enable_screenshots=payload.enable_screenshots,
        enable_summary=payload.enable_summary,
        notify_minutes_before=payload.notify_minutes_before,
        additional_notes=payload.additional_notes,
        host_user_id=user.id,
        platform=getattr(payload, "platform", "google"),
    )
    db.add(meeting)
    db.flush()

    # 3. Save attendees
    for att in payload.attendees:
        db.add(MeetingAttendee(
            meeting_id=meeting.id,
            email=att.email,
            name=att.name,
            department=att.department,
            role=att.role,
        ))
    db.flush()

    # 4. Create meeting on selected platform
    start_dt = datetime.combine(payload.meeting_date, payload.start_time)
    end_dt = start_dt + timedelta(minutes=payload.duration_minutes)
    attendee_emails = [a.email for a in payload.attendees]
    platform = getattr(payload, "platform", "google")

    if platform == "zoom":
        try:
            zm = zoom_service.create_zoom_meeting(
                title=payload.title, start_datetime=start_dt,
                duration_minutes=payload.duration_minutes,
                timezone=payload.timezone, agenda=payload.agenda or "",
            )
            meeting.meet_link = zm["join_url"]
            meeting.zoom_start_url = zm.get("start_url")
            meeting.zoom_password = zm.get("password")
            meeting.zoom_meeting_id = zm.get("meeting_id")
        except Exception as e:
            db.rollback()
            raise HTTPException(500, f"Zoom error: {e}")
        try:
            zoom_service.send_zoom_invite_emails(
                to_emails=attendee_emails, meeting_title=payload.title,
                join_url=meeting.meet_link, password=meeting.zoom_password or "",
                start_datetime=start_dt, duration_minutes=payload.duration_minutes,
            )
        except Exception as e:
            print(f"[zoom email] {e}")
        for att_row in meeting.attendees:
            att_row.invitation_sent = True

    elif platform == "jitsi":
        # Use pre-generated link if frontend sent one
        if getattr(payload, "jitsi_preview_link", None):
            meeting.meet_link = payload.jitsi_preview_link
        else:
            jitsi = jitsi_service.create_jitsi_meeting(
                title=payload.title, start_datetime=start_dt,
                duration_minutes=payload.duration_minutes,
            )
            meeting.meet_link = jitsi["join_url"]
        # Send emails in background so API responds fast
        background_tasks.add_task(
            jitsi_service.send_jitsi_invite_emails,
            to_emails=attendee_emails,
            meeting_title=payload.title,
            join_url=meeting.meet_link,
            start_datetime=start_dt,
            duration_minutes=payload.duration_minutes,
        )
        for att_row in meeting.attendees:
            att_row.invitation_sent = True

    else:
        # Google Meet — original logic unchanged
        recurrence_rule = None
        if payload.is_recurring:
            end_for_rule = datetime.combine(
                payload.recurrence_end_date or (payload.meeting_date + timedelta(days=365)),
                payload.start_time,
            )
            recurrence_rule = google_calendar.build_recurrence_rule(
                payload.recurrence_type, end_for_rule
            )
        try:
            cal_result = google_calendar.create_calendar_event(
                user=user, db=db, title=payload.title,
                description=f"{payload.purpose or ''}\n\nAgenda:\n{payload.agenda or ''}",
                start_datetime=start_dt, end_datetime=end_dt,
                timezone=payload.timezone, attendee_emails=attendee_emails,
                recurrence_rule=recurrence_rule,
            )
            meeting.meet_link = cal_result["meet_link"]
            meeting.google_event_id = cal_result["event_id"]
            meeting.calendar_event_link = cal_result["calendar_link"]
        except Exception as e:
            db.rollback()
            raise HTTPException(500, f"Failed to create Google Calendar event: {e}")
        for att_row in meeting.attendees:
            att_row.invitation_sent = True

    db.commit()
    db.refresh(meeting)
    return meeting


@router.get("", response_model=List[MeetingListItem])
async def list_meetings(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    date_from: Optional[date_cls] = Query(None),
    date_to: Optional[date_cls] = Query(None),
    status: Optional[str] = Query(None),
    series_id: Optional[int] = Query(None),
):
    """List meetings with filters - supports date-range and series queries"""
    q = db.query(Meeting).filter(Meeting.host_user_id == user.id)

    if date_from:
        q = q.filter(Meeting.meeting_date >= date_from)
    if date_to:
        q = q.filter(Meeting.meeting_date <= date_to)
    if status:
        q = q.filter(Meeting.status == status)
    if series_id is not None:
        q = q.filter(Meeting.series_id == series_id)

    q = q.order_by(Meeting.meeting_date.desc(), Meeting.start_time.desc())
    meetings = q.all()

    return [
        MeetingListItem(
            id=m.id,
            meeting_code=m.meeting_code,
            title=m.title,
            meeting_date=m.meeting_date,
            start_time=m.start_time,
            duration_minutes=m.duration_minutes,
            status=m.status,
            series_id=m.series_id,
            attendee_count=len(m.attendees),
            has_report=m.report is not None,
        )
        for m in meetings
    ]


@router.get("/grouped-by-date")
async def list_grouped_by_date(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Return meetings grouped by date for calendar/timeline view.
    Response shape:
    {
      "2025-05-15": [{...meeting...}, {...meeting...}],
      "2025-05-14": [...]
    }
    """
    meetings = (
        db.query(Meeting)
        .filter(Meeting.host_user_id == user.id)
        .order_by(Meeting.meeting_date.desc(), Meeting.start_time)
        .all()
    )
    grouped = {}
    for m in meetings:
        key = m.meeting_date.isoformat()
        grouped.setdefault(key, []).append({
            "id": m.id,
            "meeting_code": m.meeting_code,
            "title": m.title,
            "start_time": m.start_time.isoformat(),
            "duration_minutes": m.duration_minutes,
            "status": m.status,
            "series_id": m.series_id,
            "has_report": m.report is not None,
        })
    return grouped


@router.get("/series/{series_id}/history")
async def series_history(
    series_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """All meetings in a recurring series - shows history timeline of daily/weekly meetings"""
    series = db.query(MeetingSeries).filter(MeetingSeries.id == series_id).first()
    if not series or series.host_user_id != user.id:
        raise HTTPException(404, "Series not found")

    meetings = (
        db.query(Meeting)
        .filter(Meeting.series_id == series_id)
        .order_by(Meeting.meeting_date.desc())
        .all()
    )

    return {
        "series": {
            "id": series.id,
            "title": series.title,
            "recurrence_type": series.recurrence_type,
            "is_active": series.is_active,
        },
        "meetings": [
            {
                "id": m.id,
                "meeting_code": m.meeting_code,
                "meeting_date": m.meeting_date.isoformat(),
                "start_time": m.start_time.isoformat(),
                "status": m.status,
                "has_report": m.report is not None,
                "summary_preview": (m.report.summary[:200] + "...") if m.report and m.report.summary else None,
            }
            for m in meetings
        ],
    }


@router.get("/{meeting_id}", response_model=MeetingOut)
async def get_meeting(
    meeting_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")
    return meeting


@router.post("/{meeting_id}/start")
async def start_meeting(
    meeting_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark meeting as live - frontend calls this when host opens live page"""
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")
    meeting.status = "live"
    meeting.actual_start_time = datetime.utcnow()
    db.commit()
    return {"status": "started", "meeting_id": meeting_id}


@router.post("/{meeting_id}/end")
async def end_meeting(
    meeting_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark meeting as completed - triggers report generation"""
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")
    meeting.status = "completed"
    meeting.actual_end_time = datetime.utcnow()
    db.commit()
    background_tasks.add_task(_generate_report_task, meeting_id, settings.DATABASE_URL)
    return {"status": "completed", "meeting_id": meeting_id}
