"""Export AswinG5/moto-parts-30cls (YOLOv8-cls) to ONNX for in-browser inference."""

from __future__ import annotations

import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
PT_PATH = ROOT / "tools" / "hf-moto-parts" / "motopartscls.pt"
OUT_DIR = ROOT / "store" / "model"
ONNX_NAME = "moto-parts-30cls.onnx"
IMGSZ = 224


def main() -> None:
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


if __name__ == "__main__":
    main()
