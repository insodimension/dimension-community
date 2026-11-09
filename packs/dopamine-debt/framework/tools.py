"""The programs the framework runs, found the same way on every machine, and the flag that keeps their console hidden.

Every subprocess the framework starts passes `creationflags=HIDDEN`: on Windows a console window over the person's
screen is a defect, elsewhere the flag is 0. A program is looked up on PATH, then in the engine's own tools folder
(`dd.home.TOOLS`); a browser also through the Windows App Paths registry, where Chrome and Edge register themselves
without joining PATH. `DD_BROWSER` names a browser binary outright."""
import os
import shutil
import subprocess

from dd.home import TOOLS

HIDDEN = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
SEARCH_PATH = os.pathsep.join(p for p in (os.environ.get("PATH", ""), str(TOOLS)) if p)
YTDLP = shutil.which("yt-dlp", path=SEARCH_PATH) or "yt-dlp"
BROWSERS = ("chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge", "microsoft-edge")


def browser() -> str | None:
    """A Chromium browser to run headless: DD_BROWSER, else the first of BROWSERS on PATH or in Windows App Paths."""
    if os.environ.get("DD_BROWSER"):
        return os.environ["DD_BROWSER"]
    for name in BROWSERS:
        found = shutil.which(name, path=SEARCH_PATH)
        if found:
            return found
    if os.name != "nt":
        return None
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for name in ("chrome.exe", "msedge.exe"):
            try:
                with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{name}") as key:
                    path = winreg.QueryValue(key, None)
            except OSError:
                continue
            if path and os.path.isfile(path):
                return path
    return None
