#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
xcrun swiftc -target "$(uname -m)-apple-macos14.0" Sources/StartupURL.swift Sources/RuntimeLaunch.swift Tests/main.swift -o build/startup-url-tests
./build/startup-url-tests
xcrun swiftc -target "$(uname -m)-apple-macos14.0" -O -framework AppKit -framework WebKit Sources/StartupURL.swift Sources/RuntimeLaunch.swift Sources/main.swift -o build/deepseek-harness
python3 - <<'PY'
import pathlib, plistlib, shutil, subprocess
from staging import refresh_staged_bundle
source = pathlib.Path('/Applications/DeepSeek Harness.app')
target = pathlib.Path('build/DeepSeek Harness.app')
refresh_staged_bundle(source, target)
shutil.copy2('build/deepseek-harness', target / 'Contents/MacOS/deepseek-harness')
info = target / 'Contents/Info.plist'
data = plistlib.loads(info.read_bytes())
original_executable = data.get('DSHElectronExecutable') or data.get('CFBundleExecutable')
if original_executable and original_executable != 'deepseek-harness':
    data['DSHElectronExecutable'] = original_executable
data['CFBundleExecutable'] = 'deepseek-harness'
data['CFBundleShortVersionString'] = '0.1.2'
data['CFBundleVersion'] = '0.1.2'
data['NSAppTransportSecurity'] = {'NSAllowsLocalNetworking': True}
data['LSMinimumSystemVersion'] = '14.0'
info.write_bytes(plistlib.dumps(data))
electron_name = data.get('DSHElectronExecutable')
electron = target / 'Contents/MacOS' / electron_name if electron_name else None
if electron and electron.is_file():
    subprocess.run(['codesign', '--force', '--sign', '-', str(electron)], check=True)
PY
codesign --force --options runtime --sign - 'build/DeepSeek Harness.app'
codesign --verify --deep --strict 'build/DeepSeek Harness.app'
