"""One-time developer export; end users need only the built extension.

server/.venv/bin/python -m pip install 'optimum-onnx[onnxruntime]' 'transformers<5'
server/.venv/bin/python scripts/export-browser-model.py
"""
import argparse
import json
from pathlib import Path
import shutil

from optimum.exporters.onnx import main_export
from onnxruntime.quantization import quantize_dynamic, QuantType
from transformers import AutoConfig, GenerationConfig, WhisperTokenizerFast

ROOT = Path(__file__).resolve().parent.parent
MODEL = "tarteel-ai/whisper-tiny-ar-quran"
WORK = ROOT / "server/cache/quran-tiny-onnx"
OUT = ROOT / "public/models/quran-tiny"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--requantize", action="store_true", help="Regenerate q8 files from the cached float export")
args = parser.parse_args()
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "onnx").mkdir(exist_ok=True)

if not (WORK / "decoder_model_merged.onnx").exists():
    main_export(MODEL, output=WORK, task="automatic-speech-recognition-with-past",
                opset=17, device="cpu", do_validation=False)

for name in ("encoder_model", "decoder_model_merged"):
    destination = OUT / "onnx" / f"{name}_quantized.onnx"
    if args.requantize or not destination.exists():
        # Quantize inside BOTH branches of the merged decoder, including the
        # embedding Gather. Otherwise most decoder weights remain float32.
        quantize_dynamic(str(WORK / f"{name}.onnx"), str(destination),
                         weight_type=QuantType.QUInt8 if name == "encoder_model" else QuantType.QInt8,
                         per_channel=False, reduce_range=False,
                         op_types_to_quantize=["MatMul", "Gather"],
                         extra_options={"EnableSubgraph": True, "MatMulConstBOnly": True})
    print(destination, flush=True)

for name in ("config.json", "preprocessor_config.json"):
    shutil.copy2(WORK / name, OUT / name)
WhisperTokenizerFast.from_pretrained(MODEL).save_pretrained(OUT)
GenerationConfig.from_model_config(AutoConfig.from_pretrained(MODEL)).save_pretrained(OUT)
(OUT / "source.json").write_text(json.dumps({"model": MODEL, "license": "apache-2.0",
                                            "quantization": "q8 MatMul/Gather with subgraphs"}, indent=2))
print(f"Browser model ready: {OUT}", flush=True)
