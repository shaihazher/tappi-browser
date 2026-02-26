# Build Assets

This directory contains build-time assets for electron-builder.

## Required Icons

Before running `npm run dist`, add icons:

### macOS
- `icon.icns` — macOS app icon (1024x1024 master)
  - Generate with: `iconutil -c icns icon.iconset`
  - Or use online tools like https://cloudconvert.com/png-to-icns

### Windows
- `icon.ico` — Windows app icon (256x256)
  - Generate with: https://cloudconvert.com/png-to-ico

### Linux
- `icons/` — PNG icons in various sizes:
  - `512x512.png`
  - `256x256.png`
  - `128x128.png`
  - `64x64.png`
  - `48x48.png`
  - `32x32.png`
  - `16x16.png`

## Quick Icon Generation

If you have a single 1024x1024 PNG called `icon.png`:

```bash
# macOS (requires iconutil)
mkdir icon.iconset
sips -z 16 16 icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32 icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32 icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64 icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128 icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256 icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

# Windows (use online converter or ImageMagick)
convert icon.png -resize 256x256 icon.ico

# Linux sizes
for size in 16 32 48 64 128 256 512; do
  convert icon.png -resize ${size}x${size} icons/${size}x${size}.png
done
```

## Temporary Build (No Icons)

electron-builder will use Electron's default icon if these files are missing.
The build will succeed, just with a generic Electron icon.
