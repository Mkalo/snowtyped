import type { Key } from './pivot.js';
import type * as Snowtyped from './types.js';

/** @deprecated Use `Snowtyped.AfterMatch`. */
export type AfterMatch<V extends string> = Snowtyped.AfterMatch<V>;
/** @deprecated Use `Snowtyped.AnyColumn`. */
export type AnyColumn = Snowtyped.AnyColumn;
/** @deprecated Use `Snowtyped.AnyExpression`. */
export type AnyExpression = Snowtyped.AnyExpression;
/** @deprecated Use `Snowtyped.AnyStructuredType`. */
export type AnyStructuredType = Snowtyped.AnyStructuredType;
/** @deprecated Use `Snowtyped.AssignmentNode`. */
export type AssignmentNode = Snowtyped.AssignmentNode;
/** @deprecated Use `Snowtyped.BindValue`. */
export type BindValue = Snowtyped.BindValue;
/** @deprecated Use `Snowtyped.BoundColumns`. */
export type BoundColumns<
  C extends Snowtyped.ColumnMap,
  Name extends string,
> = Snowtyped.BoundColumns<C, Name>;
/** @deprecated Use `Snowtyped.CaseExpression`. */
export type CaseExpression<
  T,
  S extends string,
  N extends string,
  D extends Snowtyped.DataType = Snowtyped.DataType,
> = Snowtyped.CaseExpression<T, S, N, D>;
/** @deprecated Use `Snowtyped.CastType`. */
export type CastType = Snowtyped.CastType;
/** @deprecated Use `Snowtyped.CastValue`. */
export type CastValue = Snowtyped.CastValue;
/** @deprecated Use `Snowtyped.Column`. */
export type Column<
  T,
  Required extends boolean = false,
  Scope extends string = string,
  Server extends Snowtyped.ServerValueKind = 'none',
  D extends Snowtyped.DataType = Snowtyped.DataType,
> = Snowtyped.Column<T, Required, Scope, Server, D>;
/** @deprecated Use `Snowtyped.ColumnMap`. */
export type ColumnMap = Snowtyped.ColumnMap;
/** @deprecated Use `Snowtyped.ColumnValue`. */
export type ColumnValue<T, Required extends boolean> = Snowtyped.ColumnValue<T, Required>;
/** @deprecated Use `Snowtyped.CompatibleOperand`. */
export type CompatibleOperand<L, R, LT = object, RT = object> = Snowtyped.CompatibleOperand<
  L,
  R,
  LT,
  RT
>;
/** @deprecated Use `Snowtyped.CompiledQuery`. */
export type CompiledQuery = Snowtyped.CompiledQuery;
/** @deprecated Use `Snowtyped.CteNode`. */
export type CteNode = Snowtyped.CteNode;
/** @deprecated Use `Snowtyped.DataType`. */
export type DataType = Snowtyped.DataType;
/** @deprecated Use `Snowtyped.DatePart`. */
export type DatePart = Snowtyped.DatePart;
/** @deprecated Use `Snowtyped.DefaultNode`. */
export type DefaultNode = Snowtyped.DefaultNode;
/** @deprecated Use `Snowtyped.DefineContext`. */
export type DefineContext<
  C extends Snowtyped.ColumnMap,
  N extends string,
> = Snowtyped.DefineContext<C, N>;
/** @deprecated Use `Snowtyped.DeleteNode`. */
export type DeleteNode = Snowtyped.DeleteNode;
/** @deprecated Use `Snowtyped.DerivedNode`. */
export type DerivedNode = Snowtyped.DerivedNode;
/** @deprecated Use `Snowtyped.EqualityNode`. */
export type EqualityNode = Snowtyped.EqualityNode;
/** @deprecated Use `Snowtyped.ExistsNode`. */
export type ExistsNode = Snowtyped.ExistsNode;
/** @deprecated Use `Snowtyped.Expression`. */
export type Expression<
  T = unknown,
  Scope extends string = string,
  NullScope extends string = Scope,
  D extends Snowtyped.DataType = Snowtyped.DataType,
> = Snowtyped.Expression<T, Scope, NullScope, D>;
/** @deprecated Use `Snowtyped.ExpressionNode`. */
export type ExpressionNode = Snowtyped.ExpressionNode;
/** @deprecated Use `Snowtyped.FilteredMutation`. */
export type FilteredMutation<Scope extends string> = Snowtyped.FilteredMutation<Scope>;
/** @deprecated Use `Snowtyped.FlattenNode`. */
export type FlattenNode = Snowtyped.FlattenNode;
/** @deprecated Use `Snowtyped.FlattenOptions`. */
export type FlattenOptions = Snowtyped.FlattenOptions;
/** @deprecated Use `Snowtyped.FrameBoundary`. */
export type FrameBoundary<
  Offset = {
    readonly unit?: never;
  },
> = Snowtyped.FrameBoundary<Offset>;
/** @deprecated Use `Snowtyped.FrameBoundaryNode`. */
export type FrameBoundaryNode = Snowtyped.FrameBoundaryNode;
/** @deprecated Use `Snowtyped.FramedWindowOptions`. */
export type FramedWindowOptions<S extends string = string> = Snowtyped.FramedWindowOptions<S>;
/** @deprecated Use `Snowtyped.GeoJsonGeometry`. */
export type GeoJsonGeometry = Snowtyped.GeoJsonGeometry;
/** @deprecated Use `Snowtyped.GeoPosition`. */
export type GeoPosition = Snowtyped.GeoPosition;
/** @deprecated Use `Snowtyped.IdentifierNode`. */
export type IdentifierNode = Snowtyped.IdentifierNode;
/** @deprecated Use `Snowtyped.IdentityOptions`. */
export type IdentityOptions = Snowtyped.IdentityOptions;
/** @deprecated Use `Snowtyped.InferColumn`. */
export type InferColumn<C> = Snowtyped.InferColumn<C>;
/** @deprecated Use `Snowtyped.InferExpression`. */
export type InferExpression<E> = Snowtyped.InferExpression<E>;
/** @deprecated Use `Snowtyped.InferSelection`. */
export type InferSelection<
  S extends Snowtyped.Projection,
  Nullable extends string = never,
> = Snowtyped.InferSelection<S, Nullable>;
/** @deprecated Use `Snowtyped.InferStructured`. */
export type InferStructured<S> = Snowtyped.InferStructured<S>;
/** @deprecated Use `Snowtyped.InsertNode`. */
export type InsertNode = Snowtyped.InsertNode;
/** @deprecated Use `Snowtyped.InsertSource`. */
export type InsertSource<C extends Snowtyped.ColumnMap, Row> = Snowtyped.InsertSource<C, Row>;
/** @deprecated Use `Snowtyped.InsertValues`. */
export type InsertValues<C extends Snowtyped.ColumnMap> = Snowtyped.InsertValues<C>;
/** @deprecated Use `Snowtyped.InSubqueryNode`. */
export type InSubqueryNode = Snowtyped.InSubqueryNode;
/** @deprecated Use `Snowtyped.IntersectRow`. */
export type IntersectRow<L, R> = Snowtyped.IntersectRow<L, R>;
/** @deprecated Use `Snowtyped.IntervalUnit`. */
export type IntervalUnit = Snowtyped.IntervalUnit;
/** @deprecated Use `Snowtyped.IntrospectedColumn`. */
export type IntrospectedColumn = Snowtyped.IntrospectedColumn;
/** @deprecated Use `Snowtyped.IntrospectedTable`. */
export type IntrospectedTable = Snowtyped.IntrospectedTable;
/** @deprecated Use `Snowtyped.JoinNode`. */
export type JoinNode = Snowtyped.JoinNode;
/** @deprecated Use `Snowtyped.LoadedQuery`. */
export type LoadedQuery<Row> = Snowtyped.LoadedQuery<Row>;
/** @deprecated Use `Snowtyped.LoadedRow`. */
export type LoadedRow<Row, R> = Snowtyped.LoadedRow<Row, R>;
/** @deprecated Use `Snowtyped.LoadOptions`. */
export type LoadOptions = Snowtyped.LoadOptions;
/** @deprecated Use `Snowtyped.MatchRecognizeColumns`. */
export type MatchRecognizeColumns<
  C extends Snowtyped.ColumnMap,
  P extends keyof C,
  M extends Snowtyped.Selection,
  R extends Snowtyped.RowsPerMatch,
  E extends boolean,
> = Snowtyped.MatchRecognizeColumns<C, P, M, R, E>;
/** @deprecated Use `Snowtyped.MatchRecognizeNode`. */
export type MatchRecognizeNode = Snowtyped.MatchRecognizeNode;
/** @deprecated Use `Snowtyped.MatchRecognizeOptions`. */
export type MatchRecognizeOptions<
  C extends Snowtyped.ColumnMap,
  N extends string,
  P extends readonly (keyof C & string)[],
  V extends string,
  E extends boolean,
  D,
  M,
  R extends Snowtyped.RowsPerMatch,
> = Snowtyped.MatchRecognizeOptions<C, N, P, V, E, D, M, R>;
/** @deprecated Use `Snowtyped.MatchRowScope`. */
export type MatchRowScope<N extends string> = Snowtyped.MatchRowScope<N>;
/** @deprecated Use `Snowtyped.MatchVariableScope`. */
export type MatchVariableScope<N extends string, V extends string> = Snowtyped.MatchVariableScope<
  N,
  V
>;
/** @deprecated Use `Snowtyped.MeasureContext`. */
export type MeasureContext<
  C extends Snowtyped.ColumnMap,
  N extends string,
  V extends string,
> = Snowtyped.MeasureContext<C, N, V>;
/** @deprecated Use `Snowtyped.MergeBranchNode`. */
export type MergeBranchNode = Snowtyped.MergeBranchNode;
/** @deprecated Use `Snowtyped.MergeNode`. */
export type MergeNode = Snowtyped.MergeNode;
/** @deprecated Use `Snowtyped.MergeQuery`. */
export type MergeQuery<
  C extends Snowtyped.ColumnMap,
  Scope extends string,
  Source extends string = Scope,
> = Snowtyped.MergeQuery<C, Scope, Source>;
/** @deprecated Use `Snowtyped.MutationQuery`. */
export type MutationQuery = Snowtyped.MutationQuery;
/** @deprecated Use `Snowtyped.Navigation`. */
export type Navigation<N extends string> = Snowtyped.Navigation<N>;
/** @deprecated Use `Snowtyped.NavigationNode`. */
export type NavigationNode = Snowtyped.NavigationNode;
/** @deprecated Use `Snowtyped.OffsetWindowOptions`. */
export type OffsetWindowOptions<S extends string = string> = Snowtyped.OffsetWindowOptions<S>;
/** @deprecated Use `Snowtyped.OperandRow`. */
export type OperandRow<Q> = Snowtyped.OperandRow<Q>;
/** @deprecated Use `Snowtyped.OrderedWindowOptions`. */
export type OrderedWindowOptions<S extends string = string> = Snowtyped.OrderedWindowOptions<S>;
/** @deprecated Use `Snowtyped.Ordering`. */
export type Ordering<S extends string = string> = Snowtyped.Ordering<S>;
/** @deprecated Use `Snowtyped.OrderNode`. */
export type OrderNode = Snowtyped.OrderNode;
/** @deprecated Use `Snowtyped.PatternNode`. */
export type PatternNode = Snowtyped.PatternNode;
/** @deprecated Use `Snowtyped.PivotAggregate`. */
export type PivotAggregate = Snowtyped.PivotAggregate;
/** @deprecated Use `Snowtyped.PivotColumns`. */
export type PivotColumns<
  C extends Snowtyped.ColumnMap,
  A extends Snowtyped.PivotAggregate,
  V extends Key<C>,
  F extends Key<C>,
  In,
  D,
> = Snowtyped.PivotColumns<C, A, V, F, In, D>;
/** @deprecated Use `Snowtyped.PivotLiteral`. */
export type PivotLiteral = Snowtyped.PivotLiteral;
/** @deprecated Use `Snowtyped.PivotNode`. */
export type PivotNode = Snowtyped.PivotNode;
/** @deprecated Use `Snowtyped.PivotOptions`. */
export type PivotOptions<
  C extends Snowtyped.ColumnMap,
  A extends Snowtyped.PivotAggregate,
  V extends Key<C>,
  F extends Key<C>,
  In,
  D,
> = Snowtyped.PivotOptions<C, A, V, F, In, D>;
/** @deprecated Use `Snowtyped.PivotValue`. */
export type PivotValue<A extends Snowtyped.PivotAggregate, C> = Snowtyped.PivotValue<A, C>;
/** @deprecated Use `Snowtyped.Predicate`. */
export type Predicate<S extends string = string> = Snowtyped.Predicate<S>;
/** @deprecated Use `Snowtyped.Projection`. */
export type Projection = Snowtyped.Projection;
/** @deprecated Use `Snowtyped.QuantifiablePattern`. */
export type QuantifiablePattern<
  V extends string = string,
  Empty extends boolean = boolean,
> = Snowtyped.QuantifiablePattern<V, Empty>;
/** @deprecated Use `Snowtyped.QuantifierOptions`. */
export type QuantifierOptions = Snowtyped.QuantifierOptions;
/** @deprecated Use `Snowtyped.QueryNode`. */
export type QueryNode = Snowtyped.QueryNode;
/** @deprecated Use `Snowtyped.RangeBoundary`. */
export type RangeBoundary = Snowtyped.RangeBoundary;
/** @deprecated Use `Snowtyped.RawQuery`. */
export type RawQuery<T = unknown> = Snowtyped.RawQuery<T>;
/** @deprecated Use `Snowtyped.RecursiveName`. */
export type RecursiveName<N extends string> = Snowtyped.RecursiveName<N>;
/** @deprecated Use `Snowtyped.RecursiveOperand`. */
export type RecursiveOperand<Contract, R, CT = object, RT = object> = Snowtyped.RecursiveOperand<
  Contract,
  R,
  CT,
  RT
>;
/** @deprecated Use `Snowtyped.RecursiveRow`. */
export type RecursiveRow<Row, Nullable extends PropertyKey = never> = Snowtyped.RecursiveRow<
  Row,
  Nullable
>;
/** @deprecated Use `Snowtyped.Relation`. */
export type Relation<
  C extends Snowtyped.RelationCardinality = Snowtyped.RelationCardinality,
  Row = unknown,
  Parent extends string = string,
> = Snowtyped.Relation<C, Row, Parent>;
/** @deprecated Use `Snowtyped.RelationCardinality`. */
export type RelationCardinality = Snowtyped.RelationCardinality;
/** @deprecated Use `Snowtyped.RelationKeyType`. */
export type RelationKeyType = Snowtyped.RelationKeyType;
/** @deprecated Use `Snowtyped.RelationNode`. */
export type RelationNode = Snowtyped.RelationNode;
/** @deprecated Use `Snowtyped.RelationRow`. */
export type RelationRow<R> = Snowtyped.RelationRow<R>;
/** @deprecated Use `Snowtyped.RowPattern`. */
export type RowPattern<
  V extends string = string,
  Empty extends boolean = boolean,
> = Snowtyped.RowPattern<V, Empty>;
/** @deprecated Use `Snowtyped.RowsPerMatch`. */
export type RowsPerMatch = Snowtyped.RowsPerMatch;
/** @deprecated Use `Snowtyped.Selection`. */
export type Selection = Snowtyped.Selection;
/** @deprecated Use `Snowtyped.SelectNode`. */
export type SelectNode = Snowtyped.SelectNode;
/** @deprecated Use `Snowtyped.SelectQuery`. */
export type SelectQuery<
  S extends Snowtyped.Projection,
  Scope extends string = string,
  Nullable extends string = never,
  Outer extends string = never,
> = Snowtyped.SelectQuery<S, Scope, Nullable, Outer>;
/** @deprecated Use `Snowtyped.SelfReferenceNode`. */
export type SelfReferenceNode = Snowtyped.SelfReferenceNode;
/** @deprecated Use `Snowtyped.SemanticsNode`. */
export type SemanticsNode = Snowtyped.SemanticsNode;
/** @deprecated Use `Snowtyped.ServerValue`. */
export type ServerValue = Snowtyped.ServerValue;
/** @deprecated Use `Snowtyped.ServerValueKind`. */
export type ServerValueKind = Snowtyped.ServerValueKind;
/** @deprecated Use `Snowtyped.ServerValues`. */
export type ServerValues = Snowtyped.ServerValues;
/** @deprecated Use `Snowtyped.SetColumns`. */
export type SetColumns<
  Row,
  N extends string = Snowtyped.SetScope,
  Types = object,
> = Snowtyped.SetColumns<Row, N, Types>;
/** @deprecated Use `Snowtyped.SetOperand`. */
export type SetOperand = Snowtyped.SetOperand;
/** @deprecated Use `Snowtyped.SetOperationNode`. */
export type SetOperationNode = Snowtyped.SetOperationNode;
/** @deprecated Use `Snowtyped.SetOperator`. */
export type SetOperator = Snowtyped.SetOperator;
/** @deprecated Use `Snowtyped.SetQuery`. */
export type SetQuery<Row, Types = object> = Snowtyped.SetQuery<Row, Types>;
/** @deprecated Use `Snowtyped.SetScope`. */
export type SetScope = Snowtyped.SetScope;
/** @deprecated Use `Snowtyped.SourceReference`. */
export type SourceReference = Snowtyped.SourceReference;
/** @deprecated Use `Snowtyped.SqlInterpolation`. */
export type SqlInterpolation = Snowtyped.SqlInterpolation;
/** @deprecated Use `Snowtyped.SqlParameter`. */
export type SqlParameter = Snowtyped.SqlParameter;
/** @deprecated Use `Snowtyped.StarNode`. */
export type StarNode = Snowtyped.StarNode;
/** @deprecated Use `Snowtyped.StatementNode`. */
export type StatementNode = Snowtyped.StatementNode;
/** @deprecated Use `Snowtyped.StructuredType`. */
export type StructuredType<T, Required extends boolean = false> = Snowtyped.StructuredType<
  T,
  Required
>;
/** @deprecated Use `Snowtyped.SubqueryNode`. */
export type SubqueryNode = Snowtyped.SubqueryNode;
/** @deprecated Use `Snowtyped.Table`. */
export type Table<
  C extends Snowtyped.ColumnMap = Snowtyped.ColumnMap,
  Name extends string = string,
> = Snowtyped.Table<C, Name>;
/** @deprecated Use `Snowtyped.TableNode`. */
export type TableNode = Snowtyped.TableNode;
/** @deprecated Use `Snowtyped.TableOptions`. */
export type TableOptions = Snowtyped.TableOptions;
/** @deprecated Use `Snowtyped.TemporalNode`. */
export type TemporalNode = Snowtyped.TemporalNode;
/** @deprecated Use `Snowtyped.UnionRow`. */
export type UnionRow<L, R> = Snowtyped.UnionRow<L, R>;
/** @deprecated Use `Snowtyped.UnpivotColumns`. */
export type UnpivotColumns<
  C extends Snowtyped.ColumnMap,
  In extends readonly Key<C>[],
  V extends string,
  F extends string,
  I extends boolean,
> = Snowtyped.UnpivotColumns<C, In, V, F, I>;
/** @deprecated Use `Snowtyped.UnpivotNode`. */
export type UnpivotNode = Snowtyped.UnpivotNode;
/** @deprecated Use `Snowtyped.UnpivotOptions`. */
export type UnpivotOptions<
  C extends Snowtyped.ColumnMap,
  In extends readonly Key<C>[],
  V extends string,
  F extends string,
  I extends boolean,
> = Snowtyped.UnpivotOptions<C, In, V, F, I>;
/** @deprecated Use `Snowtyped.UpdateNode`. */
export type UpdateNode = Snowtyped.UpdateNode;
/** @deprecated Use `Snowtyped.UpdateValues`. */
export type UpdateValues<
  C extends Snowtyped.ColumnMap,
  Scope extends string = string,
> = Snowtyped.UpdateValues<C, Scope>;
/** @deprecated Use `Snowtyped.WindowFrame`. */
export type WindowFrame<Offset extends boolean = boolean> = Snowtyped.WindowFrame<Offset>;
/** @deprecated Use `Snowtyped.WindowFrameNode`. */
export type WindowFrameNode = Snowtyped.WindowFrameNode;
/** @deprecated Use `Snowtyped.WireType`. */
export type WireType = Snowtyped.WireType;
