"""
TubeGrab Desktop — YouTube downloader GUI
Built with customtkinter for a modern dark look.
Requires: yt-dlp, ffmpeg in PATH
"""

import customtkinter as ctk
import threading
import subprocess
import json
import os
import sys
import re
import io
import shutil
import tempfile
import time
from pathlib import Path
from tkinter import filedialog, messagebox

try:
    from PIL import Image, ImageTk
    import urllib.request
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# ── Theme setup ──────────────────────────────────────────────────────────────
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")

# Color palette (matching the website)
BG = "#0a0a0f"
SURFACE = "#12121a"
SURFACE2 = "#1a1a26"
SURFACE3 = "#22222f"
BORDER = "#2a2a3a"
ACCENT = "#ff3366"
ACCENT2 = "#ff6633"
ACCENT3 = "#cc33ff"
TEXT = "#e8e8f0"
TEXT_DIM = "#8888aa"
TEXT_DIMMER = "#55556a"
SUCCESS = "#33ff99"
ERR = "#ff6688"

# ── Utility ───────────────────────────────────────────────────────────────────


def resolve_binary(name):
    # When running as a frozen PyInstaller exe, look next to the exe first
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        for candidate in [name, name + ".exe"]:
            full = os.path.join(exe_dir, candidate)
            if os.path.isfile(full):
                return full
    path = shutil.which(name)
    return path or name


YT_DLP = resolve_binary("yt-dlp")
FFMPEG = resolve_binary("ffmpeg")


def fmt_bytes(b):
    if not b:
        return "varies"
    if b >= 1e9:
        return f"{b/1e9:.2f} GB"
    if b >= 1e6:
        return f"{b/1e6:.1f} MB"
    return f"{b/1e3:.0f} KB"


def fmt_duration(secs):
    if not secs:
        return ""
    h, rem = divmod(int(secs), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def fmt_views(n):
    if not n:
        return ""
    if n >= 1e9:
        return f"{n/1e9:.1f}B views"
    if n >= 1e6:
        return f"{n/1e6:.1f}M views"
    if n >= 1e3:
        return f"{n/1e3:.0f}K views"
    return f"{n} views"


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|]', '', str(name or "video"))
    name = re.sub(r'[\x00-\x1f\x7f]', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name[:120] or "video"


def make_temp_path(suffix, prefix="tubegrab-"):
    # Reserve a unique temp pathname, then remove the placeholder so external tools can create it.
    fd, temp_path = tempfile.mkstemp(suffix=suffix, prefix=prefix)
    os.close(fd)
    try:
        os.unlink(temp_path)
    except OSError:
        pass
    return temp_path


YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "music.youtube.com", "youtu.be",
    "youtube-nocookie.com", "www.youtube-nocookie.com"
}
VIDEO_ID_RE = re.compile(r'^[\w-]{11}$')
LIST_ID_RE = re.compile(r'^[\w-]{1,64}$')


def parse_youtube_url(raw):
    raw = (raw or "").strip()
    for prefix in ["", "https://"]:
        try:
            from urllib.parse import urlparse, parse_qs
            p = urlparse(prefix + raw)
            if p.scheme not in ("http", "https"):
                continue
            host = (p.hostname or "").lower()
            host = re.sub(r'\.+', '.', host).rstrip('.')
            if host.lower() not in YOUTUBE_HOSTS:
                continue
            qs = parse_qs(p.query)
            video_id = (qs.get("v") or [None])[0]
            list_id = (qs.get("list") or [None])[0]
            short_m = re.match(r'^/(shorts|live|embed)/([\w-]{11})', p.path)
            short_id = p.path.lstrip(
                "/").split("/")[0] if host == "youtu.be" else None

            has_video = (
                (video_id and VIDEO_ID_RE.match(video_id)) or
                (short_m and VIDEO_ID_RE.match(short_m.group(2))) or
                (short_id and VIDEO_ID_RE.match(short_id))
            )
            has_list = (
                (p.path.startswith("/playlist") and list_id and LIST_ID_RE.match(list_id)) or
                (p.path == "/watch" and list_id and LIST_ID_RE.match(list_id))
            )
            if not has_video and not has_list:
                continue
            vid = (
                (video_id if video_id and VIDEO_ID_RE.match(video_id) else None) or
                (short_m.group(2) if short_m else None) or
                (short_id if short_id and VIDEO_ID_RE.match(short_id) else None)
            )
            return {
                "video_id": vid,
                "list_id": list_id if list_id and LIST_ID_RE.match(list_id) else None,
                "is_playlist_path": p.path.startswith("/playlist"),
            }
        except Exception:
            continue
    return None


def is_playlist(url):
    info = parse_youtube_url(url)
    if not info:
        return False
    if info["is_playlist_path"] and info["list_id"]:
        return True
    return bool(info["list_id"]) and not info["video_id"]


def run_ytdlp(args, timeout=120):
    full_args = [YT_DLP, "--ignore-config", "--socket-timeout", "30"] + args
    result = subprocess.run(
        full_args,
        capture_output=True, text=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if result.returncode != 0:
        stderr = result.stderr or ""
        lines = [l.strip() for l in stderr.splitlines() if l.strip()]
        err_line = next((l for l in reversed(lines)
                        if re.match(r'^ERROR:', l, re.I)), None)
        msg = (err_line or lines[-1] if lines else "yt-dlp failed")
        msg = re.sub(r'^ERROR:\s*', '', msg, flags=re.I)
        raise RuntimeError(msg[:400])
    return result.stdout.strip()


def check_deps():
    results = {}
    checks = [
        ("yt-dlp", YT_DLP, ["--version"]),
        ("ffmpeg", FFMPEG, ["-version"]),
    ]
    for name, binary, args in checks:
        try:
            r = subprocess.run(
                [binary, *args],
                capture_output=True, text=True, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if r.returncode == 0:
                output = (r.stdout or "").strip() or (r.stderr or "").strip()
                results[name] = output.splitlines()[0] if output else None
            else:
                results[name] = None
        except Exception:
            results[name] = None
    return results


def fetch_info(url):
    if is_playlist(url):
        raw = run_ytdlp([
            "--dump-single-json", "--flat-playlist", "--no-warnings",
            "--yes-playlist", "--playlist-end", "500", url,
        ])
        data = json.loads(raw)
        entries = _normalize_playlist(data.get("entries") or [])
        if not entries:
            raise RuntimeError(
                "Playlist found but no downloadable entries detected.")
        first_thumb = next((e["thumbnail"]
                           for e in entries if e.get("thumbnail")), None)
        return {
            "kind": "playlist",
            "id": data.get("id", "playlist"),
            "title": data.get("title") or "Untitled Playlist",
            "channel": data.get("uploader") or data.get("channel") or "Unknown",
            "thumbnail": data.get("thumbnail") or first_thumb,
            "playlist_count": len(entries),
            "entries": entries,
            "formats": _fallback_formats(for_playlist=True),
        }

    raw = run_ytdlp(["--dump-json", "--no-warnings", "--no-playlist", url])
    info = json.loads(raw)
    formats = _parse_formats(info.get("formats") or [])
    if len(formats) <= 1:
        formats = _fallback_formats(for_playlist=False)
    vid_id = info.get("id", "")
    return {
        "kind": "video",
        "id": vid_id,
        "title": info.get("title") or "Untitled",
        "channel": info.get("uploader") or info.get("channel") or "Unknown",
        "views": info.get("view_count") or 0,
        "duration": int(info["duration"]) if info.get("duration") else None,
        "upload_date": _fmt_date(info.get("upload_date")),
        "thumbnail": info.get("thumbnail") or f"https://img.youtube.com/vi/{vid_id}/maxresdefault.jpg",
        "formats": formats,
    }


def _fmt_date(d):
    if not d or len(d) != 8:
        return None
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def _normalize_playlist(entries):
    out = []
    for i, e in enumerate(entries):
        vid = e.get("id")
        if not vid and isinstance(e.get("url"), str) and VIDEO_ID_RE.match(e["url"]):
            vid = e["url"]
        watch = None
        if vid:
            watch = f"https://www.youtube.com/watch?v={vid}"
        elif isinstance(e.get("url"), str) and e["url"].startswith("http"):
            watch = e["url"]
            m = re.search(r'[?&]v=([\w-]{11})', watch)
            if m:
                vid = m.group(1)
        if not watch:
            continue
        thumb = e.get("thumbnail") or (
            f"https://img.youtube.com/vi/{vid}/hqdefault.jpg" if vid else None)
        out.append({"id": vid or f"item-{i+1}", "title": str(e.get("title")
                   or f"Video {i+1}").strip(), "url": watch, "thumbnail": thumb})
    return out


def _is_h264(vcodec):
    return isinstance(vcodec, str) and vcodec.startswith("avc1")


def _parse_formats(raw_formats):
    by_height = {}
    for fmt in raw_formats:
        if not fmt or not fmt.get("vcodec") or fmt["vcodec"] == "none" or not fmt.get("height"):
            continue
        h = fmt["height"]
        slot = by_height.setdefault(h, {"progressive": None, "adaptive": None})
        has_audio = fmt.get("acodec") and fmt["acodec"] != "none"
        if has_audio:
            cur = slot["progressive"]
            if not cur or (not _is_h264(cur["vcodec"]) and _is_h264(fmt["vcodec"])) or (cur.get("ext") != "mp4" and fmt.get("ext") == "mp4"):
                slot["progressive"] = fmt
        else:
            cur = slot["adaptive"]
            if not cur or (not _is_h264(cur["vcodec"]) and _is_h264(fmt["vcodec"])) or (cur.get("ext") != "mp4" and fmt.get("ext") == "mp4"):
                slot["adaptive"] = fmt

    video_fmts = []
    for height, slot in by_height.items():
        if slot["progressive"]:
            f = slot["progressive"]
            fid = f"bestvideo[vcodec^=avc1][height={height}]+bestaudio[ext=m4a]/bestvideo[height={height}]+bestaudio/best[height<={height}]"
            detail = f"MP4 · {fmt_bytes(f.get('filesize') or f.get('filesize_approx'))}"
            badge = "HD" if height >= 1080 else ""
        elif slot["adaptive"]:
            f = slot["adaptive"]
            fid = f"bestvideo[vcodec^=avc1][height={height}]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1][height<={height}]+bestaudio[ext=m4a]/bestvideo[height<={height}]+bestaudio/best[height<={height}]"
            detail = f"MP4 · {fmt_bytes(f.get('filesize') or f.get('filesize_approx'))} + audio"
            badge = "HD" if height >= 1080 else ""
        else:
            continue
        video_fmts.append({"id": fid, "label": f"{height}p", "height": height,
                          "detail": detail, "type": "video", "ext": "mp4", "badge": badge})

    video_fmts.sort(key=lambda x: x["height"], reverse=True)
    return video_fmts + [{"id": "bestaudio", "label": "MP3", "detail": "320kbps Audio", "type": "audio", "ext": "mp3", "badge": "Audio"}]


def _fallback_formats(for_playlist=False):
    if for_playlist:
        return [
            {"id": "best", "label": "Best", "detail": "Best available per video",
                "type": "video", "ext": "mp4", "badge": "HD"},
            {"id": "bestvideo[height<=1080]+bestaudio/best[height<=1080]", "label": "1080p",
                "detail": "Up to 1080p", "type": "video", "ext": "mp4", "badge": "FHD"},
            {"id": "bestvideo[height<=720]+bestaudio/best[height<=720]", "label": "720p",
                "detail": "Up to 720p", "type": "video", "ext": "mp4", "badge": "HD"},
            {"id": "bestvideo[height<=480]+bestaudio/best[height<=480]", "label": "480p",
                "detail": "Up to 480p", "type": "video", "ext": "mp4", "badge": "SD"},
            {"id": "bestaudio", "label": "MP3", "detail": "Audio only",
                "type": "audio", "ext": "mp3", "badge": "Audio"},
        ]
    return [
        {"id": "best", "label": "Best", "detail": "Best available",
            "type": "video", "ext": "mp4", "badge": "HD"},
        {"id": "bestaudio", "label": "MP3", "detail": "Audio only",
            "type": "audio", "ext": "mp3", "badge": "Audio"},
    ]


def _prefer_m4a(sel):
    if "+" not in sel:
        return sel
    sel = re.sub(r'\+bestaudio/best',
                 '+bestaudio[ext=m4a]/bestaudio/best', sel)
    sel = re.sub(r'\+bestaudio(?!\[)', '+bestaudio[ext=m4a]/bestaudio', sel)
    return sel


def get_format_selector(fmt_id, is_audio):
    if is_audio:
        return "bestaudio/best"
    sel = fmt_id if fmt_id and fmt_id != "best" else "best"
    return _prefer_m4a(sel)


def build_dl_args(fmt_id, is_audio, output_path):
    selector = get_format_selector(fmt_id, is_audio)
    needs_merge = not is_audio and "+" in selector
    args = [
        "--no-warnings", "--no-playlist", "--no-check-certificates", "--newline",
    ]
    if is_audio:
        args += ["-x", "--audio-format", "mp3", "--audio-quality",
                 "0", "-f", selector, "-o", output_path]
    else:
        args += ["-f", selector]
        if needs_merge:
            args += ["--merge-output-format", "mp4"]
        args += ["-o", output_path]
    return args, needs_merge

# ── App ───────────────────────────────────────────────────────────────────────


class TubeGrabApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("TubeGrab")
        self.geometry("860x680")
        self.minsize(600, 520)
        self.configure(fg_color=BG)

        # State
        self._current_info = None
        self._selected_fmt = None
        self._dl_jobs = {}       # job_id -> dict
        self._job_counter = 0
        self._thumb_images = {}  # url -> CTkImage
        self._thumb_raw = None   # raw PIL image for responsive resizing
        self._card_layout = None  # "wide" or "narrow"

        self._build_ui()
        self._check_deps_async()

    # ── UI build ──────────────────────────────────────────────────────────────
    def _build_ui(self):
        # Title bar area (simulated)
        self._title_bar = ctk.CTkFrame(
            self, fg_color=SURFACE, corner_radius=0, height=44)
        self._title_bar.pack(fill="x", side="top")
        self._title_bar.pack_propagate(False)

        logo_frame = ctk.CTkFrame(
            self._title_bar, fg_color=ACCENT, corner_radius=7, width=26, height=26)
        logo_frame.place(relx=0, rely=0.5, anchor="w", x=14)
        ctk.CTkLabel(logo_frame, text="▼", font=("", 11, "bold"),
                     text_color="#fff").place(relx=0.5, rely=0.5, anchor="center")

        ctk.CTkLabel(self._title_bar, text="TubeGrab", font=(
            "", 13, "bold"), text_color=TEXT_DIM).place(x=50, rely=0.5, anchor="w")

        self._dep_label = ctk.CTkLabel(
            self._title_bar, text="", font=("Consolas", 10), text_color=TEXT_DIM)
        self._dep_label.place(relx=1.0, rely=0.5, anchor="e", x=-14)

        # Separator
        sep = ctk.CTkFrame(self, fg_color=BORDER, height=1, corner_radius=0)
        sep.pack(fill="x", side="top")

        # Downloads tray — must be packed at side="bottom" BEFORE the expanding
        # scroll frame so tkinter reserves its space correctly. Hidden until first download.
        self._tray_outer = ctk.CTkFrame(
            self, fg_color=SURFACE, corner_radius=0, border_color=BORDER, border_width=0)
        sep2 = ctk.CTkFrame(self._tray_outer, fg_color=BORDER,
                            height=1, corner_radius=0)
        sep2.pack(fill="x", side="top")

        tray_header = ctk.CTkFrame(self._tray_outer, fg_color="transparent")
        tray_header.pack(fill="x", padx=14, pady=(5, 0))
        self._tray_title_lbl = ctk.CTkLabel(
            tray_header, text="Downloads", font=("", 11, "bold"), text_color=TEXT_DIM)
        self._tray_title_lbl.pack(side="left")
        self._tray_count_lbl = ctk.CTkLabel(tray_header, text="", font=("", 10, "bold"),
                                            fg_color=ACCENT, text_color="#fff", corner_radius=10, width=20)
        self._tray_count_lbl.pack(side="left", padx=(6, 0))

        self._tray_scroll = ctk.CTkScrollableFrame(self._tray_outer, height=110, fg_color="transparent",
                                                   scrollbar_button_color=BORDER)
        self._tray_scroll.pack(fill="x", padx=8, pady=(4, 6))
        self._tray_scroll.columnconfigure(0, weight=1)

        self._tray_outer.pack(fill="x", side="bottom")
        self._tray_outer.pack_forget()  # hidden until first download

        # Scrollable main area — packed after tray so tray space is reserved
        self._main_scroll = ctk.CTkScrollableFrame(
            self, fg_color=BG, scrollbar_button_color=BORDER, scrollbar_button_hover_color=SURFACE3)
        self._main_scroll.pack(fill="both", expand=True, padx=0, pady=0)
        self._main_scroll.columnconfigure(0, weight=1)

        inner = ctk.CTkFrame(self._main_scroll, fg_color="transparent")
        inner.pack(fill="x", expand=False, padx=24, pady=(22, 24))
        inner.columnconfigure(0, weight=1)

        self._inner = inner

        # Dep warning banner
        self._dep_banner = ctk.CTkLabel(inner, text="", font=("", 12),
                                        text_color="#ffaa66", fg_color=SURFACE2,
                                        corner_radius=8, wraplength=680, justify="left")

        # Search section
        search_frame = ctk.CTkFrame(
            inner, fg_color=SURFACE, border_color=BORDER, border_width=2, corner_radius=12)
        search_frame.grid(row=1, column=0, sticky="ew", pady=(0, 6))
        search_frame.columnconfigure(0, weight=1)

        inner_search = ctk.CTkFrame(search_frame, fg_color="transparent")
        inner_search.pack(fill="x", padx=6, pady=6)
        inner_search.columnconfigure(0, weight=1)

        self._url_var = ctk.StringVar()
        self._url_var.trace_add("write", self._on_url_change)

        self._url_entry = ctk.CTkEntry(
            inner_search,
            textvariable=self._url_var,
            placeholder_text="Paste a YouTube URL here…",
            font=("Consolas", 13),
            fg_color="transparent",
            border_width=0,
            text_color=TEXT,
            placeholder_text_color=TEXT_DIMMER,
            height=42,
        )
        self._url_entry.grid(row=0, column=0, sticky="ew", padx=(8, 0))
        self._url_entry.bind("<Return>", lambda _: self._fetch_video())

        self._clear_btn = ctk.CTkButton(
            inner_search, text="✕", width=28, height=28,
            fg_color=SURFACE3, hover_color=ACCENT, text_color=TEXT_DIM,
            font=("", 11), corner_radius=14,
            command=self._clear_search,
        )
        self._clear_btn.grid(row=0, column=1, padx=(4, 0))

        self._fetch_btn = ctk.CTkButton(
            inner_search,
            text="  Fetch  ",
            font=("", 13, "bold"),
            fg_color=ACCENT,
            hover_color="#cc2a52",
            text_color="#fff",
            corner_radius=8,
            height=42,
            command=self._fetch_video,
        )
        self._fetch_btn.grid(row=0, column=2, padx=(6, 0))

        ctk.CTkLabel(inner, text="Supports single videos, Shorts, playlists & music.youtube.com",
                     font=("", 11), text_color=TEXT_DIMMER).grid(row=2, column=0, pady=(0, 14))

        # Loader
        self._loader_frame = ctk.CTkFrame(inner, fg_color="transparent")
        self._loader_label = ctk.CTkLabel(
            self._loader_frame, text="Fetching info…", font=("", 13), text_color=TEXT_DIM)
        self._loader_label.pack()
        self._loader_progress = ctk.CTkProgressBar(
            self._loader_frame, width=200, fg_color=SURFACE3, progress_color=ACCENT)
        self._loader_progress.pack(pady=(10, 0))
        self._loader_progress.configure(mode="indeterminate")

        # Error
        self._error_label = ctk.CTkLabel(inner, text="",
                                         font=("", 12), text_color=ERR,
                                         fg_color="transparent", wraplength=680, justify="left")

        # Result card — responsive: side-by-side when wide, stacked when narrow
        self._result_card = ctk.CTkFrame(
            inner, fg_color=SURFACE, border_color=BORDER, border_width=1, corner_radius=14)
        self._result_card.columnconfigure(0, weight=1)
        self._card_layout = None  # tracks current layout: "wide" or "narrow"

        # Thumbnail
        self._thumb_label = ctk.CTkLabel(
            self._result_card, text="", fg_color="#000", corner_radius=0)

        # Right-side info panel (used in wide mode) and inline panel (narrow mode)
        # We create a single info_panel that gets re-parented by re-gridding
        self._info_panel = ctk.CTkFrame(self._result_card, fg_color="transparent")
        self._info_panel.columnconfigure(0, weight=1)

        self._meta_label = ctk.CTkLabel(self._info_panel, text="",
                                        font=("", 11), text_color=TEXT_DIM, justify="left")
        self._meta_label.grid(row=0, column=0, sticky="w", padx=18, pady=(14, 0))

        self._title_label = ctk.CTkLabel(self._info_panel, text="",
                                         font=("", 15, "bold"), text_color=TEXT,
                                         justify="left", wraplength=400, anchor="w")
        self._title_label.grid(row=1, column=0, sticky="w", padx=18, pady=(4, 10))

        self._fmt_header = ctk.CTkLabel(self._info_panel, text="SELECT QUALITY",
                                        font=("Consolas", 10), text_color=TEXT_DIMMER)
        self._fmt_header.grid(row=2, column=0, sticky="w", padx=18, pady=(0, 8))

        self._fmt_frame = ctk.CTkFrame(self._info_panel, fg_color="transparent")
        self._fmt_frame.grid(row=3, column=0, sticky="ew", padx=18, pady=(0, 16))

        self._dl_btn = ctk.CTkButton(
            self._info_panel,
            text="⬇  Download",
            font=("", 14, "bold"),
            fg_color=ACCENT,
            hover_color=ACCENT2,
            text_color="#fff",
            corner_radius=9,
            height=48,
            command=self._start_download,
        )
        self._dl_btn.grid(row=4, column=0, sticky="ew", padx=18, pady=(0, 20))

        # Bind resize to switch layout
        self._result_card.bind("<Configure>", self._on_card_resize)

        self._dl_rows = {}  # job_id -> {frame, bar, label}

        self._update_clear_btn()

    # ── Dep check ─────────────────────────────────────────────────────────────
    def _check_deps_async(self):
        def _run():
            deps = check_deps()
            self.after(0, self._show_deps, deps)
        threading.Thread(target=_run, daemon=True).start()

    def _show_deps(self, deps):
        parts = []
        missing = []
        for name in ["yt-dlp", "ffmpeg"]:
            ok = deps.get(name)
            if ok:
                parts.append(f"✓ {name}")
            else:
                parts.append(f"✗ {name}")
                missing.append(name)
        self._dep_label.configure(text="  ".join(parts),
                                  text_color=SUCCESS if not missing else ERR)

        if missing:
            msg = "Missing: " + \
                ", ".join(missing) + \
                ". Install them and ensure they are in PATH."
            self._dep_banner.configure(text=msg, height=36)
            self._dep_banner.grid(row=0, column=0, sticky="ew", pady=(0, 12))

    # ── Search ────────────────────────────────────────────────────────────────
    def _on_url_change(self, *_):
        self._update_clear_btn()

    def _update_clear_btn(self):
        if self._url_var.get().strip():
            self._clear_btn.configure(state="normal", fg_color=SURFACE3)
        else:
            self._clear_btn.configure(state="disabled", fg_color=SURFACE3)

    def _clear_search(self):
        self._url_var.set("")
        self._hide_result()
        self._url_entry.focus()

    def _hide_result(self):
        self._result_card.grid_remove()
        self._error_label.grid_remove()
        self._current_info = None
        self._selected_fmt = None
        self._thumb_raw = None
        self._card_layout = None

    def _fetch_video(self):
        url = self._url_var.get().strip()
        if not url:
            return

        self._hide_result()
        self._error_label.grid_remove()
        self._show_loader(True)
        self._fetch_btn.configure(state="disabled", text="Fetching…")

        def _run():
            try:
                info = fetch_info(url)
                self.after(0, self._on_info, info)
            except Exception as e:
                self.after(0, self._on_fetch_error, str(e))

        threading.Thread(target=_run, daemon=True).start()

    def _show_loader(self, on):
        if on:
            self._loader_frame.grid(row=3, column=0, pady=20)
            self._loader_progress.start()
        else:
            self._loader_progress.stop()
            self._loader_frame.grid_remove()
        self._fetch_btn.configure(
            state="normal", text="  Fetch  ") if not on else None

    def _on_fetch_error(self, msg):
        self._show_loader(False)
        self._fetch_btn.configure(state="normal", text="  Fetch  ")
        self._error_label.configure(text=f"Error: {msg}")
        self._error_label.grid(row=3, column=0, sticky="ew", pady=(4, 0))

    def _on_info(self, info):
        self._show_loader(False)
        self._fetch_btn.configure(state="normal", text="  Fetch  ")
        self._current_info = info
        self._render_result(info)

    # ── Result rendering ──────────────────────────────────────────────────────
    def _render_result(self, info):
        # Thumbnail
        self._thumb_label.configure(image=None, text="")
        if info.get("thumbnail"):
            self._load_thumb_async(info["thumbnail"])

        # Meta / title
        meta_parts = []
        if info.get("channel"):
            meta_parts.append(info["channel"])
        if info.get("views"):
            meta_parts.append(fmt_views(info["views"]))
        if info.get("upload_date"):
            meta_parts.append(info["upload_date"])
        if info.get("duration"):
            meta_parts.append(fmt_duration(info["duration"]))
        if info.get("playlist_count"):
            meta_parts.append(f"{info['playlist_count']} videos")
        self._meta_label.configure(text="  ·  ".join(meta_parts))
        self._title_label.configure(text=info.get("title", "Untitled"))

        # Format buttons — layout cols applied via _relayout_fmt_btns on resize
        for w in self._fmt_frame.winfo_children():
            w.destroy()
        self._fmt_btns = []
        self._selected_fmt = None

        for fmt in info.get("formats", []):
            self._make_fmt_btn(self._fmt_frame, fmt, 0)  # grid applied by _relayout_fmt_btns

        if info.get("formats"):
            self._select_fmt(info["formats"][0])

        # Show card, then trigger layout on next frame when width is known
        self._result_card.grid(row=4, column=0, sticky="ew", pady=(8, 0))
        self.after(50, self._trigger_layout)

    def _make_fmt_btn(self, parent, fmt, idx):
        badge_color = ACCENT3 if fmt.get("type") == "audio" else SUCCESS
        badge_text = fmt.get("badge", "")

        frame = ctk.CTkFrame(parent, fg_color=SURFACE2,
                             border_color=BORDER, border_width=2, corner_radius=9)

        lbl_quality = ctk.CTkLabel(frame, text=fmt.get("label", ""), font=(
            "", 14, "bold"), text_color=TEXT, anchor="w")
        lbl_quality.pack(anchor="w", padx=10, pady=(10, 2))
        lbl_detail = ctk.CTkLabel(frame, text=fmt.get("detail", ""), font=(
            "Consolas", 9), text_color=TEXT_DIM, anchor="w")
        lbl_detail.pack(anchor="w", padx=10, pady=(0, 8))

        if badge_text:
            lbl_badge = ctk.CTkLabel(frame, text=badge_text, font=("", 8, "bold"),
                                     text_color=badge_color, fg_color="transparent")
            lbl_badge.place(relx=1.0, rely=0, x=-6, y=6, anchor="ne")

        def _on_click(_e=None, f=frame, fm=fmt):
            self._select_fmt(fm)

        for w in [frame, lbl_quality, lbl_detail]:
            w.bind("<Button-1>", _on_click)

        frame._fmt_data = fmt
        return frame

    def _select_fmt(self, fmt):
        self._selected_fmt = fmt
        for w in self._fmt_frame.winfo_children():
            if hasattr(w, "_fmt_data"):
                is_sel = w._fmt_data is fmt
                w.configure(
                    border_color=ACCENT if is_sel else BORDER,
                    fg_color=SURFACE3 if is_sel else SURFACE2,
                )

    # ── Responsive layout ─────────────────────────────────────────────────────
    def _trigger_layout(self):
        card_w = self._result_card.winfo_width()
        if card_w >= 10:
            target = "wide" if card_w >= 760 else "narrow"
            self._card_layout = target
            self._apply_card_layout(card_w)

    def _on_card_resize(self, event):
        card_w = event.width
        if card_w < 10:
            return
        # Switch layout based on card width
        target = "wide" if card_w >= 760 else "narrow"
        if target != self._card_layout:
            self._card_layout = target
        self._apply_card_layout(card_w)

    def _apply_card_layout(self, card_w):
        if self._card_layout == "wide":
            thumb_w = int(card_w * 0.42)
            thumb_h = int(thumb_w * 9 / 16)
            self._result_card.columnconfigure(0, weight=0, minsize=thumb_w)
            self._result_card.columnconfigure(1, weight=1)
            self._thumb_label.grid(row=0, column=0, sticky="nsew")
            self._thumb_label.configure(width=thumb_w, height=thumb_h)
            self._info_panel.grid(row=0, column=1, sticky="nsew")
            info_w = max(card_w - thumb_w - 40, 120)
            self._title_label.configure(wraplength=info_w - 36)
            self._relayout_fmt_btns(cols=2)
        else:
            thumb_w = max(card_w - 2, 100)
            thumb_h = int(thumb_w * 9 / 16)
            self._result_card.columnconfigure(0, weight=1)
            self._result_card.columnconfigure(1, weight=0, minsize=0)
            self._thumb_label.grid(row=0, column=0, sticky="ew", columnspan=2)
            self._thumb_label.configure(width=thumb_w, height=thumb_h)
            self._info_panel.grid(row=1, column=0, sticky="ew", columnspan=2)
            self._title_label.configure(wraplength=max(card_w - 60, 100))
            cols = 5 if card_w >= 580 else (3 if card_w >= 380 else 2)
            self._relayout_fmt_btns(cols=cols)
        if self._thumb_raw:
            self._update_thumb_image(card_w)

    def _relayout_fmt_btns(self, cols):
        children = self._fmt_frame.winfo_children()
        for btn in children:
            btn.grid_forget()
        for i, btn in enumerate(children):
            btn.grid(row=i // cols, column=i % cols, padx=4, pady=4, sticky="ew")
        for c in range(cols):
            self._fmt_frame.columnconfigure(c, weight=1)
        for c in range(cols, 6):
            self._fmt_frame.columnconfigure(c, weight=0, minsize=0)

    def _update_thumb_image(self, card_w):
        if self._card_layout == "wide":
            thumb_w = int(card_w * 0.42)
            thumb_h = int(thumb_w * 9 / 16)
        else:
            thumb_w = max(card_w - 2, 100)
            thumb_h = int(thumb_w * 9 / 16)
        try:
            img = self._thumb_raw.resize((thumb_w, thumb_h), Image.LANCZOS)
            ctk_img = ctk.CTkImage(light_image=img, dark_image=img, size=(thumb_w, thumb_h))
            self._thumb_label.configure(image=ctk_img, width=thumb_w, height=thumb_h)
            self._thumb_label.image = ctk_img
        except Exception:
            pass

    # ── Thumbnail loading ─────────────────────────────────────────────────────
    def _load_thumb_async(self, url):
        self._thumb_raw = None
        if not PIL_AVAILABLE:
            return

        def _run():
            try:
                import urllib.request
                with urllib.request.urlopen(url, timeout=8) as resp:
                    data = resp.read()
                img = Image.open(io.BytesIO(data)).convert("RGB")
                self.after(0, self._on_thumb_loaded, img)
            except Exception:
                pass

        threading.Thread(target=_run, daemon=True).start()

    def _on_thumb_loaded(self, img):
        self._thumb_raw = img
        card_w = self._result_card.winfo_width()
        if card_w >= 10:
            self._update_thumb_image(card_w)

    # ── Download ──────────────────────────────────────────────────────────────
    def _start_download(self):
        if not self._current_info or not self._selected_fmt:
            return
        fmt = self._selected_fmt
        info = self._current_info
        title = info.get("title", "video")
        default_name = sanitize(title) + "." + fmt["ext"]
        url = self._url_var.get().strip()

        save_path = filedialog.asksaveasfilename(
            defaultextension="." + fmt["ext"],
            initialfile=default_name,
            initialdir=str(Path.home() / "Downloads"),
            filetypes=[
                ("Video files", "*.mp4"),
                ("Audio files", "*.mp3"),
                ("All files", "*.*"),
            ],
        )
        if not save_path:
            return

        self._job_counter += 1
        job_id = str(self._job_counter)
        self._dl_jobs[job_id] = {
            "title": title,
            "fmt": fmt,
            "save_path": save_path,
            "state": "pending",
            "progress": 0,
            "stage": "Queued",
            "error": None,
        }
        self._add_tray_row(job_id)
        self._update_tray_count()

        threading.Thread(target=self._run_download, args=(
            job_id, url, fmt, save_path), daemon=True).start()

    def _run_download(self, job_id, url, fmt, save_path):
        is_audio = fmt["ext"] == "mp3" or fmt["id"] == "bestaudio"
        output_ext = "mp3" if is_audio else "mp4"
        tmp = make_temp_path(suffix=f".{output_ext}", prefix="tubegrab-")

        self._update_job(job_id, stage="Downloading…", progress=5)

        try:
            args, needs_merge = build_dl_args(fmt["id"], is_audio, tmp)
            full_args = [YT_DLP, "--ignore-config",
                         "--socket-timeout", "30"] + args + [url]

            proc = subprocess.Popen(
                full_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )

            stream_index = 0
            PROGRESS_RANGE = 70
            expected_streams = 1 if (is_audio or not needs_merge) else 2
            last_progress = 5

            for line in proc.stdout:
                line = line.rstrip()
                if re.search(r'\[download\]\s+Destination:', line):
                    stream_index += 1
                m = re.search(r'\[download\]\s+(\d+(?:\.\d+)?)%', line)
                if m:
                    latest = float(m.group(1))
                    streams = max(expected_streams, stream_index)
                    cur = max(1, stream_index)
                    per_stream = PROGRESS_RANGE / streams
                    base = 5 + (cur - 1) * per_stream
                    pct = min(75, int(base + (latest / 100) * per_stream))
                    if pct > last_progress:
                        last_progress = pct
                        self._update_job(job_id, progress=pct,
                                         stage="Downloading…")
                if re.search(r'\[Merger\]|\[ExtractAudio\]|Deleting original|post-process', line, re.I):
                    self._update_job(job_id, progress=max(
                        last_progress, 78), stage="Merging…")

            proc.wait()

            if proc.returncode != 0:
                raise RuntimeError(
                    f"yt-dlp exited with code {proc.returncode}")

            if not os.path.exists(tmp):
                raise RuntimeError("Output file not found after download.")

            # Remux if needed
            final_path = tmp
            if not is_audio and needs_merge:
                self._update_job(job_id, progress=90, stage="Remuxing…")
                final_path = self._remux_mp4(tmp)
                try:
                    os.unlink(tmp)
                except:
                    pass

            self._update_job(job_id, progress=95, stage="Saving…")
            shutil.copy2(final_path, save_path)
            try:
                os.unlink(final_path)
            except:
                pass

            self._update_job(job_id, progress=100, stage="Done",
                             state="done", save_path=save_path)

        except Exception as e:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except:
                pass
            self._update_job(job_id, state="failed",
                             stage="Failed", error=str(e)[:200])

    def _remux_mp4(self, input_path):
        out = make_temp_path(suffix=".mp4", prefix="tubegrab-remux-")
        proc = subprocess.run(
            [FFMPEG, "-i", input_path, "-c", "copy",
                "-movflags", "+faststart", "-y", out],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if proc.returncode != 0:
            try:
                os.unlink(out)
            except:
                pass
            raise RuntimeError("ffmpeg remux failed: " +
                               (proc.stderr.decode() or "")[-200:])
        return out

    def _update_job(self, job_id, **kwargs):
        if job_id not in self._dl_jobs:
            return
        self._dl_jobs[job_id].update(kwargs)
        self.after(0, self._refresh_tray_row, job_id)

    # ── Tray ──────────────────────────────────────────────────────────────────
    def _show_tray(self):
        self._tray_outer.pack(fill="x", side="bottom")

    def _add_tray_row(self, job_id):
        dl = self._dl_jobs[job_id]
        row_frame = ctk.CTkFrame(
            self._tray_scroll, fg_color=SURFACE2, corner_radius=8)
        row_frame.pack(fill="x", padx=4, pady=3)
        row_frame.columnconfigure(0, weight=1)

        top = ctk.CTkFrame(row_frame, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", padx=10, pady=(7, 2))
        top.columnconfigure(0, weight=1)

        title_lbl = ctk.CTkLabel(top, text=dl["title"][:60],
                                 font=("", 11, "bold"), text_color=TEXT, anchor="w", justify="left")
        title_lbl.grid(row=0, column=0, sticky="w")

        actions = ctk.CTkFrame(top, fg_color="transparent")
        actions.grid(row=0, column=1, sticky="e")

        open_btn = ctk.CTkButton(actions, text="📂", width=26, height=22, font=("", 11),
                                 fg_color="transparent", hover_color=SURFACE3, text_color=TEXT_DIM,
                                 command=lambda jid=job_id: self._open_file(jid))
        open_btn.pack(side="left")

        dismiss_btn = ctk.CTkButton(actions, text="✕", width=26, height=22, font=("", 10),
                                    fg_color="transparent", hover_color=SURFACE3, text_color=TEXT_DIMMER,
                                    command=lambda jid=job_id: self._dismiss_job(jid))
        dismiss_btn.pack(side="left")

        bar = ctk.CTkProgressBar(row_frame, height=4, corner_radius=3,
                                 fg_color=SURFACE3, progress_color=ACCENT)
        bar.grid(row=1, column=0, sticky="ew", padx=10, pady=(2, 2))
        bar.set(0)

        status_lbl = ctk.CTkLabel(row_frame, text="Queued",
                                  font=("Consolas", 10), text_color=TEXT_DIM, anchor="w")
        status_lbl.grid(row=2, column=0, sticky="w", padx=10, pady=(0, 6))

        self._dl_rows[job_id] = {
            "frame": row_frame,
            "bar": bar,
            "status": status_lbl,
            "open_btn": open_btn,
        }
        self._show_tray()

    def _refresh_tray_row(self, job_id):
        if job_id not in self._dl_rows:
            return
        dl = self._dl_jobs.get(job_id, {})
        row = self._dl_rows[job_id]

        pct = dl.get("progress", 0) / 100
        row["bar"].set(pct)

        state = dl.get("state", "pending")
        stage = dl.get("stage", "")
        error = dl.get("error", "")

        if state == "done":
            row["bar"].configure(progress_color=SUCCESS)
            row["status"].configure(text="Done ✓", text_color=SUCCESS)
            row["open_btn"].configure(state="normal")
        elif state == "failed":
            row["bar"].configure(progress_color=ERR)
            row["status"].configure(
                text=f"Failed: {error[:60]}", text_color=ERR)
        else:
            row["status"].configure(
                text=f"{stage}  {int(pct*100)}%", text_color=TEXT_DIM)

        self._update_tray_count()

    def _update_tray_count(self):
        active = sum(1 for dl in self._dl_jobs.values()
                     if dl.get("state") == "pending")
        total = len(self._dl_jobs)
        if total:
            self._tray_count_lbl.configure(text=str(active or total))
        else:
            self._tray_count_lbl.configure(text="")

    def _open_file(self, job_id):
        dl = self._dl_jobs.get(job_id)
        if not dl:
            return
        save = dl.get("save_path")
        if not save or not os.path.exists(save):
            return

        folder = os.path.dirname(save)
        if sys.platform == "win32":
            os.startfile(folder)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder])
        else:
            subprocess.Popen(["xdg-open", folder])

    def _dismiss_job(self, job_id):
        if job_id in self._dl_rows:
            self._dl_rows[job_id]["frame"].destroy()
            del self._dl_rows[job_id]
        if job_id in self._dl_jobs:
            del self._dl_jobs[job_id]
        self._update_tray_count()


def main():
    app = TubeGrabApp()
    app.mainloop()


if __name__ == "__main__":
    main()
