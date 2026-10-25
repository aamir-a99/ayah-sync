"""No model downloads: test the lightweight helper's bounded audio interface."""
import base64
import math
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import audio_source


class AudioSourceTest(unittest.TestCase):
    def test_window_is_bounded_and_no_speech_model_loaded(self):
        self.assertNotIn("engine", sys.modules)
        self.assertNotIn("torch", sys.modules)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            with wave.open(str(path), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(b"".join(struct.pack("<h", int(1000 * math.sin(i * 0.1))) for i in range(32000)))
            raw = base64.b64decode(audio_source.read_window({"path": path}, 0.5, 0.5))
            self.assertEqual(len(raw), 8000 * 4)
            for start, duration in [(-1, 1), (0, 25), (float("nan"), 1), (0, float("inf"))]:
                with self.assertRaises(ValueError):
                    audio_source.read_window({"path": path}, start, duration)


if __name__ == "__main__":
    unittest.main()
