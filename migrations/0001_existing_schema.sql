-- Existing schema; only apply to a fresh D1 database. Never recreate an existing DB.
CREATE TABLE schema_version(version INTEGER PRIMARY KEY);
CREATE TABLE employees(id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, team TEXT NOT NULL, site_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE users(id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','employee')), employee_id TEXT UNIQUE REFERENCES employees(id) ON DELETE CASCADE, must_change INTEGER NOT NULL DEFAULT 1, CHECK((role='admin' AND employee_id IS NULL) OR (role='employee' AND employee_id IS NOT NULL)));
CREATE TABLE sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE attendance(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL, in_at TEXT NOT NULL, out_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(employee_id,date), CHECK(out_at IS NULL OR out_at>=in_at));
CREATE TABLE production(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id), task_name TEXT NOT NULL, date TEXT NOT NULL, recorded_at TEXT NOT NULL, good INTEGER NOT NULL CHECK(good BETWEEN 0 AND 999999), bad INTEGER NOT NULL CHECK(bad BETWEEN 0 AND 999999), version INTEGER NOT NULL DEFAULT 1, request_key TEXT NOT NULL, CHECK(good+bad>0), UNIQUE(employee_id,request_key));
CREATE TABLE overtime(id TEXT PRIMARY KEY, attendance_id TEXT NOT NULL UNIQUE REFERENCES attendance(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN('approved','rejected')), actor_id TEXT NOT NULL, decided_at TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE audit(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_login TEXT NOT NULL, occurred_at TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, before_json TEXT, after_json TEXT);
CREATE TABLE qr_challenges(hash TEXT PRIMARY KEY, site_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('in','out')), expires INTEGER NOT NULL);
CREATE TABLE qr_uses(challenge_hash TEXT NOT NULL REFERENCES qr_challenges(hash) ON DELETE CASCADE, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, used_at TEXT NOT NULL, PRIMARY KEY(challenge_hash,employee_id));
CREATE TABLE deletion_confirmations(hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE login_limits(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE initial_setup(id INTEGER PRIMARY KEY CHECK(id=1), completed_at TEXT NOT NULL);
CREATE TABLE work_requests (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK(type IN('overtime','annual','monthly','early','absence')),
      start_date TEXT NOT NULL, end_date TEXT NOT NULL CHECK(end_date>=start_date),
      start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
      end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 1 AND 1440 AND end_minute>start_minute),
      all_day INTEGER NOT NULL CHECK(all_day IN(0,1)), reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('pending','approved','rejected')),
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      actor_id TEXT, actor_login TEXT, decided_at TEXT, comment TEXT
    );
CREATE TABLE work_request_history (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES work_requests(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_login TEXT NOT NULL,
      occurred_at TEXT NOT NULL, comment TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      UNIQUE(request_id,version)
    );
CREATE UNIQUE INDEX one_open_shift ON attendance(employee_id) WHERE out_at IS NULL;
CREATE INDEX work_requests_employee_dates ON work_requests(employee_id,start_date,end_date);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
CREATE TRIGGER work_requests_no_delete BEFORE DELETE ON work_requests BEGIN SELECT RAISE(ABORT,'work requests must be retained'); END;
CREATE TRIGGER work_history_no_update BEFORE UPDATE ON work_request_history BEGIN SELECT RAISE(ABORT,'work request history is append only'); END;
CREATE TRIGGER work_history_no_delete BEFORE DELETE ON work_request_history BEGIN SELECT RAISE(ABORT,'work request history is append only'); END;
INSERT INTO schema_version VALUES(1);
