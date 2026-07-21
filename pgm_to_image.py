#!/usr/bin/env python3
"""
pgm_to_image.py — конвертує фінальний PGM (вихід C++ рушія) у JPG для
показу на сайті / відправки в Telegram.

CLI:
    python3 pgm_to_image.py <input.pgm> <output_full.jpg> <output_web.jpg> [web_max_side=1400]

Робить ОДРАЗУ два файли:
  - output_full.jpg — повна роздільна здатність (для Telegram/друку/архіву)
  - output_web.jpg  — зменшена версія для швидкого показу в браузері

Код виходу: 0 — успіх, 1 — помилка.
"""

import sys
import json
import cv2


def convert(pgm_path, full_jpg_path, web_jpg_path, web_max_side=1400):
    img = cv2.imread(pgm_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"Помилка: не вдалося прочитати {pgm_path}", file=sys.stderr)
        print("##PGM_RESULT##" + json.dumps({"ok": False, "error": "cannot_read_pgm"}))
        sys.exit(1)

    h, w = img.shape[:2]

    cv2.imwrite(full_jpg_path, img, [cv2.IMWRITE_JPEG_QUALITY, 92])

    scale = min(1.0, web_max_side / max(h, w))
    if scale < 1.0:
        web_img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    else:
        web_img = img
    cv2.imwrite(web_jpg_path, web_img, [cv2.IMWRITE_JPEG_QUALITY, 88])

    print("##PGM_RESULT##" + json.dumps({
        "ok": True,
        "fullSize": [w, h],
        "webSize": [web_img.shape[1], web_img.shape[0]],
    }))


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        print("Usage: python3 pgm_to_image.py <input.pgm> <output_full.jpg> <output_web.jpg> [web_max_side]", file=sys.stderr)
        sys.exit(1)

    pgm_path = sys.argv[1]
    full_jpg = sys.argv[2]
    web_jpg = sys.argv[3]
    max_side = int(sys.argv[4]) if len(sys.argv) == 5 else 1400

    convert(pgm_path, full_jpg, web_jpg, max_side)
