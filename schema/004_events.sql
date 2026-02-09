-- Events: discrete observations produced by agents.
-- Covers decisions, insights, critiques, opportunities, and more.

CREATE TABLE IF NOT EXISTS quorum_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quorum_events_event_type  ON quorum_events (event_type);
CREATE INDEX IF NOT EXISTS idx_quorum_events_created_at  ON quorum_events (created_at DESC);
