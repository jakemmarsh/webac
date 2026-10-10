import sys,collections
cnt=collections.Counter(); ex={}
def parse(L,i,fn):
    assert L[i]=="uTank2 NAV 1.2",(fn,L[i]); i+=1
    t=int(L[i]); i+=1
    cnt['navtype%d'%t]+=1
    if t==3: ex.setdefault('follow',(fn,L[i:i+2])); return i+2
    n=int(L[i]); i+=1
    for _ in range(n):
        nt=int(L[i]); i+=1
        xyz=L[i:i+3]; i+=3; assert L[i]=="0",(fn,i,L[i]); i+=1
        extra={0:0,1:1,2:1,3:1,4:1,5:2,6:6,7:6,8:0,9:3}[nt]
        cnt[nt]+=1
        ex.setdefault(nt,(fn,xyz,L[i:i+extra]))
        i+=extra
    return i
for fn in sys.argv[1:]:
    L=open(fn,encoding='latin-1').read().replace('\r\n','\n').split('\n')
    try: parse(L,0,fn)
    except Exception as e: print("ERR",fn,e)
print(cnt)
for k,v in ex.items(): print(k,v)
