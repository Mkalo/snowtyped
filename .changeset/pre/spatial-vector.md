---
"snowtyped": minor
---

Declare GEOGRAPHY, GEOMETRY, and VECTOR columns with `geography(name)`, `geometry(name, { srid })`, and `vector(name, 'int' | 'float', dimension)`. Spatial values are typed GeoJSON geometries decoded with exact coordinates, GEOMETRY results are checked against the declared SRID, VECTOR writes and results are checked against the declared dimension and element type, and code generation emits these declarations.
