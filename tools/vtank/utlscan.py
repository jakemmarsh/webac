import sys,collections
ARGS={0:None,1:2,2:2,3:2,4:2,5:2,6:1,7:1,8:1,9:3,10:1,11:2,12:2,13:2,14:5,15:6,16:6,17:2,1000:2,1001:1,1002:1,1003:1,1004:3,2000:1,2001:1,2003:2,2005:2,2006:1,2007:1,2008:3,9999:1}
ARGS[0]=1
rt=collections.Counter(); acts=collections.Counter(); blocks=collections.Counter(); errs=0
for fn in sys.argv[1:]:
    raw=open(fn,'rb').read().decode('utf-8','replace')
    try:
        L=raw.replace('\r\n','\n').split('\n'); i=0
        if L[0]=='UTL': ver=int(L[1]); n=int(L[2]); i=3
        else: ver=0; n=int(L[0]); i=1
        for _ in range(n):
            name=L[i]; i+=1
            if ver>=1: expr=L[i]; i+=1
            big=L[i].split(';'); i+=1
            act=int(big[1]); acts[act]+=1
            if act==10: i+=1
            for t in big[2:]:
                t=int(t); rt[t]+=1
                if ver>=1:
                    ln=int(L[i]); i+=1
                    k=ARGS[t]; got=sum(len(x)+2 for x in L[i:i+k])
                    assert got==ln,(fn,name,t,ln,got)
                i+=ARGS[t]
        while i<len(L) and L[i]!='':
            b=L[i]; ln=int(L[i+1]); blocks[b]+=1; i+=2
            # skip ln chars
            rest='\r\n'.join(L[i:]); consumed=rest[:ln]; i+=consumed.count('\r\n')
        assert all(x=='' for x in L[i:]),(fn,L[i:i+3])
    except Exception as e: errs+=1; print("ERR",fn,repr(e)[:200])
print("files",len(sys.argv)-1,"errs",errs); print("ruletypes",rt); print("actions",acts); print("blocks",blocks)
