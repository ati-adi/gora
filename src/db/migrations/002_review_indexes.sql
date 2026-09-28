-- 002 (post-review, performance only; everything works without these indexes).
-- The outbox pump runs per-chat NOT EXISTS checks over queued/sending rows of the same chat.
CREATE INDEX IF NOT EXISTS outbox_chat ON outbox(chat_id, status);
-- engine.stopByDraft finds a queued / retry_wait run by the draft it still shows (RunsRepo.byDraft).
CREATE INDEX IF NOT EXISTS runs_draft ON runs(draft_id) WHERE draft_id IS NOT NULL;
