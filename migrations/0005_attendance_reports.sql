-- Additive only. Back up the remote database before applying this migration.
-- Existing accounts, passkeys, punches, requests and audits are not rewritten.
CREATE TABLE attendance_policies(id TEXT PRIMARY KEY, effective_from TEXT NOT NULL, definition_json TEXT NOT NULL);
INSERT INTO attendance_policies VALUES('attendance-2026-11-03-v1','2026-11-03','{"id":"attendance-2026-11-03-v1","effectiveFrom":"2026-11-03","timezone":"Asia/Seoul","startMinute":510,"endMinute":1050,"breaks":[{"name":"오전 휴게","start":630,"end":640,"paid":null},{"name":"점심","start":750,"end":810,"paid":null},{"name":"오후 휴게","start":930,"end":940,"paid":null}],"payroll":"unconfirmed","workday":"출근일 기준, 자정 이후도 같은 근무일"}');
CREATE TABLE attendance_originals(attendance_id TEXT PRIMARY KEY, in_at TEXT NOT NULL, out_at TEXT, source TEXT NOT NULL);
INSERT INTO attendance_originals SELECT id,in_at,out_at,'migration' FROM attendance;
CREATE TRIGGER attendance_capture_original AFTER INSERT ON attendance BEGIN
  INSERT OR IGNORE INTO attendance_originals VALUES(NEW.id,NEW.in_at,NEW.out_at,'recorded');
END;
CREATE TRIGGER attendance_original_no_rewrite BEFORE UPDATE ON attendance_originals
WHEN NEW.attendance_id!=OLD.attendance_id OR NEW.in_at!=OLD.in_at OR NEW.source!=OLD.source OR OLD.out_at IS NOT NULL OR NEW.out_at IS NULL
BEGIN SELECT RAISE(ABORT,'original punches are immutable'); END;
CREATE TRIGGER attendance_original_no_delete BEFORE DELETE ON attendance_originals BEGIN SELECT RAISE(ABORT,'original punches must be retained'); END;
CREATE TABLE attendance_adjustments(
  id TEXT PRIMARY KEY, attendance_id TEXT NOT NULL REFERENCES attendance(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL, start_at TEXT, reason TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_login TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(attendance_id,version)
);
CREATE TABLE attendance_finalizations(
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  month TEXT NOT NULL, version INTEGER NOT NULL, policy_id TEXT NOT NULL REFERENCES attendance_policies(id),
  rows_json TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, actor_login TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(employee_id,month,version)
);
CREATE INDEX attendance_finalizations_period ON attendance_finalizations(employee_id,month,version);
CREATE INDEX audit_attendance_corrections ON audit(target_id,action,occurred_at);
CREATE TRIGGER attendance_policy_no_update BEFORE UPDATE ON attendance_policies BEGIN SELECT RAISE(ABORT,'policies are immutable'); END;
CREATE TRIGGER attendance_policy_no_delete BEFORE DELETE ON attendance_policies BEGIN SELECT RAISE(ABORT,'policies are immutable'); END;
CREATE TRIGGER attendance_adjustments_no_update BEFORE UPDATE ON attendance_adjustments BEGIN SELECT RAISE(ABORT,'adjustments are append only'); END;
CREATE TRIGGER attendance_adjustments_no_delete BEFORE DELETE ON attendance_adjustments BEGIN SELECT RAISE(ABORT,'adjustments are append only'); END;
CREATE TRIGGER attendance_finalizations_no_update BEFORE UPDATE ON attendance_finalizations BEGIN SELECT RAISE(ABORT,'finalizations are append only'); END;
CREATE TRIGGER attendance_finalizations_no_delete BEFORE DELETE ON attendance_finalizations BEGIN SELECT RAISE(ABORT,'finalizations are append only'); END;
-- worker_revision exists only on D1. The Node installer omits these triggers.
CREATE TRIGGER revision_attendance_originals_insert AFTER INSERT ON attendance_originals BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_originals_update AFTER UPDATE ON attendance_originals BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_adjustments_insert AFTER INSERT ON attendance_adjustments BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_finalizations_insert AFTER INSERT ON attendance_finalizations BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_policies_insert AFTER INSERT ON attendance_policies BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
