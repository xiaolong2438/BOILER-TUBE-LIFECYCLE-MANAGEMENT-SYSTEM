# -*- coding: utf-8 -*-
"""登录页背景图 v5 转换：湛江钢铁晨昏交界版（用户选定实施）
源图: 1672x941 WebP (113KB)，亮度保持原样
产物: v5.webp 桌面主图(q92) / v5.png 桌面回退 / v5-mobile.webp 移动端(900宽,q88)
管线与 v4 相同；登录页叠层已按亮图调轻（见 login.html .page/.page::after）。
"""
import os
from PIL import Image

SRC = r"C:\Users\DLX\Downloads\image-0adfbaf7-9a22-4fb0-8f7b-0a110d0bb545.webp"
ASSETS = r"D:\锅炉炉管全生命周期管理系统\assets"
PREFIX = "power-station-boiler-bg-v5"

def main():
    im = Image.open(SRC).convert("RGB")
    print("source:", im.size)

    desktop_webp = os.path.join(ASSETS, PREFIX + ".webp")
    im.save(desktop_webp, "WEBP", quality=92, method=6)
    print("desktop webp: %.1f KB" % (os.path.getsize(desktop_webp) / 1024))

    desktop_png = os.path.join(ASSETS, PREFIX + ".png")
    im.save(desktop_png, "PNG", optimize=True)
    print("desktop png: %.1f KB" % (os.path.getsize(desktop_png) / 1024))

    mobile = im.resize((900, round(im.height * 900 / im.width)), Image.LANCZOS)
    mobile_webp = os.path.join(ASSETS, PREFIX + "-mobile.webp")
    mobile.save(mobile_webp, "WEBP", quality=88, method=6)
    print("mobile webp: %s %.1f KB" % (mobile.size, os.path.getsize(mobile_webp) / 1024))

if __name__ == "__main__":
    main()
