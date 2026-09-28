// telegram/channels/index.ts (WP2) — the channel factory (01 §5.5). Channels dereference s.telegram / s.repos / … at call
// time, so the factory may be built before the gateway exists.
import type { ChannelFactory, Services } from '../../contracts/index.ts';
import { createBizOwnerChannel } from './bizOwner.ts';
import { createDmStreamChannel } from './dmStream.ts';
import { createGroupChannel } from './group.ts';
import { createGuestChannel } from './guest.ts';
import { createNotifyChannel } from './notify.ts';

export function createChannelFactory(s: Services): ChannelFactory {
  return {
    forRun(run, conv, onDraft) {
      switch (run.channel) {
        case 'dm_stream':
          return createDmStreamChannel(s, run, conv, onDraft);
        case 'notify':
          return createNotifyChannel(s, run, conv);
        case 'group':
          return createGroupChannel(s, run, conv);
        case 'guest':
          return createGuestChannel(s, run, conv);
        case 'biz_owner':
          return createBizOwnerChannel(s, run, conv);
        default: {
          const never: never = run.channel;
          throw new Error(`unknown channel ${String(never)}`);
        }
      }
    },
  };
}
