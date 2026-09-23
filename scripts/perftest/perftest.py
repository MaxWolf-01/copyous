#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["tyro", "pillow"]
# ///
"""Measure how quickly the Copyous dialog opens and scrolls, in a private headless gnome-shell.

Starts the same private shell as memtest.py (own D-Bus session bus, own home, virtual monitor), seeds its
history, and repeats a cycle of what a user does, driven through a virtual pointer:

- enable: the extension is disabled and enabled again, which is what a screen unlock does; reports how long the
  main thread was blocked until the history is loaded and settled
- cold: the dialog is opened right after
- warm: opened again right after
- scroll: a touchpad swipe through the whole history
- reopen: opened again after the scroll, when the list has been shrunk back
- copied: a new text is copied while the dialog is closed, then the dialog is opened
- search: the dialog is opened and --query typed into the search, one character every 200 ms, then cleared
- end, home: the dialog is opened and End pressed, which jumps to the oldest entry; then Home, back to the newest
- coldscroll: re-enabled again, opened, and a touchpad swipe starts 0.3 s later

Open metrics, in ms from the call to open():

- block: the synchronous part of open(), during which the shell draws nothing
- first: until the first frame is painted (the dialog is still fully transparent in it)
- visible: until the first frame that shows the dialog
- jank: the longest interval between two frames during the 150 ms fade-in; 16.7 is perfect at 60 Hz

Scroll metrics: the longest frame (update + paint), the longest interval between frames, and how many intervals
missed at least one 60 Hz frame (> 25 ms).

Search and End/Home metrics, in ms from the keystroke: until the first frame painted after it (median and worst over
the keystrokes), and the longest the main thread was blocked meanwhile.

With --profile, the shell's JavaScript is sampled (GJS profiler) and the heaviest functions are listed per phase.

Examples:

    scripts/perftest/perftest.py --history ~/.local/share/copyous@boerdereinar.dev
    scripts/perftest/perftest.py --zip /path/to/other-build.zip --cycles 5 --json
"""

from __future__ import annotations

import calendar
import collections
import itertools
import json
import os
import random
import shutil
import sqlite3
import statistics
import struct
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import tyro

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "memtest"))
import memtest

REPO = memtest.REPO
UUID = memtest.COPYOUS_UUID
DRIVER = Path(__file__).with_name("driver.js")

SETTINGS = f"""
[org/gnome/shell]
enabled-extensions=['{UUID}', '{memtest.HELPER_UUID}']
disable-user-extensions=false
welcome-dialog-last-shown-version='4294967295'

[org/gnome/mutter]
experimental-features=['scale-monitor-framebuffer']

[org/gnome/desktop/interface]
color-scheme='prefer-dark'

[org/gnome/shell/extensions/copyous]
clipboard-history='keep-all'
database-backend='sqlite'
history-length={{history_length}}
{{extra}}
"""

# The layout the measurements were first taken with: a vertical list at the pointer
DEFAULT_SETTINGS = """clipboard-orientation='vertical'
clipboard-position-horizontal='top'
clipboard-position-vertical='fill'
clipboard-size=600
item-width=512
item-height=128
dynamic-item-height=true
auto-hide-search=true
show-header=false
header-controls-visibility='visible-on-hover'
show-at-pointer=true

[org/gnome/shell/extensions/copyous/image-item]
show-image-info=true

[org/gnome/shell/extensions/copyous/link-item]
link-preview-orientation='horizontal'"""


@dataclass
class Args:
    zip: Path = REPO / "dist" / f"{UUID}.zip"
    """Extension build to measure, as packed by `make build`."""
    history: Path | None = None
    """A Copyous data directory (clipboard.db, images/) to copy the history from. Image paths are rewritten to the
    copies, so the run never touches the original. Default: a generated history of 100 entries."""
    entries: int | None = None
    """Grow the history with generated entries, older than the existing ones, to this many; history-length is set
    to match. Default: the history as it is, with history-length 100."""
    hljs: Path | None = Path.home() / ".local/share" / UUID / "highlight.min.js"
    """highlight.js build to install, so code entries are highlighted as in a real session."""
    settings: str = DEFAULT_SETTINGS
    """Keyfile lines under [org/gnome/shell/extensions/copyous] (further sections may follow)."""
    cycles: int = 3
    scale: float = 1.333
    settle: float = 3.0
    """Seconds to wait after the history is loaded before a cold open."""
    window: float = 1.0
    """Seconds of frames recorded after each open."""
    scroll_events: int = 300
    scroll_dy: float = 3.0
    """Pixels per touchpad event; the extension scrolls one item per 10 px."""
    scroll_interval_ms: int = 8
    query: str = "value"
    """Typed into the search, one character at a time."""
    rtl: bool = False
    """Lay out right to left, as an Arabic or Hebrew locale does."""
    profile: bool = False
    """Sample the shell's JavaScript and list the heaviest functions per phase."""
    top: int = 25
    keep: bool = False
    json: bool = False


# --- history -----------------------------------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE 'clipboard' ('id' integer NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT, 'type' text NOT NULL,
  'content' text NOT NULL, 'pinned' boolean NOT NULL, 'tag' text, 'datetime' timestamp NOT NULL, 'metadata' text,
  'title' text, UNIQUE ('type', 'content'));
CREATE TABLE 'clipboard_version' ('id' integer PRIMARY KEY CHECK (id = 1), 'version' integer);
INSERT INTO 'clipboard_version' (id, version) VALUES (1, 2);
"""

WORDS = "the of and to in is that for it as with was on be by this are from or at an which not have but".split()


def copy_history(source: Path, data: Path) -> None:
    images = data / "images"
    images.mkdir(parents=True)
    if (source / "images").is_dir():
        for f in (source / "images").iterdir():
            shutil.copy2(f, images / f.name)
    src = sqlite3.connect(f"file:{source / 'clipboard.db'}?mode=ro", uri=True)
    dst = sqlite3.connect(data / "clipboard.db")
    src.backup(dst)
    src.close()
    old, new = f"file://{source}/images/", f"file://{images}/"
    dst.execute("UPDATE clipboard SET content = replace(content, ?, ?) WHERE type = 'Image'", (old, new))
    dst.commit()
    left = dst.execute("SELECT count(*) FROM clipboard WHERE content LIKE ?", (old + "%",)).fetchone()[0]
    dst.close()
    if left:
        sys.exit("perftest: entries still point into the source directory; refusing to run")


def generate_history(data: Path, count: int, rng: random.Random) -> None:
    """Adds `count` entries older than those already there, mixed like a real history: mostly short text and code,
    a few long texts, screenshots, links."""
    images = data / "images"
    images.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(data / "clipboard.db")
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'clipboard'").fetchone():
        db.executescript(SCHEMA)
    oldest = db.execute("SELECT min(datetime) FROM clipboard").fetchone()[0]
    # Stored in UTC
    start = calendar.timegm(time.strptime(oldest, "%Y-%m-%d %H:%M:%S")) if oldest else time.time()

    def prose(n: int) -> str:
        return " ".join(rng.choice(WORDS) for _ in range(n))

    def code(lines: int) -> str:
        body = [f"    value_{i} = compute({i}, 'x' * {i})  # {prose(4)}" for i in range(lines)]
        return "def function():\n" + "\n".join(body) + "\n    return value_0\n"

    rows = []
    for i in range(count):
        kind = rng.random()
        if kind < 0.40:
            n = rng.choice([5, 20, 80, 300, 1500]) if i != 50 else 20000
            rows.append(("Text", f"{i} {prose(n)}", None))
        elif kind < 0.72:
            rows.append(("Code", f"# {i}\n{code(rng.choice([3, 10, 40, 120]))}", None))
        elif kind < 0.90:
            path = images / f"generated-{i}.png"
            memtest.make_screenshot(path, (1920, 1200), seed=i)
            rows.append(("Image", f"file://{path}", None))
        else:
            meta = json.dumps({"title": prose(6), "description": prose(30), "image": None})
            rows.append(("Link", f"https://example.com/{i}/{prose(3).replace(' ', '-')}", meta))
    for i, (kind, content, meta) in enumerate(rows):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(start - (i + 1) * 600))
        db.execute(
            "INSERT OR IGNORE INTO clipboard (type, content, pinned, tag, datetime, metadata) VALUES (?, ?, 0, NULL, ?, ?)",
            (kind, content, stamp, meta),
        )
    db.commit()
    db.close()


# --- measuring ---------------------------------------------------------------------------------------------------


@dataclass
class Phase:
    cycle: int
    name: str
    start: int  # monotonic µs
    end: int = 0
    metrics: dict = field(default_factory=dict)


def open_metrics(t0: int, t1: int, frames: list) -> dict:
    ends = [f for f in frames if f[1] > t1]
    first = next((f for f in ends), None)
    visible = next((f for f in ends if f[2] > 0), None)
    m = {"block": (t1 - t0) / 1000}
    m["first"] = (first[1] - t0) / 1000 if first else None
    m["visible"] = (visible[1] - t0) / 1000 if visible else None
    if first:
        fade = [f[1] for f in ends if f[1] <= first[1] + 200_000]
        gaps = [(b - a) / 1000 for a, b in itertools.pairwise(fade)]
        m["jank"] = max(gaps) if gaps else None
    return m


def key_metrics(keys: list, frames: list, stalls: dict) -> dict:
    """keys: [before, after] each keystroke's synchronous handling; stalls: the main thread's blocks meanwhile. A
    keystroke no frame followed has no latency."""
    ends = [f[1] for f in frames]
    latencies = [(e - t0) / 1000 for t0, t1 in keys if (e := next((e for e in ends if e > t1), None))]
    return {
        "latency": statistics.median(latencies) if latencies else None,
        "worst": max(latencies, default=None),
        "longest": stalls["longest"],
        "blocks": stalls["blocks"],
    }


def scroll_metrics(frames: list) -> dict:
    durations = [(f[1] - f[0]) / 1000 for f in frames]
    ends = [f[1] for f in frames]
    gaps = [(b - a) / 1000 for a, b in itertools.pairwise(ends)]
    return {
        "frames": len(frames),
        "max_frame": max(durations, default=0),
        "max_gap": max(gaps, default=0),
        "missed": sum(g > 25 for g in gaps),
        "p50_gap": statistics.median(gaps) if gaps else 0,
    }


class Run:
    def __init__(self, shell: memtest.Shell, args: Args):
        self.shell, self.args = shell, args
        self.phases: list[Phase] = []

    def js(self, expr: str):
        return self.shell.eval(expr)

    def wait_ready(self) -> None:
        deadline = time.monotonic() + 60
        while (state := self.js("perf.ready()")) is not True:
            if time.monotonic() > deadline:
                sys.exit(f"perftest: the history and highlight.js did not load: {state}")
            time.sleep(0.1)
        time.sleep(self.args.settle)

    def measure_open(self, cycle: int, name: str, x: int = 900, y: int = 300) -> None:
        phase = Phase(cycle, name, self.js("perf.startFrames()"))
        t0, t1 = self.js(f"perf.open({x}, {y})")
        time.sleep(self.args.window)
        frames = self.js("perf.stopFrames()")
        phase.end = self.js("perf.close()")
        phase.metrics = open_metrics(t0, t1, frames)
        self.phases.append(phase)
        time.sleep(0.5)

    def measure_scroll(self, cycle: int, name: str = "scroll", delay: float | None = None) -> None:
        a = self.args
        self.js("perf.open(900, 300)")
        time.sleep(self.args.window if delay is None else delay)
        self.js("perf.pointAtList()")
        phase = Phase(cycle, name, self.js("perf.startFrames()"))
        self.js(f"perf.scroll({a.scroll_events}, {a.scroll_dy}, {a.scroll_interval_ms})")
        memtest.wait_for(lambda: self.js("perf.scrolling") is False, 60, "the scroll to finish", 0.1)
        time.sleep(0.5)
        frames = self.js("perf.stopFrames()")
        phase.metrics = scroll_metrics(frames) | {"list": self.js("perf.listState()")}
        phase.end = self.js("perf.close()")
        self.phases.append(phase)
        time.sleep(0.5)

    def measure_search(self, cycle: int) -> None:
        self.js("perf.open(900, 300)")
        time.sleep(self.args.window)
        phase = Phase(cycle, "search", self.js("perf.startFrames()"))
        self.js("perf.watchStalls()")
        self.js(f"perf.typeSearch({json.dumps(self.args.query)}, 200)")
        memtest.wait_for(lambda: self.js("perf.typing") is False, 60, "the search to be typed", 0.1)
        time.sleep(0.5)
        frames = self.js("perf.stopFrames()")
        phase.metrics = key_metrics(self.js("perf.keys"), frames, self.js("perf.stalls()"))
        phase.end = self.js("perf.close()")
        self.phases.append(phase)
        time.sleep(0.5)

    def measure_jumps(self, cycle: int) -> None:
        """End, to the oldest entry, then Home, back to the newest"""
        self.js("perf.open(900, 300)")
        time.sleep(self.args.window)
        for name, key in (("end", "Clutter.KEY_End"), ("home", "Clutter.KEY_Home")):
            phase = Phase(cycle, name, self.js("perf.startFrames()"))
            self.js("perf.watchStalls()")
            keys = [self.js(f"perf.key({key})")]
            time.sleep(1.0)
            frames = self.js("perf.stopFrames()")
            phase.end = frames[-1][1] if frames else phase.start
            phase.metrics = key_metrics(keys, frames, self.js("perf.stalls()")) | {"list": self.js("perf.listState()")}
            self.phases.append(phase)
        self.js("perf.close()")
        time.sleep(0.5)

    def measure_enable(self, cycle: int) -> None:
        """What a screen unlock costs: the main thread's blocks from enable() until the history is shown and settled"""
        phase = Phase(cycle, "enable", self.js("perf.watchStalls()"))
        self.js("perf.reenable()")
        self.wait_ready()
        phase.metrics = self.js("perf.stalls()")
        phase.end = phase.metrics.pop("end")
        self.phases.append(phase)

    def cycle(self, n: int) -> None:
        self.measure_enable(n)
        self.measure_open(n, "cold")
        self.measure_open(n, "warm")
        self.measure_scroll(n)
        self.measure_open(n, "reopen")
        self.js(f"perf.copyText('perftest {n} {time.time()}')")
        time.sleep(1.0)
        self.measure_open(n, "copied")
        self.measure_search(n)
        self.measure_jumps(n)
        self.js("perf.reenable()")
        self.wait_ready()
        self.measure_scroll(n, "coldscroll", delay=0.3)


def run(args: Args, run_dir: Path) -> tuple[list[Phase], Path | None]:
    shell = memtest.Shell(run_dir, args.zip, "cover")
    keyfile = SETTINGS.format(history_length=max(args.entries or 100, 100), extra=args.settings)
    (shell.home / ".config/glib-2.0/settings/keyfile").write_text(keyfile)
    data = shell.home / ".local/share" / UUID
    if args.history:
        copy_history(args.history.expanduser(), data)
    else:
        generate_history(data, 100, random.Random(1))
    db = sqlite3.connect(data / "clipboard.db")
    have = db.execute("SELECT count(*) FROM clipboard").fetchone()[0]
    db.close()
    if args.entries and args.entries > have:
        generate_history(data, args.entries - have, random.Random(2))
    if args.hljs and args.hljs.exists():
        shutil.copy2(args.hljs, data / "highlight.min.js")
    if args.profile:
        shell.env["GJS_ENABLE_PROFILER"] = "1"
    if args.rtl:
        shell.env["CLUTTER_TEXT_DIRECTION"] = "rtl"

    # Processes the private bus activates inherit the working directory; keep their files in the run
    os.chdir(run_dir)
    try:
        shell.start()
        shell.helper("SetScale", str(args.scale))
        r = Run(shell, args)
        r.js(f"(() => {{ {DRIVER.read_text()} }})()")
        # The extension is now and then found disabled right after startup, cause unknown; enabling it here gives
        # every run the same start
        time.sleep(2)
        r.js("perf.reenable()")
        r.wait_ready()
        for n in range(1, args.cycles + 1):
            r.cycle(n)
        pid = shell.shell.pid
    finally:
        shell.stop()
    capture = shell.home / f"gjs-{pid}.syscap"
    return r.phases, capture if capture.exists() else None


# --- GJS profile -------------------------------------------------------------------------------------------------


def profile_by_phase(capture: Path, phases: list[Phase], top: int) -> dict[str, list[tuple[str, int, int]]]:
    """Per phase name: (function, self samples, total samples), heaviest total first. A phase that watched the main
    thread's blocks also gets "<phase> blocked", from the samples taken while the thread was blocked, which name what
    blocked it."""
    data = capture.read_bytes()
    jit: dict[int, str] = {}
    windows = [(p.start * 1000, p.end * 1000, p.name) for p in phases]
    blocked = [(a * 1000, b * 1000, f"{p.name} blocked") for p in phases for a, b in p.metrics.get("blocks", [])]
    self_counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    total_counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    samples = collections.Counter()
    frames = []
    off = 256
    while off + 24 <= len(data):
        length, _, _, t, kind = struct.unpack_from("<HhiqB", data, off)
        if length < 24:
            break
        frames.append((kind, t, data[off + 24 : off + length]))
        off += length
    # A sample can name functions whose JITMAP comes later in the file: read all of them first
    for kind, t, body in sorted(frames, key=lambda f: f[0] != 7):
        if kind == 7:  # JITMAP
            (n,) = struct.unpack_from("<I", body, 0)
            pos = 4
            for _ in range(n):
                (addr,) = struct.unpack_from("<Q", body, pos)
                end = body.index(b"\0", pos + 8)
                jit[addr] = body[pos + 8 : end].decode(errors="replace")
                pos = end + 1
        elif kind == 2:  # SAMPLE
            phase = next((w[2] for w in windows if w[0] <= t <= w[1]), None)
            block = next((w[2] for w in blocked if w[0] <= t <= w[1]), None)
            counted_in = [name for name in (phase, block) if name]
            if not counted_in:
                continue
            (n,) = struct.unpack_from("<H", body, 0)
            stack = [jit.get(a, hex(a)) for a in struct.unpack_from(f"<{n}Q", body, 8)]
            for name in counted_in:
                samples[name] += 1
                if stack:
                    self_counts[name][stack[0]] += 1
                for fn in set(stack):
                    total_counts[name][fn] += 1
    heaviest = {
        name: [(fn, self_counts[name][fn], c) for fn, c in total_counts[name].most_common(top)] for name in samples
    }
    return heaviest | {"_samples": dict(samples)}


# --- report ------------------------------------------------------------------------------------------------------


def summarize(phases: list[Phase]) -> dict[str, dict[str, dict[str, float]]]:
    """Per phase name and metric: median and max over the cycles."""
    by: dict[str, dict[str, list[float]]] = collections.defaultdict(lambda: collections.defaultdict(list))
    for p in phases:
        for k, v in p.metrics.items():
            if isinstance(v, (int, float)) and v is not None:
                by[p.name][k].append(v)
    return {
        name: {k: {"median": statistics.median(v), "max": max(v)} for k, v in metrics.items()}
        for name, metrics in by.items()
    }


def main(args: Args) -> None:
    if not args.zip.exists():
        sys.exit(f"perftest: no build at {args.zip}; run `make build` first")
    run_dir = Path(tempfile.mkdtemp(prefix="copyous-perftest-", dir="/var/tmp"))
    cwd = Path.cwd()
    try:
        phases, capture = run(args, run_dir)
        profile = profile_by_phase(capture, phases, args.top) if args.profile and capture else None
    finally:
        os.chdir(cwd)
        if args.keep:
            print(f"perftest: run directory kept at {run_dir}", file=sys.stderr)
        else:
            shutil.rmtree(run_dir, ignore_errors=True)

    summary = summarize(phases)
    if args.json:
        print(json.dumps({"summary": summary, "phases": [p.__dict__ for p in phases], "profile": profile}, indent=2))
        return

    print(f"{args.cycles} cycles, median (max) in ms\n")
    opens = ["cold", "warm", "reopen", "copied"]
    print(f"{'open':<8} {'block':>15} {'first':>15} {'visible':>15} {'jank':>15}")
    for name in opens:
        s = summary.get(name, {})
        cells = [f"{s[k]['median']:6.1f} ({s[k]['max']:6.1f})" if k in s else f"{'-':>15}" for k in
                 ("block", "first", "visible", "jank")]  # fmt: skip
        print(f"{name:<8} " + " ".join(f"{c:>15}" for c in cells))
    s = summary.get("enable", {})
    if s:
        print(
            f"\nenable (unlock): main thread blocked {s['blocked']['median']:.0f} ms in total "
            f"(max {s['blocked']['max']:.0f}), longest block {s['longest']['median']:.0f} ms (max {s['longest']['max']:.0f})"
        )
    print(f"\n{'':<10} {'max frame':>15} {'max gap':>15} {'missed':>15} {'p50 gap':>15}")
    for name in ("scroll", "coldscroll"):
        s = summary.get(name, {})
        cells = [f"{s[k]['median']:6.1f} ({s[k]['max']:6.1f})" if k in s else f"{'-':>15}" for k in
                 ("max_frame", "max_gap", "missed", "p50_gap")]  # fmt: skip
        print(f"{name:<10} " + " ".join(f"{c:>15}" for c in cells))

    print(f"\n{'keys':<10} {'latency':>15} {'worst':>15} {'longest block':>15}")
    for name in ("search", "end", "home"):
        s = summary.get(name, {})
        cells = [f"{s[k]['median']:6.1f} ({s[k]['max']:6.1f})" if k in s else f"{'-':>15}" for k in
                 ("latency", "worst", "longest")]  # fmt: skip
        print(f"{name:<10} " + " ".join(f"{c:>15}" for c in cells))

    if profile:
        names = ["enable", "cold", "warm", "scroll", "reopen", "copied", "search", "end", "home", "coldscroll"]
        for name in [n for phase in names for n in (phase, f"{phase} blocked")]:
            if name not in profile:
                continue
            n = profile["_samples"].get(name, 0)
            print(f"\n-- {name}: {n} samples, heaviest by total --")
            for fn, self_n, total in profile[name]:
                print(f"{total:>6} {self_n:>6}  {fn[:140]}")


if __name__ == "__main__":
    main(tyro.cli(Args, description=__doc__))
