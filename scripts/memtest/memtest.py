#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["tyro", "pillow"]
# ///
"""Measure what Copyous image previews cost gnome-shell, in memory and in open latency.

Starts a private headless gnome-shell on its own D-Bus session bus with its own home
directory, installs the extension zip into it, and then repeats a cycle: copy generated
screenshots to that shell's clipboard, open and close the clipboard dialog, clear the
history. The shell's memory is recorded after every step, after a forced garbage
collection. Nothing is read from or written to the real session.

Exits 1 when the shell still holds more than --leak-threshold-mib of anonymous memory
above its baseline after the last history clear.

Memory columns, all in MiB:

- anon: anonymous memory, resident plus swapped out
- big: the part of anon in mappings of 8 MiB or more, which is where glibc puts a large allocation
- gpu: memory the shell holds through its DRM file descriptors, from fdinfo

JSON schema (--json):

    {"scale": float, "leaked_mib": float, "leak": bool,
     "phases": [{"cycle": int, "phase": "str", "anon": float, "big": float, "big_maps": [float], "gpu": float}],
     "opens": [{"cycle": int, "stall_ms": float, "total_ms": float, "images_ms": float | null}]}

- stall_ms: longest single block of the shell's main thread from the open request until --settle has passed
- total_ms: Copyous' own open timing, from the request to the first painted frame
- images_ms: see --images-ready

Examples:

    scripts/memtest/memtest.py
    scripts/memtest/memtest.py --scale 1.333 --images 6 --cycles 3
    scripts/memtest/memtest.py --zip /path/to/other-build.zip --json | jq .leaked_mib
"""

from __future__ import annotations

import ast
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import tyro
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
COPYOUS_UUID = "copyous@boerdereinar.dev"
HELPER_UUID = "memtest-helper@copyous.test"

SETTINGS = f"""
[org/gnome/shell]
enabled-extensions=['{COPYOUS_UUID}', '{HELPER_UUID}']
disable-user-extensions=false
welcome-dialog-last-shown-version='4294967295'

[org/gnome/mutter]
experimental-features=['scale-monitor-framebuffer']

[org/gnome/shell/extensions/copyous]
clipboard-orientation='vertical'
clipboard-position-horizontal='top'
clipboard-position-vertical='fill'
clipboard-size=600
dynamic-item-height=true
item-height=128
item-width=512
show-header=false
history-length=100

[org/gnome/shell/extensions/copyous/image-item]
show-image-info=true
background-size='{{background_size}}'
"""


IMAGES_READY = """(function walk(actor) {
	if (actor.mapped === false) return true;
	if ('loaded' in actor && !actor.loaded) return false;
	return actor.get_children().every(walk);
})(Main.extensionManager.lookup('%s').stateObj.clipboardDialog)""" % COPYOUS_UUID


@dataclass
class Args:
    zip: Path = REPO / "dist" / f"{COPYOUS_UUID}.zip"
    """Extension build to measure, as packed by `make build`."""
    images: int = 3
    """Screenshots copied per cycle."""
    image_size: tuple[int, int] = (3840, 2160)
    """Width and height of each generated screenshot, in pixels."""
    cycles: int = 2
    """Copy, open, close and clear this many times. Growth from one cycle to the next is a leak."""
    opens: int = 2
    """Times the dialog is opened per cycle. The first open of a cycle shows images never drawn before."""
    scale: float = 2.0
    """Monitor scale. The shell applies the nearest scale the virtual monitor supports."""
    settle: float = 2.0
    """Seconds to wait after the dialog's first paint before measuring, so background loads finish."""
    leak_threshold_mib: float = 64.0
    """Growth of anon above the baseline, after the last clear, that counts as a leak."""
    images_ready: str = IMAGES_READY
    """JavaScript expression that is true once every mapped image preview shows its image.

    Evaluated inside the shell after each open; the time until it turns true is reported as images_ms.
    The default walks the dialog for image boxes with a `loaded` getter. Pass '' for a build that
    draws images in its first paint (CSS background images): images_ms is then not measured."""
    background_size: Literal["cover", "contain"] = "cover"
    """How previews fit their box, the image-item setting of the same name."""
    screenshot: Path | None = None
    """Write a PNG of the open dialog here, taken on the last cycle's first open once the images are shown."""
    keep: bool = False
    """Keep the run directory (shell log, generated images, the private home) instead of deleting it."""
    json: bool = False
    """Emit JSON to stdout instead of the tables."""


class Shell:
    """The private gnome-shell, its session bus, and the calls into both."""

    def __init__(self, run_dir: Path, zip_path: Path, background_size: str):
        self.run_dir = run_dir
        self.home = run_dir / "home"
        self.log_path = run_dir / "shell.log"
        runtime = run_dir / "runtime"
        runtime.mkdir(mode=0o700)
        self.env = {
            "PATH": os.environ["PATH"],
            "LANG": "C.UTF-8",
            "HOME": str(self.home),
            "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "XDG_STATE_HOME": str(self.home / ".local/state"),
            "XDG_RUNTIME_DIR": str(runtime),
            "XDG_DATA_DIRS": "/usr/local/share:/usr/share",
            "GSETTINGS_BACKEND": "keyfile",
            "NO_AT_BRIDGE": "1",
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
        }
        self.procs: list[subprocess.Popen] = []
        self._install(zip_path, background_size)

    def _install(self, zip_path: Path, background_size: str) -> None:
        extensions = self.home / ".local/share/gnome-shell/extensions"
        copyous = extensions / COPYOUS_UUID
        copyous.mkdir(parents=True)
        subprocess.run(["unzip", "-q", str(zip_path), "-d", str(copyous)], check=True)
        subprocess.run(["glib-compile-schemas", str(copyous / "schemas")], check=True)
        shutil.copytree(Path(__file__).parent / "helper", extensions / HELPER_UUID)

        keyfile = self.home / ".config/glib-2.0/settings/keyfile"
        keyfile.parent.mkdir(parents=True)
        keyfile.write_text(SETTINGS.format(background_size=background_size))

    def start(self) -> None:
        log = self.log_path.open("w")
        bus = self.env["DBUS_SESSION_BUS_ADDRESS"]
        self._spawn(["dbus-daemon", "--session", "--nofork", "--nopidfile", f"--address={bus}"], log)
        wait_for(lambda: Path(bus.removeprefix("unix:path=")).exists(), 10, "the private session bus")
        self.shell = self._spawn(
            ["gnome-shell", "--headless", "--no-x11", "--virtual-monitor", "2560x1600",
             "--wayland-display", f"copyous-memtest-{os.getpid()}"],
            log,
        )  # fmt: skip
        wait_for(lambda: self._try_eval("1") == 1, 60, "the memtest helper extension inside the shell")

    def _spawn(self, argv: list[str], log) -> subprocess.Popen:
        proc = subprocess.Popen(argv, env=self.env, stdout=log, stderr=log, start_new_session=True)
        self.procs.append(proc)
        return proc

    def stop(self) -> None:
        for proc in reversed(self.procs):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def call(self, dest: str, path: str, method: str, *params: str) -> str:
        argv = ["gdbus", "call", "--session", "--dest", dest, "--object-path", path, "--method", method, *params]
        result = subprocess.run(argv, env=self.env, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"{method} failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def helper(self, method: str, *params: str) -> str:
        return self.call("org.copyous.Memtest", "/org/copyous/Memtest", f"org.copyous.Memtest.{method}", *params)

    def copyous(self, method: str, *params: str) -> None:
        name = "org.gnome.Shell.Extensions.Copyous"
        self.call(name, "/" + name.replace(".", "/"), f"{name}.{method}", *params)

    def eval(self, expression: str):
        (result,) = ast.literal_eval(self.helper("Eval", expression))
        return json.loads(result)

    def _try_eval(self, expression: str):
        try:
            return self.eval(expression)
        except RuntimeError:
            return None

    def gc(self) -> None:
        for _ in range(3):
            self.eval("(System.gc(), 1)")
            time.sleep(0.3)

    def log(self) -> str:
        return self.log_path.read_text(errors="replace")


def wait_for(predicate, timeout: float, what: str, interval: float = 0.05) -> float:
    start = time.monotonic()
    while not predicate():
        if time.monotonic() - start > timeout:
            sys.exit(f"memtest: gave up after {timeout:.0f}s waiting for {what}")
        time.sleep(interval)
    return time.monotonic() - start


def make_screenshot(path: Path, size: tuple[int, int], seed: int) -> None:
    """A PNG shaped like a desktop screenshot: flat window rectangles with rows of text-sized marks."""
    rng = random.Random(seed)
    width, height = size
    image = Image.new("RGB", size, tuple(rng.randrange(256) for _ in range(3)))
    draw = ImageDraw.Draw(image)
    for _ in range(12):
        x, y = rng.randrange(width), rng.randrange(height)
        w, h = rng.randrange(200, width // 2), rng.randrange(150, height // 2)
        draw.rectangle((x, y, x + w, y + h), fill=tuple(rng.randrange(256) for _ in range(3)))
        for row in range(y + 20, min(y + h, height) - 20, 22):
            for col in range(x + 20, min(x + w, width) - 20, 9):
                if rng.random() < 0.7:
                    draw.rectangle((col, row, col + 6, row + 12), fill=tuple(rng.randrange(64) for _ in range(3)))
    image.save(path)


def memory(pid: int) -> dict:
    mib = 1 / 1024
    # Per mapping: [size of the address range, anonymous memory held (resident + swapped)], both in kB
    mappings: list[list[int]] = []
    for line in Path(f"/proc/{pid}/smaps").read_text().splitlines():
        header = re.match(r"([0-9a-f]+)-([0-9a-f]+) ", line)
        if header:
            start, end = (int(address, 16) for address in header.groups())
            mappings.append([(end - start) // 1024, 0])
        elif line.startswith(("Anonymous:", "Swap:")):
            mappings[-1][1] += int(line.split()[1])
    anon = sum(held for _, held in mappings)
    maps = [round(held * mib, 1) for size, held in mappings if size >= 8192 and held >= 8192]

    gpu: dict[str, int] = {}
    for fdinfo in Path(f"/proc/{pid}/fdinfo").iterdir():
        try:
            fields = dict(line.split(":", 1) for line in fdinfo.read_text().splitlines() if ":" in line)
        except OSError:
            continue
        if "drm-client-id" in fields:
            total = sum(int(v.split()[0]) for k, v in fields.items() if k.startswith("drm-total-"))
            gpu[fields["drm-client-id"].strip()] = total
    return {
        "anon": round(anon * mib, 1),
        "big": round(sum(maps), 1),
        "big_maps": sorted(maps, reverse=True),
        "gpu": round(sum(gpu.values()) * mib, 1),
    }


def run(args: Args, shell: Shell) -> dict:
    shell.start()
    applied = float(ast.literal_eval(shell.helper("SetScale", str(args.scale)))[0])
    images_dir = shell.home / ".local/share" / COPYOUS_UUID / "images"
    sources = shell.run_dir / "screenshots"
    sources.mkdir()
    time.sleep(2)  # the extension loads its (empty) history

    phases: list[dict] = []
    opens: list[dict] = []

    def record(cycle: int, phase: str) -> None:
        shell.gc()
        phases.append({"cycle": cycle, "phase": phase, **memory(shell.shell.pid)})

    record(0, "baseline")
    for cycle in range(1, args.cycles + 1):
        for i in range(args.images):
            source = sources / f"{cycle}-{i}.png"
            make_screenshot(source, args.image_size, seed=cycle * 1000 + i)
            before = len(list(images_dir.glob("*"))) if images_dir.exists() else 0
            shell.helper("CopyImage", str(source))
            wait_for(lambda: images_dir.exists() and len(list(images_dir.glob("*"))) > before, 20, "Copyous to save the image")
            time.sleep(0.3)
        record(cycle, "copied")

        for n in range(args.opens):
            timings = len(re.findall(r"open timing", shell.log()))
            shell.helper("StallStart")
            shell.copyous("Show")
            wait_for(lambda: len(re.findall(r"open timing", shell.log())) > timings, 30, "the dialog's first paint")
            images_ms = None
            if args.images_ready:
                first_paint = time.monotonic()
                wait_for(lambda: shell.eval(args.images_ready) is True, 30, "--images-ready to turn true", interval=0.01)
                images_ms = round((time.monotonic() - first_paint) * 1000, 1)
            line = re.findall(r"open timing \(ms\): (.*)", shell.log())[-1]
            fields = dict(re.findall(r"(\S+) ([\d.]+)", line))
            time.sleep(args.settle)
            if args.screenshot and n == 0 and cycle == args.cycles:
                shell.helper("Screenshot", str(args.screenshot.resolve()))
            stall_ms = round(float(ast.literal_eval(shell.helper("StallStop"))[0]), 1)
            opens.append({"cycle": cycle, "stall_ms": stall_ms, "total_ms": float(fields["total"]), "images_ms": images_ms})
            if n == 0:
                record(cycle, "open")
            shell.copyous("Hide")
            time.sleep(0.6)
        record(cycle, "closed")

        shell.copyous("ClearHistory", "true")
        wait_for(lambda: not list(images_dir.glob("*")), 20, "Copyous to delete the image files")
        time.sleep(0.5)
        record(cycle, "cleared")

    leaked = round(phases[-1]["anon"] - phases[0]["anon"], 1)
    return {"scale": applied, "leaked_mib": leaked, "leak": leaked > args.leak_threshold_mib, "phases": phases, "opens": opens}


def main(args: Args) -> None:
    if not args.zip.exists():
        sys.exit(f"memtest: no build at {args.zip}; run `make build` first")
    run_dir = Path(tempfile.mkdtemp(prefix="copyous-memtest-", dir="/var/tmp"))
    shell = Shell(run_dir, args.zip, args.background_size)
    try:
        result = run(args, shell)
    finally:
        shell.stop()
        if args.keep:
            print(f"memtest: run directory kept at {run_dir}", file=sys.stderr)
        else:
            shutil.rmtree(run_dir, ignore_errors=True)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"monitor scale {result['scale']:g}, {args.images} x {args.image_size[0]}x{args.image_size[1]} per cycle\n")
        print(f"{'cycle':>5}  {'phase':<9} {'anon':>9} {'big':>9} {'gpu':>9}   big mappings")
        for p in result["phases"]:
            print(f"{p['cycle']:>5}  {p['phase']:<9} {p['anon']:>9.1f} {p['big']:>9.1f} {p['gpu']:>9.1f}   {p['big_maps']}")
        print(f"\n{'cycle':>5}  {'stall ms':>9} {'total ms':>9} {'images ms':>10}")
        for o in result["opens"]:
            images = "-" if o["images_ms"] is None else f"{o['images_ms']:.1f}"
            print(f"{o['cycle']:>5}  {o['stall_ms']:>9.1f} {o['total_ms']:>9.1f} {images:>10}")
        verdict = "LEAK" if result["leak"] else "ok"
        print(f"\nanon above baseline after the last clear: {result['leaked_mib']:.1f} MiB  [{verdict}]")
    sys.exit(1 if result["leak"] else 0)


if __name__ == "__main__":
    main(tyro.cli(Args, description=__doc__))
