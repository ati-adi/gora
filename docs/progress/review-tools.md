# Review: tools (adversarial)

Started 2026-09-28. Scope: src/tools/**, src/capabilities/**, src/integrations/**.

Run proofs: npx vitest run --config test/review/tools/vitest.review.config.ts

## Findings
- F1 MEDIUM gmail.ts:190-203 reconcile: findSent(to[0], subject, afterMs=now-7d) → 'done' for an unsent draft when an older mail had same To+Subject; ignores that the draft still exists. Proof: test/review/tools/gmailReconcile.test.ts (fails: 'done').
- F2 HIGH calendar.ts:43-56 withApi / gmail.ts:23-36 withMail return is_error for every provider error, so executor.ts:412-420 never calls reconcile(); lost-response (timeout after Google acted) → approval 'failed', retry = new pa:<id> idemKey → duplicate event + duplicate invites. Proof: test/review/tools/ambiguousFailure.test.ts (fails: 'failed').
- F3 HIGH web.ts:74-101 Groq client web_fetch: read_public, no URL-provenance/taint check → email-tainted run opens attacker URL with private data (no url_sources equivalent, 01 §11.3.4). Proof: test/review/tools/groqWebFetch.test.ts (a).
- F4 MEDIUM 03 R4 per-run web max uses (FULL 5, GROUP/GUEST 3) not enforced anywhere; web_fetch has no quotaKind → unbounded ~4.5K-token Groq calls per turn. Proof: groqWebFetch.test.ts (b) (8 opened).
- F5 MEDIUM place.ts:30-36 share_place sends exact owner GPS to Photon (01 §12 says rounded; weather rounds). Proof: test/review/tools/placePrivacy.test.ts.
- F6 MEDIUM composio.ts:72-78 completeConnection trusts connected_account_id from the redirect query; no user_id/toolkit binding check (service.ts:87 never passes userId). Proof: test/review/tools/composioBinding.test.ts.
- F7 LOW makeFile.ts:26-30 safeFilename keeps U+202E/U+2066.. bidi + zero-width chars (extension spoofing 'invoice<RLO>gpj.csv' → shows 'invoicevsc.jpg'); '..' → '...csv'. Proof: test/review/tools/makeFileName.test.ts.
- F8 MEDIUM media.ts:160-163 Groq: txt/md/csv/json ≤200KB inlined whole (no summarizeLong); groq-free maxPromptTokens 5,200 → run-start row can't be trimmed → prompt_budget failure for ~20KB CSV (02 §C says summarize). Proof: test/review/tools/groqTextDoc.test.ts.
- F9 MEDIUM calendar.ts:273-277 + calMemo.ts: update classify/prev from a never-expiring in-process memo; event that gained guests after listing → write_self auto-run, no card. clearEventMemo never called (revoke/delete). Proof: test/review/tools/calMemoStale.test.ts.
- F10 MEDIUM media.ts:189-190 (and :171-172 image docs) Anthropic PDFs ingested untrusted:false → no 'file' taint (txt/csv and Groq PDFs are tainted); injected PDF leaves run untainted (S14 off, S15 grants apply). Proof: test/review/tools/pdfTaint.test.ts.
- F11 LOW media.ts:124-126 + surfaces/dm.ts:121: no album (media_group_id) handling; each photo of an N-photo album is a separate interactive qwen vision call (02 §C: up to 3 images per album) → N×~1.8K est tokens, no fallback model. Code trace only (grep media_group_id: no hits in src).

## Status
Done. 11 findings, 9 proof files (11 failing tests) under test/review/tools/. SafeFetch probed (decimal/octal/hex/IPv4-mapped/NAT64/redirect/stalled body): conforms to 01 §11.5; no finding. No production code changed.

## Fixer (independent) — started 2026-09-28
- F5 FIXED place.ts: owner location rounded with round1() before searchPlace (proof placePrivacy.test.ts).
- F7 FIXED makeFile.ts safeFilename: strips \p{Cc}\p{Cf}\p{Zl}\p{Zp}, leading dots, trailing dots/spaces; empty stem -> 'file' (proof makeFileName.test.ts).
- F10 FIXED media.ts: Anthropic PDF document ingest now untrusted:true (taint 'file'), consistent with txt/csv and Groq PDFs. Image documents left trusted (same as photos; spec treats photos as owner input).
- F8 FIXED media.ts: on Groq, decoded txt/md/csv/json go through summarizeLong() (chunked fast summaries past docBudgetChars); summarizer failure -> busy/failed rejection. Also text files now keep the owner's caption (withCaption), previously dropped.
- F3 FIXED web.ts: web_fetch in a tainted run (ctx.taint non-empty) opens only a URL that appeared verbatim (canonicalized) in user-row text blocks or in web_search/web_fetch tool_result blocks (or Anthropic *_tool_result) of the epoch — url_sources mirror; other client tool results excluded. Error URL_NOT_FROM_USER_OR_SEARCH. Untainted runs unchanged. Proof groqWebFetch (a) now persists round taint like engine.afterRound; added (c) positive/negative provenance, (d) untainted.
- F4 FIXED web.ts: claimWebUse() per run and tool: max(in-process counter, started tool_calls rows) vs CLIENT_WEB_MAX_USES (03 R4: FULL 5, GROUP/GUEST 3, BIZ 0), toolset from the conversation row; MAX_USES is_error past the cap. web_fetch classify now has quotaKind 'web_search'. Proof (b) + new (e) search cap across rounds.
- F2 FIXED common.ts OutcomeUnknownError + isAmbiguousProviderError (HTTP 5xx/408, timeout/network/parse = ambiguous; 4xx, not found, not supported, Composio successful:false = definite). calendar_create_event: ambiguous create error -> findByIdem inline; found => success, else throw OutcomeUnknownError. gmail_send_draft: ambiguous sendDraft error -> throw OutcomeUnknownError. withApi/withMail rethrow OutcomeUnknownError so executor.executeApproved runs reconcile(). Proof ambiguousFailure.test.ts passes (status executed, one event).
- F1 FIXED gmail.ts reconcile: draft still exists -> 'not_done'; draft gone -> findSent(to, subject, afterMs = rememberSend 'at' - 2 min) -> 'done', else 'unknown' (no note -> 'unknown'). rememberSend stores at = max(ctx.now, clock.now). Proof gmailReconcile.test.ts.
- F9 FIXED calMemo.ts: entries carry seenAt; knownEvent(userId,id,now) honours MEMO_TTL_MS = 5 min (stale -> undefined -> send_external). findEvent always re-fetches (memo start only narrows the window). calendar_update_event.execute refuses (NEEDS_APPROVAL) a non-approval run when classify saw a self-only event but the fresh one has attendees / other organizer; prev/undo restore come from the fresh event. clearEventMemo called on gcal revoke and in the integrations privacy hook onDeleteUser. Proof calMemoStale.test.ts (fixed missing await on clock.advance) + 2 new tests.
- F6 FIXED composio.ts completeConnection(query, expect {userId, kind}): refuses without expect, requires acc.user_id === userId (missing user_id refused) and toolkit.slug (when present) === COMPOSIO_TOOLKIT[kind]. service.ts passes {st.user_id, st.integration} through a locally widened provider type (contract change listed cross-area). fake.ts accepts/ignores the 2nd arg. Proof composioBinding.test.ts + positive/negative matrix.
- F11 FIXED (partial, in-area) media.ts: per (user, media_group_id) synchronous claim; on Groq only the first ALBUM_MAX_DESCRIBED=3 photos/image-docs of an album are downloaded + described, the rest become "[image: photo N of an album, not described …]". True coalescing into one 3-image vision call needs surfaces/dm.ts buffering -> cross-area. Test test/review/tools/album.test.ts.

### Fixer verification (2026-09-28)
- tsc -p tsconfig.json: clean in area files.
- npm test: 757/761; the 4 failures are outside this area (foundation/config PUBLIC_URL checks, importRules violations in src/http/routes/ledger.ts) from concurrent fixers.
- review proofs: npx vitest run --config test/review/tools/vitest.review.config.ts -> 18/18 (10 files incl. new album.test.ts).
- npm run test:e2e: 100/101; the failure (memory.e2e incognito extract) is agent/memory-area work in progress (engine.ts edited 23:25), untouched by this area.
- trust review proofs touching calendar/gmail tools: 8/8.
Cross-area: contracts completeConnection `expect` param; executor runAllowed reconcile-on-throw; dm.ts album coalescing; web_search/file quota consumption.
