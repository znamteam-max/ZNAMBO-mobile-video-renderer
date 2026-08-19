import server


def tf(rw, rh, transform):
    transform = transform or {}
    zoom = server.clamp(float(transform.get('zoom') or 1), 0.55, 4)
    x = server.clamp(float(transform.get('panX') or 0), -1, 1)
    y = server.clamp(float(transform.get('panY') or 0), -1, 1)
    ratio = rw / rh
    return (
        f"scale=w='if(gt(a,{ratio:.10f}),-2,ceil({rw}*{zoom:.6f}/2)*2)'"
        f":h='if(gt(a,{ratio:.10f}),ceil({rh}*{zoom:.6f}/2)*2,-2)',"
        f"pad=w='max(iw,{rw})':h='max(ih,{rh})':x='(ow-iw)/2':y='(oh-ih)/2':color=black,"
        f"crop={rw}:{rh}:'(iw-ow)/2*(1+{-x:.6f})':'(ih-oh)/2*(1+{-y:.6f})',"
        f"setsar=1,fps={server.FPS},format=yuv420p"
    )


def install():
    server.tf = tf
    return server
