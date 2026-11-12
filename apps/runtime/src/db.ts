import { DatabaseSync } from "node:sqlite";
import { DomainEvent, Project } from "@graphcode/protocol";

const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     added_at TEXT NOT NULL,
     last_opened_at TEXT NOT NULL
   );
   CREATE TABLE events (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     type TEXT NOT NULL,
     at TEXT NOT NULL,
     v INTEGER NOT NULL,
     payload TEXT NOT NULL,
     UNIQUE (task_id, seq)
   );
   CREATE INDEX events_task ON events (task_id, seq);
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     created_at TEXT NOT NULL
   );`,
];

/** Durable local state. The event log is the source of truth; projections are rebuilt from it. */
export class Database {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    let version = row ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version]!);
        version += 1;
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  upsertProject(p: Project): Project {
    this.db
      .prepare(
        `INSERT INTO projects (id, path, name, added_at, last_opened_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at, name = excluded.name`,
      )
      .run(p.id, p.path, p.name, p.addedAt, p.lastOpenedAt);
    return this.projectByPath(p.path)!;
  }

  projectByPath(path: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE path = ?").get(path) as Record<string, string> | undefined;
    return r ? rowToProject(r) : null;
  }

  project(id: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, string> | undefined;
    return r ? rowToProject(r) : null;
  }

  projects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC").all() as Record<string, string>[]).map(rowToProject);
  }

  insertTask(id: string, projectId: string, createdAt: string) {
    this.db.prepare("INSERT INTO tasks (id, project_id, created_at) VALUES (?, ?, ?)").run(id, projectId, createdAt);
  }

  appendEvent(e: DomainEvent) {
    this.db
      .prepare("INSERT INTO events (id, task_id, seq, type, at, v, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.taskId, e.seq, e.type, e.at, e.v, JSON.stringify(e.payload));
  }

  allEvents(): DomainEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY task_id, seq").all() as Record<string, unknown>[];
    return rows.map((r) =>
      DomainEvent.parse({
        id: r.id,
        taskId: r.task_id,
        seq: Number(r.seq),
        type: r.type,
        at: r.at,
        v: Number(r.v),
        payload: JSON.parse(String(r.payload)),
      }),
    );
  }

  close() {
    this.db.close();
  }
}

function rowToProject(r: Record<string, string>): Project {
  return { id: r.id!, path: r.path!, name: r.name!, addedAt: r.added_at!, lastOpenedAt: r.last_opened_at! };
}
