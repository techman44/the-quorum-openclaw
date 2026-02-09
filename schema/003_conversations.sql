-- Conversations and their individual turns.
-- Tracks multi-turn interactions between users and agents.

CREATE TABLE IF NOT EXISTS conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT,
    source          TEXT,                       -- originating system or agent
    participant_ids TEXT[] DEFAULT '{}',         -- who was involved
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_source     ON conversations (source);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations (created_at);

-- Auto-update updated_at on row modification.
CREATE OR REPLACE FUNCTION update_conversations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    EXECUTE FUNCTION update_conversations_updated_at();


-- Individual turns within a conversation.
CREATE TABLE IF NOT EXISTS conversation_turns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    turn_index      INT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content         TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (conversation_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_conversation_id ON conversation_turns (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_created_at      ON conversation_turns (created_at);
