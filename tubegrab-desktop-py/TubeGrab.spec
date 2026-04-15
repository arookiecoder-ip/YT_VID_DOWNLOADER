# -*- mode: python ; coding: utf-8 -*-

import shutil
from pathlib import Path

try:
    import customtkinter
    CUSTOMTKINTER_DATA = [(str(Path(customtkinter.__file__).parent), 'customtkinter')]
except Exception:
    CUSTOMTKINTER_DATA = []

# Bundle yt-dlp and ffmpeg next to the exe so the app works without PATH setup
BINARIES = []
for bin_name in ["yt-dlp", "ffmpeg"]:
    found = shutil.which(bin_name)
    if found:
        BINARIES.append((found, '.'))


a = Analysis(
    ['tubegrab.py'],
    pathex=[],
    binaries=BINARIES,
    datas=CUSTOMTKINTER_DATA,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='TubeGrab',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
