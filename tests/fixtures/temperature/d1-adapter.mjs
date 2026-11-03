import { DatabaseSync } from 'node:sqlite';

// A real SQLite-backed D1 adapter. Each client has a distinct connection to a
// temporary database; batch commits or rolls back exactly as D1 does.
export class D1 {
  constructor(file) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.beforeWrite = null;
  }
  close() { this.sql.close(); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    const writing = statements.some(statement => /^INSERT INTO temperature_requests/.test(statement.sql));
    if (writing && this.beforeWrite) {
      const callback = this.beforeWrite; this.beforeWrite = null; await callback();
    }
    this.sql.exec(writing ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = statements.map(statement => statement.execute());
      this.sql.exec('COMMIT'); return result;
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
}
class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  execute() {
    const prepared = this.db.sql.prepare(this.sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(this.sql)) return { success: true, results: prepared.all(...this.args), meta: {} };
    const result = prepared.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async all() { return this.execute(); }
  async first() { return this.execute().results[0] || null; }
  async run() { return this.execute(); }
}
