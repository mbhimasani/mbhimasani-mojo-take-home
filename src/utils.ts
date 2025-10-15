import type { Event } from './types.js'

export const isObject = (value: unknown): boolean => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};
export const parseTimestamp = (ts: string): number => {
  const timestamp = Math.floor(new Date(ts).getTime() / 1000);
  if (isNaN(timestamp)) {
    throw new Error('Invalid timestamp');
  }
  return timestamp;
}

export const normalizeToArray = (events: unknown): Event[] | null => {
  if (isObject(events)) {
    return [events as Event];
  }
  
  if (Array.isArray(events)) {
    return events as Event[];
  }
  
  return null;
};

// constants
export const LATENESS_SEC = 120; // Events accepted up to 2min late
export const MAX_CLOCK_SKEW_SEC = 120;
export const MAX_RETENTION_SEC = 1800; // Retain 30 minutes of events