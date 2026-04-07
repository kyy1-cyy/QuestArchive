#!/usr/bin/env bash
set -euo pipefail

SRC="/home17/jepp/Quest Games"
DST="/home17/jepp/Quest Games Clean"
LOG_FILE="$HOME/quest-migrate-$(date +%Y%m%d-%H%M%S).log"
JOBS=8
DRY_RUN=false

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

usage() {
    cat <<EOF
Usage: $0 [--dry-run] [--jobs N]
  --dry-run   Preview moves only
  --jobs N    Parallel moves (default 8)
EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true ;;
        --jobs) JOBS="$2"; shift ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
    shift
done

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
info() { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
ok()   { echo -e "${GREEN}[MOVE]${RESET}  $*"; log "[MOVE]  $*"; }
skip() { echo -e "${YELLOW}[SKIP]${RESET} $*"; log "[SKIP]  $*"; }
err()  { echo -e "${RED}[ERROR]${RESET} $*" >&2; log "[ERROR] $*"; }
die()  { err "$*"; exit 1; }

[[ -d "$SRC" ]] || die "Source not found: $SRC"
mkdir -p "$DST" || die "Cannot create destination"
src_dev=$(stat -c '%d' "$SRC")
dst_dev=$(stat -c '%d' "$DST")
if [[ "$src_dev" != "$dst_dev" ]]; then
    die "Source and destination on different filesystems! mv would copy+delete. Aborting."
fi

$DRY_RUN && info "DRY RUN mode – no files will be moved"
info "Source: $SRC"
info "Dest : $DST"
info "Jobs : $JOBS"
info "Log  : $LOG_FILE"
echo

move_one() {
    local game_path="$1"
    local name=$(basename "$game_path")
    if [[ -d "$DST/$name" ]]; then
        skip "$name (already exists)"
        return 0
    fi
    if $DRY_RUN; then
        ok "$name (dry run)"
        return 0
    fi
    if mv -- "$game_path" "$DST/$name" 2>/dev/null; then
        ok "$name"
        return 0
    else
        err "Failed to move: $name"
        return 1
    fi
}
export -f move_one skip ok err log DST DRY_RUN

find "$SRC" -mindepth 1 -maxdepth 1 -type d -print0 | \
    xargs -0 -P "$JOBS" -I{} bash -c 'move_one "$@"' _ {}

echo
echo -e "${BOLD}Done.${RESET} Log: $LOG_FILE"
