-- Tasks: actionable items extracted or created by agents.
-- Tracks status, priority, ownership, deadlines, and provenance.

CREATE TABLE IF NOT EXISTS quorum_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open',
    priority        TEXT NOT NULL DEFAULT 'medium',
    owner           TEXT,
    due_at          TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quorum_tasks_status   ON quorum_tasks (status);
CREATE INDEX IF NOT EXISTS idx_quorum_tasks_priority ON quorum_tasks (priority);
CREATE INDEX IF NOT EXISTS idx_quorum_tasks_owner    ON quorum_tasks (owner);

-- Auto-update updated_at on row modification.
CREATE OR REPLACE FUNCTION update_quorum_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quorum_tasks_updated_at ON quorum_tasks;
CREATE TRIGGER trg_quorum_tasks_updated_at
    BEFORE UPDATE ON quorum_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_quorum_tasks_updated_at();
