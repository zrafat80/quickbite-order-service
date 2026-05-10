/**
 * Region-list helpers driven by ConfigService. The list is built once at
 * module init from `regions` in the config tree (which parses `REGIONS=eg,ksa`
 * env). Helpers are pure — pass the regions list in.
 */

export function isRegion(
  candidate: string | undefined | null,
  regions: ReadonlyArray<string>,
): candidate is string {
  return typeof candidate === 'string' && regions.includes(candidate);
}

export function assertRegion(
  candidate: string | undefined | null,
  regions: ReadonlyArray<string>,
): string {
  if (!isRegion(candidate, regions)) {
    throw new Error(
      `Unknown region: "${candidate}". Known: ${regions.join(',')}`,
    );
  }
  return candidate;
}
