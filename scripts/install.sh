#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Helpers ─────────────────────────────────────────────────────────

info()    { echo "[INFO]  $*"; }
warn()    { echo "[WARN]  $*"; }
error()   { echo "[ERROR] $*" >&2; }
success() { echo "[OK]    $*"; }

prompt_yn() {
  local msg="$1" default="${2:-y}"
  local yn
  if [[ "$default" == "y" ]]; then
    read -rp "$msg [Y/n]: " yn
    yn="${yn:-y}"
  else
    read -rp "$msg [y/N]: " yn
    yn="${yn:-n}"
  fi
  [[ "$yn" =~ ^[Yy] ]]
}

# ── Banner ──────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  The Quorum for OpenClaw - Installer"
echo "============================================"
echo ""

# ── 1. Check OpenClaw ──────────────────────────────────────────────

info "Checking for OpenClaw..."
if command -v openclaw &>/dev/null; then
  OC_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
  success "OpenClaw found: $OC_VERSION"
else
  error "OpenClaw is not installed or not in PATH."
  echo ""
  echo "  Install OpenClaw first: https://openclaw.dev"
  echo ""
  exit 1
fi

# ── 2. Check/Start PostgreSQL ──────────────────────────────────────

echo ""
info "Checking for PostgreSQL..."

PG_RUNNING=false

# Check if PostgreSQL is already running (native or Docker)
if pg_isready -q 2>/dev/null; then
  PG_RUNNING=true
  success "PostgreSQL is running."
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "postgres"; then
  PG_RUNNING=true
  success "PostgreSQL is running via Docker."
fi

if [[ "$PG_RUNNING" == false ]]; then
  warn "PostgreSQL does not appear to be running."
  echo ""
  echo "  Options:"
  echo "    1) Start PostgreSQL via Docker (requires Docker)"
  echo "    2) I'll start it myself (skip this step)"
  echo ""
  read -rp "  Choice [1]: " pg_choice
  pg_choice="${pg_choice:-1}"

  if [[ "$pg_choice" == "1" ]]; then
    if ! command -v docker &>/dev/null; then
      error "Docker is not installed. Please install Docker or start PostgreSQL manually."
      exit 1
    fi

    info "Starting PostgreSQL with pgvector via Docker..."
    docker run -d \
      --name quorum-postgres \
      -e POSTGRES_USER=quorum \
      -e POSTGRES_PASSWORD=quorum \
      -e POSTGRES_DB=quorum \
      -p 5432:5432 \
      pgvector/pgvector:pg17 \
      >/dev/null 2>&1 || {
        # Container might already exist but be stopped
        docker start quorum-postgres >/dev/null 2>&1 || {
          error "Failed to start PostgreSQL container."
          echo "  If port 5432 is already in use, you may have another PostgreSQL instance."
          echo "  Stop it or use a different port."
          exit 1
        }
      }

    info "Waiting for PostgreSQL to be ready..."
    for i in $(seq 1 30); do
      if docker exec quorum-postgres pg_isready -q 2>/dev/null; then
        break
      fi
      sleep 1
    done

    if docker exec quorum-postgres pg_isready -q 2>/dev/null; then
      success "PostgreSQL is ready."
      DB_HOST="localhost"
      DB_PORT="5432"
      DB_USER="quorum"
      DB_PASS="quorum"
      DB_NAME="quorum"
    else
      error "PostgreSQL did not start in time."
      exit 1
    fi
  else
    info "Skipping PostgreSQL setup. Make sure it is running before proceeding."
  fi
fi

# ── Collect DB credentials ─────────────────────────────────────────

echo ""
info "Database configuration:"

if [[ -z "${DB_HOST:-}" ]]; then
  read -rp "  Database host [localhost]: " DB_HOST
  DB_HOST="${DB_HOST:-localhost}"
fi
if [[ -z "${DB_PORT:-}" ]]; then
  read -rp "  Database port [5432]: " DB_PORT
  DB_PORT="${DB_PORT:-5432}"
fi
if [[ -z "${DB_USER:-}" ]]; then
  read -rp "  Database user [quorum]: " DB_USER
  DB_USER="${DB_USER:-quorum}"
fi
if [[ -z "${DB_PASS:-}" ]]; then
  read -rsp "  Database password [quorum]: " DB_PASS
  echo ""
  DB_PASS="${DB_PASS:-quorum}"
fi
if [[ -z "${DB_NAME:-}" ]]; then
  read -rp "  Database name [quorum]: " DB_NAME
  DB_NAME="${DB_NAME:-quorum}"
fi

export PGHOST="$DB_HOST"
export PGPORT="$DB_PORT"
export PGUSER="$DB_USER"
export PGPASSWORD="$DB_PASS"
export PGDATABASE="$DB_NAME"

# ── 3. Run schema migrations ──────────────────────────────────────

echo ""
info "Running schema migrations..."

SCHEMA_DIR="$PROJECT_DIR/schema"

if [[ ! -d "$SCHEMA_DIR" ]]; then
  error "Schema directory not found: $SCHEMA_DIR"
  exit 1
fi

for sql_file in "$SCHEMA_DIR"/*.sql; do
  fname="$(basename "$sql_file")"
  info "  Applying $fname..."
  psql -v ON_ERROR_STOP=1 -f "$sql_file" >/dev/null 2>&1 || {
    error "Failed to apply $fname"
    echo "  Check your database credentials and ensure PostgreSQL is running."
    exit 1
  }
done

success "All schema migrations applied."

# ── 4. Check Ollama ────────────────────────────────────────────────

echo ""
info "Checking for Ollama..."

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

if command -v ollama &>/dev/null; then
  success "Ollama CLI found."

  # Check if Ollama server is running
  if curl -s "${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
    success "Ollama server is running at $OLLAMA_HOST"
  else
    warn "Ollama is installed but the server may not be running."
    echo "  Start it with: ollama serve"
    echo ""
    if prompt_yn "  Continue anyway?" "y"; then
      info "Continuing without verifying Ollama server."
    else
      exit 1
    fi
  fi

  # Check for mxbai-embed-large model
  info "Checking for mxbai-embed-large model..."
  if ollama list 2>/dev/null | grep -q "mxbai-embed-large"; then
    success "mxbai-embed-large model is available."
  else
    warn "mxbai-embed-large model not found."
    if prompt_yn "  Pull mxbai-embed-large now? (~670MB)" "y"; then
      info "Pulling mxbai-embed-large (this may take a few minutes)..."
      ollama pull mxbai-embed-large
      success "mxbai-embed-large model pulled."
    else
      warn "Skipping model pull. The plugin will not work without the embedding model."
    fi
  fi
else
  warn "Ollama is not installed."
  echo "  The Quorum requires Ollama for local embeddings."
  echo "  Install it from: https://ollama.com"
  echo ""
  if prompt_yn "  Continue anyway?" "n"; then
    info "Continuing without Ollama. Install it before using the plugin."
  else
    exit 1
  fi
fi

# ── 5. Install plugin into OpenClaw ───────────────────────────────

echo ""
info "Installing The Quorum plugin into OpenClaw..."

cd "$PROJECT_DIR"
openclaw plugins install -l .
success "Plugin installed."

# ── 6. Configure plugin ──────────────────────────────────────────

echo ""
info "Configuring The Quorum plugin in OpenClaw..."

openclaw plugins config the-quorum \
  --set db_host="$DB_HOST" \
  --set db_port="$DB_PORT" \
  --set db_user="$DB_USER" \
  --set db_password="$DB_PASS" \
  --set db_name="$DB_NAME" \
  --set ollama_host="$OLLAMA_HOST" \
  --set ollama_embed_model="mxbai-embed-large" \
  --set embedding_dim=1024

success "Plugin configured."

# ── 7. Offer cron setup ──────────────────────────────────────────

echo ""
if prompt_yn "Set up Quorum cron jobs now?" "y"; then
  bash "$SCRIPT_DIR/setup-cron.sh"
else
  info "Skipping cron setup. Run it later with:"
  echo "  bash $SCRIPT_DIR/setup-cron.sh"
fi

# ── Done ──────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  The Quorum installation complete!"
echo "============================================"
echo ""
echo "Verify the plugin is loaded:"
echo "  openclaw plugins list"
echo ""
echo "Test the memory tools:"
echo "  openclaw run --message \"Use quorum_store to save a test note\""
echo ""
echo "Documentation: $PROJECT_DIR/README.md"
echo ""
