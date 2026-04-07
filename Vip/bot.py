"""
QuestBot — Donation FTP slot provisioner
Deploy on Koyeb. All config via environment variables.

Quota behavior:
  - Hit 500 GB → downloads FROZEN (slot kept, credentials kept, directory intact)
  - Pay again within 30 days → quota RESET, same slot, same credentials, expiry extended
  - 30 days expire without renewal → slot DELETED
"""

import discord
import os, logging, asyncio, random, string, re, shlex, io, base64, subprocess
from discord.ext import commands
from datetime import datetime, timedelta
import aiosqlite
import aiohttp
import paramiko
from apscheduler.schedulers.asyncio import AsyncIOScheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
log = logging.getLogger("questbot")


def load_env_file(path: str = ".env"):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key:
                    os.environ.setdefault(key, value)
    except FileNotFoundError:
        return


load_env_file()

# ── Config (set all of these as env vars in Koyeb) ───────────────────────────
DISCORD_TOKEN    = os.environ["DISCORD_TOKEN"]
NP_API_KEY       = os.environ.get("NP_API_KEY", "")        # NowPayments SECRET api key
SSH_HOST         = os.environ.get("SSH_HOST", "botanic.usbx.me")
SSH_PORT         = int(os.environ.get("SSH_PORT", "22"))
SSH_USER         = os.environ.get("SSH_USER", "jepp")
SSH_PASS         = os.environ["SSH_PASS"]
FTP_HOST         = os.environ.get("FTP_HOST", SSH_HOST)
FTP_PORT         = int(os.environ.get("FTP_PORT", "12113"))
SFTP_PORT        = int(os.environ.get("SFTP_PORT", "22"))
FTP_LOGIN_SHELL  = os.environ.get("FTP_LOGIN_SHELL", "/bin/bash")
FTP_HOME_BASE    = os.environ.get("FTP_HOME_BASE", f"/home17/{SSH_USER}")
SLOT_ROOT_DIR    = os.environ.get("SLOT_ROOT_DIR", f"{FTP_HOME_BASE}/donor_slots")
QUEST_GAMES_SRC  = os.environ.get("QUEST_GAMES_SRC", f"{FTP_HOME_BASE}/Quest Games")
# Shared chroot root: contains only symlink "Quest Games" -> QUEST_GAMES_SRC (see ensure_donor_ftp_root).
FTP_ROOT_WRAPPER = os.environ.get("FTP_ROOT_WRAPPER", f"{FTP_HOME_BASE}/donor_ftp_root")
# ProFTPD home for every donor: wrapper dir (recommended) so login shows one folder to open.
# Override to QUEST_GAMES_SRC if you skip the wrapper (not recommended for UX).
FTP_USER_HOME    = os.environ.get("FTP_USER_HOME", FTP_ROOT_WRAPPER)
# Try `mount --bind` so "Quest Games" is a real dir (CWD/RETR work reliably); falls back to symlink.
FTP_TRY_BIND_MOUNT = os.environ.get("FTP_TRY_BIND_MOUNT", "1").strip().lower() not in (
    "0", "false", "no",
)
PROFTPD_PASSWD_FILE = os.environ.get("PROFTPD_PASSWD_FILE", "").strip()
PROFTPD_GROUP_FILE  = os.environ.get("PROFTPD_GROUP_FILE", "").strip()
TEST_GID           = os.environ.get("TEST_GID", "2000")
MIN_USD          = float(os.environ.get("MIN_USD", "1.0"))
SLOT_DAYS        = int(os.environ.get("SLOT_DAYS", "30"))
WARN_DAYS_BEFORE = int(os.environ.get("WARN_DAYS_BEFORE", "3"))
QUOTA_GB         = int(os.environ.get("QUOTA_GB", "500"))
DB_PATH          = "questbot.db"
NP_BASE          = "https://api.nowpayments.io/v1"
# ─────────────────────────────────────────────────────────────────────────────

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)
scheduler = AsyncIOScheduler(timezone="UTC")


# ══════════════════════════════════════════════════════════════════════════════
# Database
# ══════════════════════════════════════════════════════════════════════════════

async def db_init():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS slots (
                discord_id    TEXT PRIMARY KEY,
                discord_name  TEXT NOT NULL,
                ftp_user      TEXT NOT NULL UNIQUE,
                ftp_pass      TEXT NOT NULL,
                payment_id    TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                expires_at    TEXT NOT NULL,
                warned        INTEGER DEFAULT 0,
                quota_frozen  INTEGER DEFAULT 0
            )
        """)
        # Safe migration if upgrading from old DB without quota_frozen column
        try:
            await db.execute("ALTER TABLE slots ADD COLUMN quota_frozen INTEGER DEFAULT 0")
        except Exception:
            pass
        await db.execute("""
            CREATE TABLE IF NOT EXISTS used_payments (
                payment_id TEXT PRIMARY KEY,
                discord_id TEXT NOT NULL,
                used_at    TEXT NOT NULL
            )
        """)
        await db.commit()
    log.info("Database ready.")


async def db_get_slot(discord_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM slots WHERE discord_id = ?", (discord_id,)
        ) as cur:
            return await cur.fetchone()


async def db_save_slot(discord_id, discord_name, ftp_user, ftp_pass,
                       payment_id, expires_at):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT OR REPLACE INTO slots
              (discord_id, discord_name, ftp_user, ftp_pass,
               payment_id, created_at, expires_at, warned, quota_frozen)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
        """, (
            discord_id, discord_name, ftp_user, ftp_pass, payment_id,
            datetime.utcnow().isoformat(), expires_at.isoformat()
        ))
        await db.execute("""
            INSERT OR IGNORE INTO used_payments (payment_id, discord_id, used_at)
            VALUES (?, ?, ?)
        """, (payment_id, discord_id, datetime.utcnow().isoformat()))
        await db.commit()


async def db_renew_slot(discord_id: str, payment_id: str, new_expires: datetime):
    """Extend expiry, unfreeze quota, mark payment used. Credentials unchanged."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            UPDATE slots
            SET expires_at = ?, payment_id = ?, warned = 0, quota_frozen = 0
            WHERE discord_id = ?
        """, (new_expires.isoformat(), payment_id, discord_id))
        await db.execute("""
            INSERT OR IGNORE INTO used_payments (payment_id, discord_id, used_at)
            VALUES (?, ?, ?)
        """, (payment_id, discord_id, datetime.utcnow().isoformat()))
        await db.commit()


async def db_set_quota_frozen(discord_id: str, frozen: bool):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE slots SET quota_frozen = ? WHERE discord_id = ?",
            (1 if frozen else 0, discord_id)
        )
        await db.commit()


async def db_delete_slot(discord_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM slots WHERE discord_id = ?", (discord_id,))
        await db.commit()


async def db_payment_used(payment_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM used_payments WHERE payment_id = ?", (payment_id,)
        ) as cur:
            return await cur.fetchone() is not None


async def db_claim_payment_once(payment_id: str, discord_id: str) -> bool:
    """
    Atomically claim a payment ID exactly once.
    Returns True only for the first claimer.
    """
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """
                INSERT INTO used_payments (payment_id, discord_id, used_at)
                VALUES (?, ?, ?)
                """,
                (payment_id, discord_id, datetime.utcnow().isoformat()),
            )
            await db.commit()
            return True
    except Exception:
        # Already claimed (PRIMARY KEY conflict) or other insert failure.
        return False


async def db_get_expiring_slots(days_until: int):
    target = datetime.utcnow() + timedelta(days=days_until)
    low  = (target - timedelta(hours=1)).isoformat()
    high = (target + timedelta(hours=1)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM slots WHERE expires_at BETWEEN ? AND ? AND warned = 0",
            (low, high)
        ) as cur:
            return await cur.fetchall()


async def db_get_expired_slots():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM slots WHERE expires_at < ?",
            (datetime.utcnow().isoformat(),)
        ) as cur:
            return await cur.fetchall()


async def db_mark_warned(discord_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE slots SET warned = 1 WHERE discord_id = ?", (discord_id,)
        )
        await db.commit()


# ══════════════════════════════════════════════════════════════════════════════
# NowPayments
# ══════════════════════════════════════════════════════════════════════════════

async def verify_payment(payment_id: str) -> dict | None:
    if not NP_API_KEY:
        log.error("NP_API_KEY missing; payment verification disabled")
        return None
    headers = {"x-api-key": NP_API_KEY}
    url = f"{NP_BASE}/payment/{payment_id}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 404:
                    return None
                if resp.status != 200:
                    log.warning("NowPayments HTTP %s for %s", resp.status, payment_id)
                    return None
                data = await resp.json()

        status = data.get("payment_status", "")
        if status not in ("finished", "confirmed"):
            log.info("Payment %s status=%s", payment_id, status)
            return None

        price_usd = float(data.get("price_amount") or 0)
        if price_usd < MIN_USD:
            log.info("Payment %s: $%.2f < $%.2f minimum", payment_id, price_usd, MIN_USD)
            return None

        return data
    except Exception as e:
        log.error("NowPayments error: %s", e)
        return None


# ══════════════════════════════════════════════════════════════════════════════
# SSH / Server operations
# ══════════════════════════════════════════════════════════════════════════════

def ssh_connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=SSH_HOST, port=SSH_PORT,
                   username=SSH_USER, password=SSH_PASS, timeout=30)
    return client


def ssh_run(client: paramiko.SSHClient, cmd: str, stdin_data: str | None = None) -> tuple[str, str, int]:
    stdin, stdout, stderr = client.exec_command(cmd)
    if stdin_data is not None:
        stdin.write(stdin_data)
        if not stdin_data.endswith("\n"):
            stdin.write("\n")
        stdin.flush()
        stdin.channel.shutdown_write()
    code = stdout.channel.recv_exit_status()
    return stdout.read().decode().strip(), stderr.read().decode().strip(), code


def detect_ftpasswd(client: paramiko.SSHClient) -> str:
    out, _, _ = ssh_run(
        client,
        "if command -v ftpasswd >/dev/null 2>&1; then echo ftpasswd; "
        "elif [ -x /usr/sbin/ftpasswd ]; then echo '/usr/bin/perl /usr/sbin/ftpasswd'; "
        "else echo '/usr/bin/perl /usr/sbin/ftpasswd'; fi"
    )
    return out.strip() or "/usr/bin/perl /usr/sbin/ftpasswd"


def detect_auth_user_file(client: paramiko.SSHClient, home: str) -> str:
    if PROFTPD_PASSWD_FILE:
        return PROFTPD_PASSWD_FILE
    detect_cmd = (
        "for f in /etc/proftpd/proftpd.conf /etc/proftpd/conf.d/*.conf "
        f"{home}/proftpd_donors.conf {home}/.config/proftpd/*.conf; do "
        "[ -r \"$f\" ] || continue; "
        "line=$(grep -E '^[[:space:]]*AuthUserFile[[:space:]]+' \"$f\" | tail -n 1); "
        "[ -n \"$line\" ] || continue; "
        "path=$(printf '%s' \"$line\" | awk '{print $2}'); "
        "[ -n \"$path\" ] && { echo \"$path\"; break; }; "
        "done"
    )
    out, _, _ = ssh_run(client, detect_cmd)
    detected = out.strip()
    return detected or f"{home}/.config/proftpd/proftpd.passwd"


def detect_auth_group_file(client: paramiko.SSHClient, home: str) -> str:
    if PROFTPD_GROUP_FILE:
        return PROFTPD_GROUP_FILE
    detect_cmd = (
        "for f in /etc/proftpd/proftpd.conf /etc/proftpd/conf.d/*.conf "
        f"{home}/proftpd_donors.conf {home}/.config/proftpd/*.conf; do "
        "[ -r \"$f\" ] || continue; "
        "line=$(grep -E '^[[:space:]]*AuthGroupFile[[:space:]]+' \"$f\" | tail -n 1); "
        "[ -n \"$line\" ] || continue; "
        "path=$(printf '%s' \"$line\" | awk '{print $2}'); "
        "[ -n \"$path\" ] && { echo \"$path\"; break; }; "
        "done"
    )
    out, _, _ = ssh_run(client, detect_cmd)
    detected = out.strip()
    return detected or f"{home}/.config/proftpd/proftpd.group"


def auth_user_file_candidates(primary_file: str, is_group: bool = False) -> list[str]:
    """Return likely AuthUserFile/AuthGroupFile variants so we don't miss active config."""
    candidates = [primary_file]
    directory = os.path.dirname(primary_file)
    basename = os.path.basename(primary_file)
 
    if is_group:
        variants = {"group", "proftpd.group", "ftpd.group"}
    else:
        variants = {"passwd", "proftpd.passwd", "ftpd.passwd"}

    variants.discard(basename)
    for name in sorted(variants):
        candidates.append(os.path.join(directory, name))
 
    # Preserve order while removing duplicates
    deduped: list[str] = []
    seen = set()
    for item in candidates:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def upsert_virtual_user(
    client: paramiko.SSHClient,
    ftp_perl: str,
    passwd_file: str,
    ftp_user: str,
    ftp_pass: str,
    ftp_home: str,
    gid: str | None = None,
) -> tuple[str, str, int]:
    # Let ftpasswd generate/manage the password hash on the server.
    # This avoids hash compatibility issues that can cause 530 Login incorrect.
    quoted_passwd = shlex.quote(passwd_file)
    quoted_user = shlex.quote(ftp_user)
    quoted_home = shlex.quote(ftp_home)

    exists_cmd = f"grep -q '^{ftp_user}:' {quoted_passwd}"
    _, _, exists_code = ssh_run(client, exists_cmd)

    if exists_code == 0:
        # Existing user: refresh password hash.
        # NOTE: Some ftpasswd builds do not support --change-home.
        # Our FTPS layer uses a fixed virtual root anyway, so changing home
        # here is unnecessary and can break renewals.
        change_cmd = (
            f"{ftp_perl} --passwd --file={quoted_passwd} "
            f"--name={quoted_user} --change-password --stdin --sha512"
        )
        out, err, code = ssh_run(client, change_cmd, stdin_data=ftp_pass)
        # ftpasswd exit code 2 means "password matches current password".
        # That's expected for renewals where we keep same credentials.
        if code not in (0, 2):
            return out, err, code
        return out, err, 0

    # New user: create user entry and set password via stdin.
    target_gid = gid if gid else "$(id -g)"
    create_cmd = (
        f"{ftp_perl} --passwd --file={quoted_passwd} "
        f"--name={quoted_user} --uid=$(id -u) --gid={target_gid} "
        f"--home={quoted_home} --shell={shlex.quote(FTP_LOGIN_SHELL)} --stdin --sha512"
    )
    return ssh_run(client, create_cmd, stdin_data=ftp_pass)


def ensure_donor_ftp_root(client: paramiko.SSHClient) -> bool:
    """
    Shared chroot for all donors: only visible entry is "Quest Games" pointing at QUEST_GAMES_SRC.

    Prefer `mount --bind` (real directory) so clients can CWD/RETR/recurse without symlink quirks.
    If mount fails (no permission), fall back to symlink + AllowChrootSymlinks on the server.
    """
    root = FTP_ROOT_WRAPPER
    src = QUEST_GAMES_SRC
    inner = f"{root}/Quest Games"
    qr, qs, qi = shlex.quote(root), shlex.quote(src), shlex.quote(inner)

    if not FTP_TRY_BIND_MOUNT:
        _, err, code = ssh_run(
            client, f"mkdir -p {qr} && ln -sfn {qs} {qi}"
        )
        if code != 0:
            log.error("ensure_donor_ftp_root (symlink) failed (%d): %s", code, err)
            return False
        return True

    script = f"""set -e
mkdir -p {qr}
if command -v mountpoint >/dev/null 2>&1 && mountpoint -q {qi} 2>/dev/null; then
  exit 0
fi
rm -rf {qi}
mkdir -p {qi}
if mount --bind {qs} {qi} 2>/dev/null; then
  exit 0
fi
rmdir {qi} 2>/dev/null || true
ln -sfn {qs} {qi}
"""
    _, err, code = ssh_run(client, "bash -lc " + shlex.quote(script))
    if code != 0:
        log.error("ensure_donor_ftp_root failed (%d): %s", code, err)
        return False
    chk = (
        f"command -v mountpoint >/dev/null 2>&1 && mountpoint -q {qi} "
        f"&& echo bind_mount || echo symlink_fallback"
    )
    _, how, _ = ssh_run(client, "bash -lc " + shlex.quote(chk))
    log.info(
        "donor_ftp_root: %s <- %s [%s] (if symlink_fallback and CWD fails, as root: "
        "mkdir -p %s && mount --bind %s %s — add to fstab for reboot persistence)",
        inner,
        src,
        (how or "?").strip(),
        shlex.quote(inner),
        shlex.quote(src),
        shlex.quote(inner),
    )
    return True


def provision_slot(ftp_user: str, ftp_pass: str, is_test: bool = False) -> bool:
    """Brand new slot — wrapper dir + symlink, ProFTPD user, quota file."""
    try:
        client = ssh_connect()
        if not ensure_donor_ftp_root(client):
            client.close()
            return False
        home        = FTP_HOME_BASE
        passwd_file = detect_auth_user_file(client, home)
        passwd_candidates = auth_user_file_candidates(passwd_file, is_group=False)
        group_file  = detect_auth_group_file(client, home)
        group_candidates = auth_user_file_candidates(group_file, is_group=True)

        quota_dir   = f"{FTP_HOME_BASE}/.config/proftpd/quotas"
        quota_file  = f"{quota_dir}/{ftp_user}"
        quota_bytes = QUOTA_GB * 1024 * 1024 * 1024

        ftp_perl = detect_ftpasswd(client)
        log.info("AuthUserFile candidates for provision: %s", ", ".join(passwd_candidates))
        
        steps = [
            f"mkdir -p '{quota_dir}'",
            f"echo '0:{quota_bytes}' > '{quota_file}'",
        ]
        for pf in passwd_candidates:
            steps.append(f"mkdir -p $(dirname '{pf}')")
            steps.append(f"touch '{pf}'")
        for gf in group_candidates:
            steps.append(f"mkdir -p $(dirname '{gf}')")
            steps.append(f"touch '{gf}'")

        if is_test:
            for gf in group_candidates:
                # Ensure 'testers' group exists in group file
                ensure_group = (
                    f"grep -q '^testers:' '{gf}' || "
                    f"{ftp_perl} --group --file='{gf}' --name=testers --gid={TEST_GID}"
                )
                steps.append(ensure_group)
                # Also add the user to the group members
                add_member = (
                    f"{ftp_perl} --group --file='{gf}' --name=testers --gid={TEST_GID} --member={shlex.quote(ftp_user)}"
                )
                steps.append(add_member)

        for cmd in steps:
            _, err, code = ssh_run(client, cmd)
            if code != 0:
                log.error("Provision failed (exit %d): %s | ERR: %s", code, cmd, err)
                client.close()
                return False

        for pf in passwd_candidates:
            _, err, code = upsert_virtual_user(
                client, ftp_perl, pf, ftp_user, ftp_pass, FTP_USER_HOME,
                gid=TEST_GID if is_test else None
            )
            if code != 0:
                log.error("Provision failed (exit %d): %s | ERR: %s", code, ftp_user, err)
                client.close()
                return False

        client.close()
        log.info("Provisioned: %s (is_test=%s)", ftp_user, is_test)
        return True
    except Exception as e:
        log.error("SSH provision error (%s): %s", ftp_user, e)
        return False


def reset_quota_on_server(ftp_user: str, ftp_pass: str) -> bool:
    """
    Renewal within 30 days — resets quota counter to 0 and restores login.
    Wrapper symlink and credentials are refreshed as needed.
    """
    try:
        client = ssh_connect()
        if not ensure_donor_ftp_root(client):
            client.close()
            return False
        home        = FTP_HOME_BASE
        passwd_file = detect_auth_user_file(client, home)
        passwd_candidates = auth_user_file_candidates(passwd_file)
        quota_file  = f"{FTP_HOME_BASE}/.config/proftpd/quotas/{ftp_user}"
        quota_bytes = QUOTA_GB * 1024 * 1024 * 1024

        ftp_perl = detect_ftpasswd(client)
        log.info("AuthUserFile candidates for reset: %s", ", ".join(passwd_candidates))

        steps = [
            f"echo '0:{quota_bytes}' > '{quota_file}'",
            f"rm -f '{FTP_HOME_BASE}/.config/proftpd/frozen/{ftp_user}'",
        ]

        for cmd in steps:
            _, err, code = ssh_run(client, cmd)
            if code != 0:
                log.error("Quota reset failed (exit %d): %s | ERR: %s", code, ftp_user, err)
                client.close()
                return False

        for pf in passwd_candidates:
            _, err, code = upsert_virtual_user(
                client,
                ftp_perl,
                pf,
                ftp_user,
                ftp_pass,
                FTP_USER_HOME,
            )
            if code != 0:
                log.error("Quota reset failed (exit %d): %s | ERR: %s", code, ftp_user, err)
                client.close()
                return False

        client.close()
        log.info("Quota reset + access restored: %s", ftp_user)
        return True
    except Exception as e:
        log.error("SSH quota reset error (%s): %s", ftp_user, e)
        return False


def delete_slot_on_server(ftp_user: str) -> bool:
    """Hard delete — only called when 30 days expire with no renewal."""
    try:
        client = ssh_connect()
        home        = FTP_HOME_BASE
        slot_dir    = f"{SLOT_ROOT_DIR}/{ftp_user}"
        passwd_file = detect_auth_user_file(client, home)
        passwd_candidates = auth_user_file_candidates(passwd_file)
        quota_file  = f"{FTP_HOME_BASE}/.config/proftpd/quotas/{ftp_user}"

        ftp_perl = detect_ftpasswd(client)
        log.info("AuthUserFile candidates for delete: %s", ", ".join(passwd_candidates))

        delete_cmds = [
            f"rm -rf '{slot_dir}'",
            f"rm -f '{quota_file}'",
            f"rm -f '{FTP_HOME_BASE}/.config/proftpd/frozen/{ftp_user}'",
        ]
        for pf in passwd_candidates:
            delete_cmds.insert(0, f"{ftp_perl} --passwd --file='{pf}' --name='{ftp_user}' --delete-user")

        for cmd in delete_cmds:
            _, err, code = ssh_run(client, cmd)
            if code != 0:
                log.warning("Delete step non-zero (exit %d): %s", code, err)

        client.close()
        log.info("Hard deleted: %s", ftp_user)
        return True
    except Exception as e:
        log.error("SSH delete error (%s): %s", ftp_user, e)
        return False


# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════

def generate_password(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.SystemRandom().choice(chars) for _ in range(length))


def make_ftp_username(discord_name: str, discord_id: str | None = None) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_]", "_", discord_name.split("#")[0])
    clean = re.sub(r"_+", "_", clean).strip("_")[:20]
    if discord_id:
        return f"{clean}_Vip_{str(discord_id)[-6:]}"
    return f"{clean}_Vip"


# ── Message templates ─────────────────────────────────────────────────────────

WELCOME = """
👋 **Hey! Welcome to Quest Archive Vip Acess.**

### What you get
- Direct **rclone/FTP access** to our library of games.
- **Instant first access** when games get released, instead of waiting 24 hours on the public server.
- Personal **Vip Slot** with your own login.

### Cons
- Speeds can be slower on the Vip mirror.

📦 Quota: **500 GB** (hit it and downloads are frozen until renewal)
⏳ Duration: **30 days** (renew keeps same credentials if still active)

Send your **transaction ID** and I’ll verify it automatically.
Your transaction ID is in the confirmation email or receipt page.

To verify, send: `!verify <transaction-id>`
To view your slot info, send: `!info`
For setup tutorial, send: `!help`
""".strip()

HELP = """
# :file_folder: Quest Archive VIP — Setup Guide (2026)

## Bot Commands
`!verify <transaction-id>` — checks payment & creates/renews your slot
`!info` — shows your FTP host, quota, and expiry date

---

## FileZilla (Windows · macOS · Linux)
> https://filezilla-project.org/download.php

1. **Site Manager (Top Left) → New Site**
2. Protocol → `FTP – File Transfer Protocol`
3. Host & Port → *(from your DM)*
4. Encryption → `Require explicit FTP over TLS`
5. Logon type → `Normal` — enter your User & Password *(from your DM)*
6. Click **Connect** and accept the certificate prompt

---

## WinSCP (Windows)
> https://winscp.net/eng/downloads.php

1. Click **New Site**
2. File protocol → `FTP`
3. Encryption → `TLS/SSL Explicit encryption`
4. Host name, Port, User name & Password → *(from your DM)*
5. Click **Login** and accept the certificate prompt

---

## rclone (Windows · macOS · Linux)
> https://rclone.org/downloads

## Rclone Install Command
> **Macos**: brew install rclone
> **Linux**: sudo apt install rclone
> **Windows**: choco install rclone

Use the **QA.Rclone.config** file the bot sends you.

List files:
> rclone --config QA.Rclone.config lsf "questarchive:Quest Games"

Download files:
> rclone --config QA.Rclone.config copy "questarchive:Quest Games" ./downloads

> :warning: The certificate warning on first connect is normal — just click **Accept/Trust**. Your connection is still fully encrypted.
""".strip()


# Same 32-byte AES key as rclone fs/config/obscure (rclone obscure / pass field).
_RCLONE_OBSCURE_KEY = bytes(
    [
        0x9C,
        0x93,
        0x5B,
        0x48,
        0x73,
        0x0A,
        0x55,
        0x4D,
        0x6B,
        0xFD,
        0x7C,
        0x63,
        0xC8,
        0x86,
        0xA9,
        0x2B,
        0xD3,
        0x90,
        0x19,
        0x8E,
        0xB8,
        0x12,
        0x8A,
        0xFB,
        0xF4,
        0xDE,
        0x16,
        0x2B,
        0x8B,
        0x95,
        0xF6,
        0x38,
    ]
)


def rclone_obscure_password(plain: str) -> str:
    """
    rclone expects `pass` in the config file to be obscured (rclone obscure / AES-CTR).
    Plain text causes: "input too short when revealing password - is it obscured?"
    """
    try:
        from cryptography.hazmat.backends import default_backend
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        plaintext = plain.encode("utf-8")
        iv = os.urandom(16)
        cipher = Cipher(
            algorithms.AES(_RCLONE_OBSCURE_KEY),
            modes.CTR(iv),
            backend=default_backend(),
        )
        enc = cipher.encryptor().update(plaintext) + cipher.encryptor().finalize()
        blob = iv + enc
        return base64.urlsafe_b64encode(blob).decode("ascii").rstrip("=")
    except Exception:
        try:
            r = subprocess.run(
                ["rclone", "obscure", plain],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )
            return r.stdout.strip()
        except Exception as e:
            log.error("rclone obscuring failed: %s", e)
            raise


def slot_dm(ftp_user: str, ftp_pass: str, expires_at: datetime) -> str:
    exp = expires_at.strftime("%d %b %Y")
    return f"""
✅ **Your Quest Archive slot is live!**

**FTP Access**
```
Host:     {FTP_HOST}
FTP Port: {FTP_PORT}
Username: {ftp_user}
Password: {ftp_pass}
```

📁 After login you’ll see Quest Games Folder
📦 Download quota: 500 GB
⏳ Expires: {exp} UTC

Save these — they won't change when you renew!
""".strip()


def rclone_config_file(ftp_user: str, ftp_pass: str) -> str:
    """
    Generate a ready-to-use rclone config snippet for this slot.
    `pass` must be obscured (same as `rclone obscure`) or rclone errors on use.
    """
    obscured = rclone_obscure_password(ftp_pass)
    return f"""
[questarchive]
type = ftp
host = {FTP_HOST}
port = {FTP_PORT}
user = {ftp_user}
pass = {obscured}
explicit_tls = true
no_check_certificate = true
disable_tls13 = true
""".lstrip()


def renewal_dm(ftp_user: str, ftp_pass: str, expires_at: datetime, was_frozen: bool) -> str:
    frozen_note = "\n🔓 **Downloads re-enabled!**" if was_frozen else ""
    return f"""
✅ **Slot renewed!**{frozen_note}

Same slot, same credentials — nothing to update on your end.

```
Host:     {FTP_HOST}
FTP Port: {FTP_PORT}
Username: {ftp_user}
Password: {ftp_pass}
```

📦 Quota: **reset to 500 GB**
⏳ New expiry: **{expires_at.strftime("%d %b %Y")} UTC**
""".strip()


def quota_frozen_dm(ftp_user: str, expires_at: datetime) -> str:
    return f"""
⚠️ **500 GB quota reached — downloads paused.**

Slot `{ftp_user}` — your files and credentials are **still intact**.
Expiry: **{expires_at.strftime("%d %b %Y")} UTC**

To reset your quota and resume downloading:
→ Donate $1+ LTC and send me the new payment ID.
Same slot, same credentials, fresh 500 GB. 
""".strip()


def warn_dm(ftp_user: str, expires_at: datetime) -> str:
    return f"""
⚠️ **Slot expires in {WARN_DAYS_BEFORE} days!**

`{ftp_user}` — expires **{expires_at.strftime("%d %b %Y")} UTC**

Renew with a $11+ USDT donation and send me the new payment ID.
Same slot, same credentials, quota reset. 🎮
""".strip()


def expired_dm(ftp_user: str) -> str:
    return f"""
❌ **Slot expired and removed.**

`{ftp_user}` has been fully deleted.

To get a new slot, donate again ($1+ LTC) and send me the new payment ID.
""".strip()


def info_dm(
    ftp_user: str,
    expires_at: datetime,
    used_bytes: int,
    limit_bytes: int,
    frozen: bool,
) -> str:
    used_gb = used_bytes / (1024**3)
    limit_gb = limit_bytes / (1024**3) if limit_bytes else 0
    remaining_gb = max(limit_bytes - used_bytes, 0) / (1024**3) if limit_bytes else 0
    days_left = int((expires_at - datetime.utcnow()).total_seconds() // 86400)
    status = "Frozen (downloads paused)" if frozen else "Active"
    expires_str = expires_at.strftime("%d %b %Y")

    return f"""
📁 Your Quest Archive FTP slot

FTP:
• Host: {FTP_HOST}:{FTP_PORT}
• Username: {ftp_user}

Quota:
• Used: {used_gb:.2f} GB
• Limit: {limit_gb:.0f} GB
• Remaining: {remaining_gb:.2f} GB
• Status: {status}

Expiry:
• Expires: {expires_str} UTC
• Days left: {days_left if days_left >= 0 else 0}
""".strip()


def fetch_quota_stats_on_server(ftp_user: str) -> tuple[int, int, bool]:
    """
    Read quota + freeze flag for this ftp_user directly from the server.
    Quota file format: "<used_bytes>:<limit_bytes>".
    """
    client = ssh_connect()
    try:
        quota_file = f"{FTP_HOME_BASE}/.config/proftpd/quotas/{ftp_user}"
        frozen_flag = f"{FTP_HOME_BASE}/.config/proftpd/frozen/{ftp_user}"

        quota_cmd = (
            f"if [ -r {shlex.quote(quota_file)} ]; then cat {shlex.quote(quota_file)}; "
            f"else echo '0:0'; fi"
        )
        out, _, _ = ssh_run(client, quota_cmd)
        parts = (out or "").strip().split(":", 1)
        used_bytes = 0
        limit_bytes = 0
        if len(parts) == 2:
            try:
                used_bytes = int(parts[0])
                limit_bytes = int(parts[1])
            except ValueError:
                used_bytes, limit_bytes = 0, 0

        frozen_cmd = (
            f"if [ -f {shlex.quote(frozen_flag)} ]; then echo 1; else echo 0; fi"
        )
        frozen_out, _, _ = ssh_run(client, frozen_cmd)
        frozen = str(frozen_out).strip() == "1"
        return used_bytes, limit_bytes, frozen
    finally:
        try:
            client.close()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# Scheduled jobs
# ══════════════════════════════════════════════════════════════════════════════

@scheduler.scheduled_job("interval", hours=6, id="expiry_check")
async def check_expiry():
    log.info("Running expiry check...")

    for row in await db_get_expiring_slots(WARN_DAYS_BEFORE):
        expires_at = datetime.fromisoformat(row["expires_at"])
        try:
            user = await bot.fetch_user(int(row["discord_id"]))
            await user.send(warn_dm(row["ftp_user"], expires_at))
            await db_mark_warned(row["discord_id"])
        except Exception as e:
            log.warning("Could not warn %s: %s", row["discord_id"], e)

    # Hard delete only after full 30-day expiry with no renewal
    for row in await db_get_expired_slots():
        ftp_user   = row["ftp_user"]
        discord_id = row["discord_id"]
        ok = await asyncio.to_thread(delete_slot_on_server, ftp_user)
        if ok:
            await db_delete_slot(discord_id)
            try:
                user = await bot.fetch_user(int(discord_id))
                await user.send(expired_dm(ftp_user))
            except Exception as e:
                log.warning("Could not DM expiry to %s: %s", discord_id, e)


# ══════════════════════════════════════════════════════════════════════════════
# Bot events
# ══════════════════════════════════════════════════════════════════════════════

@bot.event
async def on_ready():
    await db_init()
    scheduler.start()
    log.info("QuestBot ready as %s", bot.user)

    # (Bot is ready)
 
    await bot.change_presence(
        activity=discord.Activity(
            type=discord.ActivityType.watching, name="for donation IDs 👾"
        )
    )


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    if not isinstance(message.channel, discord.DMChannel):
        return

    content = message.content.strip()
    user    = message.author

    if content.lower() == "!help":
        await user.send(HELP, suppress_embeds=True)
        return

    # ── Slot info (privacy: only shows THIS user's own slot) ───────────────
    if content.lower() == "!info":
        existing = await db_get_slot(str(user.id))
        if not existing:
            await user.send(
                "You don't have an active slot yet.\n\nSend me your payment ID to unlock your FTP access."
            )
            return

        ftp_user = existing["ftp_user"]
        expires_at = datetime.fromisoformat(existing["expires_at"])
        used_bytes, limit_bytes, frozen = await asyncio.to_thread(
            fetch_quota_stats_on_server, ftp_user
        )
        await user.send(
            info_dm(
                ftp_user=ftp_user,
                expires_at=expires_at,
                used_bytes=used_bytes,
                limit_bytes=limit_bytes,
                frozen=frozen,
            )
        )
        return

    # ── ADMIN TEST COMMAND BYPASS ─────────────────────────────────────────────
    if content.lower() == "!test" and str(user.id) == "870316589193519164":
        verifying = await user.send("🔍 fetching payment id...")
        await asyncio.sleep(2)
        await verifying.edit(content="✅ id confirmed, fetching slot...")

        existing_test = await db_get_slot(str(user.id))
        if existing_test and str(existing_test["payment_id"]).startswith("TEST_"):
            await asyncio.to_thread(delete_slot_on_server, existing_test["ftp_user"])
            await db_delete_slot(str(user.id))

        test_suffix = "".join(random.SystemRandom().choice(string.ascii_lowercase + string.digits) for _ in range(4))
        ftp_user   = f"{make_ftp_username(user.name, str(user.id))}_TEST_{test_suffix}"
        ftp_pass   = generate_password()
        expires_at = datetime.utcnow() + timedelta(days=SLOT_DAYS)

        success = await asyncio.to_thread(provision_slot, ftp_user, ftp_pass, is_test=True)
        if not success:
            await verifying.edit(content="⚠️ [TEST MODE] Slot setup failed on Ultra.cc server.")
            return

        await db_save_slot(str(user.id), user.name, ftp_user, ftp_pass, f"TEST_{user.id}", expires_at)
        await verifying.delete()
        # DM text + ready-to-import rclone config file
        cfg_io = io.StringIO(rclone_config_file(ftp_user, ftp_pass))
        cfg_file = discord.File(cfg_io, filename="QA.Rclone.config")
        await user.send(content=slot_dm(ftp_user, ftp_pass, expires_at), file=cfg_file)
        log.info("ADMIN TEST: Provisioned slot for %s", user.name)
        return

    # ── Verification command flow ─────────────────────────────────────────────
    # Any normal DM shows welcome/instructions. Verification only happens via:
    #   !verify <transaction-id>
    if not content.lower().startswith("!verify"):
        await user.send(WELCOME)
        return

    parts = content.split(maxsplit=1)
    if len(parts) < 2 or not parts[1].strip():
        await user.send("Use this format:\n`!verify <transaction-id>`")
        return

    payment_id = parts[1].strip().replace(" ", "")

    if await db_payment_used(payment_id):
        await user.send(
            "❌ That payment ID has already been used.\n"
            "Please donate again for a new slot or quota reset."
        )
        return

    verifying = await user.send("🔍 fetching payment id...")
    payment = await verify_payment(payment_id)

    if payment is None:
        await verifying.edit(content=(
            "❌ **Payment not verified.**\n\n"
            "• Wrong payment ID — check your receipt\n"
            "• Payment not fully confirmed yet — try again in a few minutes\n"
            f"• Amount below **${MIN_USD:.0f} LTC** minimum"
        ))
        return

    # Claim immediately after successful payment verification so the same
    # finished transaction ID cannot be reused by anyone else.
    claimed = await db_claim_payment_once(payment_id, str(user.id))
    if not claimed:
        await verifying.edit(content=(
            "❌ That transaction ID has already been used.\n"
            "Please use a new transaction ID."
        ))
        return

    existing = await db_get_slot(str(user.id))

    # ── RENEWAL: active slot within 30 days (quota frozen or not) ────────────
    if existing:
        expires_at = datetime.fromisoformat(existing["expires_at"])
        if expires_at > datetime.utcnow():
            was_frozen   = bool(existing["quota_frozen"])
            new_expires  = datetime.utcnow() + timedelta(days=SLOT_DAYS)

            await verifying.edit(content="✅ id confirmed, fetching slot...")

            ok = await asyncio.to_thread(
                reset_quota_on_server, existing["ftp_user"], existing["ftp_pass"]
            )
            if not ok:
                await verifying.edit(content=(
                    "⚠️ Payment verified but renewal hit a server error.\n"
                    f"Contact admin with payment ID `{payment_id}`."
                ))
                return

            await db_renew_slot(str(user.id), payment_id, new_expires)
            await verifying.delete()
            await user.send(renewal_dm(
                existing["ftp_user"], existing["ftp_pass"],
                new_expires, was_frozen
            ))
            log.info("Renewed: %s → %s (was_frozen=%s)", user.name, existing["ftp_user"], was_frozen)
            return

        # Fully expired — hard delete first, then fall through to new slot
        await asyncio.to_thread(delete_slot_on_server, existing["ftp_user"])
        await db_delete_slot(str(user.id))

    # ── NEW SLOT ──────────────────────────────────────────────────────────────
    await verifying.edit(content="✅ id confirmed, fetching slot...")

    ftp_user   = make_ftp_username(user.name, str(user.id))
    ftp_pass   = generate_password()
    expires_at = datetime.utcnow() + timedelta(days=SLOT_DAYS)

    ok = await asyncio.to_thread(provision_slot, ftp_user, ftp_pass)
    if not ok:
        await verifying.edit(content=(
            "⚠️ Payment verified but slot creation failed.\n"
            f"Contact admin with payment ID `{payment_id}`."
        ))
        return

    await db_save_slot(str(user.id), user.name, ftp_user, ftp_pass, payment_id, expires_at)
    await verifying.delete()
    cfg_io = io.StringIO(rclone_config_file(ftp_user, ftp_pass))
    cfg_file = discord.File(cfg_io, filename="QA.Rclone.config")
    await user.send(content=slot_dm(ftp_user, ftp_pass, expires_at), file=cfg_file)
    log.info("New slot: %s → %s (expires %s)", user.name, ftp_user, expires_at.date())


if __name__ == "__main__":
    
        bot.run(DISCORD_TOKEN)
