import request from 'supertest';
import express from 'express';
import { InMemoryStore } from '../src/storage.js';
import { Controllers } from '../src/controllers.js';
import type { Event, UserMetadata } from '../src/types.js';

describe('Integration Test: POST -> GET Flow', () => {
  let app: express.Application;
  let store: InMemoryStore;

  beforeEach(() => {
    // Setup fresh app and store for each test
    app = express();
    store = new InMemoryStore();
    const controllers = new Controllers(store);

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.post('/events', controllers.ingestEvents);
    app.put('/reference/users', controllers.updateReference);
    app.get('/metrics', controllers.getMetrics);
    app.get('/healthz', controllers.healthCheck);
  });

  it('should successfully update reference table, ingest events and retrieve metrics', async () => {
    const now = new Date();
    
    // Step 1: Update reference table with user metadata
    const userMetadata: UserMetadata = {
      "u-123": { plan: 'pro', region: 'us' },
      "u-456": { plan: 'free', region: 'eu' },
    };

    const refResponse = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata,
        ts: now.toISOString(),
      });

    expect(refResponse.status).toBe(200);
    expect(refResponse.body.message).toBe('Reference table updated successfully');

    // Step 2: POST events
    const events: Event[] = [
      {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now.getTime() - 5000).toISOString(), // 5 seconds ago
      },
      {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date(now.getTime() - 3000).toISOString(), // 3 seconds ago
      },
      {
        event_id: 'uuid-3',
        user_id: 'u-123',
        type: 'purchase',
        ts: new Date(now.getTime() - 1000).toISOString(), // 1 second ago
      },
    ];

    const postResponse = await request(app)
      .post('/events')
      .send(events);

    expect(postResponse.status).toBe(200);
    expect(postResponse.body.results).toHaveLength(3);
    expect(postResponse.body.results.every((r: any) => r.status === 'success')).toBe(true);

    // Step 3: GET metrics
    const getResponse = await request(app)
      .get('/metrics')
      .query({ window: 300 }); // 5 minute window

    expect(getResponse.status).toBe(200);
    
    const metrics = getResponse.body;
    expect(metrics.window_sec).toBe(300);
    expect(metrics.events_per_sec).toBe(3 / 300);
    expect(metrics.unique_users).toBe(2);
    expect(metrics.unknown).toBe(0);
    expect(metrics.by_plan.pro).toBe(2);
    expect(metrics.by_plan.free).toBe(1);
    expect(metrics.by_region.us).toBe(2);
    expect(metrics.by_region.eu).toBe(1);
  });

  it('should handle events for users without metadata', async () => {
    const now = new Date();

    const userMetadata: UserMetadata = {
      "u-123": { plan: 'pro', region: 'us' },
      "u-456": { plan: 'free', region: 'eu' },
    };

    const refResponse = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata,
        ts: now.toISOString(),
      });

    expect(refResponse.status).toBe(200);
    expect(refResponse.body.message).toBe('Reference table updated successfully');

    // POST events
    const events: Event[] = [
      {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: now.toISOString(),
      },
      {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: now.toISOString(),
      },
      {
        event_id: 'uuid-3',
        user_id: 'u-789',
        type: 'view',
        ts: now.toISOString(),
      },
    ];

    const postResponse = await request(app)
      .post('/events')
      .send(events);

    expect(postResponse.status).toBe(200);

    // GET metrics should show users without metadata as unknown
    const getResponse = await request(app)
      .get('/metrics')
      .query({ window: 300 });

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.window_sec).toBe(300);
    expect(getResponse.body.events_per_sec).toBe(3 / 300);
    expect(getResponse.body.unique_users).toBe(2);
    expect(getResponse.body.unknown).toBe(1);
    expect(getResponse.body.by_plan.pro).toBe(1);
    expect(getResponse.body.by_plan.free).toBe(1);


  });

  it('should respect sliding window boundaries', async () => {
    const now = new Date();

    const userMetadata: UserMetadata = {
      "u-123": { plan: 'pro', region: 'us' },
      "u-456": { plan: 'free', region: 'eu' },
    };

    const refResponse = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata,
        ts: now.toISOString(),
      });

    expect(refResponse.status).toBe(200);
    expect(refResponse.body.message).toBe('Reference table updated successfully');

    // POST event outside small window
    const oldEvent: Event = {
      event_id: 'uuid-old',
      user_id: 'u-123',
      type: 'click',
      ts: new Date(now.getTime() - 10000).toISOString(), // 10 seconds ago
    };

    await request(app)
      .post('/events')
      .send(oldEvent);

    // POST recent event
    const recentEvent: Event = {
      event_id: 'uuid-recent',
      user_id: 'u-456',
      type: 'view',
      ts: new Date(now.getTime() - 2000).toISOString(), // 2 seconds ago
    };

    await request(app)
      .post('/events')
      .send(recentEvent);

    // GET metrics with 5 second window - should only include recent event
    const getResponse = await request(app)
      .get('/metrics')
      .query({ window: 5 });

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.window_sec).toBe(5);
    expect(getResponse.body.events_per_sec).toBe(1 / 5);
    expect(getResponse.body.unique_users).toBe(1);
    expect(getResponse.body.unknown).toBe(0);
    expect(getResponse.body.by_plan.pro).toBe(0);
    expect(getResponse.body.by_plan.free).toBe(1);
    expect(getResponse.body.by_region.us).toBe(0);
    expect(getResponse.body.by_region.eu).toBe(1);
  });

  it('should enrich events with latest reference table', async () => {
    const now = new Date();

    const userMetadata: UserMetadata = {
      "u-123": { plan: 'pro', region: 'us' },
      "u-456": { plan: 'pro', region: 'us' },
    };

    const refResponse = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata,
        ts: now.toISOString(),
      });

    expect(refResponse.status).toBe(200);
    expect(refResponse.body.message).toBe('Reference table updated successfully');

    // Update reference table with different metadata
    await new Promise(resolve => setTimeout(resolve, 1000));
    const now2 = new Date();
    const userMetadata2: UserMetadata = {
      "u-123": { plan: 'free', region: 'eu' },
      "u-456": { plan: 'free', region: 'eu' },
    };
    const refResponse2 = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata2,
        ts: now2.toISOString(),
      });

    expect(refResponse2.status).toBe(200);
    expect(refResponse2.body.message).toBe('Reference table updated successfully');

    const events: Event[] = [
      {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: now.toISOString(),
      },
      {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: now.toISOString(),
      },
    ];

    const postResponse = await request(app)
      .post('/events')
      .send(events);

    expect(postResponse.status).toBe(200);

    const getResponse = await request(app)
      .get('/metrics')
      .query({ window: 300 });

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.window_sec).toBe(300);
    expect(getResponse.body.events_per_sec).toBe(2 / 300);
    expect(getResponse.body.unique_users).toBe(2);
    expect(getResponse.body.unknown).toBe(0);
    expect(getResponse.body.by_plan.pro).toBe(0);
    expect(getResponse.body.by_plan.free).toBe(2);
    expect(getResponse.body.by_region.us).toBe(0);
    expect(getResponse.body.by_region.eu).toBe(2);
  });

  it('should handle out-of-order inserts', async () => {
    const now = new Date();

    const userMetadata: UserMetadata = {
      "u-123": { plan: 'pro', region: 'us' },
      "u-456": { plan: 'free', region: 'eu' },
    };

    const refResponse = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata,
        ts: now.toISOString(),
      });
      
    expect(refResponse.status).toBe(200);
    expect(refResponse.body.message).toBe('Reference table updated successfully');

    const events: Event[] = [
      {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'click',
        ts: new Date(now.getTime() - 3000).toISOString(), // 3 seconds ago
      },
      {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date(now.getTime() - 2000).toISOString(), // 2 seconds ago
      },
      {
        event_id: 'uuid-3',
        user_id: 'u-123',
        type: 'view',
        ts: new Date(now.getTime() - 1000).toISOString(), // 1 seconds ago
      },
      {
        event_id: 'uuid-4',
        user_id: 'u-456',
        type: 'click',
        ts: new Date(now.getTime() - 4000).toISOString(), // 4 seconds ago
      },
      {
        event_id: 'uuid-5',
        user_id: 'u-123',
        type: 'view',
        ts: new Date(now.getTime() - 5000).toISOString(), // 5 seconds ago
      },
    ];

    const postResponse = await request(app)
      .post('/events')
      .send(events);

    expect(postResponse.status).toBe(200);

    const getResponse = await request(app)
      .get('/metrics')
      .query({ window: 10 });
      
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.window_sec).toBe(10);
    expect(getResponse.body.events_per_sec).toBe(5 / 10);
    expect(getResponse.body.unique_users).toBe(2);
    expect(getResponse.body.unknown).toBe(0);
    expect(getResponse.body.by_plan.pro).toBe(3);
    expect(getResponse.body.by_plan.free).toBe(2);
    expect(getResponse.body.by_region.us).toBe(3);
    expect(getResponse.body.by_region.eu).toBe(2);
  });

  it('should handle late events or clock skew', async () => {
    const now = new Date();

    const userMetadata: UserMetadata = {
      "u-123": { plan: 'pro', region: 'us' },
      "u-456": { plan: 'free', region: 'eu' },
      "u-789": { plan: 'pro', region: 'eu' },
    };

    const refResponse = await request(app)
      .put('/reference/users')
      .send({
        user_metadata: userMetadata,
        ts: now.toISOString(),
      });

    expect(refResponse.status).toBe(200);
    expect(refResponse.body.message).toBe('Reference table updated successfully');

    const events: Event[] = [
      {
        event_id: 'uuid-1',
        user_id: 'u-123',
        type: 'view',
        ts: new Date(now.getTime() - 1000).toISOString(), // 1 second ago
      },
      {
        event_id: 'uuid-2',
        user_id: 'u-456',
        type: 'view',
        ts: new Date(now.getTime() + 121000).toISOString(), // event > 2 minutes in the future
      },
      {
        event_id: 'uuid-3',
        user_id: 'u-789',
        type: 'view',
        ts: new Date(now.getTime() - 121000).toISOString(), // event > 2 minutes late
      },
    ];

    const postResponse = await request(app)
      .post('/events')
      .send(events);

    expect(postResponse.status).toBe(200);
    expect(postResponse.body.results).toHaveLength(3);
    expect(postResponse.body.results).toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'error', message: 'Event uuid-2 timestamp is more than 2 minutes skewed.' }),
      expect.objectContaining({ status: 'error', message: 'Event uuid-3 timestamp is outside the 2 minute lateness threshold.' }),
    ]);

    const getResponse = await request(app)
      .get('/metrics')
      .query({ window: 5 });
      
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.window_sec).toBe(5);
    expect(getResponse.body.events_per_sec).toBe(1 / 5);
    expect(getResponse.body.unique_users).toBe(1);
    expect(getResponse.body.unknown).toBe(0);
    expect(getResponse.body.by_plan.pro).toBe(1);
    expect(getResponse.body.by_plan.free).toBe(0);
    expect(getResponse.body.by_region.us).toBe(1);
    expect(getResponse.body.by_region.eu).toBe(0);
  });

});

