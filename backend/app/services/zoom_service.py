"""
Zoom Meeting Service
Uses Zoom Server-to-Server OAuth (no user OAuth needed)
Get credentials from: https://marketplace.zoom.us/develop/create
Create an "Server-to-Server OAuth" app
"""
import requests
import base64
from datetime import datetime
from typing import List, Optional
from app.core.config import settings


def _get_zoom_token() -> str:
    """Get Zoom access token via Server-to-Server OAuth"""
    credentials = base64.b64encode(
        f"{settings.ZOOM_CLIENT_ID}:{settings.ZOOM_CLIENT_SECRET}".encode()
    ).decode()

    resp = requests.post(
        "https://zoom.us/oauth/token",
        params={
            "grant_type": "account_credentials",
            "account_id": settings.ZOOM_ACCOUNT_ID,
        },
        headers={"Authorization": f"Basic {credentials}"},
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def create_zoom_meeting(
    *,
    title: str,
    start_datetime: datetime,
    duration_minutes: int,
    timezone: str,
    agenda: str = "",
    attendee_emails: List[str] = [],
) -> dict:
    """Create a Zoom meeting and return join/start URLs"""
    token = _get_zoom_token()

    payload = {
        "topic": title,
        "type": 2,  # Scheduled
        "start_time": start_datetime.strftime("%Y-%m-%dT%H:%M:%S"),
        "duration": duration_minutes,
        "timezone": timezone,
        "agenda": agenda,
        "settings": {
            "host_video": True,
            "participant_video": True,
            "join_before_host": False,
            "mute_upon_entry": False,
            "auto_recording": "none",
            "waiting_room": False,
            "registrants_email_notification": True,
        },
    }

    resp = requests.post(
        f"https://api.zoom.us/v2/users/me/meetings",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    resp.raise_for_status()
    data = resp.json()

    return {
        "meeting_id": str(data["id"]),
        "join_url": data["join_url"],
        "start_url": data["start_url"],
        "password": data.get("password", ""),
    }


def send_zoom_invite_email(
    *,
    to_emails: List[str],
    meeting_title: str,
    join_url: str,
    password: str,
    start_datetime: datetime,
    duration_minutes: int,
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    from_name: str,
):
    """Send Zoom meeting invite email"""
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    for email in to_emails:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Meeting Invite: {meeting_title}"
        msg["From"] = f"{from_name} <{smtp_user}>"
        msg["To"] = email

        html = f"""
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;background:#f9f9f9;border-radius:8px">
          <h2 style="color:#0a0a0a">📹 {meeting_title}</h2>
          <p style="color:#555">You have been invited to a Zoom meeting.</p>
          <table style="width:100%;background:#fff;border-radius:8px;padding:16px;border:1px solid #eee">
            <tr><td style="color:#888;padding:4px 8px">Date & Time</td>
                <td style="padding:4px 8px;font-weight:bold">{start_datetime.strftime('%d %b %Y, %I:%M %p')}</td></tr>
            <tr><td style="color:#888;padding:4px 8px">Duration</td>
                <td style="padding:4px 8px">{duration_minutes} minutes</td></tr>
            {'<tr><td style="color:#888;padding:4px 8px">Password</td><td style="padding:4px 8px">' + password + '</td></tr>' if password else ''}
          </table>
          <div style="text-align:center;margin:24px 0">
            <a href="{join_url}"
               style="background:#2D8CFF;color:white;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px">
              Join Zoom Meeting
            </a>
          </div>
          <p style="color:#aaa;font-size:12px;text-align:center">
            Or copy this link: {join_url}
          </p>
        </div>
        """
        msg.attach(MIMEText(html, "html"))

        try:
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_password)
                server.sendmail(smtp_user, email, msg.as_string())
        except Exception as e:
            print(f"[zoom email] failed to {email}: {e}")
