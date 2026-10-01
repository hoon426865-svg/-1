#!/usr/bin/env python3
"""Online read-only snapshot -> private, exclusive D1 import bundle.
Never opens the source for writing, prints records, or overwrites a target.
Run during cutover after disabling writes in the old application.
"""
import argparse, hashlib, json, os, pathlib, sqlite3

PERSISTENT = ['schema_version','employees','tasks','users','attendance','production','overtime','audit','initial_setup','work_requests','work_request_history']
VOLATILE = ['sessions','qr_challenges','qr_uses','deletion_confirmations','login_limits']

def table_manifest(db, table):
    columns = [r[1] for r in db.execute('PRAGMA table_info("'+table+'")')]
    if not columns:
        raise ValueError('Missing required table: '+table)
    rows = list(db.execute('SELECT * FROM "'+table+'" ORDER BY '+','.join('"'+c+'"' for c in columns)))
    payload = json.dumps([columns,rows],ensure_ascii=False,separators=(',',':')).encode()
    return {'rows':len(rows),'sha256':hashlib.sha256(payload).hexdigest()}

def manifest(db):
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or list(db.execute('PRAGMA foreign_key_check')):
        raise ValueError('SQLite integrity/foreign key validation failed')
    if db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0] != 1:
        raise ValueError('Unsupported source schema')
    for (stored,) in db.execute('SELECT password_hash FROM users'):
        import re
        if not re.fullmatch('[a-f0-9]{32}:[a-f0-9]{128}',stored):
            raise ValueError('Unsupported account hash; do not reset or weaken passwords')
    return {table:table_manifest(db,table) for table in PERSISTENT}

def export(source, destination):
    source=pathlib.Path(source).resolve(strict=True)
    destination=pathlib.Path(destination).resolve()
    if source.stat().st_size == 0:
        raise ValueError('Empty source database')
    os.umask(0o077)
    destination.mkdir(mode=0o700,parents=True,exist_ok=False)
    snapshot=destination/'source-snapshot.sqlite'
    # The backup API includes committed WAL entries in a consistent snapshot.
    original=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
    copy=sqlite3.connect(snapshot)
    try:
        original.backup(copy)
        tables=manifest(copy)
        site_ids=[r[0] for r in copy.execute('SELECT DISTINCT site_id FROM employees')]
        if len(site_ids)>1:
            raise ValueError('Multiple site IDs need an explicit migration mapping; records were not modified')
        digest=hashlib.sha256(snapshot.read_bytes()).hexdigest()
        report={'format':1,'source_sha256':digest,'tables':tables,'excluded_ephemeral_tables':VOLATILE,'site_ids':site_ids}
        (destination/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        # The guard refuses nonempty destinations; never INSERT OR REPLACE.
        guards=' AND '.join('(SELECT count(*)=0 FROM "'+t+'")' for t in PERSISTENT if t!='schema_version')
        lines=['-- Private account/employee data: never commit/upload as a CI artifact.',
               'CREATE TABLE migration_empty_guard(ok INTEGER NOT NULL CHECK(ok=1));',
               'INSERT INTO migration_empty_guard SELECT '+guards+';',
               "INSERT INTO worker_import(id,source_digest,verified) VALUES(1,'"+digest+"',0);"]
        for table in PERSISTENT:
            if table=='schema_version': continue
            columns=[r[1] for r in copy.execute('PRAGMA table_info("'+table+'")')]
            for row in copy.execute('SELECT * FROM "'+table+'"'):
                literals=[]
                for value in row:
                    if value is None: literals.append('NULL')
                    elif isinstance(value,(int,float)): literals.append(str(value))
                    elif isinstance(value,bytes): literals.append("X'"+value.hex()+"'")
                    else:
                        if '\x00' in value: raise ValueError('NUL text requires a separate import encoding')
                        literals.append("'"+value.replace("'","''")+"'")
                lines.append('INSERT INTO "'+table+'"('+','.join('"'+c+'"' for c in columns)+') VALUES('+','.join(literals)+');')
        lines.append('DROP TABLE migration_empty_guard;')
        (destination/'import.sql').write_text('\n'.join(lines)+'\n')
        os.chmod(snapshot,0o600)
        print('Private migration bundle created; integrity verified; ephemeral credentials excluded.')
    finally:
        original.close();copy.close()
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--out',required=True)
    args=p.parse_args();export(args.source,args.out)
