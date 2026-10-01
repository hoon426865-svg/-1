#!/usr/bin/env python3
"""SQLite's own parser handles trigger bodies, quoted semicolons and newlines."""
import json, pathlib, sqlite3, sys
statements=[]
current=''
for line in pathlib.Path(sys.argv[1]).read_text().splitlines(keepends=True):
    if not current.strip() and line.lstrip().startswith('--'): continue
    current+=line
    if sqlite3.complete_statement(current):
        statements.append(current.strip());current=''
if current.strip():raise ValueError('Incomplete SQL statement')
print(json.dumps(statements))
