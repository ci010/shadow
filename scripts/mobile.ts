import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(root, 'mobile');

function run(command: string, args: string[], cwd = root): void {
  const pnpmEntrypoint = command === 'pnpm' && /pnpm\.c?js$/.test(process.env.npm_execpath ?? '')
    ? process.env.npm_execpath : undefined;
  const result = spawnSync(pnpmEntrypoint ? process.execPath : command, pnpmEntrypoint ? [pnpmEntrypoint, ...args] : args, {
    cwd,
    stdio: 'inherit',
    shell: command === 'pnpm' && !pnpmEntrypoint && process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

interface NativePreflight {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  probe: (command: string, args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

export function checkNativeToolchain(
  target: 'android' | 'ios',
  tools: NativePreflight = {
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    probe: (command, args) => spawnSync(command, args, { encoding: 'utf8' }),
  },
): void {
  if (target === 'android') {
    const sdk = tools.env.ANDROID_HOME || tools.env.ANDROID_SDK_ROOT;
    if (!sdk || !tools.exists(resolve(sdk, 'platforms/android-36/android.jar')) ||
        !tools.exists(resolve(sdk, `build-tools/36.0.0/aapt2${tools.platform === 'win32' ? '.exe' : ''}`))) {
      throw new Error('Android SDK 36 is required. Install Android Studio/SDK command-line tools, run sdkmanager "platforms;android-36" "build-tools;36.0.0", and set ANDROID_HOME to that SDK directory.');
    }
    const java = tools.env.JAVA_HOME
      ? resolve(tools.env.JAVA_HOME, `bin/java${tools.platform === 'win32' ? '.exe' : ''}`)
      : 'java';
    const version = tools.probe(java, ['-version']);
    if (version.status !== 0 || !/(?:openjdk|java) version "21(?:[."])/.test(`${version.stdout}\n${version.stderr}`)) {
      throw new Error('JDK 21 is required for Android builds. Install JDK 21 and set JAVA_HOME/PATH to that installation.');
    }
    return;
  }
  if (tools.platform !== 'darwin') {
    throw new Error('iOS compilation requires macOS with Xcode 26 or newer. Use the macOS mobile-release CI job or a Mac; cap sync alone is not an iOS build.');
  }
  const xcode = tools.probe('xcodebuild', ['-version']);
  const major = Number(/Xcode (\d+)/.exec(xcode.stdout)?.[1]);
  if (xcode.status !== 0 || !Number.isFinite(major) || major < 26) {
    throw new Error('Xcode 26 or newer is required. Install Xcode and select it using xcode-select --switch <Xcode.app>/Contents/Developer.');
  }
  const sdk = tools.probe('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  if (sdk.status !== 0 || !sdk.stdout.trim() || !tools.exists(sdk.stdout.trim())) {
    throw new Error('The iOS Simulator SDK is missing. Install the iOS platform in Xcode Settings and complete Xcode first-launch setup.');
  }
}

export function checkMobileProject(): void {
  const text = (path: string) => readFileSync(resolve(mobile, path), 'utf8');
  const requireText = (path: string, value: string) => {
    if (!text(path).includes(value)) throw new Error(`${path} must contain ${value}`);
  };
  const config = text('capacitor.config.ts');
  if (/\b(?:server|allowNavigation)\s*:/.test(config)) {
    throw new Error('Mobile must load bundled assets, without server or navigation overrides');
  }
  requireText('capacitor.config.ts', "webDir: '../app/dist-mobile'");
  const manifest = JSON.parse(text('package.json'));
  for (const name of ['core', 'android', 'ios']) {
    if (manifest.dependencies[`@capacitor/${name}`] !== '8.5.2') throw new Error(`Unpinned ${name}`);
  }
  if (manifest.devDependencies['@capacitor/cli'] !== '8.5.2') throw new Error('Unpinned CLI');
  requireText('android/app/src/main/AndroidManifest.xml', 'android:allowBackup="false"');
  requireText('android/app/src/main/AndroidManifest.xml', 'android:usesCleartextTraffic="false"');
  requireText('android/app/src/main/AndroidManifest.xml', 'android.permission.INTERNET');
  requireText('android/app/src/main/java/app/shadow/mobile/MainActivity.java', 'registerPlugin(ShadowCredentialsPlugin.class)');
  requireText('android/app/src/main/java/app/shadow/mobile/ShadowCredentialsPlugin.java', 'AES/GCM/NoPadding');
  requireText('android/app/src/main/java/app/shadow/mobile/ShadowCredentialsPlugin.java', '16 * 1024');
  requireText('android/app/src/main/res/xml/data_extraction_rules.xml', 'shadow_credentials.xml');
  requireText('android/gradle/wrapper/gradle-wrapper.properties', 'gradle-8.14.3-all.zip');
  requireText('android/build.gradle', 'com.android.tools.build:gradle:8.13.0');
  requireText('android/variables.gradle', 'compileSdkVersion = 36');
  requireText('ios/App/App/ShadowCredentialsPlugin.swift', 'kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
  requireText('ios/App/App/ShadowCredentialsPlugin.swift', 'kSecAttrSynchronizable');
  requireText('ios/App/App/ShadowViewController.swift', 'registerPluginInstance(ShadowCredentialsPlugin())');
  requireText('ios/App/App/Base.lproj/Main.storyboard', 'customClass="ShadowViewController"');
  requireText('ios/App/App.xcodeproj/project.pbxproj', 'ShadowCredentialsPlugin.swift');
  requireText('ios/App/CapApp-SPM/Package.swift', 'capacitor-swift-pm');
  const androidManifest = text('android/app/src/main/AndroidManifest.xml');
  if (/android\.permission\.(?:CAMERA|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE)/.test(androidManifest)) {
    throw new Error('Unexpected broad native permissions');
  }
  if (/NSAllowsArbitraryLoads/.test(text('ios/App/App/Info.plist'))) {
    throw new Error('iOS transport security exceptions are not allowed');
  }
  console.log('Mobile native project contracts verified (not a native compilation).');
}

function requireMobileBundle(): void {
  const stamp = resolve(root, 'app/dist-mobile/shadow-mobile-build.json');
  if (!existsSync(stamp) || JSON.parse(readFileSync(stamp, 'utf8')).mode !== 'mobile') {
    throw new Error('No verified mobile bundle. Run pnpm mobile:build before syncing.');
  }
}

export function main(action = process.argv[2]): void {
  switch (action) {
    case 'build':
      main('build:web');
      main('sync');
      break;
    case 'build:web':
      run('pnpm', ['--filter', '@shadow/app', 'exec', 'vite', 'build', '--mode', 'mobile', '--outDir', 'dist-mobile', '--logLevel', 'warn']);
      writeFileSync(resolve(root, 'app/dist-mobile/shadow-mobile-build.json'), '{"mode":"mobile"}\n');
      break;
    case 'sync':
      requireMobileBundle();
      run('pnpm', ['exec', 'cap', 'sync'], mobile);
      checkMobileProject();
      break;
    case 'check':
      checkMobileProject();
      break;
    case 'android':
    case 'build:android':
      checkNativeToolchain('android');
      main('build');
      if (process.platform === 'win32') {
        run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'gradlew.bat --no-daemon :app:assembleRelease'], resolve(mobile, 'android'));
      } else {
        run('sh', ['gradlew', '--no-daemon', ':app:assembleRelease'], resolve(mobile, 'android'));
      }
      console.log('Android release APK built under mobile/android/app/build/outputs/apk/release (unsigned unless all signing inputs were provided).');
      break;
    case 'ios':
    case 'build:ios':
      checkNativeToolchain('ios');
      main('build');
      run('xcodebuild', [
        '-project', 'mobile/ios/App/App.xcodeproj', '-scheme', 'App',
        '-configuration', 'Release', '-sdk', 'iphonesimulator',
        '-destination', 'generic/platform=iOS Simulator',
        '-derivedDataPath', 'mobile/ios/DerivedData', 'CODE_SIGNING_ALLOWED=NO', 'build',
      ]);
      console.log('Unsigned iOS simulator app built under mobile/ios/DerivedData/Build/Products/Release-iphonesimulator (not device distribution).');
      break;
    default:
      throw new Error('Usage: mobile.ts build|build:web|sync|check|android|ios|build:android|build:ios');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
