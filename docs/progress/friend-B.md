# friend-B (behaviour model + learned proactive policy) progress log

## Step 0: started 2026-09-29
- Read spec 05, plan 06 §0-§2, §5.

## Step 1: code reading DONE
- Read contracts (behaviour, services, memory ProfileService, scheduler, telegram outbox/links, storage), kernel/random, migration 003,
  proactive/* (nudges, brief, signals scan, gate), foundation call sites (dm.ts inbound, handlers.ts reaction, outbox 403), harness fakes.
- No existing fixed-cadence re-engagement path exists (the 'checkin' NudgeKind is never produced by the scan); the policy is the only one.

## Step 2: design (decided)
- One Thompson decision per user per local day, at a slot sampled from the day's eligible top-30% hours (weighted by the rhythm
  rate) — prevents the "many draws per day" inflation of a 30-min tick. Delivery = sub-job proactive_tick `pt:<userId>` at
  slot + 20 min ± 20 min (s.random), which re-checks, composes (main), judges (fast), sends.
- Rhythm: Gamma-Poisson per hour-of-week bin: λ_b = (hist_b + 5·p0_b)/(W_eff + 5/R0), circular ±1 h kernel, P = 1−e^(−λ).
  Top set = top 30% of 168 bins AND λ ≥ weekly mean (so prior-only hours of a user with a clear peak are not "learned").
- Bandit: proactive_arms stores the user's EVIDENCE (alpha = rewards, beta = misses/penalties); prior at decision time =
  conservative base mean per arm (strength 5) updated by the other users' pooled evidence, strength capped at 10.
- unanswered = counted gora_sent (proactive|nudge|checkin) since the last inbound/reply signal (derived, no counter column).
- 24 h cap = any gora_sent with source proactive|nudge|brief|checkin in the last 24 h.
- proactive_log.judge_reason_enc = sealed JSON {reason, text} (the judge needs the last 5 proactive texts).

## Step 3: implementation (first pass) DONE
- src/behaviour/{repo,features,rhythm,style,bandit,compose,signals,policy,context,index}.ts written; typecheck clean on my files.
- src/proactive: nudges.ts (no "Why now" line; goraSent('nudge'); UNREQUESTED_KINDS date_from_memory/checkin ask
  proactivePolicy.canSendNow, drop reason 'proactive_cap'; brief preview exempt), brief.ts (goraSent('brief') on the
  scheduled brief), signals.ts (dates gate via memoryEnabled), nudgeGate.ts (DropReason 'proactive_cap').
- Next: run unit + e2e, then write tests.

## Step 4: e2e friend-proactive (6 tests) green in ~5 s
- test/harness/friend-B.ts stops the dispatcher/scheduler/outbox loops (t.advance ticks + settles explicitly): 1 simulated
  day ≈ 0.13 s instead of 6 s.
- Fix: the jittered send time is clamped out of quiet hours (a 21:30 slot + 40 min would land in 22:00 quiet and be dropped).
- nudges render: the "Why now:" label is gone but the details line stays (it is the substance for watcher/mail/commitment
  nudges; tests of missions/watchers expect it). Updated test/e2e/nudges.e2e.test.ts accordingly.
- Next: unit tests test/unit/behaviour/*.

## Step 5: unit tests DONE
- test/unit/behaviour/models.test.ts (14: features, rhythm peaks/prior/decay, style, bandit incl. convergence + seeds)
- test/unit/behaviour/policy.test.ts (16: signals features-only, rewards, reactions, stop, blocked, cap sharing, eligibility,
  hard stop, τ scaling, seeded decide(), content availability, compose/judge/send, style line, privacy)
- test/unit/proactive/friendCap.test.ts (3: nudges/brief count toward the cap; unrequested kinds gated; no "Why now:")
- style: emoji 'lots' only from 1.5 emoji/message.

## Step 6: hardening + FINAL (2026-09-29)
- Eligibility also requires an open DM (dmChatId) — group/guest-only users are never written to first.
- The send job re-checks after the two LLM calls (owner wrote / blocked / off / capped meanwhile → nothing sent).
- npm run typecheck clean; npm test 1056/1056; npm run test:e2e:strict 117/117; no Math.random in src/.

## CROSS-SET REQUESTS (also in the final report)
- P: why.ts routes 'pl_' ids to s.proactivePolicy.explain; settings_update {proactive} → s.signals.feedback(stop|less|more).
  B no longer uses the `why_now` string (the label is gone, details line kept); freeze.test.ts (planner) still lists it.
- P: persona prompt: the event "You messaged the owner first (<type>): «…»" is Gora's own earlier message.
- M: dueThreads / open_threads / summary should never carry sensitive facts (B only has a keyword belt-and-braces filter).
- Planner/reminders owner: reminders/fire.ts checkin_fire → s.signals.goraSent(source 'checkin'), reminder_fire → 'reminder'.
- Integration e2e: use the scripted settings_update {proactive:'off'} tool call (B's e2e simulates it with repos + feedback).
