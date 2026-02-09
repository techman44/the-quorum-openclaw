#!/usr/bin/env bash
set -euo pipefail

QUORUM_PREFIX="quorum-"

# ── Helpers ─────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Set up (or remove) The Quorum cron jobs for OpenClaw.

Options:
  --remove      Remove all existing Quorum cron jobs and exit
  --chat-id ID  Telegram chat ID (skips interactive prompt)
  --channel CH  Notification channel: telegram or whatsapp (default: telegram)
  -h, --help    Show this help message

Examples:
  $(basename "$0")                          # Interactive setup
  $(basename "$0") --chat-id 123456789      # Non-interactive setup
  $(basename "$0") --remove                 # Remove all Quorum cron jobs
EOF
  exit 0
}

remove_quorum_jobs() {
  echo "Removing existing Quorum cron jobs..."
  local found=0

  # List cron jobs and find quorum ones
  while IFS= read -r line; do
    local job_id job_name
    job_id=$(echo "$line" | awk '{print $1}')
    job_name=$(echo "$line" | awk '{print $2}')

    if [[ "$job_name" == ${QUORUM_PREFIX}* ]]; then
      echo "  Removing: $job_name ($job_id)"
      openclaw cron remove "$job_id"
      found=$((found + 1))
    fi
  done < <(openclaw cron list --format plain 2>/dev/null || true)

  if [[ $found -eq 0 ]]; then
    echo "  No Quorum cron jobs found."
  else
    echo "  Removed $found Quorum cron job(s)."
  fi
}

# ── Parse arguments ─────────────────────────────────────────────────

CHAT_ID=""
CHANNEL="telegram"
REMOVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove)
      REMOVE=true
      shift
      ;;
    --chat-id)
      CHAT_ID="$2"
      shift 2
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

# ── Check prerequisites ────────────────────────────────────────────

if ! command -v openclaw &>/dev/null; then
  echo "Error: openclaw is not installed or not in PATH."
  echo "Install it first: https://openclaw.dev"
  exit 1
fi

# ── Handle --remove ─────────────────────────────────────────────────

if [[ "$REMOVE" == true ]]; then
  remove_quorum_jobs
  echo ""
  echo "Done. Run 'openclaw cron list' to verify."
  exit 0
fi

# ── Interactive setup ───────────────────────────────────────────────

echo "============================================"
echo "  The Quorum - OpenClaw Cron Setup"
echo "============================================"
echo ""

# Ask for channel preference if not provided
if [[ -z "$CHAT_ID" ]]; then
  echo "Which notification channel do you want to use?"
  echo "  1) Telegram (default)"
  echo "  2) WhatsApp"
  echo ""
  read -rp "Choice [1]: " channel_choice
  channel_choice="${channel_choice:-1}"

  case "$channel_choice" in
    1) CHANNEL="telegram" ;;
    2) CHANNEL="whatsapp" ;;
    *)
      echo "Invalid choice. Using Telegram."
      CHANNEL="telegram"
      ;;
  esac

  echo ""
  read -rp "Enter your ${CHANNEL} chat ID: " CHAT_ID

  if [[ -z "$CHAT_ID" ]]; then
    echo "Error: Chat ID is required."
    exit 1
  fi
fi

echo ""
echo "Channel:  $CHANNEL"
echo "Chat ID:  $CHAT_ID"
echo ""

# Check for existing quorum jobs
existing_count=0
while IFS= read -r line; do
  job_name=$(echo "$line" | awk '{print $2}')
  if [[ "$job_name" == ${QUORUM_PREFIX}* ]]; then
    existing_count=$((existing_count + 1))
  fi
done < <(openclaw cron list --format plain 2>/dev/null || true)

if [[ $existing_count -gt 0 ]]; then
  echo "Found $existing_count existing Quorum cron job(s)."
  read -rp "Remove them before creating new ones? [Y/n]: " remove_existing
  remove_existing="${remove_existing:-Y}"
  if [[ "$remove_existing" =~ ^[Yy] ]]; then
    remove_quorum_jobs
    echo ""
  fi
fi

echo "Creating Quorum cron jobs..."
echo ""

# ── Connector: every 15 minutes ────────────────────────────────────

echo "  [1/5] The Connector (every 15 minutes)..."
openclaw cron add \
  --name "quorum-connector" \
  --cron "*/15 * * * *" \
  --session isolated \
  --message "You are running as The Connector from The Quorum. Search recent conversation history and memory for meaningful connections between current activity and past knowledge. Use the quorum_search tool to find related past documents, events, and conversations. Focus on non-obvious connections the user has forgotten or wouldn't think to link. If you find important connections, store them with quorum_store_event using event_type 'connection'. Include relevance scores. Summarize what you found." \
  --announce \
  --channel "$CHANNEL" \
  --to "$CHAT_ID"

# ── Executor: every hour ───────────────────────────────────────────

echo "  [2/5] The Executor (every hour)..."
openclaw cron add \
  --name "quorum-executor" \
  --cron "0 * * * *" \
  --session isolated \
  --message "You are running as The Executor from The Quorum. Review recent conversations and events for actionable items. Check existing tasks with quorum_list_tasks -- flag anything overdue or stale. Create new tasks from recent discussions using quorum_create_task. If the user hasn't acted on something important, call it out directly. Be specific about what was committed to and when. Do not sugarcoat procrastination." \
  --announce \
  --channel "$CHANNEL" \
  --to "$CHAT_ID"

# ── Strategist: daily at 6am ──────────────────────────────────────

echo "  [3/5] The Strategist (daily at 6:00 AM)..."
openclaw cron add \
  --name "quorum-strategist" \
  --cron "0 6 * * *" \
  --session isolated \
  --model "opus" \
  --message "You are running as The Strategist from The Quorum. Perform a daily reflection. Search memory for the last 24 hours of events, tasks, and conversations. Identify patterns, recurring themes, blocked work, and strategic opportunities. Write a structured reflection document using quorum_store with doc_type 'reflection'. Assess what is working, what is stuck, and what needs attention. Reprioritize tasks if needed based on your strategic assessment. Think in terms of days and weeks, not hours." \
  --announce \
  --channel "$CHANNEL" \
  --to "$CHAT_ID"

# ── Devil's Advocate: every 4 hours ───────────────────────────────

echo "  [4/5] The Devil's Advocate (every 4 hours)..."
openclaw cron add \
  --name "quorum-devils-advocate" \
  --cron "0 */4 * * *" \
  --session isolated \
  --message "You are running as The Devil's Advocate from The Quorum. Search memory for recent decisions, plans, and high-priority tasks. Challenge assumptions: what could go wrong? What is being taken for granted? What data is missing? What alternatives were not considered? Store critiques with quorum_store_event using event_type 'critique'. Be constructive -- highlight risks AND suggest mitigations. Focus on high-importance decisions, do not nitpick trivial choices." \
  --announce \
  --channel "$CHANNEL" \
  --to "$CHAT_ID"

# ── Opportunist: every 6 hours ────────────────────────────────────

echo "  [5/5] The Opportunist (every 6 hours)..."
openclaw cron add \
  --name "quorum-opportunist" \
  --cron "0 */6 * * *" \
  --session isolated \
  --message "You are running as The Opportunist from The Quorum. Scan memory for quick wins, reusable work, and hidden value across all projects and tasks. Look for: repeated manual work that could be automated, reusable code or docs, neglected high-impact tasks, cross-project connections, and compound investments that unblock multiple items. Store findings with quorum_store_event using event_type 'opportunity'. Create tasks for actionable opportunities. Focus on high-impact, low-effort items." \
  --announce \
  --channel "$CHANNEL" \
  --to "$CHAT_ID"

echo ""
echo "============================================"
echo "  All 5 Quorum cron jobs created!"
echo "============================================"
echo ""
echo "Schedules:"
echo "  Connector ........... every 15 minutes"
echo "  Executor ............ every hour"
echo "  Strategist .......... daily at 6:00 AM"
echo "  Devil's Advocate .... every 4 hours"
echo "  Opportunist ......... every 6 hours"
echo ""
echo "Run 'openclaw cron list' to verify."
echo "Edit a job: openclaw cron edit <jobId>"
echo "Remove all: $(basename "$0") --remove"
