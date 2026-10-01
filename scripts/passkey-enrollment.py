#!/usr/bin/env python3
"""Verify preserved scrypt locally; issue an origin/account-bound short ticket.
The source DB is read-only. Keys/tickets are exclusive files in private/.
The Node helper uses the standard ES256 JOSE signature encoding.
"""
import argparse, getpass, hashlib, hmac, json, pathlib, sqlite3, subprocess, tempfile, os
def issue(source,login,origin,key,out):
    p=pathlib.Path(source).resolve(strict=True)
    db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
    try:
        row=db.execute('SELECT u.id,u.password_hash,u.role,e.active FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE u.login=? COLLATE NOCASE',(login,)).fetchone()
        password=getpass.getpass('기존 계정 비밀번호 (화면에 표시되지 않음): ')
        if not row or (row[2]!='admin' and row[3]!=1):raise ValueError('Account verification failed')
        salt,stored=row[1].split(':')
        actual=hashlib.scrypt(password.encode(),salt=salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=33554432)
        if not hmac.compare_digest(actual,bytes.fromhex(stored)):raise ValueError('Account verification failed')
        password=None
        claims={'sub':row[0],'passwordDigest':hashlib.sha256(row[1].encode()).hexdigest(),'aud':origin,'purpose':'enroll'}
        subprocess.run(['node',str(pathlib.Path(__file__).with_name('sign-enrollment.mjs')),key,out],input=json.dumps(claims),text=True,check=True)
    finally:db.close()
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--login',required=True);p.add_argument('--origin',required=True);p.add_argument('--key',required=True);p.add_argument('--out',required=True)
    a=p.parse_args();issue(a.source,a.login,a.origin,a.key,a.out)
