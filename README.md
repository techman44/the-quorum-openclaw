# The Quorum for OpenClaw

An OpenClaw plugin that gives your AI agent long-term memory, self-awareness, and accountability. Five autonomous "conscience agents" run on scheduled intervals, searching your memory system for connections, tracking commitments, challenging decisions, and surfacing opportunities -- then delivering their findings directly to you via Telegram or WhatsApp.

## Prerequisites

- **OpenClaw** -- installed and configured ([openclaw.dev](https://openclaw.dev))
- **Docker** -- for running PostgreSQL + Ollama containers (Will be checked and installed during the install script)
- **Node.js** and **npm** -- for building the TypeScript plugin

PostgreSQL, pgvector, Ollama, and the embedding model are all handled automatically via Docker -- you don't need to install them separately.

## GPU Acceleration (Recommended)

Ollama uses the `mxbai-embed-large` model to generate vector embeddings for semantic search. This works on **both CPU and GPU** -- GPU isn't required to run The Quorum.

- **CPU**: Works out of the box, no extra setup. Embedding requests take ~500ms+ each. Fine for small document sets or occasional use.
- **GPU (NVIDIA)**: Recommended for bulk ingestion. Embedding requests drop to ~60-90ms each. When processing hundreds of document chunks, the difference is significant.

The install script and Docker setup work on **any Linux distribution** -- Debian, Ubuntu, CentOS, Rocky, Fedora, etc. The host OS does not matter as long as Docker is available.

### Enabling GPU Support

If you have an NVIDIA GPU available, Ollama will detect and use it automatically as long as:

1. **NVIDIA drivers** are installed on the host
2. **[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)** is installed so Docker can access the GPU

Once both are in place, uncomment the GPU section in `docker-compose.yml`:

```yaml
services:
  ollama:
    # ...
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

Restart the containers and verify with:

```bash
docker compose up -d
docker exec quorum-ollama nvidia-smi
```

## Installation

```bash
git clone https://github.com/techman44/the-quorum-openclaw.git
cd the-quorum-openclaw
bash scripts/install.sh
```

The install script will:

1. Verify prerequisites (OpenClaw, Node.js, npm, Docker)
2. Create `.env` from `.env.example` with default config
3. Install npm dependencies and compile TypeScript
4. Start PostgreSQL + pgvector and Ollama via Docker Compose
5. Wait for services to be ready
6. Pull the `mxbai-embed-large` embedding model (~670MB on first run)
7. Run database schema migrations
8. Install and configure the plugin in OpenClaw
9. Run a quick onboarding questionnaire to seed the agents with your context
10. Offer to set up cron jobs for the conscience agents
11. Run a final health check to verify everything works

To manage the Docker services after installation:

```bash
cd the-quorum-openclaw
docker compose ps       # check service status
docker compose logs -f  # view logs
docker compose down     # stop services
docker compose up -d    # start services
```

## How It Works

The Quorum has three layers:

**1. Memory Tools (Plugin)**
The OpenClaw plugin provides eight tools that any agent session can use:
- `quorum_store` -- Save documents, notes, reflections, and other knowledge
- `quorum_search` -- Semantic search across all stored memory
- `quorum_store_event` -- Record events (decisions, insights, critiques, opportunities, etc.)
- `quorum_list_tasks` -- View and filter tracked tasks
- `quorum_create_task` -- Create or update actionable task items
- `quorum_embed` -- Manually trigger embedding generation for a document
- `quorum_integration_status` -- Check health of PostgreSQL, Ollama, and pgvector
- `quorum_scan_inbox` -- Scan the inbox directory for new files, ingest and index them

**2. Conscience Agents (Skills + Cron)**
Five agents run on scheduled intervals via OpenClaw cron jobs. Each has a distinct personality and purpose, defined by skill files in the `skills/` directory:

| Agent | Schedule | Purpose |
|---|---|---|
| **The Connector** | Every 15 minutes | Finds non-obvious connections between current activity and forgotten history |
| **The Executor** | Every hour | Tracks commitments, flags overdue tasks, calls out procrastination |
| **The Strategist** | Daily at 6:00 AM | Writes reflections, identifies patterns, reprioritizes work |
| **The Devil's Advocate** | Every 4 hours | Challenges assumptions, critiques decisions, highlights risks |
| **The Opportunist** | Every 6 hours | Scans for quick wins, reusable work, and hidden value |
| **The Data Collector** | Every 30 minutes | Scans the inbox directory for new files, ingests and indexes them automatically |

**Onboarding**
During installation, a quick CLI questionnaire captures your basics -- name, role, projects, priorities, and how you want the agents to behave. This gets written to `data/inbox/` where the Data Collector ingests it into the memory system automatically. For a deeper interactive onboarding, you can run the `quorum-onboarding` skill through OpenClaw chat at any time.

**3. Delivery (Notifications)**
Each agent run announces its findings via your configured channel (Telegram or WhatsApp), so insights reach you without opening a terminal.

## Configuration

Plugin configuration is managed through the OpenClaw config system. The install script handles this automatically, but you can adjust settings manually:

```bash
# View current plugin config
openclaw config get plugins.entries.the-quorum.config

# Set all config at once (JSON)
openclaw config set plugins.entries.the-quorum.config '{"db_host":"localhost","db_port":5432,"db_user":"quorum","db_password":"YOUR_PASSWORD","db_name":"quorum","ollama_host":"http://localhost:11434","ollama_embed_model":"mxbai-embed-large","embedding_dim":1024}'

# After changing config, restart the gateway
systemctl --user restart openclaw-gateway.service
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

## Inbox Directory

The Data Collector agent automatically monitors a local inbox directory for new files. Any file placed in the inbox is ingested into the Quorum memory system, categorized by file type, tagged, embedded for semantic search, and then moved to a processed directory.

**Default paths** (relative to the plugin directory):
- Inbox: `data/inbox/`
- Processed: `data/processed/`

**How to use it:**
1. Drop any file into `data/inbox/`.
2. The Data Collector cron job runs every 30 minutes and processes all files found.
3. Each file is stored as a document with its type inferred from the extension (`.eml` -> email, `.html` -> web, `.md`/`.txt` -> note, `.json`/`.csv` -> record, others -> file).
4. After ingestion, the file is moved to `data/processed/` with a timestamp prefix.

You can also trigger a manual scan at any time using the `quorum_scan_inbox` tool, which supports a `dry_run` mode to preview files without ingesting them.

To customize the inbox and processed directory paths:
```bash
openclaw plugins config the-quorum --set inbox_dir=/path/to/custom/inbox
openclaw plugins config the-quorum --set processed_dir=/path/to/custom/processed
```

## Example: Gmail to Inbox via n8n

You can use [n8n](https://n8n.io) to automatically feed emails into The Quorum without giving the system direct access to your Gmail account. The idea is simple: you label emails in Gmail, n8n watches for that label, and drops the content into `data/inbox/` where the Data Collector picks it up on its next run.

**Setup:**

1. **Create a Gmail label** called "Quorum" (or whatever name you prefer). Any email you tag with this label will be ingested into the memory system.

2. **Create an n8n workflow** with the following node structure:

```
Gmail Trigger (label: "Quorum")
  -> Extract body + attachments
  -> Write to File (path: data/inbox/)
```

   - **Gmail Trigger node**: Configure it to watch for new emails with the "Quorum" label. n8n handles the OAuth connection to Gmail entirely on its own.
   - **Process the email**: Extract the email body (plain text or HTML) and any attachments.
   - **Write the email body to file**: Save it as a `.txt` or `.eml` file in `data/inbox/` with a descriptive filename like `sender_subject_2026-02-09.txt`.
   - **Write attachments to file**: Save each attachment to `data/inbox/` using its original filename.

3. **The Data Collector cron job** (running every 30 minutes) picks up all new files from `data/inbox/`, categorizes them by file type, generates embeddings for semantic search, and moves them to `data/processed/`.

**Why this approach works well:**

- **Gmail credentials stay in n8n**, not in The Quorum. The Quorum never touches your email account.
- **You control exactly what enters the system** by choosing which emails to label. There is no background scanning of your inbox.
- **Security-conscious by design.** The separation means a compromise of The Quorum does not expose your Gmail credentials, and vice versa.

**This pattern works for any data source n8n supports.** The inbox directory is the universal entry point for external data. The same workflow structure applies to:

- **Slack messages** -- trigger on a specific channel or reaction, write message content to `data/inbox/`
- **Calendar events** -- trigger on new events, save event details as text files
- **RSS feeds** -- trigger on new items, save articles to `data/inbox/`
- **Webhooks** -- receive data from any service and write it to `data/inbox/`
- **Notion, Airtable, Google Sheets** -- trigger on changes, export rows or pages as files

Anything n8n can connect to becomes a data source for The Quorum, all flowing through the same `data/inbox/` directory that the Data Collector already monitors.

## Project Structure

```
the-quorum-openclaw/
  docker-compose.yml     PostgreSQL + Ollama containers
  openclaw.plugin.json   Plugin manifest for OpenClaw
  package.json           Node.js package definition
  tsconfig.json          TypeScript configuration
  .env.example           Environment configuration template
  src/                   Plugin source code (TypeScript)
  schema/                PostgreSQL schema migrations (7 files)
  skills/
    onboarding/          One-time setup questionnaire (self-removes after completion)
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
