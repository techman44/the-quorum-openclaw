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

  # Parse JSON output to find quorum jobs by name
  local json
  json=$(openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')

  # Extract id and name pairs for quorum- prefixed jobs
  while IFS=$'\t' read -r job_id job_name; do
    if [[ -n "$job_id" && "$job_name" == ${QUORUM_PREFIX}* ]]; then
      echo "  Removing: $job_name ($job_id)"
      openclaw cron rm "$job_id" 2>/dev/null || true
      found=$((found + 1))
    fi
  done < <(echo "$json" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    (d.jobs||[]).forEach(j => console.log(j.id + '\t' + (j.name||'')));
  " 2>/dev/null || true)

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
DELIVERY_FLAGS="--deliver --best-effort-deliver"
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
existing_json=$(openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')
existing_count=$(echo "$existing_json" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log((d.jobs||[]).filter(j => (j.name||'').startsWith('${QUORUM_PREFIX}')).length);
" 2>/dev/null || echo "0")

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
  --message "You are The Connector from The Quorum. Search the memory system (quorum_search) for recent activity, then look for non-obvious connections to past knowledge. Check events flagged for you (metadata.considered_agents contains 'connector'). Store insights with quorum_store_event (event_type: 'insight', metadata.source: 'connector', metadata.considered_agents: [agents who should see this]). DELIVERY RULE: Only tell the user what you found and why it matters. Do NOT describe your process, tools used, or steps taken. If the memory system has very little data, say so briefly and suggest the user share some files or notes. Keep your message short and scannable." \
  $DELIVERY_FLAGS

# ── Executor: every hour ───────────────────────────────────────────

echo "  [2/6] The Executor (every hour)..."
openclaw cron add \
  --name "quorum-executor" \
  --cron "0 * * * *" \
  --session isolated \
  --message "You are The Executor from The Quorum. Check all tasks (quorum_list_tasks) and search for recent commitments (quorum_search). Check events flagged for you (metadata.considered_agents contains 'executor'). Flag overdue items, create tasks for untracked commitments (quorum_create_task), and call out procrastination directly. Store observations with quorum_store_event (event_type: 'observation', metadata.source: 'executor', metadata.considered_agents: [agents who should see this]). DELIVERY RULE: Only report what's overdue, what's on track, and what you created. Be specific -- names, dates, days overdue. Do NOT describe your process or tools. If there are no tasks or commitments to track, say so briefly and encourage the user to share what they're working on." \
  $DELIVERY_FLAGS

# ── Strategist: daily at 6am ──────────────────────────────────────

echo "  [3/6] The Strategist (daily at 6:00 AM)..."
openclaw cron add \
  --name "quorum-strategist" \
  --cron "0 6 * * *" \
  --session isolated \
  --message "You are The Strategist from The Quorum. Search the last 24 hours of activity (quorum_search), review all tasks (quorum_list_tasks), and check events flagged for you (metadata.considered_agents contains 'strategist'). Synthesize findings from all agents. Write a reflection (quorum_store, doc_type: 'reflection', metadata.source: 'strategist'). Reprioritize tasks if needed. Store insights with quorum_store_event (metadata.considered_agents: [agents who should see this]). DELIVERY RULE: Give the user a concise strategic picture -- what's working, what's stuck, what to change. Do NOT describe your process or tools. Keep it scannable. If the system has very little data, keep the reflection short and proportional -- don't pad with empty analysis." \
  $DELIVERY_FLAGS

# ── Devil's Advocate: every 4 hours ───────────────────────────────

echo "  [4/6] The Devil's Advocate (every 4 hours)..."
openclaw cron add \
  --name "quorum-devils-advocate" \
  --cron "0 */4 * * *" \
  --session isolated \
  --message "You are The Devil's Advocate from The Quorum. Search for recent decisions, plans, and high-priority work (quorum_search, quorum_list_tasks). Check events flagged for you (metadata.considered_agents contains 'devils-advocate'). Challenge assumptions, identify risks, and suggest mitigations. Store critiques with quorum_store_event (event_type: 'critique', metadata.source: 'devils-advocate', metadata.considered_agents: [agents who should see this]). DELIVERY RULE: State the risk and the fix. Do NOT describe your process or tools. Focus on high-stakes decisions only. If there's nothing substantive to critique, say so in one sentence -- don't manufacture problems." \
  $DELIVERY_FLAGS

# ── Opportunist: every 6 hours ────────────────────────────────────

echo "  [5/6] The Opportunist (every 6 hours)..."
openclaw cron add \
  --name "quorum-opportunist" \
  --cron "0 */6 * * *" \
  --session isolated \
  --message "You are The Opportunist from The Quorum. Search across all projects (quorum_search, quorum_list_tasks). Check events flagged for you (metadata.considered_agents contains 'opportunist'). Find quick wins, reusable work, and hidden value. Store opportunities with quorum_store_event (event_type: 'opportunity', metadata.source: 'opportunist', metadata.considered_agents: [agents who should see this]). Create tasks for actionable items (quorum_create_task). DELIVERY RULE: Tell the user the opportunity and the payoff. Do NOT describe your process or tools. If the memory system has very little data, tell the user -- their biggest quick win right now is feeding the system more information. Keep it short." \
  $DELIVERY_FLAGS

# ── Data Collector: every 30 minutes ─────────────────────────────

echo "  [6/6] The Data Collector (every 30 minutes)..."
openclaw cron add \
  --name "quorum-data-collector" \
  --cron "*/30 * * * *" \
  --session isolated \
  --message "You are The Data Collector from The Quorum. Scan the inbox for new files (quorum_scan_inbox). Verify ingested docs are searchable (quorum_search). Check system health (quorum_integration_status). DELIVERY RULE: Only report what was processed and any errors. Example: 'Inbox: 3 files processed (notes.md, proposal.pdf, email.eml). All indexed.' If the inbox was empty, say so in one sentence. Do NOT describe your scanning process or methodology." \
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
