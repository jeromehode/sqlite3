import type { Database } from "./database.ts";
import { readCstr, toCString, unwrap } from "./util.ts";
import ffi from "./ffi.ts";
import {
  SQLITE3_DONE,
  SQLITE3_ROW,
  SQLITE_BLOB,
  SQLITE_FLOAT,
  SQLITE_INTEGER,
  SQLITE_TEXT,
} from "./constants.ts";

const {
  sqlite3_prepare_v2,
  sqlite3_reset,
  sqlite3_clear_bindings,
  sqlite3_step,
  sqlite3_column_count,
  sqlite3_column_type,
  sqlite3_column_text,
  sqlite3_finalize,
  sqlite3_column_int64,
  sqlite3_column_double,
  sqlite3_column_blob,
  sqlite3_column_bytes,
  sqlite3_column_name,
  sqlite3_expanded_sql,
  sqlite3_bind_parameter_count,
  sqlite3_bind_int,
  sqlite3_bind_int64,
  sqlite3_bind_text,
  sqlite3_bind_blob,
  sqlite3_bind_double,
  sqlite3_bind_parameter_index,
  sqlite3_sql,
  sqlite3_stmt_readonly,
  sqlite3_bind_parameter_name,
  sqlite3_changes,
  sqlite3_column_int,
  sqlite3_step_cb,
} = ffi;

/** Types that can be possibly serialized as SQLite bind values */
export type BindValue =
  | number
  | string
  | symbol
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | Uint8Array;

export type BindParameters = BindValue[] | Record<string, BindValue>;
export type RestBindParameters = BindValue[] | [BindParameters];

export const STATEMENTS = new Map<Deno.PointerValue, Deno.PointerValue>();

const emptyStringBuffer = new Uint8Array(1);

const statementFinalizer = new FinalizationRegistry(
  (ptr: Deno.PointerValue) => {
    if (STATEMENTS.has(ptr)) {
      sqlite3_finalize(ptr);
      STATEMENTS.delete(ptr);
    }
  },
);

function getColumn(handle: number, i: number, int64: boolean): any {
  const ty = sqlite3_column_type(handle, i);

  if (ty === SQLITE_INTEGER && !int64) return sqlite3_column_int(handle, i);

  switch (ty) {
    case SQLITE_TEXT: {
      const ptr = sqlite3_column_text(handle, i);
      if (ptr === 0) return null;
      return readCstr(ptr);
    }

    case SQLITE_INTEGER: {
      const v = sqlite3_column_int64(handle, i);
      const numv = Number(v);
      if (Number.isSafeInteger(numv)) {
        return numv;
      } else {
        return v;
      }
    }

    case SQLITE_FLOAT: {
      return sqlite3_column_double(handle, i);
    }

    case SQLITE_BLOB: {
      const ptr = sqlite3_column_blob(handle, i);
      const bytes = sqlite3_column_bytes(handle, i);
      return new Uint8Array(
        Deno.UnsafePointerView.getArrayBuffer(ptr, bytes).slice(0)
      );
    }

    default: {
      return null;
    }
  }
}


/**
 * Represents a prepared statement.
 *
 * See `Database#prepare` for more information.
 */
export class Statement {
  #handle: Deno.PointerValue;
  #finalizerToken: { handle: Deno.PointerValue };
  #bound = false;
  //#hasNoArgs = false;
  #unsafeConcurrency;
  //#isReset = true;

  /**
   * Whether the query might call into JavaScript or not.
   *
   * Must enable if the query makes use of user defined functions,
   * otherwise there can be V8 crashes.
   *
   * Off by default. Causes performance degradation.
   */
  callback = false;

  /** Unsafe Raw (pointer) to the sqlite object */
  get unsafeHandle(): Deno.PointerValue {
    return this.#handle;
  }

  /** SQL string including bindings */
  get expandedSql(): string {
    return readCstr(sqlite3_expanded_sql(this.#handle));
  }

  /** The SQL string that we passed when creating statement */
  get sql(): string {
    return readCstr(sqlite3_sql(this.#handle));
  }

  /** Whether this statement doesn't make any direct changes to the DB */
  get readonly(): boolean {
    return sqlite3_stmt_readonly(this.#handle) !== 0;
  }

  #bindParameterCount: number;

  /** Number of parameters (to be) bound */
  get bindParameterCount(): number {
    return this.#bindParameterCount;
  }

  constructor(public db: Database, sql: string) {
    const pHandle = new Uint32Array(2);
    unwrap(
      sqlite3_prepare_v2(
        db.unsafeHandle,
        toCString(sql),
        sql.length,
        pHandle,
        null,
      ),
      db.unsafeHandle,
    );
    this.#handle = Deno.UnsafePointer.create(pHandle[0] + 2 ** 32 * pHandle[1]);
    STATEMENTS.set(this.#handle, db.unsafeHandle);
    this.#unsafeConcurrency = db.unsafeConcurrency;
    this.#finalizerToken = { handle: this.#handle };
    statementFinalizer.register(this, this.#handle, this.#finalizerToken);

    if (
      (this.#bindParameterCount = sqlite3_bind_parameter_count(
        this.#handle,
      )) === 0
    ) {
      //this.#hasNoArgs = true;
      this.all = this.#allNoArgs;
      this.values = this.#valuesNoArgs;
      this.run = this.#runNoArgs;
      this.value = this.#valueNoArgs;
      this.get = this.#getNoArgs;
    }
  }

  /** Shorthand for `this.callback = true`. Enables calling user defined functions. */
  enableCallback(): this {
    this.callback = true;
    return this;
  }

  /** Get bind parameter name by index */
  bindParameterName(i: number): string {
    return readCstr(sqlite3_bind_parameter_name(this.#handle, i));
  }

  /** Get bind parameter index by name */
  bindParameterIndex(name: string): number {
    if (name[0] !== ":" && name[0] !== "@" && name[0] !== "$") {
      name = ":" + name;
    }
    return sqlite3_bind_parameter_index(this.#handle, toCString(name));
  }

  /*
  #begin(): void {
    if(!this.#isReset) {
      //safety belt, in case some exception prevented #end() to be called eagerly
      this.#end(SQLITE3_DONE);
    }
    this.#isReset= false;
  }
  */

  #bindRefs: Set<any> = new Set();

  #end(status:number): void {
    sqlite3_reset(this.#handle);
    if (!this.#bound) {
      sqlite3_clear_bindings(this.#handle);
      this.#bindRefs.clear();
    }
    //this.#isReset= true;
    if (status !== SQLITE3_DONE && status !== SQLITE3_ROW) {
      unwrap(status, this.db.unsafeHandle);
    }
  }

  #endNoArg(status:number): void {
    sqlite3_reset(this.#handle);
    //this.#isReset= true;
    if (status !== SQLITE3_DONE && status !== SQLITE3_ROW) {
      unwrap(status, this.db.unsafeHandle);
    }
  }

  #bind(i: number, param: BindValue): void {
    switch (typeof param) {
      case "number": {
        if (Number.isInteger(param)) {
          if (
            Number.isSafeInteger(param) && param >= -(2 ** 31) &&
            param < 2 ** 31
          ) {
            unwrap(sqlite3_bind_int(this.#handle, i + 1, param));
          } else {
            unwrap(sqlite3_bind_int64(this.#handle, i + 1, BigInt(param)));
          }
        } else {
          unwrap(sqlite3_bind_double(this.#handle, i + 1, param));
        }
        break;
      }
      case "string": {
        if (param === "") {
          // Empty string is encoded as empty buffer in Deno. And as of
          // right now (Deno 1.29.1), ffi layer converts it to NULL pointer,
          // which causes sqlite3_bind_text to bind the NULL value instead
          // of an empty string. As a workaround let's use a special
          // non-empty buffer, but specify zero length.
          unwrap(
            sqlite3_bind_text(this.#handle, i + 1, emptyStringBuffer, 0, null),
          );
        } else {
          const str = new TextEncoder().encode(param);
          this.#bindRefs.add(str);
          unwrap(
            sqlite3_bind_text(this.#handle, i + 1, str, str.byteLength, null),
          );
        }
        break;
      }
      case "object": {
        if (param === null) {
          // pass
        } else if (param instanceof Uint8Array) {
          this.#bindRefs.add(param);
          unwrap(
            sqlite3_bind_blob(
              this.#handle,
              i + 1,
              param,
              param.byteLength,
              null,
            ),
          );
        } else if (param instanceof Date) {
          const cstring = toCString(param.toISOString());
          this.#bindRefs.add(cstring);
          unwrap(
            sqlite3_bind_text(
              this.#handle,
              i + 1,
              cstring,
              -1,
              null,
            ),
          );
        } else {
          throw new Error(`Value of unsupported type: ${Deno.inspect(param)}`);
        }
        break;
      }

      case "bigint": {
        unwrap(sqlite3_bind_int64(this.#handle, i + 1, param));
        break;
      }

      case "boolean":
        unwrap(sqlite3_bind_int(
          this.#handle,
          i + 1,
          param ? 1 : 0,
        ));
        break;
      default: {
        throw new Error(`Value of unsupported type: ${Deno.inspect(param)}`);
      }
    }
  }

  /**
   * Bind parameters to the statement. This method can be called
   * to set the parameters to be same throughout the statement.
   *
   * This method is merely just for optimization to avoid binding parameters
   * each time in prepared statement.
   */
  bind(...params: RestBindParameters): this {
    if(this.#bound) {
      sqlite3_clear_bindings(this.#handle);
      this.#bindRefs.clear();
      this.#bound = false;
    }
    if(params.length) {
      this.#bindAll(params);
      this.#bound = true;
    }
    return this;
  }

  #bindAll(params: RestBindParameters | BindParameters): void {
    if (this.#bound) throw new Error("Statement already bound to values");
    if (
      typeof params[0] === "object" && params[0] !== null &&
      !(params[0] instanceof Uint8Array) && !(params[0] instanceof Date)
    ) {
      params = params[0];
    }
    if (Array.isArray(params)) {
      for (let i = 0; i < params.length; i++) {
        this.#bind(i, (params as BindValue[])[i]);
      }
    } else {
      for (const [name, param] of Object.entries(params)) {
        const i = this.bindParameterIndex(name);
        if (i === 0) {
          throw new Error(`No such parameter "${name}"`);
        }
        this.#bind(i - 1, param as BindValue);
      }
    }
  }

  #runNoArgs(): number {
    //this.#begin();
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    const status = step(this.#handle);
    this.#endNoArg(status);
    return sqlite3_changes(this.db.unsafeHandle);
  }

  /** Simply run the query without retrieving any output there may be. */
  run(...params: RestBindParameters): number {
    //this.#begin();
    if(params.length) this.#bindAll(params);
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    const status = step(this.#handle);
    this.#end(status);
    return sqlite3_changes(this.db.unsafeHandle);
  }

  #valuesNoArgs<T extends Array<unknown>>(): T[] {
    //this.#begin();
    const columnCount = sqlite3_column_count(this.#handle);
    const result: T[] = [];
    const getRowArray = new Function(
      "getColumn","handle",
      `
      return function() {
        return [${
        Array.from({ length: columnCount }).map((_, i) =>
          `getColumn(handle, ${i}, ${this.db.int64})`
        )
          .join(", ")
      }];
      };
      `,
    )(getColumn,this.#handle);
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    let status = step(this.#handle);
    while (status === SQLITE3_ROW) {
      result.push(getRowArray());
      status = step(this.#handle);
    }
    this.#endNoArg(status);
    return result as T[];
  }

  /**
   * Run the query and return the resulting rows where rows are array of columns.
   */
  values<T extends Array<unknown>>(
    ...params: RestBindParameters
  ): T[] {
    //this.#begin();
    if(params.length) this.#bindAll(params);
    return this.#valuesNoArgs();

    const columnCount = sqlite3_column_count(this.#handle);
    const result: T[] = [];
    const getRowArray = new Function(
      "getColumn","handle",
      `
      return function() {
        return [${
        Array.from({ length: columnCount }).map((_, i) =>
          `getColumn(handle, ${i}, ${this.db.int64})`
        )
          .join(", ")
      }];
      };
      `,
    )(getColumn,this.#handle);
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    let status = step(this.#handle);
    while (status === SQLITE3_ROW) {
      result.push(getRowArray());
      status = step(this.#handle);
    }
    this.#end(status);
    return result as T[];
  }

  #rowObjectFn: (() => any) | undefined;


  getRowObject(): () => any {
    if (!this.#rowObjectFn || !this.#unsafeConcurrency) {
      const columnNames = this.columnNames();
      const getRowObject = new Function(
        "getColumn","handle",
        `
        return function() {
          return {
            ${
          columnNames.map((name, i) =>
            `"${name}": getColumn(handle, ${i}, ${this.db.int64})`
          ).join(",\n")
        }
          };
        };
        `,
      )(getColumn,this.#handle);
      this.#rowObjectFn = getRowObject;
    }
    return this.#rowObjectFn!;
  }

  #allNoArgs<T extends Record<string, unknown>>(): T[] {
    //this.#begin();
    const getRowObject = this.getRowObject();

    const result: T[] = [];
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    let status = step(this.#handle);
    while (status === SQLITE3_ROW) {
      result.push(getRowObject());
      status = step(this.#handle);
    }
    this.#endNoArg(status);
    return result as T[];
  }

  /**
   * Run the query and return the resulting rows where rows are objects
   * mapping column name to their corresponding values.
   */
  all<T extends Record<string, unknown>>(
    ...params: RestBindParameters
  ): T[] {
    //this.#begin();
    if(params.length) this.#bindAll(params);

    const getRowObject = this.getRowObject();
    const result: T[] = [];
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    let status = step(this.#handle);
    while (status === SQLITE3_ROW) {
      result.push(getRowObject());
      status = step(this.#handle);
    }
    this.#end(status);
    return result as T[];
  }

  /** Fetch only first row as an array, if any. */
  value<T extends Array<unknown>>(
    ...params: RestBindParameters
  ): T | undefined {
    //this.#begin();
    if(params.length) this.#bindAll(params);

    const handle = this.#handle;
    const int64 = this.db.int64;
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    const status = step(handle);

    let arr;
    if (status === SQLITE3_ROW) {
      arr= new Array(sqlite3_column_count(handle));
      for (let i = 0; i < arr.length; i++) {
        arr[i] = getColumn(handle as number, i, int64);
      }
    }
    this.#end(status);
    return arr as T|undefined;
  }

  #valueNoArgs<T extends Array<unknown>>(): T | undefined {
    //this.#begin();

    const handle = this.#handle;
    const int64 = this.db.int64;
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    const status = step(handle);

    let arr;
    if (status === SQLITE3_ROW) {
      arr= new Array(sqlite3_column_count(handle));
      for (let i = 0; i < arr.length; i++) {
        arr[i] = getColumn(handle as number, i, int64);
      }
    }
    this.#endNoArg(status);
    return arr as T|undefined;
  }

  #columnNames: string[] | undefined;

  columnNames(): string[] {
    if (!this.#columnNames || !this.#unsafeConcurrency) {
      const columnCount = sqlite3_column_count(this.#handle);
      const columnNames = new Array(columnCount);
      for (let i = 0; i < columnCount; i++) {
        columnNames[i] = readCstr(sqlite3_column_name(this.#handle, i));
      }
      this.#columnNames = columnNames;
    }
    return this.#columnNames!;
  }

  /** Fetch only first row as an object, if any. */
  get<T extends Record<string, unknown>>(
    ...params: RestBindParameters
  ): T | undefined {
    //this.#begin();
    if(params.length) this.#bindAll(params);

    const handle = this.#handle;
    const int64 = this.db.int64;
    const columnNames = this.columnNames();
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    const status = step(handle);

    let row: Record<string, unknown>|undefined;
    if (status === SQLITE3_ROW) {
      row= {};
      for (let i = 0; i < columnNames.length; i++) {
        row[columnNames[i]] = getColumn(handle as number, i, int64);
      }
    }
    this.#end(status);
    return row as T|undefined;
  }

  #getNoArgs<T extends Record<string, unknown>>(): T | undefined {
    //this.#begin();

    const handle = this.#handle;
    const int64 = this.db.int64;
    const columnNames = this.columnNames();
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    const status = step(handle);

    let row: Record<string, unknown>;
    if (status === SQLITE3_ROW) {
      row= {};
      for (let i = 0; i < columnNames?.length; i++) {
        row[columnNames[i]] = getColumn(handle as number, i, int64);
      }
    }
    this.#end(status);
    return row as T|undefined;
  }

  /** Free up the statement object. */
  finalize(): void {
    if (!STATEMENTS.has(this.#handle)) return;
    this.#bindRefs.clear();
    statementFinalizer.unregister(this.#finalizerToken);
    STATEMENTS.delete(this.#handle);
    unwrap(sqlite3_finalize(this.#handle));
  }

  /** Coerces the statement to a string, which in this case is expanded SQL. */
  toString(): string {
    return readCstr(sqlite3_expanded_sql(this.#handle));
  }

  /** Iterate over resultant rows from query. */
  *[Symbol.iterator](): IterableIterator<any> {
    //this.#begin();
    const getRowObject = this.getRowObject();
    const step = this.callback ? sqlite3_step_cb : sqlite3_step;
    let status = step(this.#handle);
    while (status === SQLITE3_ROW) {
      yield getRowObject();
      status = step(this.#handle);
    }
    this.#end(status);
  }
}
