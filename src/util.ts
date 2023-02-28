import { SQLITE3_MISUSE, SQLITE3_OK } from "./constants.ts";
import ffi from "./ffi.ts";

const {
  sqlite3_errmsg,
  sqlite3_errstr,
} = ffi;

export const encoder = new TextEncoder();

export function toCString(str: string): Uint8Array {
  return encoder.encode(str + "\0");
}

export function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export class SqliteError extends Error {
  name = "SqliteError";

  constructor(
    public code: number = 1,
    message: string = "Unknown Error",
  ) {
    super(`${code}: ${message}`);
  }
}

export const readCstr= Deno.UnsafePointerView.getCString;

export function unwrap(code: number, db?: Deno.PointerValue): void {
  if (code === SQLITE3_OK) return;
  if (code === SQLITE3_MISUSE) {
    throw new SqliteError(code, "SQLite3 API misuse");
  } else if (db !== undefined) {
    const errmsg = sqlite3_errmsg(db);
    if (errmsg === 0) throw new SqliteError(code);
    throw new Error(readCstr(sqlite3_errmsg(db)));
  } else throw new SqliteError(code, readCstr(sqlite3_errstr(code)));
}


