"""Build dist/tvhome.wgt, TV Home as its own Samsung TV app (no TizenBrew needed).

    python3 scripts/build_wgt.py

The package is unsigned: Apps2Samsung signs it with your Samsung certificate when it installs it.
home.html inside the package loads the newest app.html from GitHub, so pushes still reach the TV in minutes.
"""
import os, zipfile
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')


def icon(path):
    # A rounded dark-blue square with a white screen outline: plain enough to read at any size.
    s = 512
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=110, fill=(15, 26, 43, 255))
    d.rounded_rectangle((96, 150, 416, 340), radius=22, outline=(255, 255, 255, 255), width=22)
    d.rounded_rectangle((196, 372, 316, 392), radius=10, fill=(255, 255, 255, 255))
    img.save(path)


def main():
    os.makedirs(DIST, exist_ok=True)
    icon_path = os.path.join(DIST, 'icon.png')
    icon(icon_path)
    out = os.path.join(DIST, 'tvhome.wgt')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(ROOT, 'wgt', 'config.xml'), 'config.xml')
        z.write(os.path.join(ROOT, 'home.html'), 'home.html')
        z.write(os.path.join(ROOT, 'app.html'), 'app.html')
        z.write(icon_path, 'icon.png')
    print(out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main()
