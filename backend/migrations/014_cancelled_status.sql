-- Support stopping an in-progress analysis. CANCELLED marks a session the user
-- explicitly stopped; its files/patterns are removed but the session row is kept
-- for history. (Idempotent: the value may already exist from the initial schema.)
ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'CANCELLED';
