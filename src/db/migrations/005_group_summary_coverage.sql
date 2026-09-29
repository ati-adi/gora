-- 005 (s07 integration gate; red team "the rolling group summary outlives the 14-day message retention", spec 07 C3).
-- covered_from_at: the time of the oldest group message folded into the rolling summary. The groups retention sweep
-- drops the summary text once its coverage starts outside the retention window (the next batch starts a fresh one), so
-- no summarised content is older than the messages it came from may be. NULL on existing rows = unknown → dropped at
-- the next sweep. Never edit 004 (it may already be applied); fix forward.
ALTER TABLE group_summaries ADD COLUMN covered_from_at INTEGER;
