import jsonata from 'jsonata';
import { WtopError } from '@wtop/provider';

const DB_NAME = 'data-msqt-fun';
const STORE = 'records';

interface Row { _collection: string; _id: string; data: Record<string, unknown> }

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) {
        reject(new WtopError('BUSINESS_ERROR', `本站需以 allow-same-origin 注册使用（当前环境 IndexedDB 不可用）: ${String(e instanceof Error ? e.message : e)}`));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: ['_collection', '_id'] });
          os.createIndex('_collection', '_collection', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new WtopError('BUSINESS_ERROR', `本站需以 allow-same-origin 注册使用（IndexedDB 打开失败）: ${String(req.error)}`));
      req.onblocked = () => reject(new WtopError('BUSINESS_ERROR', 'IndexedDB 被其他标签页阻塞，请关闭本站其他页面后重试'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function rowsOf(collection: string): Promise<Row[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).index('_collection').getAll(collection);
    req.onsuccess = () => resolve(req.result as Row[]);
    req.onerror = () => reject(req.error);
  });
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function compile(expression: string): jsonata.Expression {
  try {
    return jsonata(expression);
  } catch (e) {
    throw new WtopError('INVALID_INPUT', `JSONata 表达式无效: ${errText(e)}`);
  }
}

async function evalFilter(expression: string, record: Record<string, unknown>): Promise<boolean> {
  try {
    return Boolean(await compile(expression).evaluate(record));
  } catch (e) {
    if (e instanceof WtopError) throw e;
    throw new WtopError('INVALID_INPUT', `JSONata 求值失败: ${errText(e)}`);
  }
}

function nameCheck(collection: unknown): string {
  if (typeof collection !== 'string' || !collection.trim()) {
    throw new WtopError('INVALID_INPUT', 'collection 不能为空');
  }
  return collection.trim();
}

export async function collections() {
  const rows = await tx<Row[]>('readonly', (os) => os.getAll());
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r._collection, (counts.get(r._collection) ?? 0) + 1);
  return { collections: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)) };
}

export interface PutParams { collection: string; records: Record<string, unknown>[]; idField?: string; mode?: 'upsert' | 'insert' }
export async function put(p: PutParams) {
  const collection = nameCheck(p.collection);
  if (!Array.isArray(p.records) || !p.records.length) throw new WtopError('INVALID_INPUT', 'records 需为非空对象数组');
  const idField = p.idField ?? 'id';
  const mode = p.mode ?? 'upsert';
  const existing = new Set((await rowsOf(collection)).map((r) => r._id));
  let inserted = 0, updated = 0;
  const ids: string[] = [];
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const os = t.objectStore(STORE);
    for (const rec of p.records) {
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        reject(new WtopError('INVALID_INPUT', 'records 每项需为对象'));
        return;
      }
      const raw = rec[idField];
      const id = raw === undefined || raw === null || raw === '' ? crypto.randomUUID() : String(raw);
      if (mode === 'insert' && existing.has(id)) {
        reject(new WtopError('BUSINESS_ERROR', `insert 模式：id "${id}" 已存在`));
        return;
      }
      if (existing.has(id)) updated++; else { inserted++; existing.add(id); }
      ids.push(id);
      os.put({ _collection: collection, _id: id, data: { ...rec, [idField]: raw === undefined || raw === null || raw === '' ? id : raw } } satisfies Row);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('事务中止'));
  });
  return { inserted, updated, ids };
}

export interface GetParams { collection: string; id: string }
export async function get(p: GetParams) {
  const collection = nameCheck(p.collection);
  const row = await tx<Row | undefined>('readonly', (os) => os.get([collection, String(p.id)]));
  if (!row) throw new WtopError('BUSINESS_ERROR', `记录不存在: ${collection}/${p.id}`);
  return { record: row.data };
}

export interface QueryParams { collection: string; filter?: string; sort?: string; order?: 'asc' | 'desc'; limit?: number; offset?: number }
export async function query(p: QueryParams) {
  const collection = nameCheck(p.collection);
  const limit = Math.min(Math.max(1, p.limit ?? 100), 10000);
  const offset = Math.max(0, p.offset ?? 0);
  let rows = await rowsOf(collection);
  let records = rows.map((r) => r.data);
  if (p.filter) {
    const kept: Record<string, unknown>[] = [];
    for (const rec of records) if (await evalFilter(p.filter, rec)) kept.push(rec);
    records = kept;
  }
  if (p.sort) {
    const dir = p.order === 'desc' ? -1 : 1;
    const key = p.sort;
    records.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }
  const total = records.length;
  const page = records.slice(offset, offset + limit);
  return { records: page, total, count: page.length };
}

export interface DeleteParams { collection: string; ids?: string[]; filter?: string }
export async function deleteRecords(p: DeleteParams) {
  const collection = nameCheck(p.collection);
  if ((!p.ids || !p.ids.length) && !p.filter) {
    throw new WtopError('INVALID_INPUT', 'ids 与 filter 至少填一个');
  }
  let ids: string[];
  if (p.ids?.length) {
    ids = p.ids.map(String);
  } else {
    const rows = await rowsOf(collection);
    ids = [];
    for (const r of rows) if (await evalFilter(p.filter!, r.data)) ids.push(r._id);
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    for (const id of ids) t.objectStore(STORE).delete([collection, id]);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return { deleted: ids.length };
}

export interface DropParams { collection: string }
export async function drop(p: DropParams) {
  const collection = nameCheck(p.collection);
  const rows = await rowsOf(collection);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    for (const r of rows) t.objectStore(STORE).delete([collection, r._id]);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return { deleted: rows.length };
}

export interface TransformParams { data: unknown; expression: string }
export async function transform(p: TransformParams) {
  try {
    const result = await compile(p.expression).evaluate({ data: p.data });
    return { result: result === undefined ? null : result };
  } catch (e) {
    if (e instanceof WtopError) throw e;
    throw new WtopError('INVALID_INPUT', `JSONata 求值失败: ${errText(e)}`);
  }
}

/** RFC4180 子集：引号包裹、双引号转义、CRLF */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

function autoType(s: string): string | number | boolean {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export interface CsvParseParams { csv?: string; file?: Blob; delimiter?: string; header?: boolean }
export async function csvParse(p: CsvParseParams) {
  const text = p.file ? await p.file.text() : p.csv;
  if (typeof text !== 'string') throw new WtopError('INVALID_INPUT', 'csv 与 file 至少填一个');
  const delimiter = p.delimiter ?? ',';
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return { records: [], count: 0 };
  const header = p.header ?? true;
  const keys = header ? rows[0] : rows[0].map((_, i) => `col${i}`);
  const body = header ? rows.slice(1) : rows;
  const records = body.map((r) => Object.fromEntries(keys.map((k, i) => [k, autoType(r[i] ?? '')])));
  return { records, count: records.length };
}

function csvEscape(v: unknown, delimiter: string): string {
  const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvFormatParams { records: Record<string, unknown>[]; columns?: string[]; delimiter?: string; header?: boolean }
export async function csvFormat(p: CsvFormatParams) {
  if (!Array.isArray(p.records)) throw new WtopError('INVALID_INPUT', 'records 需为对象数组');
  const delimiter = p.delimiter ?? ',';
  const columns = p.columns ?? [...new Set(p.records.flatMap((r) => Object.keys(r)))];
  const lines: string[] = [];
  if (p.header ?? true) lines.push(columns.map((c) => csvEscape(c, delimiter)).join(delimiter));
  for (const r of p.records) lines.push(columns.map((c) => csvEscape(r[c], delimiter)).join(delimiter));
  return { csv: lines.join('\n') };
}

export interface ExportParams { collection: string; filter?: string; format?: 'json' | 'csv' }
export async function exportCollection(p: ExportParams) {
  const { records, total } = await query({ collection: p.collection, filter: p.filter, limit: 10000 });
  if (total > 10000) throw new WtopError('BUSINESS_ERROR', `导出上限 10000 条，当前 ${total} 条，请用 filter 分批`);
  const format = p.format ?? 'json';
  const content = format === 'csv' ? (await csvFormat({ records })).csv : JSON.stringify(records, null, 2);
  const file = new Blob([content], { type: format === 'csv' ? 'text/csv' : 'application/json' });
  return { file, count: records.length };
}

export interface ImportParams { collection: string; file: Blob; format?: 'auto' | 'json' | 'csv'; idField?: string }
export async function importFile(p: ImportParams) {
  const collection = nameCheck(p.collection);
  const text = await p.file.text();
  let format = p.format ?? 'auto';
  if (format === 'auto') {
    const t = text.trimStart();
    format = t.startsWith('[') || t.startsWith('{') ? 'json' : 'csv';
  }
  let records: Record<string, unknown>[];
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new WtopError('INVALID_INPUT', `JSON 解析失败: ${String(e instanceof Error ? e.message : e)}`);
    }
    records = Array.isArray(parsed) ? parsed : [parsed];
    if (records.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
      throw new WtopError('INVALID_INPUT', 'JSON 需为对象或对象数组');
    }
  } else {
    records = (await csvParse({ csv: text })).records;
  }
  if (!records.length) return { imported: 0 };
  const { inserted, updated } = await put({ collection, records, idField: p.idField });
  return { imported: inserted + updated };
}