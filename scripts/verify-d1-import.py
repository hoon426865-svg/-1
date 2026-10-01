#!/usr/bin/env python3
"""Verify a private D1 SQL export against the frozen source manifest.
Verification imports into a NEW temporary SQLite file, never into the source.
Only matching hashes/counts and empty ephemeral tables yield verified.sql.
"""
import argparse, json, pathlib, sqlite3, tempfile, os
from importlib.machinery import SourceFileLoader
from contextlib import closing
module=SourceFileLoader('d1_export',str(pathlib.Path(__file__).with_name('export-sqlite-d1.py'))).load_module()

def verify(expected_path, export_path, output):
    expected=json.loads(pathlib.Path(expected_path).read_text())
    with tempfile.TemporaryDirectory(prefix='onwork-d1-verify-') as directory:
        with closing(sqlite3.connect(str(pathlib.Path(directory)/'verify.sqlite'))) as db:
            db.executescript(pathlib.Path(export_path).read_text())
            actual=module.manifest(db)
            if actual!=expected['tables']:
                raise ValueError('D1 rows/content differ from source; keep maintenance mode and preserve both databases')
            for table in module.VOLATILE:
                if db.execute('SELECT count(*) FROM "'+table+'"').fetchone()[0]:
                    raise ValueError('Ephemeral credentials must not be migrated: '+table)
            # Fresh legacy migration must not contain unexpected passkeys or
            # live enrollment/admin authorizations before service is enabled.
            for table in ['passkeys','passkey_challenges','passkey_used_tickets','passkey_invites','passkey_admin_challenges','passkey_account_state']:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone() and db.execute('SELECT count(*) FROM "'+table+'"').fetchone()[0]:
                    raise ValueError('Fresh migration contains unexpected authentication state: '+table)
            marker=db.execute('SELECT source_digest FROM worker_import WHERE id=1').fetchone()
            if not marker or marker[0]!=expected['source_sha256']:
                raise ValueError('Source snapshot marker mismatch')
            if db.execute('SELECT count(*) FROM worker_guard').fetchone()[0]:
                raise ValueError('Transaction guard is not empty')
            required=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'revision_%'")]
            if len(required) not in (48,54,61):
                raise ValueError('Expected revision triggers missing')
    os.umask(0o077)
    with open(output,'x') as f:
        f.write("UPDATE worker_import SET verified=1 WHERE id=1 AND source_digest='"+expected['source_sha256']+"';\n")
    print('D1 import verified: all persistent row counts AND contents match; sessions/tokens empty.')
    return True

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--d1-export',required=True);p.add_argument('--out',required=True)
    a=p.parse_args();verify(a.manifest,a.d1_export,a.out)
