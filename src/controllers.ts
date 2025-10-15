import type { Request, Response } from 'express';
import type { InMemoryStore } from './storage.js';
import type { Event } from './types.js';
import { normalizeToArray } from './utils.js';
export class Controllers {
  constructor(private store: InMemoryStore) {}

  ingestEvents = withErrorHandling((req: Request, res: Response): void => {
    const events = req.body;
    if (!events) {
      res.status(400).json({ error: 'Missing events in request body' });
      return;
    }

    // Normalize to array format
    const eventsArray = normalizeToArray(events)
    if (!eventsArray) {
      res.status(400).json({ 
        error: 'Invalid events format', 
        message: 'events must be an object or array of objects, got ' + typeof events 
      });
      return;
    }

    // Process events
    const serverTimeSec = Math.floor(Date.now() / 1000)
    const results = eventsArray.map((event: Event) => {
      try {
        this.store.validateEvent(event, serverTimeSec);
        this.store.updateRingBuffer(event, serverTimeSec)
        return {
          event_id: event.event_id,
          status: 'success'
        }
      } catch (error) {
        return {
          event_id: event.event_id ?? 'event_unknown',
          status: 'error',
          message: (error as Error).message
        }
      }
    })
    
    res.status(200).json({ results });
  })

  updateReference = withErrorHandling((req: Request, res: Response): void => {
    const { user_metadata, ts } = req.body;

    if (!user_metadata || typeof user_metadata !== 'object' || !ts) {
      res.status(400).json({ 
        error: 'Invalid request body', 
        message: 'user_metadata must be an object and timestamp must be an ISO datetime string' 
      });
      return;
    }
  
    try {
      this.store.updateReferenceTable(user_metadata, ts);
    } catch (error) {
      res.status(409).json({
        error: 'Update rejected',
        reason: (error as Error).message,
      });
      return;
    }

    res.status(200).json({message: 'Reference table updated successfully'});
  })

  getMetrics = withErrorHandling((req: Request, res: Response): void => {
    const { window } = req.query;
    const windowSec = window? parseInt(window as string) : 300;

    if (isNaN(windowSec) || windowSec <= 0) {
      res.status(400).json({ error: 'Invalid window parameter' });
      return;
    }

    // Advance sliding window to current time before reading
    // This ensures stale buckets are cleared and we're reading fresh data
    const now = Math.floor(Date.now() / 1000);
    this.store.advanceSlidingWindow(now);

    // Get buckets within lookback window and latest reference table
    const lookbackWindow = this.store.getLookbackWindow(windowSec, now);
    const userReferenceTable = this.store.getReferenceTable();

    if (!lookbackWindow.length) {
      res.status(200).json({
        window_sec: windowSec,
        events_per_sec: 0,
        unique_users: 0,
        unknown: 0,
        by_plan: { free: 0, pro: 0 },
        by_region: { us: 0, eu: 0 },
        message: 'No events found in the specified window' 
      });
      return;
    }

    const aggregation = {
      totalEvents: 0,
      uniqueUsers: new Set<string>(),
      unknown: new Set<string>(),
      byPlan: { free: 0, pro: 0 },
      byRegion: { us: 0, eu: 0 },
    }

    // Process each bucket in the lookback window with lazy enrichment
    for (const bucket of lookbackWindow) {
      aggregation.totalEvents += bucket.events.length;

      for (const event of bucket.events) {
        const enrichedEvent = this.store.enrichEvent(event, userReferenceTable);
        if (enrichedEvent.metadata && enrichedEvent.metadata.user) {
          aggregation.byPlan[enrichedEvent.metadata.user.plan]++;
          aggregation.byRegion[enrichedEvent.metadata.user.region]++;
          aggregation.uniqueUsers.add(event.user_id);
        } else {
          aggregation.unknown.add(event.event_id);
        }
      }
    }

    const metrics = {
      window_sec: windowSec,
      events_per_sec: aggregation.totalEvents / windowSec,
      unique_users: aggregation.uniqueUsers.size,
      unknown: aggregation.unknown.size,
      by_plan: aggregation.byPlan,
      by_region: aggregation.byRegion,
    }
    res.status(200).json(metrics);
  })

  healthCheck = (_req: Request, res: Response): void => {
    res.status(200).json({ ok: true});
  }
}

type ControllerHandler = (req: Request, res: Response) => void;
const withErrorHandling = (handler: ControllerHandler): ControllerHandler => {
  return (req: Request, res: Response): void => {
    try {
      handler(req, res);
    } catch (error) {
      res.status(500).json({ 
        error: 'Internal server error', 
        message: (error as Error).message 
      });
    }
  };
};
