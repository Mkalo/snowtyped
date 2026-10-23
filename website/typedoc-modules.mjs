import { Converter, ReflectionKind } from 'typedoc';

const names = { index: 'snowtyped', snowflake: 'snowtyped/snowflake', ddl: 'snowtyped/ddl' };

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const module of context.project.getReflectionsByKind(ReflectionKind.Module)) {
      module.name = names[module.name] ?? module.name;
    }
  });
}
