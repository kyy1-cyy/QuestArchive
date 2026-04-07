#!/usr/bin/env python3
"""
VRP FTPS server (Option B) — virtual root without kernel chroot.

Goals:
  - FTPS on the same port as ProFTPD (explicit AUTH TLS / data TLS)
  - Each login gets a unique FTP user/pass (bot provisions via ftpasswd)
  - Users see ONE clickable folder: "Quest Games"
  - They can browse/download inside it
  - They cannot go outside it (they can only see the Quest Games symlink
    from the virtual root "/")
  - Write ops are blocked (read-only perms)
  - Download accounting is written to an xferlog-like file so your existing
    `quota_check.py` can freeze/unfreeze users.
"""

from __future__ import annotations

import base64
import crypt
import os
import random
import time
from pathlib import Path

from pyftpdlib.authorizers import DummyAuthorizer, AuthorizerError
from pyftpdlib.filesystems import AbstractedFS, FilesystemError
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer


# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

FTP_HOST = os.environ.get("VRP_FTPS_HOST", "")  # bind all by default
FTP_PORT = int(os.environ.get("VRP_FTPS_PORT", "12113"))

# Reuse the ProFTPD cert/key so clients keep working.
TLS_CERTFILE = os.environ.get("VRP_TLS_CERTFILE", "/home17/jepp/.config/proftpd/server.crt")
TLS_KEYFILE = os.environ.get("VRP_TLS_KEYFILE", "/home17/jepp/.config/proftpd/server.key")

# Where bot/ftpasswd store user hashes + homes.
PROFTPD_PASSWD_FILE = os.environ.get(
    "VRP_PROFTPD_PASSWD_FILE", "/home17/jepp/.config/proftpd/proftpd.passwd"
)

# Library source the symlink points to (virtual "/Quest Games" -> this).
QUEST_GAMES_SRC = os.environ.get("VRP_QUEST_GAMES_SRC", "/home17/jepp/Quest Games")

# Virtual users' "home" dir. Bot provisions a symlink "Quest Games" inside it.
VRP_WRAPPER_ROOT = os.environ.get("VRP_WRAPPER_ROOT", "/home17/jepp/donor_ftp_root")

# Quota enforcement reads ProFTPD-style transfer logs.
# quota_check.py expects:
#   - field[4] = filesize
#   - field[7] = direction (o=download)
#   - field[9] = username
TRANSFER_LOG = Path(os.environ.get("VRP_TRANSFER_LOG", "/home17/jepp/.config/proftpd/transfer.log"))


def _read_lines(path: str | Path) -> list[str]:
    p = Path(path)
    if not p.exists():
        return []
    return p.read_text(encoding="utf-8", errors="replace").splitlines()


# ──────────────────────────────────────────────────────────────────────────────
# Filesystem: allow access only under the symlinked "Quest Games"
# ──────────────────────────────────────────────────────────────────────────────


class QuestGamesFS(AbstractedFS):
    """
    Virtual FS mapping:
      - virtual "/"  -> wrapper root (contains only "Quest Games" entry)
      - virtual "/Quest Games" -> real QUEST_GAMES_SRC
      - virtual everything else -> rejected

    We still rely on the actual symlink existing in wrapper root so LIST
    shows a clickable "Quest Games" folder. We then allow access to the
    symlink target by loosening validpath checks.
    """

    wrapper_real: str
    game_real: str

    def __init__(self, root: str, cmd_channel):  # root is wrapper dir
        super().__init__(root, cmd_channel)
        # Never trust the per-user home path here: existing slots may have
        # been provisioned with older home values (wrapper vs library).
        # We want a consistent global mapping.
        self.wrapper_real = os.path.realpath(VRP_WRAPPER_ROOT)
        self.game_real = os.path.realpath(QUEST_GAMES_SRC)

    def validpath(self, path: str) -> bool:
        # Allow both:
        #   - wrapper root itself
        #   - anything that resolves inside the real library (symlink target)
        rp = os.path.realpath(path)
        if rp == self.wrapper_real:
            return True
        if rp.startswith(self.wrapper_real.rstrip(os.sep) + os.sep):
            # wrapper contains only the symlink entry anyway
            return True
        if rp == self.game_real:
            return True
        if rp.startswith(self.game_real.rstrip(os.sep) + os.sep):
            return True
        return False

    def listdir(self, path: str):
        rp = os.path.realpath(path)

        # Virtual "/" should show ONE clickable entry, even if the real home
        # for a particular slot is wrong (old slots).
        if rp == self.wrapper_real:
            return ["Quest Games"]

        # For the actual library tree, list the real directory contents.
        return super().listdir(path)

    def fs2ftp(self, fspath: str) -> str:
        # Map real library paths back under the virtual "/Quest Games" prefix.
        rp = os.path.realpath(fspath)
        game = self.game_real.rstrip(os.sep)
        if rp == game:
            return "/Quest Games"
        if rp.startswith(game + os.sep):
            rel = rp[len(game) :].lstrip(os.sep).replace(os.sep, "/")
            return "/Quest Games/" + rel if rel else "/Quest Games"

        # Wrapper root (anything else) is shown as "/"
        wrapper = self.wrapper_real.rstrip(os.sep)
        if rp == wrapper or rp.startswith(wrapper + os.sep):
            return "/"
        return "/"

    def ftp2fs(self, ftppath: str) -> str:
        # Deny anything except "/" and "/Quest Games".
        v = self.ftpnorm(ftppath)
        if v == "/":
            return self.wrapper_real

        allowed_prefix = "/Quest Games"
        if v == allowed_prefix or v.startswith(allowed_prefix + "/"):
            rel = v[len(allowed_prefix) :].lstrip("/")
            if rel:
                return os.path.normpath(os.path.join(self.game_real, rel))
            return self.game_real

        raise FilesystemError('"{}": outside the allowed Quest Games tree'.format(v))


# ──────────────────────────────────────────────────────────────────────────────
# Authorizer: validate against ftpasswd hashes from ProFTPD
# ──────────────────────────────────────────────────────────────


class ProftpdCryptAuthorizer:
    """
    Minimal Authorizer compatible with pyftpdlib for virtual users.

    Reads /home17/jepp/.config/proftpd/proftpd.passwd (ftpasswd format) and
    validates passwords using crypt().
    """

    def __init__(self, passwd_file: str | Path):
        self.passwd_file = Path(passwd_file)
        self._cache: dict[str, dict] = {}
        self._last_mtime = 0.0

        # Read-only perms:
        #  e = CWD
        #  l = LIST/NLST/SIZE/etc
        #  r = RETR
        self.perm = "elr"

    def _load(self):
        try:
            st = self.passwd_file.stat()
        except FileNotFoundError:
            self._cache = {}
            return

        if st.st_mtime <= self._last_mtime:
            return

        self._last_mtime = st.st_mtime
        cache: dict[str, dict] = {}

        for line in _read_lines(self.passwd_file):
            if not line.strip() or line.strip().startswith("#"):
                continue
            parts = line.split(":")
            # ftpasswd style:
            # user:pw_hash:uid:gid:gecos:home:shell
            if len(parts) < 7:
                continue
            username = parts[0]
            pw_hash = parts[1]
            uid = parts[2]
            gid = parts[3]
            home = parts[5]
            shell = parts[6]
            cache[username] = {
                "pw_hash": pw_hash,
                "uid": uid,
                "gid": gid,
                "home": home,
                "shell": shell,
            }

        self._cache = cache

    def has_user(self, username: str) -> bool:
        self._load()
        return username in self._cache

    def validate_authentication(self, username: str, password: str, handler):
        self._load()
        if username not in self._cache:
            raise AuthorizerError("Authentication failed.")
        stored = self._cache[username]["pw_hash"]
        # crypt.crypt(password, stored) uses the hash's salt+identifier.
        if crypt.crypt(password, stored) != stored:
            raise AuthorizerError("Authentication failed.")

    def get_home_dir(self, username: str) -> str:
        self._load()
        if username not in self._cache:
            raise AuthorizerError("no such user")
        # Bot sets home to the wrapper dir so users start with "Quest Games".
        return self._cache[username]["home"]

    def has_perm(self, username: str, perm: str, path=None) -> bool:
        # pyftpdlib expects perm to be a string like "elr" for required perms.
        # We treat it as substring check.
        return perm in self.perm or all(p in self.perm for p in perm)

    def get_perms(self, username: str) -> str:
        return self.perm

    def get_msg_login(self, username: str) -> str:
        return "Login successful."

    def get_msg_quit(self, username: str) -> str:
        return "Goodbye."

    # No-op hooks required by pyftpdlib
    def impersonate_user(self, username, password):
        return

    def terminate_impersonation(self, username):
        return


# ──────────────────────────────────────────────────────────────────────────────
# Handler: append to transfer log on successful downloads
# ──────────────────────────────────────────────────────────────────────────────


class VRPHandler(TLS_FTPHandler):
    authorizer: ProftpdCryptAuthorizer
    abstracted_fs = QuestGamesFS
    tls_control_required = True
    tls_data_required = True

    # Encourage rclone/FileZilla compatibility.
    use_gmt_times = False

    passive_ports = range(5000, 10000)

    def on_file_sent(self, file: str):
        # quota_check reads transfer.log and assumes:
        #   parts[4] = filesize
        #   parts[7] = direction (o)
        #   parts[9] = username
        try:
            size = int(os.path.getsize(file))
        except Exception:
            size = 0

        username = self.username or ""
        if not username:
            return

        # Minimal xferlog-like line with >= 11 fields.
        # Indices:
        #  0 1 2 3 4      5 6 7 8 9      10
        #  0 0 0 0 size  0 0 o 0 user   0
        line = f"0 0 0 0 {size} 0 0 o 0 {username} 0\n"
        try:
            TRANSFER_LOG.parent.mkdir(parents=True, exist_ok=True)
            with open(TRANSFER_LOG, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            # Never crash the FTP session because quota accounting failed.
            pass

    # Block all uploads/renames at the handler level just in case.
    def on_file_received(self, file: str):
        # Should never happen due to perms, but keep safe.
        raise FilesystemError("Uploads are disabled.")


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────


def main():
    # Ensure wrapper root exists and has a Quest Games symlink.
    # Users' homes come from ftpasswd homedir, but we also make sure the
    # shared wrapper dir has the right entry.
    wrapper = Path(VRP_WRAPPER_ROOT)
    wrapper.mkdir(parents=True, exist_ok=True)
    link_path = wrapper / "Quest Games"
    game_src = Path(QUEST_GAMES_SRC)
    # If a symlink already exists, keep it; otherwise set it up.
    try:
        if link_path.is_symlink() or link_path.exists():
            # don't overwrite unless it's missing
            pass
        else:
            link_path.symlink_to(game_src)
    except Exception:
        # symlink might fail on some hosts; server still works if the symlink
        # exists from bot provisioning.
        pass

    authorizer = ProftpdCryptAuthorizer(PROFTPD_PASSWD_FILE)

    # Attach cert/key to handler class.
    VRPHandler.certfile = TLS_CERTFILE
    VRPHandler.keyfile = TLS_KEYFILE
    VRPHandler.authorizer = authorizer

    # Start server.
    server = FTPServer((FTP_HOST, FTP_PORT), VRPHandler)
    server.max_cons = 2000
    server.max_cons_per_ip = 0

    print(f"VRP FTPS server listening on {FTP_HOST or '0.0.0.0'}:{FTP_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

