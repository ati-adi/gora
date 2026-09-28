# Review log: telegram (adversarial reviewer)

Scope: src/telegram/**. Proof tests under test/review/telegram/. Run:
`npx vitest run --config test/review/telegram/vitest.review.config.ts`

## Status
- [x] read outbox, limiter, dispatcher, lanes, inbox, ingress, index, bot, render/*, dmStream, common
- [x] group, guest, notify, bizOwner, topics, files, links, commands, callbackCodec, flags (no further proven defects: files never log URL; codec OK)
- [x] all 13 proof files fail for the stated reason (22 failing tests); tsc clean for test/review/telegram
- DONE: final structured findings returned

## Findings
- F1 (high) group placeholder edit: rich edit 400 -> entities/plain edit carries only the first 4096 chars; rest of the first 30k part dropped. Proof: test/review/telegram/groupEditTruncation.test.ts (fails).
- F2 (high) sendDurable: part 0 sendNow throws on transient 429/5xx -> parts 1..n + keyboard never enqueued; engine logs and marks run done. Proof: finalizePartialSend.test.ts (fails).
- F3 (medium) multi-message outbox row (entities/plain fallback chunks) re-sent from chunk 0 on a transient failure -> duplicates. Proof: outboxChainDuplicate.test.ts (fails).
- F4 (medium) outbox per-chat reorder after 429 retry_after>30: re-queued row gets later not_before; later rows go first. Proof: outboxReorder.test.ts (fails).
- F5 (medium) outbox head-of-line: autoRetry sleeps inside sweep's sequential await; one 429'd chat stalls all chats up to 30 s (5xx: ~21 s). Proof: outboxHeadOfLine.test.ts (fails).
- F6 (medium) dispatcher pump sees only the 500 oldest due rows; a busy serial lane with >=500 backlog starves ctl lane (Stop) and all other users. Proof: dispatcherWindowStarvation.test.ts (fails).
- F7 (CRITICAL) sanitizer bypass: protectInlineCode matches backticks across blank lines; "`\n\n<tg-button>/[link](evil)/🔐 card\n\n`" passes untouched, CommonMark parses the middle as live markup. Proof: sanitizerCodeSpanBypass.test.ts (3 fail).
- F8 (high) numeric char refs bypass 🔐->🔒 and Approve-prefix (&#128272; / &#65;pprove:). Proof: sanitizerEntityRefBypass.test.ts (2 fail).
- F9 (high) reference-definition link bypass (dest on next line / in blockquote / in list item). Proof: sanitizerRefDefinitionBypass.test.ts (3 fail).
- F10 (CRITICAL) allowedHref decodeURIComponent throws URIError on "mailto:a%@b.com" -> sanitizer throws; in dmStream this is inside a timer callback -> uncaught exception -> process exit (no handler in main.ts); finalize rejects -> answer lost. Proof: sanitizerUriErrorCrash.test.ts (3 fail).
- F11 (medium) outbox 403 on a business-connection send (userId=owner, chatId=peer) marks the OWNER bot_blocked -> reminders dropped, briefs dead. Proof: outbox403Business.test.ts (fails).
- F12 (high) split after sanitize cuts inside a multi-line code span (>450 blocks) -> next part carries a live <tg-button>. Proof: splitCodeSpanBypass.test.ts (fails).
- F13 (critical, same class as F7) fence detection ignores list-item containers: "- a\n  ```\n<tg-button>..." -> live button/link. Proof: sanitizerFenceContainerBypass.test.ts (2 fail).

# Fixer log (independent fixer)
- Reproduced: all 13 proof files fail (22 tests) as stated, before any change.
- F7/F13/F9/F8/F10 FIXED in src/telegram/render/sanitize.ts: code (fenced + inline only) and link definitions located by a
  micromark/mdast parse (details/summary tags blanked so their content parses as Markdown); char refs decoded outside code
  (ASCII-punct/space/ctrl/PUA refs kept); Approve rule on visible line start (heading/emphasis/code/link/tag stripped) and
  per table cell; shortcut [label] escaped; decodeURIComponent guarded; a parse-based VERIFY step with strict (no-code)
  re-pass and literal code-block fallback; sanitizer never throws. dmStream push() guards compose().
- F12 FIXED in split.ts: parts of a split message are re-sanitized (resanitizePart, links kept iff live in the whole);
  pieces of one paragraph re-joined with '\n'.
- F3/F4/F5/F11 FIXED in outbox.ts: per-chat FIFO (head-of-chat selection: a sending / due / retried row holds later rows;
  scheduled untried rows do not), one concurrent worker per chat, sendNow respects order (OutboxPendingError when held
  behind a retry), multi-message markdown rows persist sent_message_ids per message and resume (fallback.ts ChainProgress),
  403 marks bot_blocked only in the user's own DM without business connection. outbox.test 'other chats' expectation
  changed to per-chat order (cross-chat interleaving is now concurrent).
- F2 FIXED in common.ts sendDurable: all parts enqueued first; OutboxPendingError → return refs so far (worker delivers
  the rest in order). Also dmStream.finalize: when auto-checkpoints consumed the whole body, the keyboard is sent on a '⤴'
  message (the F2 proof's keyboard assertion exposed this: the proof's 36k text auto-checkpoints).
- F1 FIXED: fallback.ts editMarkdownChainWithRest returns the entity/plain overflow; group.deliver sends it as durable
  outbox rows (run:<id>:<what>-ov:<i>) before the other parts, keyboard on the last message. editMarkdownChain keeps its
  contract (keyboard always on the edited message) for outbox/guest.
- F6 FIXED: inboxRepo.dueInLane / laneHeads (MIN(update_id) per lane); dispatcher pump takes due ctl rows + one head per
  lane; a lease watchdog (leaseMs) releases a lane whose handler hangs (row marked failed 'lease expired').
- Extra regressions: test/unit/telegram/reviewFixes.test.ts (sanitizer parse-level fuzz, ordinary Markdown unchanged,
  details+fence literal, split re-sanitize of a blockquote fence, links kept across split, outbox pending order,
  scheduled row does not hold its chat, own-DM 403, dispatcher lease watchdog). Proofs kept in test/review/telegram.
- sendEffectMessages logs OutboxPendingError as info (row stays queued, delivered in order).
- FINAL: typecheck clean; unit 773/773; e2e 101/101; review/telegram 22/22.
- Cross-area: package.json should declare mdast-util-from-markdown 2.0.3, mdast-util-gfm 3.1.0, micromark-extension-gfm
  3.0.0, decode-named-character-reference 1.3.0 (deps) and @types/mdast 4.0.4 (dev) — today they resolve transitively via
  telegram-md-entities@0.6.0. Optional: src/main.ts uncaughtException handler; outbox (chat_id, status) index.
