#!/usr/bin/env bash
set -euo pipefail

GAMES_DIR="/home17/jepp/Quest Games"
B2_REMOTE="b2:quest-archive"
B2_PATH=""
JOBS=8
BW_LIMIT="100M"
MAX_RETRIES=3

# Optional API registration – leave empty to disable
API_BASE="https://questarchive.xyz"
API_KEY=""

LOG_DIR="$HOME"
LOG_FILE="$LOG_DIR/upload-$(date +%Y%m%d-%H%M%S).log"
TMP_COUNTERS="/tmp/b2_upload_counters_$$"
mkdir -p "$TMP_COUNTERS"
cleanup() {
    local exit_code=$?
    [[ -d "$TMP_COUNTERS" ]] && rm -rf "$TMP_COUNTERS"
    if [[ $exit_code -ne 0 ]]; then
        # Kill all processes in this process group to stop workers
        kill -TERM -$$ 2>/dev/null || true
    fi
}
trap cleanup EXIT SIGINT SIGTERM

log()   { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
info()  { echo -e "\033[0;36m[INFO]\033[0m  $*"; log "[INFO]  $*"; }
ok()    { echo -e "\033[0;32m[UPLOAD]\033[0m $*"; log "[UPLOAD] $*"; }
skip()  { echo -e "\033[1;33m[SKIP]\033[0m  $*"; log "[SKIP]  $*"; }
err()   { echo -e "\033[0;31m[ERROR]\033[0m $*" >&2; log "[ERROR] $*"; }
die()   { err "$*"; exit 1; }

compute_hash() {
    local name="$1"
    if [[ -n "${HASH_SECRET:-}" ]]; then
        echo -n "$name" | openssl dgst -sha256 -hmac "$HASH_SECRET" -hex | cut -d' ' -f2 | cut -c1-32
    else
        echo -n "$name" | sha256sum | cut -c1-32
    fi
}

register_upload() {
    local hash="$1"
    local key="$2"
    if [[ -z "$API_BASE" || "$API_BASE" == "https://your-server.com" ]]; then
        return 0
    fi
    local status_code
    status_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/internal/register-upload" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"hash\":\"$hash\",\"key\":\"$key\"}")
    if [[ "$status_code" -eq 200 || "$status_code" -eq 204 ]]; then
        info "Registered: $hash → $key"
    else
        err "API registration failed (HTTP $status_code) for $key"
        return 1
    fi
}

process_game() {
    local folder="$1"
    local name=$(basename "$folder")
    local remote_key="${B2_PATH}${name}.zip"
    local hash=""

    if rclone lsf "${B2_REMOTE}/${remote_key}" 2>/dev/null | grep -q .; then
        skip "$name (already in B2)"
        echo 1 >> "$TMP_COUNTERS/skipped"
        return 0
    fi

    hash=$(compute_hash "$name")
    info "Processing: $name"

    for attempt in $(seq 1 $MAX_RETRIES); do
        info "Attempt $attempt for $name"
        if (
            cd "$folder" && \
            zip -0 -r - . | \
            rclone rcat "${B2_REMOTE}/${remote_key}" \
                --bwlimit "$BW_LIMIT" \
                --retries 3 \
                --low-level-retries 5 \
                --checksum \
                --progress \
                2>>"$LOG_FILE"
        ); then
            ok "$name -> ${remote_key}"
            register_upload "$hash" "$remote_key" || true
            echo 1 >> "$TMP_COUNTERS/uploaded"
            return 0
        else
            err "Attempt $attempt failed for $name"
            sleep 5
        fi
    done

    err "FAILED after $MAX_RETRIES attempts: $name"
    echo 1 >> "$TMP_COUNTERS/failed"
    return 1
}

# Worker mode handler
if [[ "${1:-}" == "worker" ]]; then
    # Exit with 255 to tell xargs to stop everything on Ctrl+C
    trap "exit 255" SIGINT SIGTERM
    process_game "$2"
    exit $?
fi

# Ensure mandatory variables are exported for workers
export B2_REMOTE B2_PATH BW_LIMIT MAX_RETRIES API_BASE API_KEY LOG_FILE TMP_COUNTERS HASH_SECRET

[[ -d "$GAMES_DIR" ]] || die "Games directory not found: $GAMES_DIR"
command -v rclone >/dev/null || die "rclone not installed"
command -v zip >/dev/null || die "zip not installed"
command -v curl >/dev/null || die "curl not installed"

info "Starting B2 upload pipeline"
info "Source: $GAMES_DIR"
info "Remote: ${B2_REMOTE}/${B2_PATH}"
info "Parallel jobs: $JOBS"
info "Bandwidth limit: $BW_LIMIT"
info "Log: $LOG_FILE"
echo

{
    find "$GAMES_DIR" -mindepth 1 -maxdepth 1 -type d -name "_*" -print0 | sort -z
    find "$GAMES_DIR" -mindepth 1 -maxdepth 1 -type d -name "[0-9]*" -print0 | sort -z
    find "$GAMES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name "_*" ! -name "[0-9]*" ! -name "*.7z" ! -name "*.txt" -print0 | sort -z
} | xargs -0 -P "$JOBS" -I{} bash "$0" worker {}

uploaded=$(wc -l < "$TMP_COUNTERS/uploaded" 2>/dev/null | tr -d ' ' || echo 0)
skipped=$(wc -l < "$TMP_COUNTERS/skipped" 2>/dev/null | tr -d ' ' || echo 0)
failed=$(wc -l < "$TMP_COUNTERS/failed" 2>/dev/null | tr -d ' ' || echo 0)

echo ""
echo "─────────────────────────────"
echo "  Uploaded : $uploaded"
echo "  Skipped  : $skipped"
echo "  Failed   : $failed"
echo "  Log      : $LOG_FILE"
echo "─────────────────────────────"

[[ $failed -eq 0 ]] || exit 1
