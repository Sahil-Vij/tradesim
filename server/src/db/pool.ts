import pg from "pg";

// BIGINT (int8) columns hold money in paise and cents. node-postgres returns them as strings
// by default; parse them as BigInt so amounts never pass through a floating-point number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => BigInt(value));

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}
