-- Administrative test-data reset: backups and row-scoped guards are atomic.
-- Applying this migration does not delete or reset any business data.
CREATE TABLE test_reset_backups(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,actor_login TEXT NOT NULL,created_at TEXT NOT NULL,reason TEXT NOT NULL,counts_json TEXT NOT NULL,payload_json TEXT NOT NULL);
CREATE TABLE test_reset_previews(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,revision INTEGER NOT NULL,selection_json TEXT NOT NULL,fingerprint TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE test_reset_items(reset_id TEXT NOT NULL REFERENCES test_reset_backups(id),table_name TEXT NOT NULL,row_id TEXT NOT NULL,PRIMARY KEY(reset_id,table_name,row_id));
CREATE TABLE test_reset_guard(id INTEGER PRIMARY KEY CHECK(id=1),reset_id TEXT NOT NULL REFERENCES test_reset_backups(id));
CREATE INDEX test_reset_backups_created ON test_reset_backups(created_at,id);
CREATE TRIGGER test_reset_backups_no_update BEFORE UPDATE ON test_reset_backups BEGIN SELECT RAISE(ABORT,'reset backups are immutable'); END;
CREATE TRIGGER test_reset_backups_no_delete BEFORE DELETE ON test_reset_backups BEGIN SELECT RAISE(ABORT,'reset backups must be retained'); END;
DROP TRIGGER attendance_original_no_delete;
CREATE TRIGGER attendance_original_no_delete BEFORE DELETE ON attendance_originals WHEN NOT EXISTS(SELECT 1 FROM test_reset_guard g JOIN test_reset_items i ON i.reset_id=g.reset_id WHERE i.table_name='attendance_originals' AND i.row_id=OLD.attendance_id) BEGIN SELECT RAISE(ABORT,'original punches must be retained'); END;
DROP TRIGGER attendance_adjustments_no_delete;
CREATE TRIGGER attendance_adjustments_no_delete BEFORE DELETE ON attendance_adjustments WHEN NOT EXISTS(SELECT 1 FROM test_reset_guard g JOIN test_reset_items i ON i.reset_id=g.reset_id WHERE i.table_name='attendance_adjustments' AND i.row_id=OLD.id) BEGIN SELECT RAISE(ABORT,'adjustments are append only'); END;
DROP TRIGGER attendance_finalizations_no_delete;
CREATE TRIGGER attendance_finalizations_no_delete BEFORE DELETE ON attendance_finalizations WHEN NOT EXISTS(SELECT 1 FROM test_reset_guard g JOIN test_reset_items i ON i.reset_id=g.reset_id WHERE i.table_name='attendance_finalizations' AND i.row_id=OLD.id) BEGIN SELECT RAISE(ABORT,'finalizations are append only'); END;
DROP TRIGGER work_requests_no_delete;
CREATE TRIGGER work_requests_no_delete BEFORE DELETE ON work_requests WHEN NOT EXISTS(SELECT 1 FROM test_reset_guard g JOIN test_reset_items i ON i.reset_id=g.reset_id WHERE i.table_name='work_requests' AND i.row_id=OLD.id) BEGIN SELECT RAISE(ABORT,'work requests must be retained'); END;
DROP TRIGGER work_history_no_delete;
CREATE TRIGGER work_history_no_delete BEFORE DELETE ON work_request_history WHEN NOT EXISTS(SELECT 1 FROM test_reset_guard g JOIN test_reset_items i ON i.reset_id=g.reset_id WHERE i.table_name='work_request_history' AND i.row_id=OLD.id) BEGIN SELECT RAISE(ABORT,'work request history is append only'); END;
-- worker_revision exists only on D1. The Node installer adds its own triggers.
CREATE TRIGGER revision_test_reset_backups_insert AFTER INSERT ON test_reset_backups BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_originals_delete AFTER DELETE ON attendance_originals BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_adjustments_delete AFTER DELETE ON attendance_adjustments BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_attendance_finalizations_delete AFTER DELETE ON attendance_finalizations BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
