import base64,os
src=open("cfg_src.html",encoding="utf-8").read()
three=open("three.min.js",encoding="utf-8").read().replace("</script>","<\\/script>")
gltf=open("GLTFLoader.js",encoding="utf-8").read().replace("</script>","<\\/script>")
glb=base64.b64encode(open("Dragon-light.glb","rb").read()).decode()
rose=base64.b64encode(open("Rose.glb","rb").read()).decode()
t1='<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
t2='<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>'
assert t1 in src and t2 in src and "__GLB_B64__" in src and "__ROSE_B64__" in src
src=src.replace(t1,"<script>\n"+three+"\n</script>").replace(t2,"<script>\n"+gltf+"\n</script>").replace("__GLB_B64__",glb).replace("__ROSE_B64__",rose)
open("configurateur.html","w",encoding="utf-8").write(src)
print("built bytes",os.path.getsize("configurateur.html"))
