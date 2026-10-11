#!/usr/bin/env python3
"""Reference parser for VirindiTank .usd settings files (docs/vtank-formats.md §6).

Independent of the TypeScript reader: checks every table parses with nothing left over and
prints each table's columns, index flags, row count and value tags (v: every row too).
Usage: python3 -I tools/vtank/usdscan.py q|v <files...>
"""
import sys
def scan(path, verbose):
    L = open(path,encoding='latin-1').read().replace('\r\n','\n').split('\n')
    p=0
    def nx():
        nonlocal p; v=L[p]; p+=1; return v
    def table(named):
        name=nx() if named else None
        nc=int(nx()); cols=[nx() for _ in range(nc)]; idx=[nx() for _ in range(nc)]; nr=int(nx())
        rows=[]; types=set()
        for r in range(nr):
            row=[]
            for c in range(nc):
                tag=nx(); types.add(tag)
                if tag=='TABLE': row.append(('TABLE',table(False)))
                else: row.append((tag,nx()))
            rows.append(row)
        return dict(name=name,cols=cols,idx=idx,rows=rows,types=sorted(types))
    nt=int(nx())
    print(path, 'tables', nt)
    for t in range(nt):
        tb=table(True)
        print(' ',tb['name'],tb['cols'],tb['idx'],len(tb['rows']),tb['types'])
        if verbose:
            for r in tb['rows']: print('    ',r)
    print(' leftover', L[p:])
for a in sys.argv[2:]: scan(a, sys.argv[1]=='v')
