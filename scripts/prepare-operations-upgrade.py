#!/usr/bin/env python3
"""Restore a D1 export locally and prepare only missing, known migrations.
No network access. Never print database rows, credentials, or raw SQL.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((ROOT / 'migrations').glob('000[1-8]_*.sql'))
TOKEN = re.compile(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`(?:``|[^`])*`|\[[^\]]*\]|\w+|[^\s]", re.S)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(sql):
    # D1 exports can quote identifiers or add IF NOT EXISTS. Preserve literals.
    tokens = []
    for token in TOKEN.findall(sql):
        if token.startswith("'"):
            tokens.append(token)
        elif token[0] in ('"', '`', '['):
            tokens.append(token[1:-1].lower())
        elif token != ';':
            tokens.append(token.lower())
    if tokens[2:5] == ['if', 'not', 'exists']:
        del tokens[2:5]
    return tokens


def schema(db):
    return {name: (kind, canonical(sql)) for name, kind, sql in db.execute(
        "SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")}


def digest(db, table):
    rows = db.execute('SELECT * FROM "' + table.replace('"', '""') + '"').fetchall()
    rows = [[{'blob': value.hex()} if isinstance(value, bytes) else value for value in row] for row in rows]
    encoded = sorted(json.dumps(row, ensure_ascii=False, separators=(',', ':')) for row in rows)
    return hashlib.sha256('\n'.join(encoded).encode()).hexdigest()


def check_integrity(db):
    require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'DB integrity check failed')
    require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'DB foreign key check failed')


def reference_schemas():
    require(len(MIGRATIONS) == 8, 'Expected exactly eight known migration files')
    db = sqlite3.connect(':memory:')
    snapshots = {}
    try:
        for index, migration in enumerate(MIGRATIONS, 1):
            db.executescript(migration.read_text())
            if index >= 6:
                snapshots[index] = schema(db)
        policy = db.execute("SELECT effective_from,definition_json FROM attendance_policies WHERE id='attendance-2026-11-03-v2'").fetchone()
        return snapshots, policy
    finally:
        db.close()


def prepare(backup, output, expect_current=False, before_report=None):
    os.umask(0o077)
    backup = Path(backup).resolve(strict=True)
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    db = sqlite3.connect(output / 'rehearsal.sqlite')
    try:
        db.executescript(backup.read_text())
        check_integrity(db)
        actual = schema(db)
        references, policy = reference_schemas()
        # Match the complete schema, not just migration ledger rows/table counts.
        candidates = [stage for stage, expected in references.items()
                      if all(actual.get(name) == definition for name, definition in expected.items())
                      and not any(name in actual for name in references[8].keys() - expected.keys())]
        require(len(candidates) == 1, 'Unknown or partially applied schema; stopped without remote changes')
        stage = candidates[0]
        if expect_current:
            require(stage == 8, 'Post-upgrade schema is incomplete')
        require(db.execute('SELECT version FROM schema_version').fetchall() == [(1,)], 'Unexpected application schema version')
        require(db.execute('SELECT count(*) FROM worker_revision WHERE id=1').fetchone()[0] == 1, 'Missing D1 revision guard')
        existing_policy = db.execute("SELECT effective_from,definition_json FROM attendance_policies WHERE id='attendance-2026-11-03-v2'").fetchone()
        require(existing_policy and existing_policy[0] == policy[0] and json.loads(existing_policy[1]) == json.loads(policy[1]), 'Paid-break policy is missing or different; review required')
        tables = sorted(name for name, (kind, _) in actual.items() if kind == 'table')
        before = {table: digest(db, table) for table in tables}
        pending = MIGRATIONS[stage:]
        sql_parts = []
        ledger = 'd1_migrations' in tables
        if ledger:
            recorded = {row[0] for row in db.execute('SELECT name FROM d1_migrations')}
            require(not any(file.name in recorded for file in pending), 'Migration ledger disagrees with schema')
        for file in pending:
            sql_parts.append(file.read_text())
            if ledger:
                # Only record migrations actually applied in this same import.
                sql_parts.append("INSERT INTO d1_migrations(name) VALUES('" + file.name + "');")
        planned_sql = '\n'.join(sql_parts)
        if planned_sql:
            db.executescript('BEGIN;\n' + planned_sql + '\nCOMMIT;')
        check_integrity(db)
        require(all(schema(db).get(name) == definition for name, definition in references[8].items()), 'Rehearsed schema mismatch')
        require(all(digest(db, table) == value for table, value in before.items() if table != 'd1_migrations'), 'Migration changed existing data')
        report = {
            'detected_stage': stage,
            'pending_migrations': [file.name for file in pending],
            'backup_sha256': hashlib.sha256(backup.read_bytes()).hexdigest(),
            'migration_sha256': hashlib.sha256(planned_sql.encode()).hexdigest(),
            'table_hashes': before,
            'rehearsal_preserved_tables': len(tables) - int(ledger),
            'integrity': 'ok', 'foreign_keys': 'ok',
        }
        if before_report:
            previous = json.loads(Path(before_report).read_text())['table_hashes']
            require(all(name in before for name in previous), 'An existing table disappeared')
            report['live_snapshot_changed_tables'] = [name for name in previous if name not in ('worker_revision', 'd1_migrations') and before[name] != previous[name]]
            # Live users can write between exports. Do not overwrite their work.
            # This field distinguishes exact snapshot equality from rehearsal.
        (output / 'migration.sql').write_text(planned_sql)
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print('DB 복원·무결성·기존 자료 보존 사전 검사 통과. 적용할 변경: ' + (', '.join(report['pending_migrations']) or '없음'))
        return report
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--expect-current', action='store_true')
    parser.add_argument('--before-report')
    args = parser.parse_args()
    try:
        prepare(args.backup, args.out, args.expect_current, args.before_report)
    except (ValueError, sqlite3.Error) as error:
        # SQLite errors can contain row values. Print only our static messages.
        print('검사 중단: ' + (str(error) if isinstance(error, ValueError) else 'SQLite restore/validation failed; inspect the private backup locally.'))
        raise SystemExit(1)
