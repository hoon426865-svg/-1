import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('upgrade', ROOT / 'scripts/prepare-operations-upgrade.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class OperationsUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = sqlite3.connect(':memory:')
        for file in upgrade.MIGRATIONS[:6]:
            self.db.executescript(file.read_text())
        self.db.executescript("""
            INSERT INTO users(id,login,password_hash,role,must_change) VALUES('admin','ADMIN','synthetic','admin',0);
            INSERT INTO employees(id,number,name,team,site_id) VALUES('e1','001','합성 직원','생산','site-1');
            INSERT INTO users(id,login,password_hash,role,employee_id,must_change) VALUES('u1','001','synthetic','employee','e1',0);
            INSERT INTO tasks(id,name) VALUES('t1','합성 작업');
            INSERT INTO production(id,employee_id,task_id,task_name,date,recorded_at,good,bad,request_key) VALUES('p1','e1','t1','합성 작업','2026-11-09','2026-11-09T01:00:00Z',8,1,'synthetic-request');
            INSERT INTO sessions(hash,user_id,csrf,expires) VALUES('synthetic-hash','u1','synthetic-csrf',99999999);
            INSERT INTO audit(id,actor_id,actor_login,occurred_at,action,target_id,reason) VALUES('a1','u1','001','2026-11-09T01:00:00Z','production','p1','합성 검사');
        """)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def run_plan(self, name='check', **options):
        backup = self.root / (name + '.sql')
        backup.write_text('\n'.join(self.db.iterdump()))
        with contextlib.redirect_stdout(io.StringIO()):
            return upgrade.prepare(backup, self.root / name, **options)

    def apply_to_fixture(self, name):
        self.db.executescript((self.root / name / 'migration.sql').read_text())

    def test_stage_six_backfills_seven_through_nine_preserving_existing_rows(self):
        before = {name: upgrade.digest(self.db, name) for name in ['users', 'employees', 'production', 'audit', 'sessions', 'worker_revision']}
        report = self.run_plan()
        self.assertEqual(report['pending_migrations'], ['0007_test_data_reset.sql', '0008_operations.sql', '0009_quality_deliveries.sql'])
        self.apply_to_fixture('check')
        self.assertEqual(before, {name: upgrade.digest(self.db, name) for name in before})
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('DELETE FROM audit')
        again = self.run_plan('again', expect_current=True)
        self.assertEqual(again['pending_migrations'], [])
        self.assertEqual((self.root / 'again/migration.sql').read_text(), '')

    def test_stage_seven_applies_eight_and_nine_and_tracks_them_atomically(self):
        self.db.executescript(upgrade.MIGRATIONS[6].read_text())
        self.db.executescript("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); INSERT INTO d1_migrations(name) VALUES('0007_test_data_reset.sql');")
        report = self.run_plan()
        self.assertEqual(report['pending_migrations'], ['0008_operations.sql', '0009_quality_deliveries.sql'])
        self.apply_to_fixture('check')
        self.assertEqual(self.db.execute('SELECT name FROM d1_migrations ORDER BY id').fetchall(), [('0007_test_data_reset.sql',), ('0008_operations.sql',), ('0009_quality_deliveries.sql',)])

    def test_stage_eight_preserves_populated_inventory_and_history_adding_only_nine(self):
        for file in upgrade.MIGRATIONS[6:8]:
            self.db.executescript(file.read_text())
        self.db.executescript("""
            INSERT INTO ops_items(id,drawing,name,model,kind,unit,supplier,source,criteria,warnings) VALUES('part','GC9-PR-9001','합성 부품','TEST','part','EA','합성 공급자','합성 출처','외관','');
            INSERT INTO ops_lots(id,item_id,code,supplier,origin,received,balance,status,created_by,created_at) VALUES('lot','part','LOT-1','합성','receipt',12,10,'released','admin','2026-11-09T01:00:00Z');
            INSERT INTO ops_movements VALUES('m1','lot','receipt',12,'합성 입고','admin','2026-11-09T01:00:00Z');
            INSERT INTO ops_movements VALUES('m2','lot','issue',-2,'합성 출고','admin','2026-11-09T02:00:00Z');
            INSERT INTO ops_inspections VALUES('q1','lot','incoming',2,0,'pass','외관','이상 없음','합성 검사','{}','admin','2026-11-09T01:30:00Z');
            INSERT INTO ops_permissions(user_id,quality) VALUES('u1',1);
            INSERT INTO ops_requests VALUES('admin','synthetic-operations-request','{}','{}');
        """)
        tables = [r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        before = {name: upgrade.digest(self.db, name) for name in tables}
        report = self.run_plan()
        self.assertEqual(report['pending_migrations'], ['0009_quality_deliveries.sql'])
        self.apply_to_fixture('check')
        self.assertEqual(before, {name: upgrade.digest(self.db, name) for name in tables})
        self.assertEqual(self.db.execute('SELECT count(*) FROM ops_deliveries').fetchone()[0], 0)
        self.assertEqual(self.run_plan('again', expect_current=True)['pending_migrations'], [])

    def test_partial_schema_and_disagreeing_ledger_stop(self):
        self.db.execute('CREATE TABLE ops_items(id TEXT PRIMARY KEY)')
        with self.assertRaisesRegex(ValueError, 'partially applied'):
            self.run_plan('partial')
        self.db.execute('DROP TABLE ops_items')
        self.db.executescript("CREATE TABLE d1_migrations(name TEXT UNIQUE); INSERT INTO d1_migrations VALUES('0008_operations.sql');")
        with self.assertRaisesRegex(ValueError, 'ledger disagrees'):
            self.run_plan('ledger')

    def test_missing_protection_trigger_stops(self):
        for file in upgrade.MIGRATIONS[6:]:
            self.db.executescript(file.read_text())
        self.db.execute('DROP TRIGGER ops_production_lock')
        with self.assertRaisesRegex(ValueError, 'partially applied'):
            self.run_plan()

    def test_foreign_key_corruption_stops_before_generating_sql(self):
        self.db.execute("UPDATE production SET employee_id='missing'")
        with self.assertRaisesRegex(ValueError, 'foreign key'):
            self.run_plan()
        self.assertFalse((self.root / 'check/migration.sql').exists())

    def test_snapshot_comparison_records_concurrent_changes_without_overwriting(self):
        self.run_plan('before')
        self.apply_to_fixture('before')
        self.db.execute("UPDATE employees SET name='새 합성 이름' WHERE id='e1'")
        after = self.run_plan('after', expect_current=True, before_report=self.root / 'before/report.json')
        self.assertEqual(after['live_snapshot_changed_tables'], ['employees'])
        self.assertEqual(self.db.execute("SELECT name FROM employees WHERE id='e1'").fetchone()[0], '새 합성 이름')

    def test_post_check_requires_complete_schema(self):
        with self.assertRaisesRegex(ValueError, 'Post-upgrade schema'):
            self.run_plan(expect_current=True)

    def test_export_identifier_quoting_is_accepted_but_changed_constraints_are_not(self):
        self.assertEqual(upgrade.canonical('CREATE TABLE ops_items(id TEXT);'), upgrade.canonical('CREATE TABLE IF NOT EXISTS "ops_items"("id" TEXT)'))
        self.assertNotEqual(upgrade.canonical("CHECK(status IN('pending','released'))"), upgrade.canonical("CHECK(status IN('pending','held'))"))


if __name__ == '__main__':
    unittest.main()
