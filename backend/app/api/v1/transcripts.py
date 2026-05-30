"""
Transcript ingestion + report generation.

Flow:
1. Frontend uses Web Speech API to capture audio -> text
2. POSTs segments to /transcripts/{meeting_id}/segments as user speaks
3. When meeting ends, POST /meetings/{id}/generate-report runs Gemini
4. Report stored in MeetingReport table
"""
import re
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, BackgroundTasks, UploadFile
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.user import User
from app.models.meeting import Meeting, MeetingAttendee
from app.models.transcript import TranscriptSegment, MeetingReport
from app.schemas.meeting import (
    TranscriptSegmentIn, TranscriptSegmentOut, MeetingReportOut
)
from app.services import gemini_ai
from app.core.security import get_current_user


router = APIRouter(tags=["transcripts"])


# ─────────────────────────────────────────────────────────────────────────────
# UI NOISE CLEANER
# ─────────────────────────────────────────────────────────────────────────────

_BAD_SPEAKER_RE = re.compile(
    r'^('
    r'\d{1,2}:\d{2}|\d+|am|pm|format_size|settings|beta|devices|language'
    r'|default|brute\s*force|closed_caption_off|closed_caption|open_caption'
    r'|font\s*size|font\s*color|font\s*colour'
    r'|tiny|small|medium|large|huge|jumbo'
    r'|white|black|blue|green|red|yellow|cyan|magenta|circle'
    r'|more_vert|arrow_drop_down|frame_person|visual_effects|computer_arrow_up'
    r'|back_hand|keyboard_arrow_up|call_end|chat_bubble|lock_person|mood|videocam|notifications'
    r')$',
    re.IGNORECASE,
)

_BAD_SPEAKER_CONTAINS_RE = re.compile(
    r'(closed_caption|caption_off|caption_on|format_size|open_caption'
    r'|brute.?force|font.?size|font.?color|font.?colour'
    r'|arrow_drop|frame_person|visual_effect|more_vert'
    r'|keyboard_arrow|computer_arrow|back_hand|lock_person)',
    re.IGNORECASE,
)

_UI_NOISE_PHRASES = [
    r"Press Down Arrow to open the hover tray",
    r"Escape to close it",
    r"This call is open to anyone",
    r"Ask Gemini", r"Hand raises", r"Meeting timer", r"Meeting details",
    r"Turn off microphone", r"Turn off camera",
    r"Turn on captions", r"Turn off captions",
    r"Share screen", r"Send a reaction", r"Raise hand", r"Leave call",
    r"Host controls", r"Open caption settings",
    r"Font size", r"Font color", r"Font colour",
    r"Developing an extension for Meet", r"An add-on would work better",
    r"Extensions frequently cause user issues",
    r"https://developers\.google\.com/meet",
    r"inject buttons into #browser-extension", r"not officially supported",
    r"Audio settings", r"Video settings", r"More options",
    r"Others might still see your full video",
    r"Meeting tools", r"Chat with everyone",
    r"checking meeting_room", r"checking checking",
    r"arrow_drop_down", r"frame_person", r"Reframe", r"visual_effects",
    r"Backgrounds and effects", r"more_vert", r"computer_arrow_up",
    r"back_hand", r"closed_caption", r"keyboard_arrow_up", r"call_end",
    r"chat_bubble", r"lock_person", r"videocam",
    r"ctrl \+ [a-z]", r"shift \+ [a-z]", r"ctrl \+ alt \+ [a-z]",
    r"\bc or shift\b",
    r"White Black Blue Green Red Yellow",
    r"Tiny Small Medium Large Huge Jumbo",
    r"Default\s+Tiny", r"Default\s+White",
    r"brute force",
]

_LANGUAGE_LIST_RE = re.compile(
    r'\b(Afrikaans|Albanian|Amharic|Arabic|Armenian|Azerbaijani|Basque|Bengali|'
    r'Bulgarian|Burmese|Catalan|Chinese|Czech|Dutch|English|Estonian|Filipino|'
    r'Finnish|French|Galician|Georgian|German|Greek|Gujarati|Hebrew|Hindi|'
    r'Hungarian|Icelandic|Indonesian|Italian|Japanese|Javanese|Kannada|Kazakh|'
    r'Khmer|Kinyarwanda|Korean|Lao|Latvian|Lithuanian|Macedonian|Malay|Malayalam|'
    r'Marathi|Mongolian|Nepali|Norwegian|Persian|Polish|Portuguese|Romanian|'
    r'Russian|Serbian|Sesotho|Sinhala|Slovak|Slovenian|Spanish|Sundanese|Swahili|'
    r'Swati|Swedish|Tamil|Telugu|Thai|Tshivenda|Tswana|Turkish|Ukrainian|Urdu|'
    r'Uzbek|Vietnamese|Xhosa|Xitsonga|Zulu)[\s,\(]',
    re.IGNORECASE,
)

_COLOR_LIST_RE = re.compile(
    r'\b(white|black|blue|green|red|yellow|cyan|magenta)\b.*'
    r'\b(white|black|blue|green|red|yellow|cyan|magenta)\b',
    re.IGNORECASE,
)

_NOISE_RES = [re.compile(p, re.IGNORECASE) for p in _UI_NOISE_PHRASES]
_TIME_HEADER_RE = re.compile(r'^\d{1,2}:\d{2}:\s*[AP]M\b', re.IGNORECASE)
_PEOPLE_COUNT_RE = re.compile(r'\bPeople\s+\d+\b', re.IGNORECASE)
_BETA_RE = re.compile(r'\bBETA\b', re.IGNORECASE)
_MIN_WORDS = 2


def _is_ui_noise(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if _TIME_HEADER_RE.match(t):
        return True
    if len(_LANGUAGE_LIST_RE.findall(t)) >= 3:
        return True
    if _COLOR_LIST_RE.search(t):
        return True
    for nr in _NOISE_RES:
        if nr.search(t):
            return True
    words = t.split()
    if len(words) <= 2:
        ui_labels = {
            "am", "pm", "beta", "devices", "language", "format_size",
            "settings", "notifications", "you", "speaker", "default",
            "brute", "force", "white", "black", "blue", "green", "red",
            "yellow", "cyan", "magenta", "tiny", "small", "medium",
            "large", "huge", "jumbo", "circle",
        }
        if all(w.lower() in ui_labels for w in words):
            return True
    return False


def _clean_segment_text(text: str) -> str:
    t = text.strip()
    if len(_LANGUAGE_LIST_RE.findall(t)) >= 3:
        return ""
    if _COLOR_LIST_RE.search(t):
        return ""
    t = re.sub(r'\b\d{1,2}:\d{2}:\s*[AP]M\b.*', '', t, flags=re.IGNORECASE).strip()
    t = _PEOPLE_COUNT_RE.sub('', t).strip()
    for nr in _NOISE_RES:
        t = nr.sub('', t).strip()
    t = _BETA_RE.sub('', t).strip()
    t = re.sub(r'\s{2,}', ' ', t).strip()
    if len(t.split()) < _MIN_WORDS:
        return ""
    return t


def clean_segment(speaker_name: str, text: str) -> Optional[tuple]:
    sp = (speaker_name or "").strip()
    if _BAD_SPEAKER_RE.match(sp):
        return None
    if _BAD_SPEAKER_CONTAINS_RE.search(sp):
        return None
    if not sp:
        sp = "Unknown"
    if _is_ui_noise(text):
        return None
    cleaned = _clean_segment_text(text)
    if not cleaned:
        return None
    return sp, cleaned


# ─────────────────────────────────────────────────────────────────────────────
# DEDUPLICATION  — Web Speech API sends cumulative "final" results
# e.g. seg1="hello world", seg2="hello world how are you", seg3="hello world how are you doing"
# We only keep the NEW words appended in each segment.
# ─────────────────────────────────────────────────────────────────────────────

def _is_continuation(prev: str, current: str) -> bool:
    """Return True if current is just prev + more words (cumulative repeat)."""
    prev = prev.strip()
    current = current.strip()
    if not prev or not current:
        return False
    # Exact extension: current starts with prev
    if current.startswith(prev):
        return True
    # Fuzzy: prev appears in the first 80% of current (handles minor ASR drift)
    if len(prev) > 15 and prev in current[:int(len(current) * 0.85)]:
        return True
    return False


def _extract_new_text(prev: str, current: str) -> str:
    """Strip the repeated prefix from current, returning only new content."""
    prev = prev.strip()
    current = current.strip()
    if current.startswith(prev):
        return current[len(prev):].strip()
    # Fuzzy match: find where prev ends inside current
    idx = current.find(prev)
    if idx != -1:
        return current[idx + len(prev):].strip()
    return current


def dedup_segments(
    segments: List[dict],
) -> List[dict]:
    """
    Remove cumulative repetitions produced by Web Speech API.
    Each dict must have keys: speaker_name, text, relative_seconds.
    Returns a cleaned list where each entry contains only the NEW speech.
    """
    result: List[dict] = []
    # Track last text per speaker so cross-speaker resets don't interfere
    last_text_by_speaker: dict = {}

    for seg in segments:
        speaker = seg.get("speaker_name", "Unknown")
        text = (seg.get("text") or "").strip()

        if not text:
            continue

        prev = last_text_by_speaker.get(speaker, "")

        if _is_continuation(prev, text):
            new_part = _extract_new_text(prev, text)
            if new_part and len(new_part.split()) >= _MIN_WORDS:
                new_seg = {**seg, "text": new_part}
                result.append(new_seg)
            # Always advance the cursor to the longest version seen
            last_text_by_speaker[speaker] = text
        else:
            result.append(seg)
            last_text_by_speaker[speaker] = text

    return result


# ─────────────────────────────────────────────────────────────────────────────
# API ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "/transcripts/{meeting_id}/segments",
    response_model=TranscriptSegmentOut,
)
async def add_segment(
    meeting_id: int,
    segment: TranscriptSegmentIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")

    result = clean_segment(segment.speaker_name, segment.text)
    if result is None:
        return TranscriptSegment(
            id=0, meeting_id=meeting_id,
            speaker_name=segment.speaker_name, speaker_email=segment.speaker_email,
            text="", relative_seconds=segment.relative_seconds,
            confidence=segment.confidence, is_final=False,
            created_at=datetime.utcnow(),
        )

    cleaned_speaker, cleaned_text = result

    # Dedup against the last stored segment for this speaker
    last_seg = (
        db.query(TranscriptSegment)
        .filter(
            TranscriptSegment.meeting_id == meeting_id,
            TranscriptSegment.speaker_name == cleaned_speaker,
            TranscriptSegment.is_final == True,
        )
        .order_by(TranscriptSegment.relative_seconds.desc())
        .first()
    )

    if last_seg and _is_continuation(last_seg.text or "", cleaned_text):
        new_part = _extract_new_text(last_seg.text or "", cleaned_text)
        if not new_part or len(new_part.split()) < _MIN_WORDS:
            # Nothing new — update the existing row's text to the longer version
            last_seg.text = cleaned_text
            db.commit()
            db.refresh(last_seg)
            return last_seg
        cleaned_text = new_part

    seg = TranscriptSegment(
        meeting_id=meeting_id,
        speaker_name=cleaned_speaker,
        speaker_email=segment.speaker_email,
        text=cleaned_text,
        relative_seconds=segment.relative_seconds,
        confidence=segment.confidence,
        is_final=segment.is_final,
    )
    db.add(seg)
    db.commit()
    db.refresh(seg)
    return seg


@router.post(
    "/transcripts/{meeting_id}/segments/batch",
    response_model=List[TranscriptSegmentOut],
)
async def add_segments_batch(
    meeting_id: int,
    segments: List[TranscriptSegmentIn],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")

    # Step 1: clean UI noise
    cleaned: List[dict] = []
    for s in segments:
        result = clean_segment(s.speaker_name, s.text)
        if result is None:
            continue
        cleaned_speaker, cleaned_text = result
        cleaned.append({
            "speaker_name": cleaned_speaker,
            "speaker_email": s.speaker_email,
            "text": cleaned_text,
            "relative_seconds": s.relative_seconds,
            "confidence": s.confidence,
            "is_final": s.is_final,
        })

    # Step 2: dedup cumulative repeats within this batch
    deduped = dedup_segments(cleaned)

    # Step 3: further dedup against last DB row per speaker
    rows = []
    last_db: dict = {}
    for s in deduped:
        speaker = s["speaker_name"]
        text = s["text"]

        if speaker not in last_db:
            last_seg = (
                db.query(TranscriptSegment)
                .filter(
                    TranscriptSegment.meeting_id == meeting_id,
                    TranscriptSegment.speaker_name == speaker,
                    TranscriptSegment.is_final == True,
                )
                .order_by(TranscriptSegment.relative_seconds.desc())
                .first()
            )
            last_db[speaker] = last_seg.text if last_seg else ""

        prev = last_db.get(speaker, "")
        if prev and _is_continuation(prev, text):
            new_part = _extract_new_text(prev, text)
            if not new_part or len(new_part.split()) < _MIN_WORDS:
                last_db[speaker] = text
                continue
            text = new_part

        last_db[speaker] = text
        rows.append(TranscriptSegment(
            meeting_id=meeting_id,
            speaker_name=speaker,
            speaker_email=s.get("speaker_email"),
            text=text,
            relative_seconds=s["relative_seconds"],
            confidence=s.get("confidence"),
            is_final=s.get("is_final", True),
        ))

    if rows:
        db.add_all(rows)
        db.commit()
        for r in rows:
            db.refresh(r)

    return rows


@router.get(
    "/transcripts/{meeting_id}/segments",
    response_model=List[TranscriptSegmentOut],
)
async def list_segments(
    meeting_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")

    segs = (
        db.query(TranscriptSegment)
        .filter(
            TranscriptSegment.meeting_id == meeting_id,
            TranscriptSegment.is_final == True,
        )
        .order_by(TranscriptSegment.relative_seconds)
        .all()
    )
    return segs


@router.post("/meetings/{meeting_id}/transcribe-audio-chunk")
async def transcribe_audio_chunk(
    meeting_id: int,
    audio: UploadFile = File(...),
    speaker: str = Form("Participant"),
    relative_seconds: float = Form(0.0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")

    audio_bytes = await audio.read()
    if not audio_bytes or len(audio_bytes) < 500:
        return {"text": "", "speaker": speaker, "relative_seconds": relative_seconds}

    mime_type = audio.content_type or "audio/webm"
    try:
        text = gemini_ai.transcribe_audio(audio_bytes, mime_type)
    except Exception as e:
        print(f"[transcribe] Gemini error for meeting {meeting_id}: {e}")
        return {"text": "", "speaker": speaker, "relative_seconds": relative_seconds}

    if not text:
        return {"text": "", "speaker": speaker, "relative_seconds": relative_seconds}

    result = clean_segment(speaker, text)
    if not result:
        return {"text": "", "speaker": speaker, "relative_seconds": relative_seconds}

    cleaned_speaker, cleaned_text = result
    seg = TranscriptSegment(
        meeting_id=meeting_id,
        speaker_name=cleaned_speaker,
        speaker_email=None,
        text=cleaned_text,
        relative_seconds=relative_seconds,
        confidence=0.95,
        is_final=True,
    )
    db.add(seg)
    db.commit()

    return {"text": cleaned_text, "speaker": cleaned_speaker, "relative_seconds": relative_seconds}


def _seconds_to_hms(s: float) -> str:
    s = int(s)
    return f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}"


def _generate_report_task(meeting_id: int, db_url: str):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
        if not meeting:
            return

        segments = (
            db.query(TranscriptSegment)
            .filter(
                TranscriptSegment.meeting_id == meeting_id,
                TranscriptSegment.is_final == True,
            )
            .order_by(TranscriptSegment.relative_seconds)
            .all()
        )
        if not segments:
            return

        # Clean + dedup before sending to Gemini
        raw_dicts = []
        for s in segments:
            result = clean_segment(s.speaker_name or "Unknown", s.text or "")
            if result is None:
                continue
            cleaned_speaker, cleaned_text = result
            raw_dicts.append({
                "speaker_name": cleaned_speaker,
                "text": cleaned_text,
                "relative_seconds": s.relative_seconds,
            })

        segment_dicts = dedup_segments(raw_dicts)

        if not segment_dicts:
            print(f"[report] No valid segments after cleaning for meeting {meeting_id}")
            return

        attendees = db.query(MeetingAttendee).filter(
            MeetingAttendee.meeting_id == meeting_id
        ).all()

        metadata = {
            "title": meeting.title,
            "date": meeting.meeting_date.isoformat(),
            "duration_minutes": meeting.duration_minutes,
            "agenda": meeting.agenda,
            "attendees": [a.name or a.email for a in attendees],
        }

        result = gemini_ai.generate_meeting_report(segment_dicts, metadata)

        report = db.query(MeetingReport).filter(MeetingReport.meeting_id == meeting_id).first()
        if not report:
            report = MeetingReport(meeting_id=meeting_id)
            db.add(report)

        report.summary = result.get("summary")
        report.key_points = result.get("key_points")
        report.decisions = result.get("decisions")
        report.action_items = result.get("action_items")
        report.speaker_contribution = result.get("speaker_contribution")
        report.topics = result.get("topics")
        report.sentiment = result.get("sentiment")
        report.engagement_score = result.get("engagement_score", 0)
        report.attendance_percentage = result.get("attendance_percentage", 0)
        report.next_meeting_suggestion = result.get("next_meeting_suggestion")
        report.highlights = result.get("highlights")
        report.full_transcript_text = result.get("full_transcript_text")
        report.gemini_model_used = result.get("gemini_model_used")
        report.generated_at = datetime.utcnow()

        db.commit()
    except Exception as e:
        print(f"[report] generation failed for meeting {meeting_id}: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


@router.post("/meetings/{meeting_id}/generate-report")
async def generate_report(
    meeting_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")

    from app.core.config import settings
    background_tasks.add_task(_generate_report_task, meeting_id, settings.DATABASE_URL)
    return {"status": "report_generation_queued", "meeting_id": meeting_id}


@router.get(
    "/meetings/{meeting_id}/report",
    response_model=MeetingReportOut,
)
async def get_report(
    meeting_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting or meeting.host_user_id != user.id:
        raise HTTPException(404, "Meeting not found")
    if not meeting.report:
        raise HTTPException(404, "Report not yet generated")
    return meeting.report