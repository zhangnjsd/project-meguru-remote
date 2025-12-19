$src = "output.png"
$base = "src-tauri/gen/android/app/src/main/res"

$dirs = @(
  "$base/mipmap-mdpi",
  "$base/mipmap-hdpi",
  "$base/mipmap-xhdpi",
  "$base/mipmap-xxhdpi",
  "$base/mipmap-xxxhdpi"
)

foreach ($d in $dirs) {
  if (-not (Test-Path $d)) {
    New-Item -ItemType Directory -Path $d | Out-Null
  }
}

# 生成图标
magick $src -alpha on -resize 48x48   "$base/mipmap-mdpi/ic_launcher.png"
magick $src -alpha on -resize 72x72   "$base/mipmap-hdpi/ic_launcher.png"
magick $src -alpha on -resize 96x96   "$base/mipmap-xhdpi/ic_launcher.png"
magick $src -alpha on -resize 144x144 "$base/mipmap-xxhdpi/ic_launcher.png"
magick $src -alpha on -resize 192x192 "$base/mipmap-xxxhdpi/ic_launcher.png"