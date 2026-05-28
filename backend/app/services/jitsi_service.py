"""Jitsi Meet — free & open source, no API key needed"""
import uuid, re, smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from app.core.config import settings


def create_jitsi_meeting(*, title, start_datetime, duration_minutes):
    slug = re.sub(r'[^a-zA-Z0-9]', '', title.replace(' ', '-'))[:28] or 'Meeting'
    room_id = f"GOG-{slug}-{uuid.uuid4().hex[:6].upper()}"
    join_url = f"https://meet.jit.si/{room_id}"
    return {"room_id": room_id, "join_url": join_url}


def send_jitsi_invite_emails(*, to_emails, meeting_title, join_url,
                              start_datetime, duration_minutes):
    """Send Jitsi meeting invite to all attendees via SMTP"""

    # Check SMTP config first
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        print("[jitsi email] SMTP not configured — skipping emails")
        return

    print(f"[jitsi email] Sending to {len(to_emails)} attendees: {to_emails}")

    for email in to_emails:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = f"Meeting Invite: {meeting_title}"
            msg["From"]    = f"{settings.SMTP_FROM_NAME} <{settings.SMTP_USER}>"
            msg["To"]      = email

            html = f"""
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
  <div style="background:#1d4ed8;padding:24px 32px">
    <h1 style="color:#ffffff;margin:0;font-size:22px">🎥 Meeting Invite</h1>
  </div>
  <div style="padding:32px">
    <h2 style="color:#0a0a0a;margin:0 0 8px">{meeting_title}</h2>
    <p style="color:#555;margin:0 0 24px">You have been invited to a Jitsi meeting.</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:10px 0;color:#888;width:120px">Date & Time</td>
        <td style="padding:10px 0;font-weight:600;color:#0a0a0a">{start_datetime.strftime('%d %b %Y, %I:%M %p')}</td>
      </tr>
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:10px 0;color:#888">Duration</td>
        <td style="padding:10px 0;font-weight:600;color:#0a0a0a">{duration_minutes} minutes</td>
      </tr>
      <tr>
        <td style="padding:10px 0;color:#888">Platform</td>
        <td style="padding:10px 0;font-weight:600;color:#0a0a0a">Jitsi Meet (free, no account needed)</td>
      </tr>
    </table>

    <div style="text-align:center;margin:32px 0">
      <a href="{join_url}"
         style="display:inline-block;background:#1d4ed8;color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.3px">
        Join Jitsi Meeting
      </a>
    </div>

    <p style="color:#aaa;font-size:12px;text-align:center;margin:0">
      No download required. Opens directly in your browser.<br/>
      <a href="{join_url}" style="color:#1d4ed8">{join_url}</a>
    </p>
  </div>
  <div style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee">
    <p style="color:#bbb;font-size:11px;margin:0;text-align:center">
      Sent by {settings.SMTP_FROM_NAME} · Powered by GOG OMS
    </p>
  </div>
</div>
</body>
</html>"""

            msg.attach(MIMEText(html, "html"))

            with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as smtp:
                smtp.ehlo()
                smtp.starttls()
                smtp.ehlo()
                smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                smtp.sendmail(settings.SMTP_USER, email, msg.as_string())

            print(f"[jitsi email] ✓ Sent to {email}")

        except smtplib.SMTPAuthenticationError:
            print(f"[jitsi email] ✗ SMTP auth failed — check SMTP_USER and SMTP_PASSWORD in .env")
        except smtplib.SMTPException as e:
            print(f"[jitsi email] ✗ SMTP error for {email}: {e}")
        except Exception as e:
            print(f"[jitsi email] ✗ Failed for {email}: {e}")