#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
xcrun swiftc -target "$(uname -m)-apple-macos14.0" Sources/StartupURL.swift Tests/main.swift -o build/startup-url-tests
./build/startup-url-tests
xcrun swiftc -target "$(uname -m)-apple-macos14.0" -O -framework AppKit -framework WebKit Sources/StartupURL.swift Sources/main.swift -o build/deepseek-harness
python3 - <<'PY'
import pathlib, plistlib, shutil
source = pathlib.Path('/Applications/DeepSeek Harness.app')
target = pathlib.Path('build/DeepSeek Harness.app')
if not target.exists():
    shutil.copytree(source, target, symlinks=True)
shutil.copy2('build/deepseek-harness', target / 'Contents/MacOS/deepseek-harness')
info = target / 'Contents/Info.plist'
data = plistlib.loads(info.read_bytes())
data['CFBundleShortVersionString'] = '0.1.1'
data['CFBundleVersion'] = '0.1.1'
data['NSAppTransportSecurity'] = {'NSAllowsLocalNetworking': True}
data['LSMinimumSystemVersion'] = '14.0'
info.write_bytes(plistlib.dumps(data))
PY
codesign --force --options runtime --sign - 'build/DeepSeek Harness.app'
codesign --verify --deep --strict 'build/DeepSeek Harness.app'
