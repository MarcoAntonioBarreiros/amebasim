"""Gera os ícones do app (PWA e Android) desenhando uma ameba estilizada."""
import math, os, random
from PIL import Image, ImageDraw, ImageFilter

BG = (11, 16, 22)
RIM = (92, 207, 198)
REAR = (226, 122, 182)
GRAN = (232, 178, 94)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')

def blob_pts(cx, cy, R, n=360):
    pts = []
    for i in range(n):
        t = i / n * 2 * math.pi
        r = 1 + 0.10 * math.sin(3 * t + 0.6) + 0.06 * math.sin(5 * t + 2.1)
        # dois pseudópodes (um principal, um ramo) e um uroide arredondado
        for c, a, w in ((0.25, 0.85, 0.26), (-1.2, 0.55, 0.17), (1.45, 0.38, 0.15), (2.6, 0.08, 0.5)):
            d = math.atan2(math.sin(t - c), math.cos(t - c))
            r += a * math.exp(-(d / w) ** 2)
        pts.append((cx + R * r * math.cos(t), cy + R * r * math.sin(t)))
    return pts

def draw_amoeba(S, scale=1.0, bg=True):
    """S = lado em px (desenhado em 4x e reduzido). scale = fração ocupada."""
    k = 4; N = S * k
    im = Image.new('RGBA', (N, N), BG + (255,) if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    R = N * 0.22 * scale
    cx, cy = N * 0.42, N * 0.52
    pts = blob_pts(cx, cy, R)
    # halo
    halo = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(halo).polygon(pts, fill=RIM + (70,))
    halo = halo.filter(ImageFilter.GaussianBlur(N * 0.03))
    im.alpha_composite(halo)
    # corpo
    d.polygon(pts, fill=(22, 34, 46, 255))
    # endoplasma dourado (nuvem)
    glow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    inner = blob_pts(cx + R * 0.05, cy, R * 0.62)
    gd.polygon(inner, fill=GRAN + (120,))
    glow = glow.filter(ImageFilter.GaussianBlur(N * 0.035))
    mask = Image.new('L', (N, N), 0); ImageDraw.Draw(mask).polygon(pts, fill=255)
    from PIL import ImageChops
    glow.putalpha(ImageChops.multiply(glow.split()[3], mask))
    im.alpha_composite(glow)
    # grânulos, núcleo e vacúolo contrátil numa camada própria (PIL não mescla alfa ao desenhar em RGBA)
    ov = Image.new('RGBA', (N, N), (0, 0, 0, 0)); od = ImageDraw.Draw(ov)
    rnd = random.Random(7)
    for _ in range(int(140 * scale)):
        a = rnd.random() * 2 * math.pi; rr = math.sqrt(rnd.random()) * R * 0.8
        x, y = cx + math.cos(a) * rr, cy + math.sin(a) * rr
        if mask.getpixel((int(x), int(y))) < 128: continue
        g = N * (0.004 + rnd.random() * 0.005)
        od.ellipse((x - g, y - g, x + g, y + g), fill=(239, 230, 207, 220))
    nx, ny, nr = cx - R * 0.25, cy + R * 0.08, R * 0.2
    od.ellipse((nx - nr, ny - nr * 0.85, nx + nr, ny + nr * 0.85), fill=(120, 150, 175, 90), outline=(214, 228, 240, 200), width=max(2, int(N * 0.004)))
    vx, vy, vr = cx - R * 0.72, cy - R * 0.05, R * 0.11
    od.ellipse((vx - vr, vy - vr, vx + vr, vy + vr), fill=(0, 0, 0, 110), outline=(230, 242, 255, 200), width=max(2, int(N * 0.003)))
    im.alpha_composite(ov)
    # membrana: verde-água na frente, magenta no uroide
    w = max(3, int(N * 0.012))
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        t = i / len(pts) * 2 * math.pi
        front = math.cos(t - 0.25)
        col = RIM if front > -0.2 else REAR
        d.line([p, q], fill=col + (255,), width=w)
    return im.resize((S, S), Image.LANCZOS)

def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True); im.save(path)

# PWA
save(draw_amoeba(192), os.path.join(ROOT, 'www/icons/icon-192.png'))
save(draw_amoeba(512), os.path.join(ROOT, 'www/icons/icon-512.png'))
save(draw_amoeba(512, scale=0.8), os.path.join(ROOT, 'www/icons/icon-maskable-512.png'))

# Android (só se o projeto android/ existir)
res = os.path.join(ROOT, 'android/app/src/main/res')
if os.path.isdir(res):
    for dens, s, fg in (('mdpi', 48, 108), ('hdpi', 72, 162), ('xhdpi', 96, 216), ('xxhdpi', 144, 324), ('xxxhdpi', 192, 432)):
        base = draw_amoeba(s)
        save(base, f'{res}/mipmap-{dens}/ic_launcher.png')
        rmask = Image.new('L', (s, s), 0); ImageDraw.Draw(rmask).ellipse((0, 0, s - 1, s - 1), fill=255)
        rnd_im = Image.new('RGBA', (s, s), (0, 0, 0, 0)); rnd_im.paste(base, (0, 0), rmask)
        save(rnd_im, f'{res}/mipmap-{dens}/ic_launcher_round.png')
        # ícone adaptativo: primeiro plano transparente, ameba dentro da zona segura (66%)
        save(draw_amoeba(fg, scale=0.62, bg=False), f'{res}/mipmap-{dens}/ic_launcher_foreground.png')
    os.makedirs(f'{res}/values', exist_ok=True)
    open(f'{res}/values/ic_launcher_background.xml', 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B1016</color>\n</resources>\n')
    # telas de abertura: fundo do campo escuro com a ameba ao centro
    for dirpath, _, files in os.walk(res):
        if 'splash.png' in files and os.path.basename(dirpath).startswith('drawable'):
            fp = os.path.join(dirpath, 'splash.png')
            w, h = Image.open(fp).size
            sp = Image.new('RGB', (w, h), BG)
            s = int(min(w, h) * 0.42)
            ic = draw_amoeba(s).convert('RGB')
            sp.paste(ic, ((w - s) // 2, (h - s) // 2))
            sp.save(fp)
print('ícones ok')
