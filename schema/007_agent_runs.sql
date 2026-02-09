-- Agent runs: audit log of every agent execution.
-- Used to track scheduling, detect failures, and measure agent activity.

CREATE TABLE IF NOT EXISTS quorum_agent_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name      TEXT NOT NULL,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
                        'running', 'completed', 'failed'
                    )),
    summary         TEXT DEFAULT '',
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quorum_agent_runs_agent_name  ON quorum_agent_runs (agent_name);
CREATE INDEX IF NOT EXISTS idx_quorum_agent_runs_status      ON quorum_agent_runs (status);
CREATE INDEX IF NOT EXISTS idx_quorum_agent_runs_started_at  ON quorum_agent_runs (started_at);
