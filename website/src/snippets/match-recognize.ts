import { db, stocks } from './fixtures.js';
// ---cut---

import { asc, eq, gt, lt, matchRecognize, rowPattern, select } from 'snowtyped';

const { variable, sequence, oneOrMore } = rowPattern;
const vShapes = matchRecognize(stocks, 'V', {
  partitionBy: ['company'],
  orderBy: (row) => [asc(row.day)],
  pattern: sequence(variable('start'), oneOrMore(variable('down')), oneOrMore(variable('up'))),
  define: ({ row, lag }) => ({
    down: lt(row.price, lag(row.price)),
    up: gt(row.price, lag(row.price)),
  }),
  measures: ({ row, vars, first, last, matchNumber, classifier }) => ({
    match: matchNumber(),
    startDay: first(row.day),
    bottomDay: last(vars.down.day),
    kind: classifier(),
  }),
});
const { rows } = await db.execute(select(vShapes).where(eq(vShapes.columns.kind, 'up')));
