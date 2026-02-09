#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# The Quorum for OpenClaw -- Uninstall Script
# Removes the plugin from OpenClaw, stops Docker services, and cleans up.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Colour helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { printf "${BLUE}[INFO]${NC}  %s\n" "$*"; }
success() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error()   { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }
header()  { printf "\n${BOLD}${CYAN}── %s${NC}\n" "$*"; }

# ── Ensure DBUS session bus is available ─────────────────────────────────
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus"
fi

# ── Helper: ask yes/no ───────────────────────────────────────────────────
prompt_yn() {
    local prompt="${1:-Continue?}"
    local default="${2:-y}"
    local answer
    if [ "$default" = "y" ]; then
        read -rp "$(printf "${BOLD}%s [Y/n]: ${NC}" "$prompt")" answer
        answer="${answer:-y}"
    else
        read -rp "$(printf "${BOLD}%s [y/N]: ${NC}" "$prompt")" answer
        answer="${answer:-n}"
    fi
    [[ "$answer" =~ ^[Yy] ]]
}

echo ""
echo "============================================"
echo "  The Quorum for OpenClaw - Uninstaller"
echo "============================================"
echo ""
info "Project directory: $PROJECT_DIR"
echo ""

# ── 1. Remove cron jobs ──────────────────────────────────────────────────
header "Removing cron jobs"

if command -v openclaw &>/dev/null; then
    # List and remove any quorum cron jobs
    CRON_JSON=$(openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')
    CRON_IDS=$(echo "$CRON_JSON" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      (d.jobs||[]).filter(j => (j.name||'').startsWith('quorum-')).forEach(j => console.log(j.id));
    " 2>/dev/null || true)
    if [ -n "$CRON_IDS" ]; then
        for cron_id in $CRON_IDS; do
            openclaw cron rm "$cron_id" 2>/dev/null && info "Removed cron job: $cron_id" || true
        done
        success "Quorum cron jobs removed."
    else
        info "No Quorum cron jobs found."
    fi
else
    warn "OpenClaw not found, skipping cron removal."
fi

# ── 2. Remove plugin from OpenClaw ───────────────────────────────────────
header "Removing plugin from OpenClaw"

if command -v openclaw &>/dev/null; then
    openclaw config unset plugins.entries.the-quorum 2>/dev/null && info "Removed plugin entry." || true
    openclaw config unset plugins.installs.the-quorum 2>/dev/null && info "Removed plugin install record." || true

    # Clean up load.paths if it references our directory
    LOAD_PATHS=$(openclaw config get plugins.load.paths 2>/dev/null || true)
    if echo "$LOAD_PATHS" | grep -q "the-quorum-openclaw"; then
        openclaw config unset plugins.load 2>/dev/null && info "Removed plugin load path." || true
    fi

    success "Plugin removed from OpenClaw config."
else
    warn "OpenClaw not found, skipping plugin removal."
fi

# ── 3. Remove skill symlinks ─────────────────────────────────────────────
header "Removing skills"

SKILLS_DIR="${HOME}/.openclaw/skills"
REMOVED_SKILLS=0
for link in "$SKILLS_DIR"/quorum-*; do
    if [ -L "$link" ] || [ -d "$link" ]; then
        rm -rf "$link"
        info "Removed: $(basename "$link")"
        REMOVED_SKILLS=$((REMOVED_SKILLS + 1))
    fi
done
if [ "$REMOVED_SKILLS" -gt 0 ]; then
    success "Removed $REMOVED_SKILLS Quorum skill(s)."
else
    info "No Quorum skills found."
fi

# ── 4. Stop and remove Docker services ───────────────────────────────────
header "Docker services"

if command -v docker &>/dev/null; then
    if docker compose version &>/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        COMPOSE_CMD=""
    fi

    if [ -n "$COMPOSE_CMD" ] && [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
        echo ""
        if prompt_yn "Stop and remove Docker containers (PostgreSQL + Ollama)?" "y"; then
            echo ""
            if prompt_yn "Also delete database data and Ollama models? (This is irreversible)" "n"; then
                (cd "$PROJECT_DIR" && $COMPOSE_CMD down -v 2>/dev/null) || true
                success "Docker containers and volumes removed."
            else
                (cd "$PROJECT_DIR" && $COMPOSE_CMD down 2>/dev/null) || true
                success "Docker containers stopped (data volumes preserved)."
            fi
        else
            info "Skipping Docker cleanup."
        fi
    else
        info "No docker-compose setup found."
    fi
else
    warn "Docker not found, skipping container cleanup."
fi

# ── 4. Clean up generated files ──────────────────────────────────────────
header "Cleaning up generated files"

# Remove .env (contains generated password)
if [ -f "$PROJECT_DIR/.env" ]; then
    rm -f "$PROJECT_DIR/.env"
    success "Removed .env"
fi

# Remove dist/ (compiled TypeScript)
if [ -d "$PROJECT_DIR/dist" ]; then
    rm -rf "$PROJECT_DIR/dist"
    success "Removed dist/"
fi

# Remove node_modules/
if [ -d "$PROJECT_DIR/node_modules" ]; then
    echo ""
    if prompt_yn "Remove node_modules/?" "y"; then
        rm -rf "$PROJECT_DIR/node_modules"
        success "Removed node_modules/"
    fi
fi

# ── 5. Remove Samba share ────────────────────────────────────────────────
header "Samba share"

if grep -q "\[quorum-inbox\]" /etc/samba/smb.conf 2>/dev/null; then
    if prompt_yn "Remove the quorum-inbox Samba share?" "y"; then
        sudo sed -i '/\[quorum-inbox\]/,/^$/d' /etc/samba/smb.conf
        if systemctl is-active smbd &>/dev/null; then
            sudo systemctl restart smbd
        fi
        success "Removed quorum-inbox Samba share."
    else
        info "Keeping Samba share."
    fi
else
    info "No quorum-inbox Samba share found."
fi

# ── 6. Restart OpenClaw gateway ──────────────────────────────────────────
header "Restarting OpenClaw gateway"

if command -v openclaw &>/dev/null; then
    if systemctl --user is-active openclaw-gateway.service &>/dev/null; then
        systemctl --user restart openclaw-gateway.service
        success "Gateway restarted."
    else
        info "Gateway service not running."
    fi
fi

# ── Done ─────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
printf "  ${GREEN}The Quorum has been uninstalled.${NC}\n"
echo "============================================"
echo ""
echo "The source code is still in: $PROJECT_DIR"
echo "To completely remove it:  rm -rf $PROJECT_DIR"
echo ""
