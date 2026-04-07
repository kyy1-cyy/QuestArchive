#!/usr/bin/env python3
"""
quota_check.py — Enforces 500 GB per-user download quotas.

When a user hits their limit:
  - Their FTP password is CHANGED to a random invalid string (blocks login)
  - Their slot directory and files are KEPT intact
  - The bot DB is notified via a flag file so the bot knows to mark them frozen
  - They can unfreeze by paying again — the bot calls reset_quota_on_server()
    which restores their real password

This script NEVER deletes anything. Only the bot's expiry checker deletes slots.

SETUP: Upload this file to your server and add a cron job:
    crontab -e
    # Add this line:
    */15 * * * * python3 /home/jepp/quota_check.py >> /home/jepp/.config/proftpd/quota.log 2>&1
"""

import os
import subprocess
import string
import random
from datetime import datetime
from pathlib import Path

FTPASSWD_BIN = os.environ.get("VRP_FTPPASSWD_BIN", "ftpasswd")

HOME         = Path("/home17/jepp")
TRANSFER_LOG = HOME / ".config/proftpd/transfer.log"
QUOTA_DIR    = HOME / ".config/proftpd/quotas"
PASSWD_FILE  = HOME / ".config/proftpd/proftpd.passwd"
PROCESSED    = HOME / ".config/proftpd/transfer.processed"
FROZEN_DIR   = HOME / ".config/proftpd/frozen"   # flag files: frozen/<username>


def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def get_processed_offset() -> int:
    if PROCESSED.exists():
        try:
            return int(PROCESSED.read_text().strip())
        except Exception:
            return 0
    return 0


def set_processed_offset(offset: int):
    PROCESSED.write_text(str(offset))


def parse_new_downloads() -> dict[str, int]:
    """
    Read new lines from ProFTPD's transfer log since last run.
    Returns {ftp_username: bytes_downloaded_this_run}
    ProFTPD xferlog format (space-separated, 14+ fields):
      field[4] = filesize, field[7] = direction (o=download, i=upload), field[9] = username
    """
    if not TRANSFER_LOG.exists():
        return {}

    offset = get_processed_offset()
    downloads: dict[str, int] = {}

    with open(TRANSFER_LOG, "r", errors="replace") as f:
        f.seek(offset)
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 11:
                continue
            try:
                direction = parts[7]
                if direction != "o":          # 'o' = outgoing = download
                    continue
                filesize = int(parts[4])
                username = parts[9]
                if username and username != "*" and "_Vip" in username:
                    downloads[username] = downloads.get(username, 0) + filesize
            except (IndexError, ValueError):
                continue
        new_offset = f.tell()

    set_processed_offset(new_offset)
    return downloads


def get_quota(username: str) -> tuple[int, int]:
    """Returns (downloaded_bytes, limit_bytes). (0, 0) if no quota file."""
    quota_file = QUOTA_DIR / username
    if not quota_file.exists():
        return 0, 0
    try:
        parts = quota_file.read_text().strip().split(":")
        return int(parts[0]), int(parts[1])
    except Exception:
        return 0, 0


def set_quota_used(username: str, used: int, limit: int):
    (QUOTA_DIR / username).write_text(f"{used}:{limit}")


def is_already_frozen(username: str) -> bool:
    return (FROZEN_DIR / username).exists()


def mark_frozen(username: str):
    FROZEN_DIR.mkdir(parents=True, exist_ok=True)
    (FROZEN_DIR / username).touch()


def random_junk_password(length: int = 32) -> str:
    """Generate a random password that the user will never know, blocking their login."""
    chars = string.ascii_letters + string.digits
    return "".join(random.SystemRandom().choice(chars) for _ in range(length))


def freeze_user(username: str):
    """
    Block FTP/SFTP login by replacing the user's password with random garbage.
    The slot directory and all files are LEFT COMPLETELY INTACT.
    The real password is stored in the bot's DB — only the bot can restore it.
    """
    junk = random_junk_password()
    # Only change the password so the FTP server's configured "home" dir
    # remains intact.
    result = subprocess.run(
        [
            FTPPASSWD_BIN,
            "--passwd",
            f"--file={PASSWD_FILE}",
            f"--name={username}",
            "--change-password",
            "--stdin",
        ],
        input=junk,
        capture_output=True,
        text=True,
    )

    if result.returncode == 0:
        mark_frozen(username)
        log(f"FROZEN (quota exceeded): {username} — login blocked, files intact")
    else:
        log(f"ERROR freezing {username}: {result.stderr.strip()}")


def main():
    QUOTA_DIR.mkdir(parents=True, exist_ok=True)
    FROZEN_DIR.mkdir(parents=True, exist_ok=True)

    new_downloads = parse_new_downloads()

    if not new_downloads:
        log("No new downloads found.")
        return

    for username, new_bytes in new_downloads.items():
        used, limit = get_quota(username)
        if limit == 0:
            log(f"No quota file for {username}, skipping.")
            continue

        # Skip if already frozen
        if is_already_frozen(username):
            log(f"{username} already frozen, skipping.")
            continue

        used += new_bytes
        set_quota_used(username, used, limit)

        used_gb  = used / (1024 ** 3)
        limit_gb = limit / (1024 ** 3)
        log(f"{username}: {used_gb:.2f} GB / {limit_gb:.0f} GB used")

        if used >= limit:
            log(f"!!! {username} hit quota ({used_gb:.2f} GB). Freezing login.")
            freeze_user(username)


if __name__ == "__main__":
    main()