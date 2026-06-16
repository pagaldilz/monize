-- 086: Per-user preferences for the AI Agent chatbox (the MCP-powered agent
-- at /ai-mcp, distinct from the read-only /ai AI Assistant).
--
-- `ai_agent_write_mode` controls the MCP scopes the in-process agent session
-- is granted:
--   'readonly' (default): read + reports scopes only. Write tools are neither
--     advertised to the model nor executable. This is the safe default.
--   'edit': additionally grants the 'write' scope so create/update tools run.
--     Still gated by the per-tool write limiter (50/day), dryRun previews,
--     confirmMerge, and action-history undo/redo.
--
-- `ai_agent_confirm_writes` only applies in 'edit' mode. When true (default),
-- each create/update tool call is preceded by a dryRun preview that the user
-- must approve before the change is persisted.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS ai_agent_write_mode VARCHAR(10) NOT NULL DEFAULT 'readonly';

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS ai_agent_confirm_writes BOOLEAN NOT NULL DEFAULT TRUE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'user_preferences_ai_agent_write_mode_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_ai_agent_write_mode_check
      CHECK (ai_agent_write_mode IN ('readonly', 'edit'));
  END IF;
END $$;
