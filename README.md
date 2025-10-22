# Real-Time Event Enrichment Service

## Overview

A lightweight backend service that provides real-time event processing with user metadata enrichment:

- **Event Stream Ingestion**: Accepts continuous POST requests with user events, validates timestamps, handles out-of-order arrivals, and deduplicates based on event IDs
- **Runtime Reference Updates**: Allows atomic updates to user metadata reference table, ensuring all future enrichments use the latest snapshot
- **Aggregated Metrics**: Returns time-windowed metrics grouped by user attributes (plan, region) using efficient sliding window aggregation

## Rules & Constraints

- **In-Memory Storage**: All data kept in memory with no external database dependencies
- **Sliding Window Aggregation**: Events organized in 1-second buckets
- **Unknown User Handling**: Events for users not present in the reference table are grouped under "unknown"
- **Atomic Reference Updates**: Reference table replacements are atomic with no mixed generations
- **Minimal Dependencies**: Simple implementation with only essential dependencies

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation

```bash
npm install
```

### Running the Service

```bash
# Development mode (with hot reload)
npm run dev

# Production build and run
npm run build
npm start
```

The service will start on `http://localhost:3000` (or the port specified in `PORT` environment variable).

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm test enrichment        # Enrichment logic tests
npm test sliding-window    # Ring buffer tests
npm test integration       # End-to-end tests
```

## Project Structure

```
├── src/
│   ├── app.ts           # Express application setup and server initialization
│   ├── controllers.ts   # HTTP request handlers for all API endpoints
│   ├── storage.ts       # InMemoryStore class with ring buffer and reference table
│   ├── types.ts         # TypeScript type definitions and interfaces
│   └── utils.ts         # Utility functions (timestamp parsing, validation, constants)
├── tests/
│   ├── enrichment.test.ts      # Unit tests for event enrichment logic
│   ├── sliding-window.test.ts  # Unit tests for ring buffer and sliding window operations
│   └── integration.test.ts     # End-to-end integration tests (POST → GET)
├── package.json         # Dependencies, scripts, and project metadata
├── tsconfig.json        # TypeScript compiler configuration
├── jest.config.js       # Jest test framework configuration
├── prettierrc.json      # Prettier configuration
└── eslintrc.json        # ES Linter configuration
```

## Tech Stack

- **TypeScript**: Provides static typing for improved code quality and developer experience
- **Node.js**: JavaScript runtime for server-side execution.
- **Express**: Minimal and flexible web framework for handling HTTP requests
- **Jest**: Testing framework with built-in mocking and assertions
- **Supertest**: HTTP assertion library for integration testing
- **tsx**: TypeScript executor for development with hot reload
- **dotenv**: Environment variable management

Rationale: Chose a minimal stack focused on simplicity, correctness, and familiarity. TypeScript catches errors at compile time, Express provides a lightweight HTTP layer, and Jest + Supertest offer comprehensive testing capabilities.

## Architecture Overview

### Data Structures

**Ring Buffer (Sliding Window)**
- Fixed-size circular buffer with 1,800 buckets (30 minutes of retention at 1-second granularity)
- Each bucket stores events for a specific epoch second
- Modulo arithmetic (`eventSec % MAX_RETENTION_SEC`) maps timestamps to bucket indices.
- Stale buckets are cleared as the window advances, preventing unbounded memory growth
- Supports efficient lookback queries by iterating only over requested time range

**Reference Table**
- Implemented as `Map<user_id, {plan, region}>` for O(1) lookups
- Atomically replaced on each PUT request using last-write-wins with timestamp validation
- Generation tracking via update counter for observability

**Event Deduplication**
- `Set<event_id>` tracks all seen event IDs to enforce idempotency
- Grows unbounded (trade-off: memory vs duplicate protection)

### Enrichment Strategy

**Lazy Enrichment at Read Time**
- Events stored in raw form without metadata
- Enrichment performed during `GET /metrics` using the current reference table snapshot

### Late Event Policy

**Acceptance Window**
- Events accepted up to **120 seconds late** relative to server clock
- Events rejected if timestamp is >**120 seconds in the future or past** (clock skew protection)

**Out-of-Order Handling**
- Ring buffer supports inserting events into past buckets within retention window
- Events outside the 30-minute retention window are rejected
- Validation occurs at ingestion; late events within window are inserted into correct buckets

## API Endpoints

| Endpoint | Description | Example Request Body | Example Response |
|----------|-------------|--------------|----------|
| **POST /events** | Ingest single event or batch of events. Validates timestamps, rejects duplicates, handles out-of-order arrivals. | `{"event_id": "uuid", "user_id": "u-123", "type": "click\|view\|purchase", "ts": "2025-10-08T12:34:56.789Z"}` or array of event objects | `{"results": [{"event_id": "uuid", "status": "success\|error", "message": "..."}]}` |
| **PUT /reference/users** | Atomically replace user reference table. Requires timestamp for versioning. | `{"user_metadata": {"u-123": {"plan": "pro", "region": "eu"}}, "ts": "2025-10-08T12:00:00.000Z"}` | `{"message": "Reference table updated successfully"}` or `409` if timestamp is stale |
| **GET /metrics?window={seconds}** | Get aggregated metrics over sliding window (default 300s). Returns events per second, unique users, and groupings by plan/region. | Query param: `window` (optional, default 300, max 1800) | `{"window_sec": 300, "events_per_sec": 52.3, "unique_users": 140, "unknown": 20, "by_plan": {"free": 380, "pro": 220}, "by_region": {"us": 400, "eu": 200}}` |
| **GET /healthz** | Health check endpoint for monitoring service availability. | None | `{"ok": true}` |

## Trade-offs

### Simple Write Implementation For Reference Table Updates
- **Decision**: No lock management, queues, or async complexicity used for writes or reads. 
- **Benefits**: Simplicity, low latency, high write throughput, no deadlocks to handle, consistent response times. Last write-wins strategy. Works for current scenario of running the service locally since since we are using a single-threaded synchronous Node.js event loop.
- **Costs**: Same-timestamp collision, check-then-set race condition, concurrent updates overwrite each other, no async safety, silent overwrites

### In-Memory Storage vs Persistence
- **Decision**: All data stored in memory with no persistence layer
- **Benefits**: Simplicity, low latency, no database setup required
- **Costs**: Data loss on service restart, no durability guarantees, limited by available RAM

### Ring Buffer Size (30-minute retention)
- **Decision**: Fixed 1,800-bucket ring buffer (30 minutes × 60 seconds).
- **Benefits**: Bounded memory usage, efficient way to clear stale events
- **Costs**: Cannot query events older than 30 minutes, hard limit on lookback window. Arbitrary fixed time.

### Lazy Enrichment
- **Decision**: Enrich events at read time rather than write time. 
- **Benefits**: Always uses latest reference data snapshot, no re-enrichment needed on reference table updates
- **Costs**: Slower GET /metrics response times, redundant enrichment on repeated queries

### Event ID Deduplication Set
- **Decision**: Unbounded Set tracking all seen event IDs
- **Benefits**: Strong idempotency guarantees across entire service lifetime
- **Costs**: Memory grows indefinitely with unique events

### Simple Validation
- **Decision**: Basic timestamp and schema validation only
- **Benefits**: Fast ingestion, minimal overhead
- **Costs**: No semantic validation (e.g., malformed UUIDs accepted, no region/plan enum validation)

## What I Would Do With More Time
- Add optimistic write-only locking with version numbers to catch same timestamp conflicts, race conditions, and concurrent updates for reference table updates. This would help support scaling for multi-threaded or distributed systems at the cost of code complexity, slightly higher latency, and lower write throughput.
- Replace hardcoded Plan (free/pro) and Region (us/eu) values with a dynamic solution to support arbitrary metadata values
- Explore pre-aggregating metrics per bucket to avoid re-scanning events for metric queries 
  - This would require insight into how often reference data will be updated vs how often metric queries will be made.
- Add caching layer for frequent metric queries. Invalidate cache on reference table updates.
- Partition events within each bucket by user_id, which would make it more efficient to aggregate metrics by user attributes
- Make `MAX_RETENTION_SEC` an env variable
- Add input validation using schema validation library like Zod and semantic validation 
- Improve test suite
  - input validation tests for ingesting events 
  - handler specific tests
