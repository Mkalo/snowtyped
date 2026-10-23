import { events } from './fixtures.js';
// ---cut---

import { flatten, jsonPath, select } from 'snowtyped';

const items = flatten(jsonPath(events.columns.payload, 'items'), 'items');
const expanded = select(events)
  .lateralJoin(items)
  .select({ eventId: events.columns.id, value: items.columns.value });
