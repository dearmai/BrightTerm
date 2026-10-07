# 다크모드 아이콘 색상 조정

2026-10-07, 내장 `image_gen` 도구로 기존 `build/icon.png`를 편집했습니다.
외부 배경은 투명하게 생성했으며, 아래 자산으로 크기를 조정해 반영했습니다.

- `build/icon.png`, `resources/icon.png`: 1024×1024
- `src/renderer/src/assets/logo.png`: 투명 여백을 정리한 256×256
- `build/icons/`: `bash scripts/gen-linux-icons.sh`로 생성한 16–512px Linux 아이콘

## 최종 프롬프트

Use case: precise-object-edit. Asset type: BrightTerm desktop application icon, 1024x1024 PNG with actual transparent background. Input image 1 is the edit target. Adjust only colors and contrast for clear visibility on very dark UI backgrounds (#0f1115 and #151821). Preserve the exact original rounded-square silhouette, centered 2x2 grid of four terminal tiles and >_ symbols, same positions and proportions, glossy subtle dimensional style. Keep red-orange upper left, yellow upper right, green lower left, cyan-blue lower right. Lighten the charcoal outer rounded-square plate to a cool medium slate blue-gray (#64748b to #475569), with a clearly visible lighter cool silver-blue rim (#a8bdd4). Keep terminal tile interiors dark and their saturated colored outlines crisp; terminal >_ symbols bright near-white. The app icon must read clearly at 18px and 32px. Remove the external dark glow and shadow surrounding the silhouette: all area outside the rounded square must be truly transparent alpha, no opaque black background, no checkerboard drawn into pixels, no extra outer halo. Keep original framing and roughly 72% canvas occupancy. No new content, letters, watermark, labels, or rearrangement.
