import os

# Assemble configurateur.html : on inline three.js et le GLTFLoader (le CDN est
# bloqué en iframe sur la boutique), mais plus les modèles 3D : ceux-ci vivent
# désormais en base et sont servis par /configurateur/models/<cle>.glb.
src = open("cfg_src.html", encoding="utf-8").read()
three = open("three.min.js", encoding="utf-8").read().replace("</script>", "<\\/script>")
gltf = open("GLTFLoader.js", encoding="utf-8").read().replace("</script>", "<\\/script>")
t1 = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
t2 = '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>'
assert t1 in src and t2 in src
src = src.replace(t1, "<script>\n" + three + "\n</script>").replace(t2, "<script>\n" + gltf + "\n</script>")
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "configurateur.html")
open(out, "w", encoding="utf-8").write(src)
print("built bytes", os.path.getsize(out))
