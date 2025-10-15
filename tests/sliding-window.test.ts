import { InMemoryStore } from '../src/storage.js';
import type { Event } from '../src/types.js';
import { MAX_RETENTION_SEC } from '../src/utils.js';

describe('Sliding Window Logic', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('updateRingBuffer', () => {
    it('should add event to appropriate bucket', () => {
      const now = Math.floor(Date.now() / 1000);
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now * 1000).toISOString(),
      };

      store.updateRingBuffer(event, now);

      const lookbackWindow = store.getLookbackWindow(1, now);
      expect(lookbackWindow).toHaveLength(1);
      expect(lookbackWindow[0].events).toContainEqual(event);
    });

    it('should handle multiple events in the same second', () => {
      const now = Math.floor(Date.now() / 1000);
      const event1: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now * 1000).toISOString(),
      };
      const event2: Event = {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date(now * 1000).toISOString(),
      };

      store.updateRingBuffer(event1, now);
      store.updateRingBuffer(event2, now);

      const lookbackWindow = store.getLookbackWindow(1, now);
      expect(lookbackWindow[0].events).toHaveLength(2);
      expect(lookbackWindow[0].events).toContainEqual(event1);
      expect(lookbackWindow[0].events).toContainEqual(event2);
    });

    it('should handle out-of-order inserts', () => {
      const now = Math.floor(Date.now() / 1000);
      const event1: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date((now - 1) * 1000).toISOString(),
      };
      const event2: Event = {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date((now - 2) * 1000).toISOString(), // out-of-order, event2 is older than event1
      };
      const event3: Event = {
        event_id: 'uuid-3',
        user_id: 'u-789',
        type: 'purchase',
        ts: new Date(now * 1000).toISOString(),
      };

      store.updateRingBuffer(event1, now);
      store.updateRingBuffer(event2, now);
      store.updateRingBuffer(event3, now);

      const lookbackWindow = store.getLookbackWindow(3, now);
      expect(lookbackWindow).toHaveLength(3);
      expect(lookbackWindow[0].events).toContainEqual(event2);
      expect(lookbackWindow[1].events).toContainEqual(event1);
      expect(lookbackWindow[2].events).toContainEqual(event3);
    });

    it(`it should throw error if event timestamp exceeds buffer size of ${MAX_RETENTION_SEC} seconds`, () => {
      const now = Math.floor(Date.now() / 1000);
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now - MAX_RETENTION_SEC - 1000).toISOString(),
      };

      expect(() => {
        store.updateRingBuffer(event, now);
      }).toThrow(`Event timestamp is more than ${MAX_RETENTION_SEC} seconds away from current time`);
      
    });
  });

  describe('advanceSlidingWindow', () => {
    it('should advance the sliding window forward', () => {
      const startTime = Math.floor(Date.now() / 1000);
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(startTime * 1000).toISOString(),
      };

      store.updateRingBuffer(event, startTime);

      const futureTime = startTime + 10;
      store.advanceSlidingWindow(futureTime);

      // Event should still be retrievable within retention window
      const lookbackWindow = store.getLookbackWindow(11, futureTime);
      expect(lookbackWindow.some(b => b.events.length > 0)).toBe(true);
    });

    it('should clear stale buckets when advancing', () => {
      const startTime = Math.floor(Date.now() / 1000);
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(startTime * 1000).toISOString(),
      };

      store.updateRingBuffer(event, startTime);

      // Advance beyond retention window
      const futureTime = startTime + MAX_RETENTION_SEC + 100;
      store.advanceSlidingWindow(futureTime);

      // Event should no longer be retrievable
      const lookbackWindow = store.getLookbackWindow(100, futureTime);
      expect(lookbackWindow.every(b => b.events.length === 0)).toBe(true);
    });

    it('should throw error if target time is less than current time', () => {
      const now = Math.floor(Date.now() / 1000);
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now * 1000).toISOString(),
      };

      store.updateRingBuffer(event, now);

      expect(() => {
        store.advanceSlidingWindow(now - 10);
      }).toThrow('Cannot advance sliding window backwards');
    });

    it('should do nothing if target time equals current time', () => {
      const now = Math.floor(Date.now() / 1000);
      const event: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now * 1000).toISOString(),
      };

      store.updateRingBuffer(event, now);

      store.advanceSlidingWindow(now);

      const lookbackWindow = store.getLookbackWindow(1, now);
      expect(lookbackWindow.some(b => b.events.length > 0)).toBe(true);
    });
  });

  describe('getLookbackWindow', () => {
    it('should return empty window when no events exist', () => {
      const now = Math.floor(Date.now() / 1000);
      const lookbackWindow = store.getLookbackWindow(300, now);
      expect(lookbackWindow).toHaveLength(0);
    });

    it('should only return events within specified window', () => {
      const now = Math.floor(Date.now() / 1000);
      const event1: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date((now - 5) * 1000).toISOString(),
      };
      const event2: Event = {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date((now - 10) * 1000).toISOString(),
      };

      store.updateRingBuffer(event1, now);
      store.updateRingBuffer(event2, now);

      const lookbackWindow = store.getLookbackWindow(6, now);
      const allEvents = lookbackWindow.flatMap(b => b.events);
      
      expect(allEvents).toContainEqual(event1);
      expect(allEvents).not.toContainEqual(event2);
    });

    it(`should throw error when window request exceeds maximum lookback window size of ${MAX_RETENTION_SEC} seconds`, () => {
      const now = Math.floor(Date.now() / 1000);

      expect(() => {
        store.getLookbackWindow(MAX_RETENTION_SEC + 1, now);
      }).toThrow(`Window parameter exceeds maximum lookback window of ${MAX_RETENTION_SEC}s`);
    });

    it('should handle ring buffer wrap-around correctly', () => {
      const startTime = Math.floor(Date.now() / 1000);
      
      // Add event at start
      const event1: Event = {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(startTime * 1000).toISOString(),
      };

      store.updateRingBuffer(event1, startTime);

      // Advance past ring buffer size to cause wrap-around
      const wrapTime = startTime + MAX_RETENTION_SEC + 10;
      const event2: Event = {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date(wrapTime * 1000).toISOString(),
      };

      store.updateRingBuffer(event2, wrapTime);

      // First event should be overwritten
      const lookbackWindow = store.getLookbackWindow(10, wrapTime);
      const allEvents = lookbackWindow.flatMap(b => b.events);
      
      expect(allEvents).toContainEqual(event2);
      expect(allEvents).not.toContainEqual(event1);
    });
  });
});

