import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Application,
  type DeclarationReflection,
  Logger,
  LogLevel,
  type ProjectReflection,
  type Reflection,
  ReflectionKind,
} from 'typedoc';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { apiEntryPoints, apiTsconfig, apiTypeDocOptions } from '../src/api';

const website = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../../src/', import.meta.url);
const packages: Record<string, string> = {
  snowtyped: 'snowtyped',
  'snowtyped/snowflake': 'snowtyped/snowflake',
  'snowtyped/ddl': 'snowtyped/ddl',
};

class Collector extends Logger {
  readonly warnings: string[] = [];
  override log(message: string, level: LogLevel): void {
    if (level >= LogLevel.Warn) this.warnings.push(message);
  }
}

let project: ProjectReflection;
let logger: Collector;

beforeAll(async () => {
  const app = await Application.bootstrapWithPlugins({
    entryPoints: apiEntryPoints,
    tsconfig: apiTsconfig,
    ...apiTypeDocOptions,
    validation: { notExported: false, invalidLink: true, notDocumented: false },
  });
  logger = new Collector();
  app.logger = logger;
  project = (await app.convert()) as ProjectReflection;
  app.validate(project);
}, 120_000);

const summarized = (reflection: Reflection) =>
  Boolean(reflection.comment?.summary.some((part) => part.text.trim()));

/** Every export, signature, method, and interface or class property needs a summary. */
function undocumented(reflection: DeclarationReflection, shallow: boolean): string[] {
  const name = reflection.getFriendlyFullName();
  const signatures = reflection.signatures ?? [];
  const missing = signatures.length
    ? signatures.some((signature) => !summarized(signature))
      ? [name]
      : []
    : summarized(reflection)
      ? []
      : [name];
  if (shallow) return missing;
  const members =
    reflection.kindOf(ReflectionKind.Variable) && reflection.type?.type === 'reflection'
      ? (reflection.type.declaration.children ?? [])
      : reflection.kindOf(
            ReflectionKind.Interface | ReflectionKind.Class | ReflectionKind.Namespace,
          )
        ? (reflection.children ?? [])
        : [];
  return [...missing, ...members.flatMap((member) => undocumented(member, false))];
}

/** The fenced TypeScript blocks of every TSDoc comment in the library source. */
function examples(): { location: string; code: string }[] {
  const files = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter((path) =>
    path.endsWith('.ts'),
  );
  return files.flatMap((file) => {
    const text = readFileSync(new URL(file, source), 'utf8');
    return [...text.matchAll(/\/\*\*[\s\S]*?\*\//g)].flatMap((comment) => {
      const body = comment[0].replace(/^\s*\/?\*+\/? ?/gm, '');
      const line = text.slice(0, comment.index).split('\n').length;
      return [...body.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => ({
        location: `src/${file.replaceAll('\\', '/')}:${line}`,
        code: match[1] ?? '',
      }));
    });
  });
}

interface Export {
  readonly entry: string;
  readonly type: boolean;
}

/** Imports the package exports, fixtures, and declarations an example uses without declaring. */
function prelude(code: string, exports: ReadonlyMap<string, Export>): string {
  const fixtures = readFileSync(new URL('../src/snippets/fixtures.ts', import.meta.url), 'utf8');
  const fixtureNames = [...fixtures.matchAll(/export (?:const (\w+)|\{ (\w+) \})/g)].map(
    (match) => (match[1] ?? match[2]) as string,
  );
  const imports = [...code.matchAll(/^import [\s\S]*? from .*$/gm)].map((match) => match[0]);
  const free = (name: string) =>
    new RegExp(`(?<![.\\w])${name}\\b`).test(code) &&
    !new RegExp(`\\b(?:const|let|function|class|type|interface)\\s+${name}\\b`).test(code) &&
    !imports.some((line) => new RegExp(`\\b${name}\\b`).test(line));
  const lines = [
    "import type { Connection, ConnectionOptions } from 'snowflake-sdk';",
    "import * as z from 'zod';",
    'declare const connection: Connection;',
    'declare const connectionOptions: ConnectionOptions;',
  ].filter((line) => !/^import \* as z/.test(line) || free('z'));
  const used = fixtureNames.filter(free);
  if (used.length) lines.push(`import { ${used.join(', ')} } from './fixtures.js';`);
  const byPackage = new Map<string, string[]>();
  for (const [name, { entry, type }] of exports)
    if (!used.includes(name) && free(name))
      byPackage.set(entry, [...(byPackage.get(entry) ?? []), type ? `type ${name}` : name]);
  for (const [entry, names] of byPackage)
    lines.push(`import { ${names.join(', ')} } from '${entry}';`);
  return `${lines.join('\n')}\nexport {};\n`;
}

describe('API reference', () => {
  it('documents every public export', () => {
    const missing = (project.children ?? []).flatMap((module) => {
      const ast = new Set(
        module.categories?.find((category) => category.title === 'AST')?.children ?? [],
      );
      return (module.children ?? []).flatMap((child) => undocumented(child, ast.has(child)));
    });
    expect(missing).toEqual([]);
  });

  it('resolves every TSDoc link without warnings', () => {
    expect(logger.warnings).toEqual([]);
  });

  it('type-checks every TSDoc example', () => {
    const exports = new Map<string, Export>();
    for (const module of project.children ?? [])
      for (const child of module.children ?? [])
        if (!exports.has(child.name))
          exports.set(child.name, {
            entry: packages[module.name] as string,
            type: child.kindOf(ReflectionKind.Interface | ReflectionKind.TypeAlias),
          });
    const found = examples();
    expect(found.length).toBeGreaterThan(50);
    const config = ts.getParsedCommandLineOfConfigFile(
      `${website}tsconfig.snippets.json`,
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    ) as ts.ParsedCommandLine;
    const files = new Map(
      found.map((example, index) => [
        `${website}src/snippets/__api_example_${index}.ts`,
        { ...example, text: `${prelude(example.code, exports)}${example.code}` },
      ]),
    );
    const host = ts.createCompilerHost(config.options);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, language, ...rest) => {
      const file = files.get(name);
      return file
        ? ts.createSourceFile(name, file.text, language)
        : getSourceFile.call(host, name, language, ...rest);
    };
    host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name);
    const program = ts.createProgram([...files.keys()], config.options, host);
    const errors = ts.getPreEmitDiagnostics(program).flatMap((diagnostic) => {
      const file = diagnostic.file && files.get(diagnostic.file.fileName);
      if (!file) return [];
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      const { line } = (diagnostic.file as ts.SourceFile).getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      );
      const preamble = file.text.split('\n').length - file.code.split('\n').length;
      return [`${file.location} (example line ${line - preamble + 1}): ${message}`];
    });
    expect(errors).toEqual([]);
  }, 120_000);
});
