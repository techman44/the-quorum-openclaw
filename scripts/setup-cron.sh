#!/usr/bin/env bash
set -euo pipefail

QUORUM_PREFIX="quorum-"

# ── Helpers ─────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Set up (or remove) The Quorum cron jobs for OpenClaw.

Options:
  --remove         Remove all existing Quorum cron jobs and exit
  --channel CH     Override notification channel (default: OpenClaw session)
  --to DEST        Override delivery destination (Telegram chatId, etc.)
  -h, --help       Show this help message

Examples:
  $(basename "$0")                                          # Default setup (OpenClaw chat)
  $(basename "$0") --channel telegram --to 123456789        # Deliver via Telegram
  $(basename "$0") --remove                                 # Remove all Quorum cron jobs
EOF
  exit 0
}

remove_quorum_jobs() {
  echo "Removing existing Quorum cron jobs..."
  local found=0

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

CHANNEL=""
TO_DEST=""
REMOVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove)
      REMOVE=true
      shift
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    --to)
      TO_DEST="$2"
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

# ── Ensure DBUS session bus is available ───────────────────────────
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus"
fi

# ── Handle --remove ─────────────────────────────────────────────────

if [[ "$REMOVE" == true ]]; then
  remove_quorum_jobs
  echo ""
  echo "Done. Run 'openclaw cron list' to verify."
  exit 0
fi

# ── Build delivery flags ────────────────────────────────────────────

# By default, agents announce through the OpenClaw session (--channel last).
# Override with --channel and --to for external delivery (Telegram, WhatsApp, etc.)
DELIVERY_FLAGS="--announce"
if [[ -n "$CHANNEL" ]]; then
  DELIVERY_FLAGS="$DELIVERY_FLAGS --channel $CHANNEL"
fi
if [[ -n "$TO_DEST" ]]; then
  DELIVERY_FLAGS="$DELIVERY_FLAGS --to $TO_DEST"
fi

# ── Setup ───────────────────────────────────────────────────────────

echo "============================================"
echo "  The Quorum - OpenClaw Cron Setup"
echo "============================================"
echo ""

if [[ -n "$CHANNEL" ]] && [[ -n "$TO_DEST" ]]; then
  echo "Delivery: $CHANNEL -> $TO_DEST"
else
  echo "Delivery: OpenClaw session (default)"
fi
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

echo "  [1/6] The Connector (every 15 minutes)..."
openclaw cron add \
  --name "quorum-connector" \
  --cron "*/15 * * * *" \
  --session isolated \
  --message "You are running as The Connector from The Quorum. Search recent conversation history and memory for meaningful connections between current activity and past knowledge. Use the quorum_search tool to find related past documents, events, and conversations. Focus on non-obvious connections the user has forgotten or wouldn't think to link. Before your own analysis, check for events where metadata.considered_agents contains 'connector' -- these are findings other agents flagged for you. If you find important connections, store them with quorum_store_event using event_type 'insight'. Include a considered_agents list in the metadata tagging which other agents should see your finding. Summarize what you found." \
  $DELIVERY_FLAGS

# ── Executor: every hour ───────────────────────────────────────────

echo "  [2/6] The Executor (every hour)..."
openclaw cron add \
  --name "quorum-executor" \
  --cron "0 * * * *" \
  --session isolated \
  --message "You are running as The Executor from The Quorum. Review recent conversations and events for actionable items. Check existing tasks with quorum_list_tasks -- flag anything overdue or stale. Create new tasks from recent discussions using quorum_create_task. Before your own analysis, check for events where metadata.considered_agents contains 'executor' -- these are findings other agents flagged for you. If the user hasn't acted on something important, call it out directly. Be specific about what was committed to and when. Do not sugarcoat procrastination. Store observations with quorum_store_event using event_type 'observation'. Include a considered_agents list in the metadata." \
  $DELIVERY_FLAGS

# ── Strategist: daily at 6am ──────────────────────────────────────

echo "  [3/6] The Strategist (daily at 6:00 AM)..."
openclaw cron add \
  --name "quorum-strategist" \
  --cron "0 6 * * *" \
  --session isolated \
  --message "You are running as The Strategist from The Quorum. Perform a daily reflection. Search memory for the last 24 hours of events, tasks, and conversations. Before your own analysis, check for events where metadata.considered_agents contains 'strategist' -- these are findings other agents flagged for you. Identify patterns, recurring themes, blocked work, and strategic opportunities. Write a structured reflection document using quorum_store with doc_type 'reflection'. Assess what is working, what is stuck, and what needs attention. Reprioritize tasks if needed. Store key insights with quorum_store_event using event_type 'insight'. Include a considered_agents list tagging all relevant agents." \
  $DELIVERY_FLAGS

# ── Devil's Advocate: every 4 hours ───────────────────────────────

echo "  [4/6] The Devil's Advocate (every 4 hours)..."
openclaw cron add \
  --name "quorum-devils-advocate" \
  --cron "0 */4 * * *" \
  --session isolated \
  --message "You are running as The Devil's Advocate from The Quorum. Search memory for recent decisions, plans, and high-priority tasks. Before your own analysis, check for events where metadata.considered_agents contains 'devils_advocate' -- these are findings other agents flagged for you. Challenge assumptions: what could go wrong? What is being taken for granted? What data is missing? What alternatives were not considered? Store critiques with quorum_store_event using event_type 'critique'. Be constructive -- highlight risks AND suggest mitigations. Include a considered_agents list in the metadata. Focus on high-importance decisions, do not nitpick trivial choices." \
  $DELIVERY_FLAGS

# ── Opportunist: every 6 hours ────────────────────────────────────

echo "  [5/6] The Opportunist (every 6 hours)..."
openclaw cron add \
  --name "quorum-opportunist" \
  --cron "0 */6 * * *" \
  --session isolated \
  --message "You are running as The Opportunist from The Quorum. Scan memory for quick wins, reusable work, and hidden value across all projects and tasks. Before your own analysis, check for events where metadata.considered_agents contains 'opportunist' -- these are findings other agents flagged for you. Look for: repeated manual work that could be automated, reusable code or docs, neglected high-impact tasks, cross-project connections, and compound investments that unblock multiple items. Store findings with quorum_store_event using event_type 'opportunity'. Create tasks for actionable opportunities using quorum_create_task. Include a considered_agents list in the metadata. Focus on high-impact, low-effort items." \
  $DELIVERY_FLAGS

# ── Data Collector: every 30 minutes ─────────────────────────────

echo "  [6/6] The Data Collector (every 30 minutes)..."
openclaw cron add \
  --name "quorum-data-collector" \
  --cron "*/30 * * * *" \
  --session isolated \
  --message "Use quorum_scan_inbox to check for new files in the inbox directory. For each file found, it will be automatically ingested, categorized, tagged, and embedded. Report what was processed." \
  $DELIVERY_FLAGS

echo ""
echo "============================================"
echo "  All 6 Quorum cron jobs created!"
echo "============================================"
echo ""
echo "Schedules:"
echo "  Connector ........... every 15 minutes"
echo "  Executor ............ every hour"
echo "  Strategist .......... daily at 6:00 AM"
echo "  Devil's Advocate .... every 4 hours"
echo "  Opportunist ......... every 6 hours"
echo "  Data Collector ...... every 30 minutes"
echo ""
echo "Delivery: ${CHANNEL:-OpenClaw session (default)}"
echo ""
echo "Run 'openclaw cron list' to verify."
echo "Edit a job: openclaw cron edit <jobId>"
echo "Remove all: $(basename "$0") --remove"
