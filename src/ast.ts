/**
 * A Snowflake identifier. Each part is quoted separately, so `parts: ['DB', 'PUBLIC', 'ORDERS']`
 * compiles to `"DB"."PUBLIC"."ORDERS"`.
 *
 * Build one with {@link identifier}, which validates the parts.
 */
export interface IdentifierNode {
  readonly kind: 'identifier';
  readonly parts: readonly string[];
}
/** A value sent to Snowflake as a bind parameter. */
export type BindValue = string | number | boolean | null;
/**
 * How a projected column is serialized by the compiler so its decoder receives an exact value, such
 * as exact text for NUMBER, DATE, and timestamps.
 *
 * Projections without a wire type are read as the SDK returns them.
 */
export type WireType =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'date'
  | 'time'
  | 'timestamp_ntz'
  | 'timestamp_ltz'
  | 'timestamp_tz'
  | 'variant'
  | 'geography'
  | 'geometry'
  | 'structured';
/**
 * The identity of a table or derived source within a query. References with the same `name` are
 * told apart by `id`.
 */
export interface SourceReference {
  /** Unique per source, so two aliases with the same name stay distinct. */
  readonly id: symbol;
  /** The source name columns are qualified with in SQL. */
  readonly name: string;
  /** The identifier that qualifies column references to this source. */
  readonly qualifier: IdentifierNode;
}
export interface ReferenceNode {
  readonly kind: 'reference';
  readonly source: SourceReference;
  readonly column: IdentifierNode;
}
export interface ParameterNode {
  readonly kind: 'parameter';
  readonly value: BindValue;
}
export interface BinaryNode {
  readonly kind: 'binary';
  readonly operator: '=' | '<>' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'ILIKE';
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}
export interface ArithmeticNode {
  readonly kind: 'arithmetic';
  readonly operator: '+' | '-' | '*' | '/';
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}
export interface LogicalNode {
  readonly kind: 'logical';
  readonly operator: 'AND' | 'OR';
  readonly operands: readonly ExpressionNode[];
}
export interface UnaryNode {
  readonly kind: 'unary';
  readonly operator: 'NOT' | 'IS NULL' | 'IS NOT NULL';
  readonly operand: ExpressionNode;
}
export interface FunctionNode {
  readonly kind: 'function';
  readonly name: string;
  readonly args: readonly ExpressionNode[];
  readonly distinct?: boolean;
  /** Aggregate and window functions are the only valid operands of OVER. */
  readonly role?: 'aggregate' | 'window';
}
export interface CaseNode {
  readonly kind: 'case';
  readonly branches: readonly { readonly when: ExpressionNode; readonly result: ExpressionNode }[];
  readonly otherwise?: ExpressionNode;
}
export interface DatePartNode {
  readonly kind: 'date-part';
  readonly part:
    | 'YEAR'
    | 'QUARTER'
    | 'MONTH'
    | 'WEEK'
    | 'DAY'
    | 'HOUR'
    | 'MINUTE'
    | 'SECOND'
    | 'MILLISECOND'
    | 'MICROSECOND'
    | 'NANOSECOND';
}
export interface InNode {
  readonly kind: 'in';
  readonly operand: ExpressionNode;
  readonly values: readonly ExpressionNode[];
  readonly negate: boolean;
}
/** The unit of an interval offset in a RANGE window frame. */
export type IntervalUnit =
  | 'YEAR'
  | 'QUARTER'
  | 'MONTH'
  | 'WEEK'
  | 'DAY'
  | 'HOUR'
  | 'MINUTE'
  | 'SECOND'
  | 'MILLISECOND';
/** A window frame boundary, such as `3 PRECEDING` or `INTERVAL '1 DAY' PRECEDING`. */
export interface FrameBoundaryNode {
  readonly bound:
    | 'UNBOUNDED PRECEDING'
    | 'PRECEDING'
    | 'CURRENT ROW'
    | 'FOLLOWING'
    | 'UNBOUNDED FOLLOWING';
  readonly offset?: number;
  readonly unit?: IntervalUnit;
}
/** A `ROWS` or `RANGE` window frame. */
export interface WindowFrameNode {
  readonly units: 'ROWS' | 'RANGE';
  readonly start: FrameBoundaryNode;
  readonly end: FrameBoundaryNode;
}
export interface WindowNode {
  readonly kind: 'window';
  readonly value: FunctionNode;
  readonly partitionBy: readonly ExpressionNode[];
  readonly orderBy: readonly OrderNode[];
  readonly frame?: WindowFrameNode;
}
export interface JsonPathNode {
  readonly kind: 'json-path';
  readonly value: ExpressionNode;
  readonly path: readonly (string | number)[];
}
export interface CastNode {
  readonly kind: 'cast';
  readonly value: ExpressionNode;
  readonly target:
    | 'VARCHAR'
    | `NUMBER(${number},${number})`
    | 'DOUBLE'
    | 'BOOLEAN'
    | 'DATE'
    | 'TIME'
    | 'TIMESTAMP_NTZ'
    | 'TIMESTAMP_LTZ'
    | 'TIMESTAMP_TZ'
    | 'ARRAY'
    | 'OBJECT'
    | `VECTOR(${'INT' | 'FLOAT'}, ${number})`
    | `${'ARRAY' | 'OBJECT' | 'MAP'}(${string})`;
}
/**
 * A scalar subquery, `(SELECT ...)`. `correlated` lists the enclosing sources the inner query may
 * reference.
 */
export interface SubqueryNode {
  readonly kind: 'subquery';
  readonly query: SelectNode;
  readonly correlated: readonly SourceReference[];
}
/** `EXISTS (subquery)`, or `NOT EXISTS` when `negate` is set. */
export interface ExistsNode {
  readonly kind: 'exists';
  readonly query: SelectNode;
  readonly correlated: readonly SourceReference[];
  readonly negate: boolean;
}
/** `operand IN (subquery)`, or `NOT IN` when `negate` is set. */
export interface InSubqueryNode {
  readonly kind: 'in-subquery';
  readonly operand: ExpressionNode;
  readonly query: SelectNode;
  readonly correlated: readonly SourceReference[];
  readonly negate: boolean;
}
/**
 * A MATCH_RECOGNIZE navigation function such as `PREV(value, 1)`. Snowflake requires constant
 * offsets.
 */
export interface NavigationNode {
  readonly kind: 'navigation';
  readonly name: 'PREV' | 'NEXT' | 'FIRST' | 'LAST' | 'LAG' | 'LEAD';
  readonly value: ExpressionNode;
  readonly offset?: number;
  readonly default?: ExpressionNode;
}
/** `RUNNING` or `FINAL` semantics around a MATCH_RECOGNIZE measure. */
export interface SemanticsNode {
  readonly kind: 'semantics';
  readonly mode: 'RUNNING' | 'FINAL';
  readonly value: ExpressionNode;
}
/** `*`, or `qualifier.*` when a qualifier is given. */
export interface StarNode {
  readonly kind: 'star';
  readonly qualifier?: IdentifierNode;
}
/** Any node that compiles to an SQL expression. */
export type ExpressionNode =
  | IdentifierNode
  | ReferenceNode
  | ParameterNode
  | BinaryNode
  | ArithmeticNode
  | LogicalNode
  | UnaryNode
  | FunctionNode
  | CaseNode
  | DatePartNode
  | InNode
  | WindowNode
  | JsonPathNode
  | CastNode
  | SubqueryNode
  | ExistsNode
  | InSubqueryNode
  | NavigationNode
  | SemanticsNode
  | StarNode;
/**
 * A `column = value` filter on an unqualified column. A `null` value compiles to `column IS NULL`.
 */
export interface EqualityNode {
  readonly kind: 'equality';
  readonly column: IdentifierNode;
  readonly value: BindValue;
}
/** An ORDER BY item. */
export interface OrderNode {
  readonly expression: ExpressionNode;
  readonly direction: 'ASC' | 'DESC';
  readonly nulls?: 'FIRST' | 'LAST';
}
/**
 * A time-travel clause: `AT` or `BEFORE` with a timestamp, an offset in seconds, or a statement ID.
 */
export interface TemporalNode {
  readonly mode: 'AT' | 'BEFORE';
  readonly selector: 'TIMESTAMP' | 'OFFSET' | 'STATEMENT';
  readonly value: BindValue;
}
/** A base table, optionally aliased and read at a point in time. */
export interface TableNode {
  readonly kind: 'table';
  readonly name: IdentifierNode;
  readonly alias?: IdentifierNode;
  readonly temporal?: TemporalNode;
}
/** A query used as a table: `(query) AS alias`. */
export interface DerivedNode {
  readonly kind: 'derived';
  readonly query: QueryNode;
  readonly alias: IdentifierNode;
}
/** A `LATERAL FLATTEN(INPUT => ...)` table function. */
export interface FlattenNode {
  readonly kind: 'flatten';
  readonly input: ExpressionNode;
  readonly alias: IdentifierNode;
  readonly path: string;
  readonly outer: boolean;
  readonly recursive: boolean;
  readonly mode: 'OBJECT' | 'ARRAY' | 'BOTH';
}
/** A common table expression in a WITH clause. */
export interface CteNode {
  readonly kind: 'cte';
  readonly name: IdentifierNode;
  readonly query: QueryNode;
  /** Present on recursive definitions; the recursive branch reads the CTE through it. */
  readonly self?: SelfReferenceNode;
}
/** A MATCH_RECOGNIZE row pattern. */
export type PatternNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'anchor'; readonly position: 'start' | 'end' }
  | { readonly kind: 'sequence'; readonly items: readonly PatternNode[] }
  | { readonly kind: 'alternation'; readonly items: readonly PatternNode[] }
  | { readonly kind: 'permute'; readonly items: readonly PatternNode[] }
  | { readonly kind: 'exclusion'; readonly pattern: PatternNode }
  | {
      readonly kind: 'quantifier';
      readonly pattern: PatternNode;
      readonly min: number;
      readonly max?: number;
      readonly reluctant: boolean;
    };
/** A MATCH_RECOGNIZE clause over a source query. */
export interface MatchRecognizeNode {
  readonly kind: 'match-recognize';
  readonly source: SelectNode;
  readonly partitionBy: readonly ExpressionNode[];
  readonly orderBy: readonly OrderNode[];
  readonly measures: readonly { readonly value: ExpressionNode; readonly alias: IdentifierNode }[];
  readonly rowsPerMatch: 'one' | 'all' | 'all-omit-empty' | 'all-with-unmatched';
  readonly afterMatch?:
    | { readonly kind: 'past-last-row' | 'to-next-row' }
    | { readonly kind: 'to-first' | 'to-last'; readonly variable: string };
  readonly pattern: PatternNode;
  /** Variable names are emitted uppercase because PATTERN folds even quoted names. */
  readonly define: readonly { readonly variable: string; readonly predicate: ExpressionNode }[];
  readonly alias: IdentifierNode;
  /** Every output column; without it, quoted partition names come back with their quotes. */
  readonly columns: readonly IdentifierNode[];
}
/** A literal value in a PIVOT `IN` list. */
export type PivotLiteral = string | number | boolean;
/** A PIVOT over a source query. */
export interface PivotNode {
  readonly kind: 'pivot';
  readonly source: SelectNode;
  readonly aggregate: 'SUM' | 'MIN' | 'MAX' | 'COUNT';
  readonly value: IdentifierNode;
  readonly for: IdentifierNode;
  /** Snowflake names pivot columns from literal SQL text, so values cannot be bound. */
  readonly values:
    | readonly PivotLiteral[]
    | { readonly kind: 'any'; readonly direction?: 'ASC' | 'DESC' };
  readonly default?: ExpressionNode;
  readonly alias: IdentifierNode;
  /** Every output column; without it, explicit IN lists mangle quoted grouping names. */
  readonly columns?: readonly IdentifierNode[];
}
/** An UNPIVOT over a source query. */
export interface UnpivotNode {
  readonly kind: 'unpivot';
  readonly source: SelectNode;
  readonly value: IdentifierNode;
  readonly name: IdentifierNode;
  readonly columns: readonly IdentifierNode[];
  readonly includeNulls: boolean;
  readonly alias: IdentifierNode;
}
/**
 * The recursive CTE as referenced from its own recursive branch. Valid only while compiling the
 * recursive branch of the CTE that owns it.
 */
export interface SelfReferenceNode {
  readonly kind: 'self-reference';
  readonly name: IdentifierNode;
  readonly columns: readonly string[];
}
/** Anything that can appear in FROM or a join. */
export type RelationNode =
  | IdentifierNode
  | TableNode
  | DerivedNode
  | FlattenNode
  | CteNode
  | MatchRecognizeNode
  | PivotNode
  | UnpivotNode
  | SelfReferenceNode;
/** A join. `on` is the join predicate, and `match` is the MATCH_CONDITION of an ASOF join. */
export interface JoinNode {
  readonly kind: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' | 'ASOF' | 'LATERAL';
  readonly source: RelationNode;
  readonly on?: ExpressionNode;
  readonly match?: ExpressionNode;
}
/** A SELECT statement. */
export interface SelectNode {
  readonly kind: 'select';
  readonly from: RelationNode;
  readonly projections: readonly {
    readonly column: ExpressionNode;
    readonly alias: string;
    readonly wireType?: WireType;
  }[];
  readonly where?: ExpressionNode | EqualityNode;
  readonly joins?: readonly JoinNode[];
  readonly distinct?: boolean;
  readonly groupBy?: readonly ExpressionNode[];
  readonly having?: ExpressionNode;
  readonly qualify?: ExpressionNode;
  readonly orderBy?: readonly OrderNode[];
  readonly limit?: number;
  readonly offset?: number;
  readonly with?: readonly CteNode[];
}
/** A set operator between two queries. */
export type SetOperator = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT';
/**
 * Two queries combined with a set operator. Operands are always parenthesized, so the tree, not
 * keyword precedence, defines grouping.
 */
export interface SetOperationNode {
  readonly kind: 'set-operation';
  readonly operator: SetOperator;
  readonly left: QueryNode;
  readonly right: QueryNode;
  readonly columns: readonly { readonly alias: string; readonly wireType?: WireType }[];
  readonly orderBy?: readonly OrderNode[];
  readonly limit?: number;
  readonly offset?: number;
  readonly with?: readonly CteNode[];
}
/** A statement that returns rows. */
export type QueryNode = SelectNode | SetOperationNode;
/**
 * `DEFAULT` in an INSERT row, which lets Snowflake apply the column's default, identity, or NULL.
 */
export interface DefaultNode {
  readonly kind: 'default';
  /** A typed NULL for the shared source row, needed where a bare NULL cannot join a UNION. */
  readonly placeholder?: ExpressionNode;
}
/** An INSERT of value rows, or of a query's rows when `query` is set. */
export interface InsertNode {
  readonly kind: 'insert';
  readonly table: IdentifierNode;
  readonly columns: readonly IdentifierNode[];
  readonly rows: readonly (readonly (ExpressionNode | DefaultNode)[])[];
  readonly query?: SelectNode;
}
/** A `column = value` assignment in UPDATE or MERGE. */
export interface AssignmentNode {
  readonly column: IdentifierNode;
  readonly value: ExpressionNode;
}
/** An UPDATE statement, optionally with a FROM source. */
export interface UpdateNode {
  readonly kind: 'update';
  readonly table: IdentifierNode;
  readonly alias?: IdentifierNode;
  readonly assignments: readonly AssignmentNode[];
  readonly from?: RelationNode;
  readonly where?: ExpressionNode;
}
/** A DELETE statement, optionally with a USING source. */
export interface DeleteNode {
  readonly kind: 'delete';
  readonly table: IdentifierNode;
  readonly alias?: IdentifierNode;
  readonly using?: RelationNode;
  readonly where?: ExpressionNode;
}
/** A `WHEN [NOT] MATCHED` branch of a MERGE. */
export type MergeBranchNode =
  | {
      readonly kind: 'matched-update';
      readonly condition?: ExpressionNode;
      readonly assignments: readonly AssignmentNode[];
    }
  | { readonly kind: 'matched-delete'; readonly condition?: ExpressionNode }
  | {
      readonly kind: 'not-matched-insert';
      readonly condition?: ExpressionNode;
      readonly columns: readonly IdentifierNode[];
      readonly values: readonly ExpressionNode[];
    };
/** A MERGE statement. Branches are emitted in order. */
export interface MergeNode {
  readonly kind: 'merge';
  readonly target: TableNode;
  readonly source: RelationNode;
  readonly on: ExpressionNode;
  readonly branches?: readonly MergeBranchNode[];
  /** @deprecated Use `branches`. */
  readonly matched?: readonly AssignmentNode[];
  /** @deprecated Use `branches`. */
  readonly insert?: {
    readonly columns: readonly IdentifierNode[];
    readonly values: readonly ExpressionNode[];
  };
  /** @deprecated Use `branches`. */
  readonly deleteMatched?: boolean;
}
/** Any statement {@link compileAst} can compile. */
export type StatementNode = QueryNode | InsertNode | UpdateNode | DeleteNode | MergeNode;
/** SQL text with `?` placeholders and the values bound to them, in order. */
export interface CompiledQuery {
  /** The SQL text. */
  readonly sql: string;
  /** The bind values, one per `?` placeholder. */
  readonly binds: readonly BindValue[];
}

/**
 * Builds an identifier node from one or more parts.
 *
 * @throws `TypeError` when a part is empty, contains NUL, or is longer than 255 characters.
 *
 * @example
 * ```ts
 * quoteIdentifier(identifier('APP_DB', 'PUBLIC', 'my "table"'));
 * // '"APP_DB"."PUBLIC"."my ""table"""'
 * ```
 */
export function identifier(...parts: [string, ...string[]]): IdentifierNode {
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part.includes('\0') || [...part].length > 255)
  ) {
    throw new TypeError(
      'Identifiers need non-empty components of at most 255 characters without NUL.',
    );
  }
  return Object.freeze({ kind: 'identifier', parts: Object.freeze([...parts]) });
}
/** Renders an identifier node as SQL, quoting every part and doubling embedded quotes. */
export function quoteIdentifier(node: IdentifierNode): string {
  return node.parts.map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
}

/**
 * Compiles a statement node to SQL text and bind values.
 *
 * `compileAst(query.ast)` returns the same result as `query.compile()`.
 */
export function compileAst(statement: StatementNode): CompiledQuery {
  // A new context per statement prevents binds leaking across reusable queries.
  const binds: BindValue[] = [];
  const active = new Set<SelfReferenceNode>();
  function parameter(value: BindValue): string {
    binds.push(value);
    return '?';
  }
  function expression(node: ExpressionNode, qualify = false): string {
    switch (node.kind) {
      case 'identifier':
        return quoteIdentifier(node);
      case 'reference':
        return `${qualify ? `${quoteIdentifier(node.source.qualifier)}.` : ''}${quoteIdentifier(node.column)}`;
      case 'parameter':
        return parameter(node.value);
      case 'binary':
      case 'arithmetic':
        return `(${expression(node.left, qualify)} ${node.operator} ${expression(node.right, qualify)})`;
      case 'logical':
        return `(${node.operands.map((item) => expression(item, qualify)).join(` ${node.operator} `)})`;
      case 'unary':
        return node.operator === 'NOT'
          ? `(NOT ${expression(node.operand, qualify)})`
          : `(${expression(node.operand, qualify)} ${node.operator})`;
      case 'function':
        return `${node.name}(${node.distinct ? 'DISTINCT ' : ''}${node.args.length ? node.args.map((arg) => expression(arg, qualify)).join(', ') : node.name === 'COUNT' ? '*' : ''})`;
      case 'case':
        return `CASE ${node.branches.map((branch) => `WHEN ${expression(branch.when, qualify)} THEN ${expression(branch.result, qualify)}`).join(' ')}${node.otherwise ? ` ELSE ${expression(node.otherwise, qualify)}` : ''} END`;
      case 'date-part':
        return node.part;
      case 'in':
        return node.values.length === 0
          ? node.negate
            ? 'TRUE'
            : 'FALSE'
          : `(${expression(node.operand, qualify)} ${node.negate ? 'NOT IN' : 'IN'} (${node.values.map((value) => expression(value, qualify)).join(', ')}))`;
      case 'window':
        return `${expression(node.value, qualify)} OVER (${[
          node.partitionBy.length
            ? `PARTITION BY ${node.partitionBy.map((value) => expression(value, qualify)).join(', ')}`
            : '',
          node.orderBy.length
            ? `ORDER BY ${node.orderBy.map((value) => order(value, qualify)).join(', ')}`
            : '',
          node.frame
            ? `${node.frame.units} BETWEEN ${boundary(node.frame.start)} AND ${boundary(node.frame.end)}`
            : '',
        ]
          .filter(Boolean)
          .join(' ')})`;
      case 'json-path':
        return node.path.reduce<string>(
          (value, part) => `GET(${value}, ${parameter(part)})`,
          expression(node.value, qualify),
        );
      case 'cast':
        return `CAST(${expression(node.value, qualify)} AS ${node.target})`;
      case 'subquery':
        return `(${selectStatement(node.query, false, true)})`;
      case 'exists':
        return `(${node.negate ? 'NOT ' : ''}EXISTS (${selectStatement(node.query, false, true)}))`;
      case 'in-subquery':
        return `(${expression(node.operand, qualify)} ${node.negate ? 'NOT IN' : 'IN'} (${selectStatement(node.query, false, true)}))`;
      case 'navigation': {
        if (node.offset !== undefined && (!Number.isSafeInteger(node.offset) || node.offset < 0))
          throw new TypeError('Navigation offsets must be nonnegative safe integers.');
        const value = expression(node.value, qualify);
        const offset = node.offset ?? (node.default ? 1 : undefined);
        return `${node.name}(${value}${offset === undefined ? '' : `, ${offset}`}${node.default ? `, ${expression(node.default, qualify)}` : ''})`;
      }
      case 'semantics':
        return `${node.mode} ${expression(node.value, qualify)}`;
      case 'star':
        return node.qualifier ? `${quoteIdentifier(node.qualifier)}.*` : '*';
      default:
        throw new TypeError('Unsupported expression AST node.');
    }
  }
  function order(node: OrderNode, qualify: boolean, rendered?: string): string {
    return `${rendered ?? expression(node.expression, qualify)} ${node.direction}${node.nulls ? ` NULLS ${node.nulls}` : ''}`;
  }
  function projectionOf(node: SelectNode, value: ExpressionNode) {
    const key = JSON.stringify(value);
    return node.projections.find((projection) => JSON.stringify(projection.column) === key);
  }
  function boundary(node: FrameBoundaryNode): string {
    if (node.offset === undefined) return node.bound;
    return `${node.unit ? `INTERVAL '${node.offset} ${node.unit}'` : node.offset} ${node.bound}`;
  }
  function literal(value: PivotLiteral): string {
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('PIVOT values must be finite numbers.');
      return String(value);
    }
    if (value.includes('\0')) throw new TypeError('PIVOT values cannot contain NUL.');
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
  }
  function pivotValues(node: PivotNode): string {
    if ('kind' in node.values) {
      const { direction } = node.values;
      return `ANY${direction ? ` ORDER BY ${quoteIdentifier(node.for)} ${direction}` : ''}`;
    }
    return node.values.map(literal).join(', ');
  }
  function source(node: RelationNode): string {
    switch (node.kind) {
      case 'identifier':
        return quoteIdentifier(node);
      case 'table':
        return `${quoteIdentifier(node.name)}${node.temporal ? ` ${node.temporal.mode} (${node.temporal.selector} => ${parameter(node.temporal.value)}${node.temporal.selector === 'TIMESTAMP' ? '::TIMESTAMP_TZ' : ''})` : ''}${node.alias ? ` AS ${quoteIdentifier(node.alias)}` : ''}`;
      case 'derived':
        return `(${queryStatement(node.query)}) AS ${quoteIdentifier(node.alias)}`;
      case 'cte':
        return quoteIdentifier(node.name);
      case 'match-recognize':
        return matchRecognize(node);
      case 'pivot': {
        if (!['SUM', 'MIN', 'MAX', 'COUNT'].includes(node.aggregate))
          throw new TypeError('Unsupported PIVOT aggregate.');
        return `(${selectStatement(node.source)}) PIVOT (${node.aggregate}(${quoteIdentifier(node.value)}) FOR ${quoteIdentifier(node.for)} IN (${pivotValues(node)})${node.default ? ` DEFAULT ON NULL (${expression(node.default)})` : ''}) AS ${quoteIdentifier(node.alias)}${node.columns ? ` (${node.columns.map(quoteIdentifier).join(', ')})` : ''}`;
      }
      case 'unpivot':
        return `(${selectStatement(node.source)}) UNPIVOT${node.includeNulls ? ' INCLUDE NULLS' : ''} (${quoteIdentifier(node.value)} FOR ${quoteIdentifier(node.name)} IN (${node.columns.map(quoteIdentifier).join(', ')})) AS ${quoteIdentifier(node.alias)}`;
      case 'self-reference':
        if (!active.has(node))
          throw new TypeError('A recursive CTE reference is only valid in its recursive branch.');
        return quoteIdentifier(node.name);
      case 'flatten':
        return `FLATTEN(INPUT => ${expression(node.input, true)}, PATH => ${parameter(node.path)}, OUTER => ${node.outer ? 'TRUE' : 'FALSE'}, RECURSIVE => ${node.recursive ? 'TRUE' : 'FALSE'}, MODE => '${node.mode}') AS ${quoteIdentifier(node.alias)}`;
      default:
        throw new TypeError('Unsupported relation AST node.');
    }
  }
  function pattern(node: PatternNode): string {
    switch (node.kind) {
      case 'variable':
        return quoteIdentifier(identifier(node.name.toUpperCase()));
      case 'anchor':
        return node.position === 'start' ? '^' : '$';
      case 'sequence':
        return node.items.map(pattern).join(' ');
      case 'alternation':
        return `(${node.items.map(pattern).join(' | ')})`;
      case 'permute':
        return `PERMUTE(${node.items.map(pattern).join(', ')})`;
      case 'exclusion':
        return `{- ${pattern(node.pattern)} -}`;
      case 'quantifier': {
        const { min, max, reluctant } = node;
        let suffix: string;
        if (max === undefined) suffix = min === 0 ? '*' : min === 1 ? '+' : `{${min},}`;
        else if (min === max) suffix = `{${min}}`;
        else suffix = min === 0 && max === 1 ? '?' : `{${min},${max}}`;
        // Snowflake rejects a reluctant {n} and {n,} for n > 1; {n} is exact either way.
        if (reluctant && max === undefined && min > 1)
          throw new TypeError('Reluctant quantifiers need an upper bound beyond one or more.');
        const inner = pattern(node.pattern);
        return `${node.pattern.kind === 'variable' || node.pattern.kind === 'alternation' || node.pattern.kind === 'permute' ? inner : `(${inner})`}${suffix}${reluctant && min !== max ? '?' : ''}`;
      }
      default:
        throw new TypeError('Unsupported pattern AST node.');
    }
  }
  function matchRecognize(node: MatchRecognizeNode): string {
    const rows = {
      one: 'ONE ROW PER MATCH',
      all: 'ALL ROWS PER MATCH SHOW EMPTY MATCHES',
      'all-omit-empty': 'ALL ROWS PER MATCH OMIT EMPTY MATCHES',
      'all-with-unmatched': 'ALL ROWS PER MATCH WITH UNMATCHED ROWS',
    }[node.rowsPerMatch];
    if (!rows) throw new TypeError('Unsupported rows-per-match mode.');
    const parts = [`(${selectStatement(node.source)}) MATCH_RECOGNIZE (`];
    const clauses: string[] = [];
    if (node.partitionBy.length)
      clauses.push(`PARTITION BY ${node.partitionBy.map((value) => expression(value)).join(', ')}`);
    if (node.orderBy.length)
      clauses.push(`ORDER BY ${node.orderBy.map((value) => order(value, false)).join(', ')}`);
    if (node.measures.length)
      clauses.push(
        `MEASURES ${node.measures.map(({ value, alias }) => `${expression(value)} AS ${quoteIdentifier(alias)}`).join(', ')}`,
      );
    clauses.push(rows);
    const skip = node.afterMatch;
    if (skip)
      clauses.push(
        `AFTER MATCH SKIP ${
          'variable' in skip
            ? // SKIP TO keeps quotes as part of the name, so the target is emitted unquoted.
              `TO ${skip.kind === 'to-first' ? 'FIRST' : 'LAST'} ${skip.variable.toUpperCase()}`
            : skip.kind === 'past-last-row'
              ? 'PAST LAST ROW'
              : 'TO NEXT ROW'
        }`,
      );
    clauses.push(`PATTERN (${pattern(node.pattern)})`);
    if (!node.define.length) throw new TypeError('MATCH_RECOGNIZE requires a DEFINE entry.');
    clauses.push(
      `DEFINE ${node.define.map(({ variable, predicate }) => `${quoteIdentifier(identifier(variable.toUpperCase()))} AS ${expression(predicate)}`).join(', ')}`,
    );
    parts.push(clauses.join(' '));
    return `${parts.join('')}) AS ${quoteIdentifier(node.alias)} (${node.columns.map(quoteIdentifier).join(', ')})`;
  }
  function wire(value: string, type?: WireType): string {
    if (!type) return value;
    if (type === 'variant') return `TO_JSON(${value})`;
    if (type === 'geography') return `TO_JSON(ST_ASGEOJSON(${value}))`;
    if (type === 'geometry') return `ST_ASEWKB(${value})`;
    if (type === 'structured') return `TO_JSON(CAST(${value} AS VARIANT))`;
    if (type === 'float') {
      // Text conversion keeps at most 16 digits, so send an exact integer significand and a
      // binary exponent instead. The scale is split to stay finite for subnormals.
      const scale = `(60 - FLOOR(LOG(2, ABS(${value}))))`;
      return `CASE WHEN ABS(${value}) > 0 AND ABS(${value}) < 'inf'::DOUBLE THEN TO_VARCHAR((${value} * POW(2, FLOOR(${scale} / 2)) * POW(2, ${scale} - FLOOR(${scale} / 2)))::NUMBER(38, 0)) || 'p' || TO_VARCHAR(-${scale}) ELSE TO_VARCHAR(${value}) END`;
    }
    const formats: Partial<Record<WireType, string>> = {
      date: 'YYYY-MM-DD',
      time: 'HH24:MI:SS.FF9',
      timestamp_ntz: 'YYYY-MM-DD HH24:MI:SS.FF9',
      timestamp_ltz: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
      timestamp_tz: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
    };
    const format = formats[type];
    return `TO_VARCHAR(${value}${format ? `, '${format}'` : ''})`;
  }
  function definition(cte: CteNode): string {
    if (!cte.self) return `${quoteIdentifier(cte.name)} AS (${queryStatement(cte.query)})`;
    const { with: _, ...query } = cte.query;
    active.add(cte.self);
    const body = queryStatement(query as QueryNode);
    active.delete(cte.self);
    return `${quoteIdentifier(cte.name)} (${cte.self.columns.map((column) => quoteIdentifier(identifier(column))).join(', ')}) AS (${body})`;
  }
  function withClause(ctes: readonly CteNode[] | undefined): string {
    if (!ctes?.length) return '';
    const ordered: CteNode[] = [];
    // Snowflake cannot see a WITH nested in a recursive definition, so its CTEs precede it.
    const add = (cte: CteNode) => {
      if (ordered.includes(cte)) return;
      if (cte.self) cte.query.with?.forEach(add);
      if (ordered.some((item) => quoteIdentifier(item.name) === quoteIdentifier(cte.name)))
        throw new TypeError('One WITH clause cannot define different CTEs with the same name.');
      ordered.push(cte);
    };
    ctes.forEach(add);
    return `WITH ${ordered.some((cte) => cte.self) ? 'RECURSIVE ' : ''}${ordered.map(definition).join(', ')} `;
  }
  function queryStatement(node: QueryNode, wireOutput = false): string {
    return node.kind === 'select'
      ? selectStatement(node, wireOutput)
      : setStatement(node, wireOutput);
  }
  function setStatement(node: SetOperationNode, wireOutput: boolean): string {
    let text = withClause(node.with);
    const wrapped =
      Boolean(node.orderBy?.length) ||
      node.limit !== undefined ||
      node.offset !== undefined ||
      (wireOutput && node.columns.some((column) => column.wireType));
    if (wrapped)
      text += `SELECT ${node.columns.map(({ alias, wireType }) => `${wire(quoteIdentifier(identifier('__sflib_result', alias)), wireOutput ? wireType : undefined)} AS ${quoteIdentifier(identifier(alias))}`).join(', ')} FROM (`;
    text += `(${queryStatement(node.left)}) ${node.operator} (${queryStatement(node.right)})`;
    if (!wrapped) return text;
    text += ') AS "__sflib_result"';
    if (node.orderBy?.length)
      text += ` ORDER BY ${node.orderBy.map((value) => order(value, true)).join(', ')}`;
    if (node.limit !== undefined) text += ` LIMIT ${node.limit}`;
    if (node.offset !== undefined) text += ` OFFSET ${node.offset}`;
    return text;
  }
  function selectStatement(node: SelectNode, wireOutput = false, nested = false): string {
    if (wireOutput && node.projections.some((item) => item.wireType)) {
      // Serialize only after relational operations, preserving native numeric/temporal sort,
      // DISTINCT, grouping, and the SQL types of nested CTEs and subqueries.
      const extras: { column: ExpressionNode; alias: string }[] = [];
      const used = new Set(node.projections.map((item) => item.alias));
      const ordering = (node.orderBy ?? []).map((item, index) => {
        const projected = projectionOf(node, item.expression);
        if (node.distinct && !projected)
          throw new TypeError('DISTINCT ORDER BY expressions must be projected.');
        let name = projected?.alias;
        if (!name) {
          name = `__sflib_order_${index}`;
          while (used.has(name)) name += '_';
          used.add(name);
          extras.push({ column: item.expression, alias: name });
        }
        return order(item, false, quoteIdentifier(identifier('__sflib_result', name)));
      });
      const native = selectStatement(
        { ...node, projections: [...node.projections, ...extras] },
        false,
      );
      const projected = node.projections
        .map(
          (item) =>
            `${wire(quoteIdentifier(identifier('__sflib_result', item.alias)), item.wireType)} AS ${quoteIdentifier(identifier(item.alias))}`,
        )
        .join(', ');
      return `SELECT ${projected} FROM (${native}) AS "__sflib_result"${ordering.length ? ` ORDER BY ${ordering.join(', ')}` : ''}`;
    }
    // Nested queries qualify every reference so correlated outer columns cannot be captured.
    const qualified =
      nested ||
      Boolean(node.joins?.length) ||
      node.from.kind === 'derived' ||
      node.from.kind === 'cte';
    let text = withClause(node.with);
    const projected = node.projections.length
      ? node.projections
          .map(
            ({ column, alias, wireType }) =>
              `${wire(expression(column, qualified), wireOutput ? wireType : undefined)} AS ${quoteIdentifier(identifier(alias))}`,
          )
          .join(', ')
      : '*';
    text += `SELECT ${node.distinct ? 'DISTINCT ' : ''}${projected} FROM ${source(node.from)}`;
    for (const join of node.joins ?? []) {
      text +=
        join.kind === 'LATERAL'
          ? `, LATERAL ${source(join.source)}`
          : ` ${join.kind} JOIN ${source(join.source)}`;
      if (join.match) text += ` MATCH_CONDITION ${expression(join.match, true)}`;
      if (join.on) text += ` ON ${expression(join.on, true)}`;
    }
    if (node.where)
      text += ` WHERE ${node.where.kind === 'equality' ? `${quoteIdentifier(node.where.column)} ${node.where.value === null ? 'IS NULL' : `= ${parameter(node.where.value)}`}` : expression(node.where, qualified)}`;
    if (node.groupBy?.length)
      text += ` GROUP BY ${node.groupBy.map((value) => expression(value, qualified)).join(', ')}`;
    if (node.having) text += ` HAVING ${expression(node.having, qualified)}`;
    if (node.qualify) text += ` QUALIFY ${expression(node.qualify, qualified)}`;
    if (node.orderBy?.length) {
      // Projected expressions order by alias (windows over aggregates are invalid repeated here);
      // the rest are qualified because ORDER BY resolves bare names to aliases before columns.
      const ordering = node.orderBy.map((value) => {
        const projected = projectionOf(node, value.expression);
        return order(value, true, projected && quoteIdentifier(identifier(projected.alias)));
      });
      text += ` ORDER BY ${ordering.join(', ')}`;
    }
    if (node.limit !== undefined) text += ` LIMIT ${node.limit}`;
    if (node.offset !== undefined) text += ` OFFSET ${node.offset}`;
    return text;
  }
  // DML has no WITH clause of its own, so a CTE source is inlined as a derived query. A
  // recursive CTE cannot be inlined, so the derived query keeps its WITH RECURSIVE.
  function mutationSource(node: RelationNode): string {
    if (node.kind !== 'cte') return source(node);
    const query: QueryNode = node.self
      ? {
          kind: 'select',
          from: node,
          projections: node.self.columns.map((alias) => ({ column: identifier(alias), alias })),
          with: [node],
        }
      : node.query;
    return source({ kind: 'derived', query, alias: node.name });
  }
  function assignments(values: readonly AssignmentNode[], qualified: boolean): string {
    return values
      .map(({ column, value }) => `${quoteIdentifier(column)} = ${expression(value, qualified)}`)
      .join(', ');
  }
  function insertStatement(node: InsertNode): string {
    const target = `${quoteIdentifier(node.table)} (${node.columns.map(quoteIdentifier).join(', ')})`;
    if (node.query) return `INSERT INTO ${target} ${selectStatement(node.query)}`;
    if (!node.rows.some((row) => row.some((value) => value.kind === 'default')))
      return `INSERT INTO ${target} ${node.rows.map((row) => `SELECT ${row.map((value) => expression(value as ExpressionNode)).join(', ')}`).join(' UNION ALL ')}`;
    // VALUES rejects expressions such as PARSE_JSON, so rows with differing omitted columns
    // become one conditional multi-table insert whose branches use DEFAULT per row shape.
    const shapes: string[] = [];
    const sources = node.rows.map((row) => {
      const shape = row
        .map((value, index) =>
          value.kind === 'default' ? 'DEFAULT' : quoteIdentifier(identifier(`__sflib_${index}`)),
        )
        .join(', ');
      if (!shapes.includes(shape)) shapes.push(shape);
      return `SELECT ${shapes.indexOf(shape)} AS "__sflib_shape", ${row.map((value, index) => `${value.kind !== 'default' ? expression(value) : value.placeholder ? expression(value.placeholder) : 'NULL'} AS ${quoteIdentifier(identifier(`__sflib_${index}`))}`).join(', ')}`;
    });
    return `INSERT ALL ${shapes.map((shape, index) => `WHEN "__sflib_shape" = ${index} THEN INTO ${target} VALUES (${shape})`).join(' ')} ${sources.join(' UNION ALL ')}`;
  }
  let sql: string;
  switch (statement.kind) {
    case 'select':
    case 'set-operation':
      sql = queryStatement(statement, true);
      break;
    case 'insert':
      sql = insertStatement(statement);
      break;
    case 'update': {
      const qualified = Boolean(statement.from);
      sql = `UPDATE ${quoteIdentifier(statement.table)}${statement.alias ? ` AS ${quoteIdentifier(statement.alias)}` : ''} SET ${assignments(statement.assignments, qualified)}`;
      if (statement.from) sql += ` FROM ${mutationSource(statement.from)}`;
      if (statement.where) sql += ` WHERE ${expression(statement.where, qualified)}`;
      break;
    }
    case 'delete': {
      const qualified = Boolean(statement.using);
      sql = `DELETE FROM ${quoteIdentifier(statement.table)}${statement.alias ? ` AS ${quoteIdentifier(statement.alias)}` : ''}`;
      if (statement.using) sql += ` USING ${mutationSource(statement.using)}`;
      if (statement.where) sql += ` WHERE ${expression(statement.where, qualified)}`;
      break;
    }
    case 'merge': {
      sql = `MERGE INTO ${source(statement.target)} USING ${mutationSource(statement.source)} ON ${expression(statement.on, true)}`;
      const branches: MergeBranchNode[] = [
        ...(statement.deleteMatched ? [{ kind: 'matched-delete' as const }] : []),
        ...(statement.matched
          ? [{ kind: 'matched-update' as const, assignments: statement.matched }]
          : []),
        ...(statement.insert ? [{ kind: 'not-matched-insert' as const, ...statement.insert }] : []),
        ...(statement.branches ?? []),
      ];
      for (const branch of branches) {
        sql += ` WHEN ${branch.kind === 'not-matched-insert' ? 'NOT MATCHED' : 'MATCHED'}`;
        if (branch.condition) sql += ` AND ${expression(branch.condition, true)}`;
        if (branch.kind === 'matched-update')
          sql += ` THEN UPDATE SET ${assignments(branch.assignments, true)}`;
        else if (branch.kind === 'matched-delete') sql += ' THEN DELETE';
        else
          sql += ` THEN INSERT (${branch.columns.map(quoteIdentifier).join(', ')}) VALUES (${branch.values.map((value) => expression(value, true)).join(', ')})`;
      }
      break;
    }
    default:
      throw new TypeError('Unsupported statement AST node.');
  }
  return Object.freeze({ sql, binds: Object.freeze(binds) });
}
