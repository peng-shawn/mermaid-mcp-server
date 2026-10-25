import re,sys
name=sys.argv[1]; lim=int(sys.argv[2]) if len(sys.argv)>2 else 15
a=open(f'out/oracle/{name}.svg').read(); b=open(f'out/browserless/{name}.svg').read()
def els(s): return [(m.group(1).lower(), dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(2)))) for m in re.finditer(r'<([a-zA-Z][\w:-]*)([^>]*)>', s)]
ea,eb=els(a),els(b)
G=['x','y','width','height','transform','d','points','viewBox','cx','cy','r','x1','x2','y1','y2','dy','dx']
n=0
for i,((ta,aa),(tb,ab)) in enumerate(zip(ea,eb)):
    for k in G:
        va,vb=aa.get(k),ab.get(k)
        if va==vb: continue
        na=[float(x) for x in re.findall(r'-?\d*\.?\d+(?:e[-+]?\d+)?',va or '')]; nb=[float(x) for x in re.findall(r'-?\d*\.?\d+(?:e[-+]?\d+)?',vb or '')]
        if len(na)==len(nb) and all(abs(p-q)<0.5 for p,q in zip(na,nb)): continue
        ctx=aa.get('id') or aa.get('class') or ''
        print(f'{i:4} <{ta} {ctx[:40]}> {k}: C={str(va)[:70]} | J={str(vb)[:70]}'); n+=1
        break
    if n>=lim: break
