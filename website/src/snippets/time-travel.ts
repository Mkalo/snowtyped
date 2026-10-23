import { customers } from './fixtures.js';
// ---cut---

import { select, timeTravel } from 'snowtyped';

const hourAgo = select(timeTravel(customers, { offset: -3600 }));
const beforeStatement = select(
  timeTravel(customers, { statement: '01b2c3d4-0000-0000-0000-000000000000' }, 'BEFORE'),
);
