"""Export AswinG5/moto-parts-30cls (YOLOv8-cls) to ONNX for in-browser inference.

Also writes store/model/reference.json: Python ONNX Runtime top-1 on
tools/test-imgs, using PIL/torchvision preprocessing identical to
Ultralytics classify_transforms(224) (bilinear + antialias, centre-crop).
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PT_PATH = ROOT / "tools" / "hf-moto-parts" / "motopartscls.pt"
OUT_DIR = ROOT / "store" / "model"
ONNX_NAME = "moto-parts-30cls.onnx"
ONNX_PATH = OUT_DIR / ONNX_NAME
TEST_DIR = ROOT / "tools" / "test-imgs"
REF_PATH = OUT_DIR / "reference.json"
IMGSZ = 224


def export_onnx() -> Path:
    from ultralytics import YOLO

    if not PT_PATH.is_file():
        raise SystemExit(
            f"missing {PT_PATH}; download with: "
            "hf download AswinG5/moto-parts-30cls --local-dir tools/hf-moto-parts"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(PT_PATH))
    exported = Path(
        model.export(format="onnx", imgsz=IMGSZ, simplify=True, dynamic=False)
    )
    dest = OUT_DIR / ONNX_NAME
    shutil.copy2(exported, dest)
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"wrote {dest} ({size_mb:.2f} MB)")
    print("classes:")
    for i, name in model.names.items():
        print(f"  {i:2d} {name}")
    return dest


def _class_names() -> list[str]:
    classes_path = OUT_DIR / "classes.json"
    if classes_path.is_file():
        data = json.loads(classes_path.read_text(encoding="utf-8"))
        return list(data["classes"])
    from ultralytics import YOLO

    model = YOLO(str(PT_PATH))
    return [model.names[i] for i in range(len(model.names))]


def write_reference(onnx_path: Path = ONNX_PATH) -> Path:
    """Python ORT predictions with Ultralytics classify_transforms(224)."""
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from ultralytics.data.augment import classify_transforms

    if not onnx_path.is_file():
        raise SystemExit(f"missing {onnx_path}; export the ONNX model first")

    names = _class_names()
    tf = classify_transforms(IMGSZ)
    sess = ort.InferenceSession(
        str(onnx_path), providers=["CPUExecutionProvider"]
    )
    input_name = sess.get_inputs()[0].name

    images: list[dict] = []
    files = sorted(
        p
        for p in TEST_DIR.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    for path in files:
        im = Image.open(path).convert("RGB")
        tensor = tf(im)  # CHW float32 0–1, bilinear+antialias, centre-crop
        x = tensor.detach().cpu().numpy()[None]
        logits = sess.run(None, {input_name: x})[0][0]
        probs = np.asarray(logits, dtype=np.float64)
        # Graph already ends in Softmax; keep a guard anyway.
        s = float(probs.sum())
        if probs.min() < 0 or abs(s - 1.0) >= 0.05:
            shifted = probs - probs.max()
            ex = np.exp(shifted)
            probs = ex / ex.sum()
        order = np.argsort(-probs)
        top5 = [
            {
                "className": names[int(i)],
                "index": int(i),
                "score": round(float(probs[i]), 6),
            }
            for i in order[:5]
        ]
        top1 = top5[0]
        rec = {
            "file": path.name,
            "className": top1["className"],
            "index": top1["index"],
            "score": top1["score"],
            "top5": top5,
        }
        images.append(rec)
        print(f"{path.name:20s}  {top1['className']:22s}  {top1['score']:.3f}")

    payload = {
        "imgsz": IMGSZ,
        "onnx": "store/model/moto-parts-30cls.onnx",
        "preprocess": "ultralytics.classify_transforms(224) = torchvision Resize(224, bilinear, antialias=True) + CenterCrop(224) + ToTensor + Normalize(0,1)",
        "images": images,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REF_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {REF_PATH} ({len(images)} images)")
    return REF_PATH


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reference-only",
        action="store_true",
        help="skip ONNX export; only write store/model/reference.json",
    )
    parser.add_argument(
        "--export-only",
        action="store_true",
        help="export ONNX and skip reference.json",
    )
    args = parser.parse_args()
    if not args.reference_only:
        export_onnx()
    if not args.export_only:
        write_reference()


if __name__ == "__main__":
    main()
