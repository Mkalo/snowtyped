/** Parallel test files for the live suite; each file holds about one Snowflake session at a time. */
export const defaultIntegrationWorkers = 6;

export function integrationWorkers(environment: NodeJS.ProcessEnv = process.env): number {
  const value = environment.SNOWTYPED_INTEGRATION_WORKERS?.trim();
  if (!value) return defaultIntegrationWorkers;
  const workers = Number(value);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(
      `SNOWTYPED_INTEGRATION_WORKERS must be a positive integer, received ${JSON.stringify(value)}.`,
    );
  }
  return workers;
}
