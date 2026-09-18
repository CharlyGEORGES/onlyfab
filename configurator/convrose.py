import zipfile, numpy as np, xml.etree.ElementTree as ET, trimesh, fast_simplification, time
t0=time.time()
Z="/root/.claude/uploads/22730c4a-4881-550e-8094-9e0c06b56ba2/54bab524-Cinderwing3D_BabyRoseDragon_Colors_Simple.3mf"
z=zipfile.ZipFile(Z)
NS="{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}"
verts=[]; faces=[]; fpaint=[]
with z.open("3D/Objects/object_1.model") as f:
    for ev,el in ET.iterparse(f,events=("end",)):
        tag=el.tag
        if tag==NS+"vertex":
            verts.append((float(el.get("x")),float(el.get("y")),float(el.get("z")))); el.clear()
        elif tag==NS+"triangle":
            faces.append((int(el.get("v1")),int(el.get("v2")),int(el.get("v3"))))
            fpaint.append(el.get("paint_color")); el.clear()
V=np.array(verts,dtype=np.float64); F=np.array(faces,dtype=np.int64)
print("parsed",V.shape,F.shape,"t=%.1f"%(time.time()-t0))
# zone per face: accent(1) if painted with majority non-zero digits, else base(0)
def is_accent(s):
    if not s: return False
    nz=sum(1 for c in s if c not in '0'); return nz*2>=len(s)
zone=np.array([1 if is_accent(s) else 0 for s in fpaint],dtype=np.int8)
print("accent faces",int((zone==1).sum()),"/",len(zone))
# Z-up (mm) -> Y-up : (x,y,z)->(x,z,-y)
V2=np.column_stack([V[:,0],V[:,2],-V[:,1]])
def decimate(vs,fs,target):
    if len(fs)<=target: return vs,fs
    v2,f2=fast_simplification.simplify(vs.astype(np.float32),fs.astype(np.int32),target_count=int(target))
    return v2,f2
scene=trimesh.Scene()
names={0:"Corps",1:"Pointes"}
targets={0:22000,1:9000}
for zid,nm in names.items():
    fmask=zone==zid
    if fmask.sum()==0: continue
    fsub=F[fmask]
    used=np.unique(fsub); remap=-np.ones(V2.shape[0],dtype=np.int64); remap[used]=np.arange(len(used))
    vs=V2[used]; fs=remap[fsub]
    vd,fd=decimate(vs,fs,targets[zid])
    m=trimesh.Trimesh(vertices=vd,faces=fd,process=False)
    scene.add_geometry(m,geom_name=nm,node_name=nm)
    print(nm,"tris",len(fd),"verts",len(vd))
glb=scene.export(file_type="glb")
open("Rose.glb","wb").write(glb)
print("Rose.glb bytes",len(glb),"t=%.1f"%(time.time()-t0))
