import { quotes, trades } from './fixtures.js';
// ---cut---

import { gte, select } from 'snowtyped';

const prices = select(trades)
  .asofJoin(quotes, gte(trades.columns.at, quotes.columns.at))
  .select({ at: trades.columns.at, price: quotes.columns.price });
// price: number | null
