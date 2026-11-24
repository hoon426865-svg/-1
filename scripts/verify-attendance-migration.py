#!/usr/bin/env python3
"""Rehearse an additive D1 upgrade in a new private SQLite clone.
The SQL backup is read only; credentials and row contents are never printed.
"""
import argparse, hashlib, json, os, pathlib, sqlite3

def table_digest(db, table):
    rows = db.execute('SELECT * FROM "'+table.replace('"','""')+'"').fetchall()
    rows = [[{'blob_hex':v.hex()} if isinstance(v,bytes) else v for v in row] for row in rows]
    rows.sort(key=lambda row: json.dumps(row,ensure_ascii=False,sort_keys=True))
    return hashlib.sha256(json.dumps(rows,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode()).hexdigest()

def verify(source, migration, output):
    source=pathlib.Path(source).resolve(strict=True)
    output=pathlib.Path(output)
    os.umask(0o077)
    output.mkdir(mode=0o700,parents=True,exist_ok=False)
    db=sqlite3.connect(output/'rehearsal.sqlite')
    try:
        db.executescript(source.read_text())
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")]
        before={t:table_digest(db,t) for t in tables}
        db.executescript(pathlib.Path(migration).read_text())
        assert all(table_digest(db,t)==h for t,h in before.items() if t!='worker_revision'), 'Existing data changed'
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        assert db.execute('SELECT count(*) FROM attendance').fetchone()[0]==db.execute('SELECT count(*) FROM attendance_originals').fetchone()[0]
        report={'backup_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
            'migration_sha256':hashlib.sha256(pathlib.Path(migration).read_bytes()).hexdigest(),
            'tables_preserved':len(tables),'before_hashes':before,
            'checks':['integrity_check','foreign_key_check','existing tables unchanged except worker_revision','all punches captured'],
            'd1_migrations':[r[0] for r in db.execute('SELECT name FROM d1_migrations')] if 'd1_migrations' in tables else None}
        (output/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print('Backup restored; migration rehearsed; '+str(len(tables))+' existing tables preserved; integrity checks passed.')
    finally:
        db.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--backup',required=True)
    parser.add_argument('--migration',default='migrations/0005_attendance_reports.sql')
    parser.add_argument('--out',required=True)
    args=parser.parse_args()
    verify(args.backup,args.migration,args.out)
