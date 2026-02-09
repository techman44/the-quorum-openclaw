# The Quorum for OpenClaw

An OpenClaw plugin that gives your AI agent long-term memory, self-awareness, and accountability. Five autonomous "conscience agents" run on scheduled intervals, searching your memory system for connections, tracking commitments, challenging decisions, and surfacing opportunities -- then delivering their findings directly to you via Telegram or WhatsApp.

## Prerequisites

- **OpenClaw** -- installed and configured ([openclaw.dev](https://openclaw.dev))
- **PostgreSQL** with the **pgvector** extension -- for persistent memory and vector search
- **Ollama** with the **mxbai-embed-large** model -- for local semantic embeddings

## Installation

```bash
git clone https://github.com/techman44/the-quorum-openclaw.git
cd the-quorum-openclaw
bash scripts/install.sh
```

The install script will:

1. Verify OpenClaw is installed
2. Check for (or start) PostgreSQL with pgvector
3. Run the database schema migrations
4. Check Ollama and pull the mxbai-embed-large model if needed
5. Install the plugin into OpenClaw
6. Configure the plugin with your database credentials
7. Offer to set up the cron jobs for the conscience agents

## How It Works

The Quorum has three layers:

**1. Memory Tools (Plugin)**
The OpenClaw plugin provides tools that any agent session can use:
- `quorum_store` -- Save documents, notes, reflections, and other knowledge
- `quorum_search` -- Semantic search across all stored memory
- `quorum_store_event` -- Record events (decisions, connections, critiques, etc.)
- `quorum_list_tasks` -- View and filter tracked tasks
- `quorum_create_task` -- Create actionable task items

**2. Conscience Agents (Skills + Cron)**
Five agents run on scheduled intervals via OpenClaw cron jobs. Each has a distinct personality and purpose, defined by skill files in the `skills/` directory:

| Agent | Schedule | Purpose |
|---|---|---|
| **The Connector** | Every 15 minutes | Finds non-obvious connections between current activity and forgotten history |
| **The Executor** | Every hour | Tracks commitments, flags overdue tasks, calls out procrastination |
| **The Strategist** | Daily at 6:00 AM | Writes reflections, identifies patterns, reprioritizes work |
| **The Devil's Advocate** | Every 4 hours | Challenges assumptions, critiques decisions, highlights risks |
| **The Opportunist** | Every 6 hours | Scans for quick wins, reusable work, and hidden value |

A sixth agent, **The Data Collector**, is available as a skill for on-demand use when ingesting and organizing information into the memory system.

**3. Delivery (Notifications)**
Each agent run announces its findings via your configured channel (Telegram or WhatsApp), so insights reach you without opening a terminal.

## Configuration

Plugin configuration is managed through OpenClaw. The install script handles this, but you can adjust settings manually:

```bash
openclaw plugins config the-quorum --set db_host=localhost
openclaw plugins config the-quorum --set db_port=5432
openclaw plugins config the-quorum --set db_user=quorum
openclaw plugins config the-quorum --set db_password=YOUR_PASSWORD
openclaw plugins config the-quorum --set db_name=quorum
openclaw plugins config the-quorum --set ollama_host=http://localhost:11434
openclaw plugins config the-quorum --set ollama_embed_model=mxbai-embed-large
openclaw plugins config the-quorum --set embedding_dim=1024
```

## Managing Cron Jobs

Set up all cron jobs interactively:
```bash
bash scripts/setup-cron.sh
```

Set up non-interactively:
```bash
bash scripts/setup-cron.sh --chat-id YOUR_CHAT_ID --channel telegram
```

Remove all Quorum cron jobs:
```bash
bash scripts/setup-cron.sh --remove
```

List active cron jobs:
```bash
openclaw cron list
```

## Project Structure

```
the-quorum-openclaw/
  openclaw.plugin.json   Plugin manifest for OpenClaw
  package.json           Node.js package definition
  tsconfig.json          TypeScript configuration
  src/                   Plugin source code
  schema/                PostgreSQL schema migrations (7 files)
  skills/
    connector/           The Connector skill
    executor/            The Executor skill
    strategist/          The Strategist skill
    devils-advocate/     The Devil's Advocate skill
    opportunist/         The Opportunist skill
    data-collector/      The Data Collector skill
  scripts/
    install.sh           Full installation script
    setup-cron.sh        Cron job setup/removal script
```

## Standalone Version

If you are not using OpenClaw, see [the-quorum](https://github.com/techman44/the-quorum) for the standalone version that runs independently with its own scheduling and CLI.

## License

MIT -- see [LICENSE](LICENSE)

Built by [ITcore.ai](https://itcore.ai)
