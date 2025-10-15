export type Plan = 'free' | 'pro';
export type Region = 'us' | 'eu';

export type UserReferenceTable = Map<string, { plan: Plan, region: Region }>;
export type UserMetadata = Record<string, { plan: Plan, region: Region }>

export type Event = {
  event_id: string;
  user_id: string;
  type: 'click' | 'view' | 'purchase';
  ts: string; // ISO datetime string
}
export type EnrichedEvent = Event & {
  metadata?: { 
    user: { 
      plan: Plan, 
      region: Region 
    } 
  };
}

// Bucket keeps per-second counts for expiry math
export type Bucket = {
  sec: number; // epoch second this bucket represents
  events: Event[];
}