import sys,collections
C=collections.Counter(); A=collections.Counter(); hdrs=collections.Counter(); tags=collections.Counter()
class S:
    def __init__(s,t): s.t=t; s.p=0
    def line(s):
        j=s.t.index('\r\n',s.p); r=s.t[s.p:j]; s.p=j+2; return r
    def chars(s,n): r=s.t[s.p:s.p+n]; s.p+=n; return r
def val(s):
    tag=s.line(); tags[tag]+=1
    if tag=='i': return int(s.line())
    if tag=='s': return s.line()
    if tag=='d': return float(s.line())
    if tag=='b': return s.line()
    if tag=='ba': n=int(s.line()); return ('ba',s.chars(n))
    if tag=='TABLE':
        nc=int(s.line()); names=[s.line() for _ in range(nc)]; types=[s.line() for _ in range(nc)]
        hdrs[(nc,tuple(names),tuple(types))]+=1
        n=int(s.line()); return ('TABLE',names,[tuple(val(s) for _ in range(nc)) for _ in range(n)])
    raise Exception('unknown tag %r at %d'%(tag,s.p))
def walkcond(cid,data):
    C[cid]+=1
    if cid in (2,3,21):
        for k,v in data[2]: walkcond(k,v)
def walkact(aid,data):
    A[aid]+=1
    if aid==3:
        for k,v in data[2]: walkact(k,v)
    if aid==4:
        nav=data[1]
        # name, count, then nav
        parts=nav.split('\r\n')
        A['embed_len_ok']+=1
for fn in sys.argv[1:]:
    t=open(fn,'rb').read().decode('latin-1')
    if '\r\n' not in t: t=t.replace('\n','\r\n')
    s=S(t)
    try:
        hdr=[s.line() for _ in range(13)]
        assert hdr==["1","CondAct","5","CType","AType","CData","AData","State","n","n","n","n","n"],hdr
        n=int(s.line())
        for _ in range(n):
            row=[val(s) for _ in range(5)]
            walkcond(row[0],row[2]); walkact(row[1],row[3])
        rest=s.t[s.p:]
        assert rest.strip()=='' ,repr(rest[:80])
    except Exception as e: print("ERR",fn,repr(e)[:200])
print(sorted(C.items(),key=str)); print(sorted(A.items(),key=str)); print(tags); 
for h,c in hdrs.items(): print(c,h)
