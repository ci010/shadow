"""Protocol replay tests; no WebSocket package, network, or real microphone needed."""

import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import struct
import unittest
import uuid
import wave

spec = importlib.util.spec_from_file_location("microphone", Path(__file__).with_name("microphone.py"))
microphone = importlib.util.module_from_spec(spec)
spec.loader.exec_module(microphone)


class Socket:
    def __init__(self, messages, output):
        self.messages = iter(messages)
        self.sent = []
        self.output = output
        self.sources = {source["id"] for source in messages[0].get("sources", [])}

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return json.dumps(next(self.messages))
        except StopIteration:
            raise StopAsyncIteration

    async def send(self, raw):
        message = json.loads(raw)
        if message["type"] == "ui":
            assert all(node.get("sourceId") is None or node["sourceId"] in self.sources
                       for node in message["nodes"]), "UI references an undeclared source"
        if message["type"] == "ack" and message["sequence"] == 2:
            # Receipt is sent before processing the first PCM packet or opening its file.
            assert not self.output.exists()
        self.sent.append(message)


def packet(sequence, event):
    return {"type": "event", "sequence": sequence, "event": event}


def pcm():
    return {"type": "data", "sourceId": "mic", "mime": "audio/pcm",
            "base64": base64.b64encode(struct.pack("<4096h", *([12000] * 4096))).decode(),
            "timestamp": 1000,
            "value": {"sampleRate": 48000, "channels": 1, "format": "s16le"}}


OPEN = {"type": "open", "protocol": "shadow.io.v1", "runId": "test",
        "sources": [{"id": "mic", "kind": "microphone", "mode": "pcm"}]}


class ExampleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = Path.cwd() / ".test-data" / f"io-python-{uuid.uuid4()}"
        self.directory.mkdir(parents=True)
        self.output = self.directory / "caller-chosen.wav"

    def tearDown(self):
        for path in self.directory.iterdir():
            path.unlink()
        self.directory.rmdir()

    async def test_live_ui_control_ack_and_complete_wav(self):
        socket = Socket([OPEN, packet(1, {"type": "start"}), packet(2, pcm()),
                         packet(3, {"type": "ui", "id": "threshold", "value": 0.8}),
                         packet(4, {"type": "end"})], self.output)
        await microphone.MicrophoneSession(self.output).handle(socket)
        self.assertEqual(socket.sent[0], {"type": "ready"})
        self.assertEqual([x["sequence"] for x in socket.sent if x["type"] == "ack"], [1, 2, 3, 4])
        controls = [x for x in socket.sent if x["type"] == "ui"]
        self.assertEqual(controls[-1]["nodes"][0]["value"], 0.8)
        self.assertIn("Above threshold", controls[1]["nodes"][1]["text"])
        artifact = next(x for x in socket.sent if x["type"] == "artifact")
        self.assertEqual(artifact["path"], str(self.output.resolve()))
        self.assertEqual(socket.sent[-1], {"type": "done"})
        with wave.open(str(self.output), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 48000))
            self.assertEqual(wav.readframes(4096), base64.b64decode(pcm()["base64"]))

    async def test_disconnect_closes_partial_wav_without_done(self):
        socket = Socket([OPEN, packet(1, {"type": "start"}), packet(2, pcm())], self.output)
        await microphone.MicrophoneSession(self.output).handle(socket)
        self.assertFalse(any(x["type"] in ("artifact", "done") for x in socket.sent))
        with wave.open(str(self.output), "rb") as wav:
            self.assertEqual(wav.getnframes(), 4096)

    async def test_bad_format_and_byte_limit_are_explicit_errors(self):
        bad = {**pcm(), "value": {"sampleRate": 48000, "channels": 2, "format": "float32"}}
        for data, limit in [(bad, 16384), (pcm(), 1024)]:
            socket = Socket([OPEN, packet(1, {"type": "start"}), packet(2, data)], self.output)
            await microphone.MicrophoneSession(self.output, limit).handle(socket)
            self.assertEqual(socket.sent[-1]["type"], "error")
            self.assertFalse(self.output.exists())

    async def test_unknown_protocol_never_claims_ready(self):
        socket = Socket([{**OPEN, "protocol": "other"}], self.output)
        await microphone.MicrophoneSession(self.output).handle(socket)
        self.assertEqual([x["type"] for x in socket.sent], ["error"])


if __name__ == "__main__":
    unittest.main()
