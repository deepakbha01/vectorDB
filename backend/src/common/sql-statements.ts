/**
 * Splits a generated DDL string (see SchemaGeneratorService) into individual
 * statements, stripping full-line `--` comments first. Needed by drivers that
 * execute one statement per call (e.g. oracledb) rather than a whole script.
 */
export function splitSqlStatements(ddl: string): string[] {
  const withoutComments = ddl
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
