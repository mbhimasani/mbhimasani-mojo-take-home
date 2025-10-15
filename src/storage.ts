import type { Bucket, Event, UserReferenceTable, UserMetadata, EnrichedEvent } from './types.js';
import { isObject, parseTimestamp, LATENESS_SEC, MAX_CLOCK_SKEW_SEC, MAX_RETENTION_SEC } from './utils.js';

/**
 * InMemoryStore manages (1) user reference table and (2) events using a ring buffer with 1s buckets for efficient sliding window queries.
 * @constructor initializes the ring buffer
 * @method validateEvent: validates an event object against clock and duplicate checks
 * @method enrichEvent: enriches an event with user metadata
 * @method updateReferenceTable: updates the user reference table using last-write-wins
 * @method getReferenceTable: returns the current user reference table
 * @method updateRingBuffer: ingests event object and updates the ring buffer
 * @method advanceSlidingWindow: advances the sliding window
 * @method getLookbackWindow: returns the lookback window
 */
export class InMemoryStore {
  private ringBuffer: Bucket[];
  private currentSec: number = 0; // second the sliding window has advanced to

  private userReferenceTable: UserReferenceTable = new Map();
  private userReferenceTableTimestamp: number = 0;
  private userReferenceTableUpdateCount: number = 0;

  private seenEventIds: Set<string> = new Set();
  
  constructor() {
    this.ringBuffer = Array.from({ length: MAX_RETENTION_SEC }, () => ({
      sec: 0,
      events: [],
    }));
  }

  /**
   * Validates an event object against clock and duplicate checks
   * @param clockSec - timestamp in seconds to compare event timestamp against, defaults to current time
   * @returns True if the event is valid, @throws Error otherwise
   */
  validateEvent = (event: Event, clockSec?: number): boolean => {
    // Reject invalid event type
    if (!(isObject(event))) {
      throw new Error('Event must be an object');
    }

    // Reject events with missing fields
    if (!event.event_id || !event.user_id || !event.type || !event.ts) {
      throw new Error(`Event ${event.event_id} is missing required fields`);
    }

    // Reject duplicates based on event_id
    if (this.seenEventIds.has(event.event_id)) {
      throw new Error(`Event ${event.event_id} already seen`);
    }

    // Reject invalid timestamps, clock skew, and late events
    const eventTs = parseTimestamp(event.ts);
    const now = clockSec ?? Math.floor(Date.now() / 1000);
    if ((eventTs - now) > MAX_CLOCK_SKEW_SEC) {
      throw new Error(`Event ${event.event_id} timestamp is more than 2 minutes skewed.`);
    } 
    if (eventTs < now - LATENESS_SEC) {
      throw new Error(`Event ${event.event_id} timestamp is outside the 2 minute lateness threshold.`);
    }
    
    // Mark valid event as seen
    this.seenEventIds.add(event.event_id);
    return true
  }

  /**
   * Enriches an event with user metadata
   * @param userReferenceTable - The user reference table to use (optional, defaults to the current user reference table)
   * @returns Enriched event if user metadata is available, original event otherwise
   */
  enrichEvent = (event: Event, userReferenceTable?: UserReferenceTable): EnrichedEvent => {
    const tableSnapshot = userReferenceTable ?? this.userReferenceTable;
    const userInfo = tableSnapshot.get(event.user_id);

    if (!userInfo) { return event }

    return { 
      ...event, 
      metadata: {
        user: {
          plan: userInfo.plan,
          region: userInfo.region
        }
      }
    };
  }

  /**
   * Updates the user reference table using last-write-wins strategy
   * @throws Error if update timestamp is older than the current reference table timestamp
   */
  updateReferenceTable = (userMetadata: UserMetadata, timestamp: string): void => {
    const updateTs = parseTimestamp(timestamp);

    // last-write-wins
    if (updateTs < this.userReferenceTableTimestamp) {
      throw new Error(
        `Stale update: timestamp is older than current version. Current version is ${new Date(this.userReferenceTableTimestamp * 1000).toISOString()}`,
      )
    }

    this.userReferenceTable = new Map(Object.entries(userMetadata))
    this.userReferenceTableTimestamp = updateTs
    this.userReferenceTableUpdateCount++

    console.log(`Reference table updated to version ${this.userReferenceTableUpdateCount} (timestamp: ${timestamp})`) 
  }

  getReferenceTable = (): UserReferenceTable => {
    return this.userReferenceTable;
  }

  /**
   * Ingests an event object and updates the ring buffer and advances the sliding window if necessary
   * @param clockSec - timestamp in seconds to compare event timestamp against, defaults to current time
   * @throws Error if event timestamp is more than MAX_RETENTION_SEC (120s) seconds away from clockSec
   */
  updateRingBuffer = (event: Event, clockSec?: number): void => {
    const eventSec = parseTimestamp(event.ts);
    const now = clockSec ?? Math.floor(Date.now() / 1000);

    // Initialize on first event
    if (this.currentSec === 0) {
      this.currentSec = eventSec;
    }
  
    if (now > this.currentSec) {
      this.advanceSlidingWindow(now);
    }

    if (Math.abs(eventSec - this.currentSec) > MAX_RETENTION_SEC) {
      throw new Error(`Event timestamp is more than ${MAX_RETENTION_SEC} seconds away from current time`);
    }
    
    // Calculate bucket index using modulo for circular behavior
    const index = eventSec % MAX_RETENTION_SEC;
    const bucket = this.ringBuffer[index];
    
    // Guard: ensure bucket exists (should always exist since ring is pre-allocated)
    if (!bucket) {
      throw new Error(`Bucket at index ${index} is undefined`);
    }

    // If bucket is for a different second (stale), clear it (wrap-around case)
    if (bucket.sec !== eventSec) {
      bucket.sec = eventSec;
      bucket.events = [];
    }
    
    // Add event to bucket
    bucket.events.push(event);
  }

  /**
   * Advances the sliding window to the target second
   * @param targetSec - timestamp to advance to in seconds, defaults to current time
   * @throws Error if targetSec is less than the sliding window timestamp
   */
  advanceSlidingWindow = (targetSec?: number): void => {
    const advanceTo = targetSec ?? Math.floor(Date.now() / 1000);

    // If this is the first advancement, just initialize
    if (this.currentSec === 0) {
      this.currentSec = advanceTo;
      return;
    }

    // throw error if try to advance backwards
    if (advanceTo < this.currentSec) { 
      throw new Error(`Cannot advance sliding window backwards: ${this.currentSec} -> ${advanceTo}. Current time is ${new Date(this.currentSec * 1000).toISOString()}`);
    }
    // if already at the target, do nothing
    if (advanceTo === this.currentSec) {
      return;
    }

    // Clear stale buckets between current position and target 
    // or entire buffer if jumping far forward (eg. after long idle period)
    const clearStart = this.currentSec + 1;
    const clearEnd = Math.min(advanceTo, clearStart + MAX_RETENTION_SEC);;

    for (let sec = clearStart; sec <= clearEnd; sec++) {
      const index = sec % MAX_RETENTION_SEC;
      this.ringBuffer[index] = {
        sec: 0,
        events: [],
      };
    }

    this.currentSec = advanceTo;
  }

  /**
   * Returns the lookback window for a given window size and query end timestamp
   * @param windowSec - size of the lookback window in seconds
   * @param queryEndSec - timestamp to query up to in seconds
   * @returns Array of buckets within specified window
   */
  getLookbackWindow = (windowSec: number, queryEndSec: number): Bucket[] => {
    // Validate lookback window size
    if (windowSec > MAX_RETENTION_SEC) {
      throw new Error(
        `Window parameter exceeds maximum lookback window of ${MAX_RETENTION_SEC}s`
      );
    }

    // Define lookback window
    const windowStart = queryEndSec - windowSec + 1;
    const windowEnd = queryEndSec;

    // Collect buckets that match the expected second, skip stale buckets
    const buckets: Bucket[] = [];
    for (let sec = windowStart; sec <= windowEnd; sec++) {
      const index = sec % MAX_RETENTION_SEC;
      const bucket = this.ringBuffer[index];

      if (bucket && bucket.sec === sec) {
        buckets.push(bucket);
      }
    }

    return buckets;
  }  
}