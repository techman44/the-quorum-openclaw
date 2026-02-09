#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# The Quorum for OpenClaw -- Install Script
# Checks prerequisites, sets up Docker services (PostgreSQL + Ollama),
# builds the TypeScript plugin, installs it into OpenClaw, and configures it.
# Safe to run multiple times (idempotent).
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
NC='\033[0m' # No colour

info()    { printf "${BLUE}[INFO]${NC}  %s\n" "$*"; }
success() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error()   { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }
header()  { printf "\n${BOLD}${CYAN}── %s${NC}\n" "$*"; }

# ── Trap: print a helpful message on unexpected failure ────────────────────
cleanup() {
    if [ $? -ne 0 ]; then
        echo ""
        error "Installation did not complete successfully."
        error "Review the output above for details, fix the issue, and re-run this script."
    fi
}
trap cleanup EXIT

# ── Helper: ask yes/no ─────────────────────────────────────────────────────
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

# ── Ensure DBUS session bus is available (headless / SSH environments) ────
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus"
fi

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "============================================"
echo "  The Quorum for OpenClaw - Installer"
echo "============================================"
echo ""
info "Project directory: $PROJECT_DIR"
echo ""

# ── 1. Check prerequisites ────────────────────────────────────────────────
header "Checking prerequisites"

MISSING=()

# OpenClaw
if command -v openclaw &>/dev/null; then
    OC_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
    success "OpenClaw found: $OC_VERSION"
else
    MISSING+=("openclaw")
    error "OpenClaw is not installed or not in PATH."
    echo "  Install OpenClaw first: https://openclaw.dev"
fi

# Node.js
if command -v node &>/dev/null; then
    NODE_VERSION="$(node --version 2>&1)"
    success "node found ($NODE_VERSION)"
else
    MISSING+=("node")
    error "node not found. Install Node.js: https://nodejs.org"
fi

# npm
if command -v npm &>/dev/null; then
    NPM_VERSION="$(npm --version 2>&1)"
    success "npm found (v$NPM_VERSION)"
else
    MISSING+=("npm")
    error "npm not found. It is usually bundled with Node.js."
fi

# Docker
if command -v docker &>/dev/null; then
    success "docker found ($(docker --version 2>&1 | head -1))"
else
    MISSING+=("docker")
    error "docker not found. Install Docker: https://docs.docker.com/get-docker/"
fi

# curl (needed for health checks)
if command -v curl &>/dev/null; then
    success "curl found"
else
    MISSING+=("curl")
    error "curl not found. Install curl to continue."
fi

if [ ${#MISSING[@]} -gt 0 ]; then
    echo ""
    error "Missing prerequisites: ${MISSING[*]}"
    error "Install the missing tools and re-run this script."
    exit 1
fi

# Docker compose check
if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
else
    error "docker-compose not found. Install the Docker Compose plugin."
    exit 1
fi
success "docker compose found ($($COMPOSE_CMD version 2>&1 | head -1))"

# ── 2. Environment file ──────────────────────────────────────────────────
header "Environment configuration"

ENV_FILE="$PROJECT_DIR/.env"

GENERATED_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"

if [ -f "$ENV_FILE" ]; then
    success ".env already exists -- using existing configuration."
else
    if [ -f "$PROJECT_DIR/.env.example" ]; then
        sed "s/GENERATE_ON_INSTALL/$GENERATED_PASSWORD/" "$PROJECT_DIR/.env.example" > "$ENV_FILE"
        success "Created .env from .env.example with generated DB password."
    else
        # Create a minimal .env with defaults
        cat > "$ENV_FILE" <<ENVEOF
# The Quorum for OpenClaw - Environment Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=quorum
DB_PASSWORD=$GENERATED_PASSWORD
DB_NAME=quorum
OLLAMA_HOST=http://localhost:11434
OLLAMA_PORT=11434
OLLAMA_EMBED_MODEL=mxbai-embed-large
EMBEDDING_DIM=1024
ENVEOF
        success "Created .env with generated DB password."
    fi
    info "A random database password has been generated automatically."
fi

# Source .env to pick up DB vars for later steps
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Set defaults for variables that might not be in .env
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-quorum}"
DB_PASSWORD="${DB_PASSWORD:-changeme}"
DB_NAME="${DB_NAME:-quorum}"
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
OLLAMA_EMBED_MODEL="${OLLAMA_EMBED_MODEL:-mxbai-embed-large}"
EMBEDDING_DIM="${EMBEDDING_DIM:-1024}"

info "DB: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
info "Ollama: $OLLAMA_HOST"

# ── 3. Install npm dependencies ──────────────────────────────────────────
header "Installing npm dependencies"

cd "$PROJECT_DIR"
info "Running npm install..."
npm install
success "npm dependencies installed."

# ── 4. Build TypeScript ──────────────────────────────────────────────────
header "Building TypeScript"

info "Running npm run build..."
npm run build
success "TypeScript build complete (output in dist/)."

# ── 5. Start Docker services ────────────────────────────────────────────
header "Starting Docker services (PostgreSQL + Ollama)"

info "Running $COMPOSE_CMD up -d..."
(cd "$PROJECT_DIR" && $COMPOSE_CMD up -d)
success "Docker containers started."

# ── 6. Wait for PostgreSQL ───────────────────────────────────────────────
header "Waiting for PostgreSQL"

PG_MAX_WAIT=30
info "Waiting up to ${PG_MAX_WAIT}s for PostgreSQL to accept connections..."

PG_READY=false
for i in $(seq 1 "$PG_MAX_WAIT"); do
    if docker exec quorum-db pg_isready -U "$DB_USER" -q 2>/dev/null; then
        PG_READY=true
        break
    fi
    printf "."
    sleep 1
done
echo ""

if [ "$PG_READY" = true ]; then
    success "PostgreSQL is ready (took ~${i}s)."
else
    error "PostgreSQL did not become ready within ${PG_MAX_WAIT}s."
    error "Check container logs: docker logs quorum-db"
    exit 1
fi

# ── 7. Wait for Ollama ──────────────────────────────────────────────────
header "Waiting for Ollama"

OLLAMA_MAX_WAIT=30
info "Waiting up to ${OLLAMA_MAX_WAIT}s for Ollama to respond..."

OLLAMA_READY=false
for i in $(seq 1 "$OLLAMA_MAX_WAIT"); do
    if curl -s "http://localhost:${OLLAMA_PORT:-11434}/api/tags" >/dev/null 2>&1; then
        OLLAMA_READY=true
        break
    fi
    printf "."
    sleep 1
done
echo ""

if [ "$OLLAMA_READY" = true ]; then
    success "Ollama is ready (took ~${i}s)."
else
    error "Ollama did not become ready within ${OLLAMA_MAX_WAIT}s."
    error "Check container logs: docker logs quorum-ollama"
    exit 1
fi

# ── 8. Pull embedding model ─────────────────────────────────────────────
header "Pulling embedding model"

# Check if model is already available
if docker exec quorum-ollama ollama list 2>/dev/null | grep -q "$OLLAMA_EMBED_MODEL"; then
    success "$OLLAMA_EMBED_MODEL is already available."
else
    info "Pulling $OLLAMA_EMBED_MODEL (this may take a few minutes on first run)..."
    docker exec quorum-ollama ollama pull "$OLLAMA_EMBED_MODEL"
    success "$OLLAMA_EMBED_MODEL model pulled."
fi

# ── 9. Schema migrations ────────────────────────────────────────────────
header "Database schema"

SCHEMA_DIR="$PROJECT_DIR/schema"

if [ ! -d "$SCHEMA_DIR" ]; then
    error "Schema directory not found: $SCHEMA_DIR"
    exit 1
fi

# docker-entrypoint-initdb.d only runs on FIRST container start (empty data volume).
# For re-installs or schema updates, we apply migrations explicitly.
# Each schema file should use CREATE ... IF NOT EXISTS or equivalent to be idempotent.
info "Applying schema migrations via docker exec..."

MIGRATION_FAILED=false
for sql_file in "$SCHEMA_DIR"/*.sql; do
    fname="$(basename "$sql_file")"
    info "  Applying $fname..."
    # The schema dir is mounted at /docker-entrypoint-initdb.d inside the container
    if docker exec quorum-db psql -U "$DB_USER" -d "$DB_NAME" \
        -v ON_ERROR_STOP=1 \
        -f "/docker-entrypoint-initdb.d/$fname" 2>&1 | while IFS= read -r line; do
            # Suppress NOTICE-level messages (e.g. "relation already exists, skipping")
            if echo "$line" | grep -qi "error"; then
                echo "    $line"
            fi
        done; then
        : # success
    else
        warn "  $fname had issues (may be OK if objects already exist)."
        # Don't fail hard -- schema files should be idempotent with IF NOT EXISTS
    fi
done

success "Schema migrations applied."

# ── 10. Install and configure plugin in OpenClaw ─────────────────────────
header "Installing plugin into OpenClaw"

cd "$PROJECT_DIR"
info "Running: openclaw plugins install -l ."
openclaw plugins install -l .
success "Plugin installed into OpenClaw."

header "Configuring plugin"

info "Setting plugin configuration in OpenClaw..."
PLUGIN_CONFIG=$(cat <<CFGEOF
{"db_host":"$DB_HOST","db_port":$DB_PORT,"db_user":"$DB_USER","db_password":"$DB_PASSWORD","db_name":"$DB_NAME","ollama_host":"$OLLAMA_HOST","ollama_embed_model":"$OLLAMA_EMBED_MODEL","embedding_dim":$EMBEDDING_DIM}
CFGEOF
)
openclaw config set plugins.entries.the-quorum.config "$PLUGIN_CONFIG"
success "Plugin configured with values from .env."

# ── 11. Install skills into OpenClaw ─────────────────────────────────────
header "Installing skills"

SKILLS_DIR="${HOME}/.openclaw/skills"
mkdir -p "$SKILLS_DIR"

for skill_dir in "$PROJECT_DIR/skills"/*/; do
    skill_name="$(basename "$skill_dir")"
    target_name="quorum-${skill_name}"
    if [ -L "$SKILLS_DIR/$target_name" ] || [ -d "$SKILLS_DIR/$target_name" ]; then
        rm -rf "$SKILLS_DIR/$target_name"
    fi
    ln -sf "$skill_dir" "$SKILLS_DIR/$target_name"
    info "  Linked skill: $target_name"
done

success "Quorum skills installed into $SKILLS_DIR."

# ── 12. Restart gateway to load plugin and skills ────────────────────────
header "Restarting OpenClaw gateway"

if systemctl --user is-active openclaw-gateway.service &>/dev/null; then
    systemctl --user restart openclaw-gateway.service
    sleep 2
    success "Gateway restarted with plugin and skills loaded."
else
    warn "Gateway service not running. Start it with: openclaw gateway install && openclaw daemon start"
fi

# ── 13. Onboarding ───────────────────────────────────────────────────────
header "Onboarding"

echo ""
echo "  The Quorum works best when the agents know about you."
echo "  Let's capture some basics so the agents have context from day one."
echo ""

if prompt_yn "Run the quick onboarding questionnaire now?" "y"; then
    echo ""

    # ── Name ──
    read -rp "$(printf "${BOLD}What's your name? ${NC}")" OB_NAME
    OB_NAME="${OB_NAME:-User}"
    echo ""

    # ── Role ──
    read -rp "$(printf "${BOLD}What do you do? (current role, company, freelancing, etc.) ${NC}")
> " OB_ROLE
    echo ""

    # ── Projects ──
    echo "What are the main projects or areas you're focused on right now?"
    echo "(Work projects, side projects, personal goals -- list as many as you like.)"
    read -rp "> " OB_PROJECTS
    echo ""

    # ── Priorities ──
    echo "What are your top 3 priorities right now? The things that, if you made"
    echo "real progress on them this month, you'd feel good about?"
    read -rp "> " OB_PRIORITIES
    echo ""

    # ── Accountability depth ──
    echo "How deeply should the agents analyse and push back?"
    echo "  1) Light    -- Quick summaries, surface-level observations"
    echo "  2) Standard -- Detailed reflections, proactive suggestions (recommended)"
    echo "  3) Deep     -- Comprehensive analysis, thorough challenges"
    read -rp "$(printf "${BOLD}Choose [1/2/3]: ${NC}")" OB_DEPTH_CHOICE
    case "$OB_DEPTH_CHOICE" in
        1) OB_DEPTH="light" ;;
        3) OB_DEPTH="deep" ;;
        *) OB_DEPTH="standard" ;;
    esac
    echo ""

    # ── Communication style ──
    echo "How direct should the agents be when calling out procrastination"
    echo "or missed commitments?"
    echo "  1) Gentle  -- Supportive nudges, encouraging tone"
    echo "  2) Direct  -- Straightforward, no sugarcoating (recommended)"
    echo "  3) Blunt   -- No-nonsense, call it like it is"
    read -rp "$(printf "${BOLD}Choose [1/2/3]: ${NC}")" OB_STYLE_CHOICE
    case "$OB_STYLE_CHOICE" in
        1) OB_STYLE="gentle" ;;
        3) OB_STYLE="blunt" ;;
        *) OB_STYLE="direct" ;;
    esac
    echo ""

    # ── Optional: LinkedIn / extra context ──
    echo "Anything else the agents should know about you? (career background,"
    echo "LinkedIn URL, goals, preferences -- or just press Enter to skip)"
    read -rp "> " OB_EXTRA
    echo ""

    # ── Write onboarding file to inbox ──
    INBOX_DIR="$PROJECT_DIR/data/inbox"
    mkdir -p "$INBOX_DIR"

    ONBOARDING_FILE="$INBOX_DIR/onboarding-profile.md"
    cat > "$ONBOARDING_FILE" <<OBEOF
# User Profile - Onboarding

## About
- **Name:** $OB_NAME
- **Role:** $OB_ROLE

## Current Projects and Focus Areas
$OB_PROJECTS

## Top Priorities
$OB_PRIORITIES

## System Preferences
- **Analysis depth:** $OB_DEPTH
- **Accountability style:** $OB_STYLE

OBEOF

    if [ -n "$OB_EXTRA" ]; then
        cat >> "$ONBOARDING_FILE" <<OBEXTRA
## Additional Context
$OB_EXTRA

OBEXTRA
    fi

    success "Onboarding profile saved to data/inbox/onboarding-profile.md"
    info "The Data Collector will ingest this into the memory system on its next run."
    info "You can also run a deeper interactive onboarding later through OpenClaw chat."
    echo ""
else
    info "Skipping onboarding. You can run it later through OpenClaw chat:"
    echo "  Open OpenClaw and say: Run the quorum-onboarding skill"
    echo ""
fi

# ── 14. Optional cron setup ─────────────────────────────────────────────
header "Cron schedule"

echo ""
if [ -f "$SCRIPT_DIR/setup-cron.sh" ]; then
    if prompt_yn "Set up Quorum cron jobs now?" "y"; then
        chmod +x "$SCRIPT_DIR/setup-cron.sh"
        bash "$SCRIPT_DIR/setup-cron.sh"
    else
        info "Skipping cron setup. Run it later with:"
        echo "  bash $SCRIPT_DIR/setup-cron.sh"
    fi
else
    warn "setup-cron.sh not found -- skipping cron setup."
fi

# ── 15. Final health check ──────────────────────────────────────────────
header "Final health check"

HEALTH_OK=true

# Check PostgreSQL
if docker exec quorum-db pg_isready -U "$DB_USER" -q 2>/dev/null; then
    success "PostgreSQL is responding."
else
    error "PostgreSQL is NOT responding."
    HEALTH_OK=false
fi

# Check Ollama
if curl -s "http://localhost:${OLLAMA_PORT:-11434}/api/tags" >/dev/null 2>&1; then
    success "Ollama is responding."
else
    error "Ollama is NOT responding."
    HEALTH_OK=false
fi

# Check embedding model
if docker exec quorum-ollama ollama list 2>/dev/null | grep -q "$OLLAMA_EMBED_MODEL"; then
    success "$OLLAMA_EMBED_MODEL model is available."
else
    error "$OLLAMA_EMBED_MODEL model is NOT available."
    HEALTH_OK=false
fi

# Check plugin in OpenClaw
if openclaw plugins list 2>/dev/null | grep -qi "quorum"; then
    success "The Quorum plugin is installed in OpenClaw."
else
    warn "Could not verify plugin in OpenClaw (openclaw plugins list did not match)."
fi

# Check skills
SKILLS_FOUND=$(openclaw skills list 2>/dev/null | grep -ci "quorum" || true)
if [ "$SKILLS_FOUND" -gt 0 ]; then
    success "$SKILLS_FOUND Quorum skills discovered by OpenClaw."
else
    warn "Could not verify skills in OpenClaw."
fi

if [ "$HEALTH_OK" = true ]; then
    echo ""
    echo "============================================"
    printf "  ${GREEN}The Quorum installation complete!${NC}\n"
    echo "============================================"
    echo ""
    echo "Verify the plugin is loaded:"
    echo "  openclaw plugins list"
    echo ""
    echo "List Quorum skills:"
    echo "  openclaw skills list | grep quorum"
    echo ""
    echo "Manage Docker services:"
    echo "  cd $PROJECT_DIR && $COMPOSE_CMD ps"
    echo "  cd $PROJECT_DIR && $COMPOSE_CMD logs -f"
    echo "  cd $PROJECT_DIR && $COMPOSE_CMD down      # stop services"
    echo ""
    info "Documentation: $PROJECT_DIR/README.md"
    echo ""
else
    echo ""
    error "Installation completed with errors. Review the health check output above."
    echo ""
    echo "Troubleshooting:"
    echo "  docker logs quorum-db       # PostgreSQL logs"
    echo "  docker logs quorum-ollama   # Ollama logs"
    echo "  docker ps                   # Check running containers"
    echo ""
    exit 1
fi
