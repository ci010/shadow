"""An ordinary adhoc WebSocket service, launched with existing exec/process tools."""

import argparse
import array
import asyncio
import base64
import json
import math
from pathlib import Path
import sys
import time
import wave


class MicrophoneSession:
    def __init__(self, output, max_bytes=16 * 1024 * 1024):
        self.output = Path(output).resolve()
        self.max_bytes = max_bytes
        self.threshold = 0.12
        self.total = 0
        self.rate = None
        self.raw = None
        self.wav = None
        self.started = False
        self.finished = False
        self.last_ui = 0.0

    async def send(self, socket, **message):
        await socket.send(json.dumps(message))

    async def render(self, socket, level=0.0):
        caption = "Above threshold" if level >= self.threshold else "Below threshold"
        await self.send(socket, type="ui", nodes=[
            {"id": "threshold", "type": "input",
             "inputType": "number", "text": "RMS threshold", "value": self.threshold,
             "min": 0.01, "max": 1, "step": 0.01},
            {"id": "caption", "type": "text",
             "text": f"{caption} · RMS {level:.3f} · {self.total} PCM bytes"},
        ])

    def close(self):
        if self.wav:
            self.wav.close()
            self.wav = None
        if self.raw:
            self.raw.close()
            self.raw = None

    async def event(self, socket, event):
        if self.finished:
            return
        if event["type"] == "start":
            self.started = True
            await self.render(socket)
            await self.send(socket, type="status", text=f"Recording to {self.output}")
        elif event["type"] == "ui" and event.get("id") == "threshold":
            value = float(event["value"])
            if not math.isfinite(value):
                raise ValueError("Threshold must be finite")
            self.threshold = min(1.0, max(0.01, value))
            await self.render(socket)
        elif event["type"] == "data" and event.get("sourceId") == "mic":
            if not self.started:
                raise ValueError("Capture has not started")
            metadata = event.get("value", {})
            rate = metadata.get("sampleRate")
            if (event.get("mime") != "audio/pcm" or metadata.get("channels") != 1
                    or metadata.get("format") != "s16le" or type(rate) is not int
                    or not 8000 <= rate <= 192000):
                raise ValueError("Expected mono signed-16LE PCM with an actual sample rate")
            pcm = base64.b64decode(event["base64"], validate=True)
            if not pcm or len(pcm) % 2 or len(pcm) > 1024 * 1024:
                raise ValueError("Invalid PCM payload")
            if self.total + len(pcm) > self.max_bytes:
                raise ValueError("Service recording limit exceeded")
            if self.rate is not None and self.rate != rate:
                raise ValueError("Sample rate changed during recording")
            if self.wav is None:
                self.raw = self.output.open("xb")  # Never overwrite an existing recording.
                self.wav = wave.open(self.raw, "wb")
                self.wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                self.rate = rate
            self.wav.writeframesraw(pcm)
            self.total += len(pcm)
            samples = array.array("h", pcm)
            if sys.byteorder != "little":
                samples.byteswap()
            level = math.sqrt(sum((sample / 32768) ** 2 for sample in samples) / len(samples))
            if time.monotonic() - self.last_ui >= 0.25:
                self.last_ui = time.monotonic()
                await self.render(socket, level)
        elif event["type"] == "end":
            self.close()  # Finalize the WAV header before publishing its path.
            self.finished = True
            if self.total:
                await self.send(socket, type="artifact", path=str(self.output),
                                name=self.output.name, mime="audio/wav")
            await self.send(socket, type="status", text="Finished; WAV saved." if self.total else "Finished; no audio received.")
            await self.send(socket, type="done")

    async def handle(self, socket):
        opened = False
        sequence = -1
        try:
            async for raw in socket:
                message = json.loads(raw)
                if message.get("type") == "open" and not opened:
                    if message.get("protocol") != "shadow.io.v1":
                        raise ValueError("Unsupported protocol")
                    opened = True
                    await self.send(socket, type="ready")
                elif message.get("type") == "event" and opened:
                    current = message.get("sequence")
                    if type(current) is not int or current <= sequence:
                        raise ValueError("Events must have increasing sequences")
                    sequence = current
                    await self.send(socket, type="ack", sequence=current)
                    await self.event(socket, message["event"])
                else:
                    raise ValueError("Expected open followed by event messages")
        except Exception as error:
            await self.send(socket, type="error", message=str(error)[:1000])
        finally:
            self.close()  # Cancel/disconnect preserves a partial file, without claiming done.


async def serve(args):
    from websockets.asyncio.server import serve as websocket_server

    async def connection(socket):
        await MicrophoneSession(args.output, args.max_bytes).handle(socket)

    async with websocket_server(connection, "127.0.0.1", args.port,
                                max_size=2 * 1024 * 1024, max_queue=8):
        print(f"Listening on ws://127.0.0.1:{args.port}; output={Path(args.output).resolve()}", flush=True)
        await asyncio.Future()  # Existing process tools own this listener's lifetime.


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="Caller-chosen WAV path; parent directory must exist")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--max-bytes", type=int, default=16 * 1024 * 1024)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535 or options.max_bytes < 1:
        parser.error("port and max-bytes must be positive and valid")
    asyncio.run(serve(options))
