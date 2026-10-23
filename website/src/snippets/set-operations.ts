import { staged, target } from './fixtures.js';
// ---cut---

import { asc, select } from 'snowtyped';

const current = select(target, { id: target.columns.id, name: target.columns.name });
const incoming = select(staged, { name: staged.columns.name, id: staged.columns.id });

const all = current.union(incoming);
const page = all.orderBy(asc(all.columns.id)).limit(50);
const unchanged = current.intersect(incoming);
const added = incoming.except(current);
