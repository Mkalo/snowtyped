import { compileAst, identifier, quoteIdentifier, select } from 'snowtyped';
import { expect, it } from 'vitest';
import { customers } from './schema.js';

it('compiles the AST behind a query', () => {
  const query = select(customers);
  expect(compileAst(query.ast)).toEqual(query.compile());
  expect(quoteIdentifier(identifier('APP_DB', 'PUBLIC', 'my "table"'))).toBe(
    '"APP_DB"."PUBLIC"."my ""table"""',
  );
});
