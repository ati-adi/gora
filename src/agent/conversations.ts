// agent/conversations.ts (WP3) — 01 §5.1 conversation resolution and the frozen per-epoch settings.
// A conversation's model, effort, toolset, tools_hash, system_version, betas and context_mode are fixed at creation and
// never change inside an epoch; a mismatch with the running code is detected at the next run start (engine → epochs).
import type { ConversationKey, ConversationRow, ConversationService, Route, Services, ToolsetId } from '../contracts/index.ts';
import { betasFor } from '../config.ts';
import { ulid } from '../kernel/ids.ts';
import { systemVersionFor } from './prompt/system.ts';

export interface FrozenSettings {
  model: string; effort: ConversationRow['effort']; toolset: ToolsetId; toolsHash: string; systemVersion: string; betas: string[]; contextMode: ConversationRow['contextMode'];
}

export function routeOf(key: ConversationKey): Route {
  switch (key.kind) {
    case 'dm':
      return 'chat';
    case 'mission':
      return 'mission';
    case 'group':
      return 'group';
    case 'guest':
      return 'guest';
    case 'biz_draft':
      return 'biz';
  }
}

export function kindOf(key: ConversationKey): ConversationRow['kind'] {
  switch (key.kind) {
    case 'dm':
      return key.threadId ? 'topic' : 'dm';
    case 'mission':
      return 'mission';
    case 'group':
      return 'group';
    case 'guest':
      return 'guest';
    case 'biz_draft':
      return 'biz_draft';
  }
}

/** The model string recorded on conversations.model: 'groq:<model>' on Groq, the Claude model id otherwise (03 R2). */
export function conversationModel(s: Pick<Services, 'config'>): string {
  const p = s.config.profile;
  return p.provider === 'groq' ? `groq:${p.models.main}` : s.config.anthropic.model;
}

/** What a conversation created now for `route` would freeze. */
export function currentSettings(s: Pick<Services, 'config' | 'registry'>, route: Route, contextMode: ConversationRow['contextMode'] = 'system'): FrozenSettings {
  const r = s.config.routes[route];
  const groq = s.config.profile.provider === 'groq';
  return {
    model: conversationModel(s),
    effort: r.effort,
    toolset: r.toolset,
    toolsHash: s.registry.toolset(r.toolset).hash,
    systemVersion: systemVersionFor(s.config.profile.systemVariant),
    betas: groq ? [] : betasFor(s.config.features),
    contextMode,
  };
}

/** Why the frozen settings no longer match the code (null = they match). model change → 'model_switch'; else 'upgrade'. */
export function settingsDrift(conv: ConversationRow, cur: FrozenSettings): 'model_switch' | 'upgrade' | null {
  if (conv.model !== cur.model) return 'model_switch';
  if (conv.systemVersion !== cur.systemVersion || conv.toolsHash !== cur.toolsHash || conv.effort !== cur.effort || conv.toolset !== cur.toolset) return 'upgrade';
  if (conv.betas.join(',') !== cur.betas.join(',')) return 'upgrade';
  return null;
}

export function createConversationService(s: Services): ConversationService {
  function scopeKeyOf(key: ConversationKey): string {
    switch (key.kind) {
      case 'dm':
        return key.threadId ? `dm:${key.tgUserId}:t${key.threadId}` : `dm:${key.tgUserId}`;
      case 'mission':
        return `mission:${key.missionId}`;
      case 'group':
        return key.threadId ? `grp:${key.chatId}:t${key.threadId}` : `grp:${key.chatId}`;
      case 'guest':
        return `guest:${key.guestQueryId}`;
      case 'biz_draft':
        return `bizdraft:${ulid(s.clock.now())}`;
    }
  }
  return {
    scopeKeyOf,
    resolve(key, owner) {
      const scopeKey = scopeKeyOf(key);
      const existing = s.repos.conversations.byScopeKey(scopeKey);
      if (existing) return existing;
      const route = routeOf(key);
      const cur = currentSettings(s, route);
      const threadId = owner.threadId ?? ('threadId' in key ? key.threadId : undefined) ?? null;
      return s.repos.conversations.create({
        scopeKey,
        kind: kindOf(key),
        userId: owner.userId,
        tgChatId: owner.tgChatId,
        threadId,
        businessConnectionId: owner.businessConnectionId ?? null,
        route,
        model: cur.model,
        effort: cur.effort,
        toolset: cur.toolset,
        toolsHash: cur.toolsHash,
        systemVersion: cur.systemVersion,
        betas: cur.betas,
        contextMode: cur.contextMode,
        singleShot: key.kind === 'guest' || key.kind === 'biz_draft',
      });
    },
  };
}
