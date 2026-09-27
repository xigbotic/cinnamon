"""
Cinnamon SMTC sidecar.

Headless bridge between the Windows System Media Transport Controls (SMTC) and
the Electron main process. Speaks newline-delimited JSON over stdio:

  stdout  ->  one JSON object per line (state / artwork / log events)
  stdin   <-  one JSON command per line (transport controls)

This reuses the playback-tracking logic proven out in the Python scrobbler:
real playback_status (not position deltas), radio handling (duration == 0),
and artwork delivered as an immutable snapshot rather than a shared stream.
"""

import asyncio
import base64
import json
import os
import sys
import threading
from datetime import datetime, timezone

from winsdk.windows.storage.streams import Buffer, DataReader
from winsdk.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)


def emit(obj):
    """Write one JSON line to stdout and flush immediately."""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        # The parent (Electron) closed the pipe on quit; exit quietly without
        # letting the exception bubble into a PyInstaller crash dialog.
        os._exit(0)


def log(msg):
    emit({"type": "log", "message": str(msg)})


class SmtcBridge:
    def __init__(self):
        self.manager = None
        self.current_track = None
        self.artwork_track = None      # track whose artwork we've already sent
        self.artwork_attempts = 0
        self.is_playing = False
        self.session = None            # last Apple Music session (for commands)

    async def get_session(self):
        if not self.manager:
            self.manager = await SessionManager.request_async()
        for s in self.manager.get_sessions():
            try:
                app_id = s.source_app_user_model_id.lower()
            except Exception:
                continue
            if "applemusic" in app_id or "itunes" in app_id:
                return s
        return None

    async def poll(self):
        session = await self.get_session()
        self.session = session

        if not session:
            if self.is_playing or self.current_track is not None:
                self.is_playing = False
                self.current_track = None
                emit({"type": "state", "playing": False, "track": None})
            return

        timeline = session.get_timeline_properties()
        duration = timeline.end_time.total_seconds()
        position = timeline.position.total_seconds()

        try:
            status = session.get_playback_info().playback_status
            is_playing = status == PlaybackStatus.PLAYING
        except Exception:
            is_playing = self.is_playing

        # SMTC's position is a snapshot frozen at last_updated_time, so a playing
        # track's real position has advanced by (now - last_updated). Correcting
        # this removes the several-second lag that threw lyrics out of sync.
        if is_playing:
            try:
                last_updated = timeline.last_updated_time
                drift = (datetime.now(timezone.utc) - last_updated).total_seconds()
                if 0 <= drift < 30:
                    position += drift
                    if duration > 0:
                        position = min(position, duration)
            except Exception:
                pass

        props = await session.try_get_media_properties_async()
        if not (props and props.title):
            return

        title = props.title
        raw_artist = props.artist or "Unknown Artist"
        album = props.album_title or ""

        # Apple Music packs "Artist <em dash> Album" into the artist field on some sources.
        artist = raw_artist
        for sep in (" \u2014 ", " - "):
            if sep in raw_artist:
                left, right = raw_artist.split(sep, 1)
                artist = left.strip()
                if not album:
                    album = right.strip()
                break

        if title != self.current_track:
            self.current_track = title
            self.artwork_track = None
            self.artwork_attempts = 0

        emit({
            "type": "state",
            "playing": is_playing,
            "track": title,
            "artist": artist,
            "album": album,
            "duration": duration,
            "position": position,
        })
        self.is_playing = is_playing

        # Artwork: fetch independently of the state emit, retry a few times, and
        # deliver an immutable base64 snapshot so nothing is shared across the wire.
        if not props.thumbnail:
            self.artwork_track = title
        elif self.artwork_track != title and self.artwork_attempts < 3:
            try:
                stream = await props.thumbnail.open_read_async()
                size = stream.size
                if size > 0:
                    buf = Buffer(size)
                    await stream.read_async(buf, size, 0)
                    with DataReader.from_buffer(buf) as reader:
                        data = bytearray(size)
                        reader.read_bytes(data)
                    stream.close()
                    emit({
                        "type": "artwork",
                        "track": title,
                        "dataB64": base64.b64encode(bytes(data)).decode("ascii"),
                        "contentType": stream.content_type,
                    })
                    self.artwork_track = title
            except Exception as e:
                self.artwork_attempts += 1
                log(f"artwork fetch error (attempt {self.artwork_attempts}): {e}")
                if self.artwork_attempts >= 3:
                    self.artwork_track = title

    async def command(self, cmd):
        """Execute a transport command against the current Apple Music session."""
        if not self.session:
            return
        try:
            action = cmd.get("cmd")
            if action == "playpause":
                await self.session.try_toggle_play_pause_async()
            elif action == "play":
                await self.session.try_play_async()
            elif action == "pause":
                await self.session.try_pause_async()
            elif action == "next":
                await self.session.try_skip_next_async()
            elif action == "prev":
                await self.session.try_skip_previous_async()
            elif action == "seek":
                # SMTC wants 100-ns ticks.
                seconds = float(cmd.get("position", 0))
                await self.session.try_change_playback_position_async(int(seconds * 1e7))
        except Exception as e:
            log(f"command error ({cmd}): {e}")


def stdin_reader(queue: "asyncio.Queue", loop):
    """Blocking stdin read on its own thread; hands commands to the async loop."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception:
            continue
        asyncio.run_coroutine_threadsafe(queue.put(cmd), loop)


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    bridge = SmtcBridge()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    threading.Thread(target=stdin_reader, args=(queue, loop), daemon=True).start()
    emit({"type": "ready"})

    while True:
        try:
            await bridge.poll()
        except Exception as e:
            log(f"poll error: {e}")

        # Drain any pending transport commands.
        while not queue.empty():
            await bridge.command(queue.get_nowait())

        await asyncio.sleep(1.0 if bridge.is_playing else 3.0)


if __name__ == "__main__":
    asyncio.run(main())
