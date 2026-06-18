import { getDb } from './connection.js';

export interface ModuleStateRow {
  module_name: string;
  key: string;
  value_json: string;
  updated_at: string;
}

export function getModuleState<T = unknown>(moduleName: string, key: string): T | undefined {
  const row = getDb()
    .prepare('SELECT value_json FROM module_state WHERE module_name = ? AND key = ?')
    .get(moduleName, key) as { value_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value_json) as T;
}

export function setModuleState(moduleName: string, key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO module_state (module_name, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module_name, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(moduleName, key, JSON.stringify(value), new Date().toISOString());
}

export function deleteModuleState(moduleName: string, key: string): void {
  getDb().prepare('DELETE FROM module_state WHERE module_name = ? AND key = ?').run(moduleName, key);
}

export function listModuleState(moduleName: string): ModuleStateRow[] {
  return getDb()
    .prepare('SELECT * FROM module_state WHERE module_name = ? ORDER BY key')
    .all(moduleName) as ModuleStateRow[];
}
