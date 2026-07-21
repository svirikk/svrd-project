#!/usr/bin/env python3
"""
convert.py — предобробка фото клієнта перед подачею в C++ рушій string-art.

CLI:
    python3 convert.py <input_image> <output.pgm> [target_size=1024]

Друкує в кінці один машинно-читабельний рядок ##CONVERT_RESULT##{...} —
саме його парсить Node.js бекенд (server/services/pipeline.js), решта
виводу — для людини/логів.

Код виходу: 0 — успіх, 1 — помилка (файл не відкрився, неможливо обробити).
"""

import sys
import json
import cv2
import numpy as np


def build_subject_mask(gray, size):
    """
    Повертає м'яку (0..1, з розмитими краями) маску: 1 = людина (обличчя +
    запас під волосся/плечі), 0 = фон.
    Якщо обличчя не знайдено — запасний варіант: великий центральний овал.
    """
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = face_cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(size // 8, size // 8)
    )

    mask = np.zeros((size, size), dtype=np.float32)

    if len(faces) > 0:
        # якщо знайшло кілька — беремо найбільше (найімовірніше головний суб'єкт)
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
        cx, cy = x + w / 2, y + h / 2

        # Розширюємо бокс обличчя із запасом: трохи ширше по X (вуха/волосся
        # збоку), суттєво більше вгору (волосся) і вниз (шия/плечі/груди).
        # ОБОВ'ЯЗКОВО обмежуємо максимальним розміром відносно кадру — інакше
        # на дуже близьких селфі (обличчя майже на весь кадр) еліпс займе
        # 100% зображення і фон просто не буде з чого спрощувати.
        rx = min(w * 1.3, size * 0.44)
        ry_up = min(h * 1.4, size * 0.38)
        ry_down = min(h * 2.2, size * 0.46)
        ry = (ry_up + ry_down) / 2
        center_y = cy + (ry_down - ry_up) / 2

        cv2.ellipse(mask, (int(cx), int(center_y)), (int(rx), int(ry)), 0, 0, 360, 1.0, -1)
        detected = True
        face_box = {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}
    else:
        cx, cy = size / 2, size / 2
        cv2.ellipse(mask, (int(cx), int(cy)), (int(size * 0.35), int(size * 0.48)), 0, 0, 360, 1.0, -1)
        detected = False
        face_box = None

    # Розмиваємо межу маски, щоб перехід фон->суб'єкт був плавним, без
    # різкого шва на фінальному зображенні.
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=size * 0.025)
    mask = np.clip(mask, 0.0, 1.0)
    return mask, detected, face_box


def measure_background_complexity(gray, mask):
    """
    Оцінює, наскільки "галасливий" фон: комбінація щільності країв
    (Laplacian) і розкиду яскравості, порахованих ТІЛЬКИ у фоновій частині
    (де маска ~0), зважено по (1 - маска).
    Повертає число приблизно 0..100+ (емпірична шкала — чим більше, тим
    складніший/деталізованіший фон).
    """
    bg_weight = 1.0 - mask
    total_weight = bg_weight.sum() + 1e-6

    laplacian = cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F)
    edge_energy = np.abs(laplacian)
    weighted_edge = (edge_energy * bg_weight).sum() / total_weight

    mean_bg = (gray.astype(np.float32) * bg_weight).sum() / total_weight
    var_bg = (((gray.astype(np.float32) - mean_bg) ** 2) * bg_weight).sum() / total_weight
    std_bg = np.sqrt(var_bg)

    # Емпірична комбінація: краї важать більше, бо вони найбільше "з'їдають"
    # ниток на дрібні деталі фону (полиці, меблі, текстури).
    complexity = 0.6 * weighted_edge + 0.4 * std_bg
    return complexity, weighted_edge, std_bg, mean_bg


def simplify_background(gray, mask, complexity, mean_bg, size):
    """
    Адаптивно спрощує фон залежно від виміряної складності:
      - трохи галасливий фон -> легке розмиття
      - дуже галасливий фон -> сильне розмиття + підмішування рівного сірого
        (фізично нитка не вміє малювати прозорість, тож "прибирання фону" —
        це вирівнювання його в один тон, а не вирізання).
    """
    blur_sigma = float(np.clip(size * 0.004 + complexity * (size * 0.0015), size * 0.006, size * 0.05))
    flatten_strength = float(np.clip((complexity - 4) / 20.0, 0.0, 0.85))

    blurred = cv2.GaussianBlur(gray, (0, 0), sigmaX=blur_sigma)
    flat = np.full_like(gray, mean_bg, dtype=np.float32)
    simplified = (1 - flatten_strength) * blurred.astype(np.float32) + flatten_strength * flat

    return simplified, blur_sigma, flatten_strength


def classify_warning(complexity, face_detected):
    """Визначає, чи варто попередити клієнта на сайті про якість фото."""
    if not face_detected:
        return "medium", ("Не вдалося точно розпізнати обличчя на фото. Переконайтесь, що "
                           "воно добре освітлене, дивиться в камеру, і спробуйте ще раз.")
    if complexity > 25:
        return "high", ("Фон на фото дуже деталізований/захаращений. Ми його спростили "
                         "автоматично, але для кращого результату спробуйте фото на "
                         "однотонному, спокійному фоні.")
    if complexity > 10:
        return "medium", ("Фон помітно деталізований — ми його трохи спростили. Для "
                           "максимальної чіткості портрета рекомендуємо однотонний фон.")
    return "none", None


def prepare_commercial_string_art(input_image_path, output_pgm_path, target_size=1024):
    img = cv2.imread(input_image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"Помилка: Не вдалося відкрити файл {input_image_path}", file=sys.stderr)
        result = {"ok": False, "error": "cannot_open_image"}
        print("##CONVERT_RESULT##" + json.dumps(result))
        sys.exit(1)

    if min(img.shape[:2]) < 400:
        print(f"Помилка: зображення замале ({img.shape[1]}x{img.shape[0]}), мінімум 400x400.", file=sys.stderr)
        result = {"ok": False, "error": "image_too_small"}
        print("##CONVERT_RESULT##" + json.dumps(result))
        sys.exit(1)

    # Квадратний кроп по центру
    h, w = img.shape[:2]
    min_side = min(h, w)
    top = (h - min_side) // 2
    left = (w - min_side) // 2
    img_cropped = img[top:top + min_side, left:left + min_side]

    img_resized = cv2.resize(img_cropped, (target_size, target_size), interpolation=cv2.INTER_LANCZOS4)

    # 1. Знаходимо, де суб'єкт, а де фон
    mask, face_detected, face_box = build_subject_mask(img_resized, target_size)

    # 2. Міряємо, наскільки складний/галасливий фон
    complexity, edge_score, std_score, mean_bg = measure_background_complexity(img_resized, mask)

    # 3. М'який адаптивний контраст (CLAHE) — до спрощення фону, щоб деталі
    #    обличчя проявились, а фон потім однаково згладиться.
    clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
    img_enhanced = clahe.apply(img_resized)

    # 4. Адаптивно спрощуємо фон і змішуємо з суб'єктом по м'якій масці
    simplified_bg, blur_sigma, flatten_strength = simplify_background(
        img_enhanced, mask, complexity, mean_bg, target_size
    )
    composited = mask * img_enhanced.astype(np.float32) + (1 - mask) * simplified_bg
    composited = np.clip(composited, 0, 255).astype(np.uint8)

    # 5. Стискаємо динамічний діапазон [0,255] -> [0,220], щоб на фото не
    #    було чистого білого і алгоритм не уникав "білих" зон.
    img_gray_toned = (composited * (220.0 / 255.0)).astype(np.uint8)

    # 6. Робоче коло (за межами круга — той самий рівний сірий)
    circle_mask = np.zeros((target_size, target_size), dtype=np.uint8)
    cv2.circle(circle_mask, (target_size // 2, target_size // 2), target_size // 2, 255, -1)
    img_final = np.where(circle_mask == 255, img_gray_toned, 220)

    # 7. Запис чистого бінарного PGM (P5)
    raw_pixels = img_final.tobytes()
    with open(output_pgm_path, "wb") as f:
        f.write(f"P5\n{target_size} {target_size}\n255\n".encode("ascii"))
        f.write(raw_pixels)

    warning_level, warning_message = classify_warning(complexity, face_detected)

    print(f"[Авто-фон] Обличчя знайдено: {face_detected}, складність фону={complexity:.1f} "
          f"(краї={edge_score:.1f}, розкид={std_score:.1f}), розмиття sigma={blur_sigma:.1f}, "
          f"вирівнювання={flatten_strength:.2f}")
    print(f"🔥 Комерційний pipeline (з адаптивним фоном) готовий! Файл '{output_pgm_path}' збережено.")

    result = {
        "ok": True,
        "faceDetected": face_detected,
        "faceBox": face_box,
        "backgroundComplexity": round(float(complexity), 2),
        "blurSigma": round(float(blur_sigma), 2),
        "flattenStrength": round(float(flatten_strength), 3),
        "warningLevel": warning_level,
        "warningMessage": warning_message,
    }
    print("##CONVERT_RESULT##" + json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print("Usage: python3 convert.py <input_image> <output.pgm> [target_size=1024]", file=sys.stderr)
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) == 4 else 1024

    prepare_commercial_string_art(in_path, out_path, size)
