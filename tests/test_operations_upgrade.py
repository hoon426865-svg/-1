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

    def test_stage_six_backfills_only_seven_and_eight_preserving_existing_rows(self):
        before = {name: upgrade.digest(self.db, name) for name in ['users', 'employees', 'production', 'audit', 'sessions', 'worker_revision']}
        report = self.run_plan()
        self.assertEqual(report['pending_migrations'], ['0007_test_data_reset.sql', '0008_operations.sql'])
        self.apply_to_fixture('check')
        self.assertEqual(before, {name: upgrade.digest(self.db, name) for name in before})
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('DELETE FROM audit')
        again = self.run_plan('again', expect_current=True)
        self.assertEqual(again['pending_migrations'], [])
        self.assertEqual((self.root / 'again/migration.sql').read_text(), '')

    def test_stage_seven_applies_only_eight_and_tracks_it_atomically(self):
        self.db.executescript(upgrade.MIGRATIONS[6].read_text())
        self.db.executescript("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); INSERT INTO d1_migrations(name) VALUES('0007_test_data_reset.sql');")
        report = self.run_plan()
        self.assertEqual(report['pending_migrations'], ['0008_operations.sql'])
        self.apply_to_fixture('check')
        self.assertEqual(self.db.execute('SELECT name FROM d1_migrations ORDER BY id').fetchall(), [('0007_test_data_reset.sql',), ('0008_operations.sql',)])

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
