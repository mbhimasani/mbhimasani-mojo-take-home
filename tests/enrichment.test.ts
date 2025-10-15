import { InMemoryStore } from '../src/storage.js';
import type { Event, UserMetadata } from '../src/types.js';

describe('Event Enrichment Logic', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('enrichEvent', () => {
    it('should return original event when reference table is empty', () => {
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date().toISOString(),
      };

      const enrichedEvent = store.enrichEvent(event);

      expect(enrichedEvent).toEqual(event);
      expect(enrichedEvent.metadata).toBeUndefined();
    });

    it('should enrich event with user metadata when user exists in reference table', () => {
      const userMetadata = new Map(Object.entries({
        "u-123": { plan: 'pro', region: 'us' },
      } as UserMetadata));

      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date().toISOString(),
      };

      const enrichedEvent = store.enrichEvent(event, userMetadata);

      expect(enrichedEvent).toEqual({
        ...event,
        metadata: {
          user: {
            plan: 'pro',
            region: 'us',
          },
        },
      });
    });

    it('should return original event when user does not exist in reference table', () => {
      const userMetadata = new Map(Object.entries({
        "u-123": { plan: 'pro', region: 'us' },
      } as UserMetadata));

      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-456', // Different user
        type: 'click',
        ts: new Date().toISOString(),
      };

      const enrichedEvent = store.enrichEvent(event, userMetadata);

      expect(enrichedEvent).toEqual(event);
      expect(enrichedEvent.metadata).toBeUndefined();
    });

    it('should handle multiple users with different metadata', () => {
      const userMetadata = new Map(Object.entries({
        "u-123": { plan: 'pro', region: 'us' },
        "u-456": { plan: 'free', region: 'eu' },
      } as UserMetadata));

      const event1: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date().toISOString(),
      };

      const event2: Event = {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date().toISOString(),
      };

      const enrichedEvent1 = store.enrichEvent(event1, userMetadata);
      const enrichedEvent2 = store.enrichEvent(event2, userMetadata);

      expect(enrichedEvent1.metadata?.user).toEqual({ plan: 'pro', region: 'us' });
      expect(enrichedEvent2.metadata?.user).toEqual({ plan: 'free', region: 'eu' });
    });

    it('should always use the latest reference table', () => {
      const now = Date.now();
      const timestamp1 = new Date(now - 1000).toISOString();
      const timestamp2 = new Date(now).toISOString();

      const metadata1: UserMetadata = {
        "u-123": { plan: 'free', region: 'us' },
      };

      const metadata2: UserMetadata = {
        "u-123": { plan: 'pro', region: 'eu' },
      };

      // last-write-wins
      store.updateReferenceTable(metadata1, timestamp1);
      store.updateReferenceTable(metadata2, timestamp2);

      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date().toISOString(),
      };

      const enrichedEvent = store.enrichEvent(event);

      expect(enrichedEvent.metadata?.user).toEqual({ plan: 'pro', region: 'eu' });
    });
  });
});

