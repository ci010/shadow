import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { checkMobileProject, checkNativeToolchain, root } from './mobile.ts';

const text = (path: string) => readFileSync(resolve(root, 'mobile', path), 'utf8');

test('committed mobile native projects enforce client and credential contracts', () => {
  assert.doesNotThrow(checkMobileProject);
});

test('mobile builds and syncs never overwrite the Main browser bundle', () => {
  const script = readFileSync(resolve(root, 'scripts/mobile.ts'), 'utf8');
  assert.match(script, /'--mode', 'mobile', '--outDir', 'dist-mobile'/);
  assert.match(script, /app\/dist-mobile\/shadow-mobile-build\.json/);
  assert.doesNotMatch(script, /app\/dist\//);
  assert.match(text('capacitor.config.ts'), /webDir: '\.\.\/app\/dist-mobile'/);
});

test('both native plugins expose only the same bounded credential record contract', () => {
  const android = text('android/app/src/main/java/app/shadow/mobile/ShadowCredentialsPlugin.java');
  const ios = text('ios/App/App/ShadowCredentialsPlugin.swift');
  for (const method of ['get', 'set', 'remove']) {
    assert.match(android, new RegExp(`void ${method}\\(PluginCall call\\)`));
    assert.match(ios, new RegExp(`CAPPluginMethod\\(name: "${method}"`));
  }
  assert.match(android, /@CapacitorPlugin\(name = "ShadowCredentials"\)/);
  assert.match(ios, /jsName = "ShadowCredentials"/);
  assert.match(android, /JSONObject\.NULL/);
  assert.match(ios, /NSNull\(\)/);
  assert.match(android, /StandardCharsets\.UTF_8/);
  assert.match(ios, /data\.count <= 16 \* 1024/);
  assert.match(android, /KeyProperties\.PURPOSE_ENCRYPT \| KeyProperties\.PURPOSE_DECRYPT/);
  assert.match(ios, /kSecAttrSynchronizable as String: false/);
  assert.doesNotMatch(android, /setUserAuthenticationRequired\(true\)/);
  assert.match(android, /store\.deleteEntry\(ALIAS\)/);
  const activity = text('android/app/src/main/java/app/shadow/mobile/MainActivity.java');
  assert.ok(activity.indexOf('registerPlugin(') < activity.indexOf('super.onCreate('));
  const project = text('ios/App/App.xcodeproj/project.pbxproj');
  for (const source of ['ShadowCredentialsPlugin.swift', 'ShadowViewController.swift']) {
    assert.match(project, new RegExp(`${source.replace('.', '\\.')} in Sources`));
  }
});

test('release validation artifacts are not mislabeled as distribution builds', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/mobile-release.yml'), 'utf8');
  assert.match(workflow, /android-unsigned-validation-apk/);
  assert.match(workflow, /ios-simulator-validation/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /SHADOW_ANDROID_KEYSTORE_BASE64/);
  assert.match(workflow, /SHADOW_IOS_CERTIFICATE_BASE64/);
});

test('native dependency manifests pin Capacitor and include lifecycle plugin', () => {
  const swift = text('ios/App/CapApp-SPM/Package.swift');
  assert.match(swift, /exact: "8\.5\.2"/);
  assert.match(swift, /\.product\(name: "CapacitorApp"/);
  assert.match(text('android/capacitor.settings.gradle'), /include ':capacitor-app'/);
  assert.match(text('android/app/capacitor.build.gradle'), /JavaVersion\.VERSION_21/);
  assert.match(text('android/gradle/wrapper/gradle-wrapper.properties'), /distributionSha256Sum=[a-f0-9]{64}/);
});

test('native Android preflight requires SDK 36 and JDK 21', () => {
  const tools = {
    platform: 'win32' as const,
    env: { ANDROID_HOME: resolve(root, 'mobile/synthetic-sdk') },
    exists: () => true,
    probe: () => ({ status: 0, stdout: '', stderr: 'openjdk version "21.0.8" 2025-07-15 LTS' }),
  };
  assert.doesNotThrow(() => checkNativeToolchain('android', tools));
  assert.throws(() => checkNativeToolchain('android', { ...tools, env: {} }), /ANDROID_HOME/);
  assert.throws(() => checkNativeToolchain('android', { ...tools, exists: () => false }), /SDK 36/);
  assert.throws(() => checkNativeToolchain('android', {
    ...tools, probe: () => ({ status: 0, stdout: '', stderr: 'openjdk version "17.0.1"' }),
  }), /JDK 21/);
});

test('native iOS preflight requires macOS, Xcode 26 and simulator SDK', () => {
  const tools = {
    platform: 'darwin' as const,
    env: {},
    exists: () => true,
    probe: (command: string) => ({
      status: 0,
      stdout: command === 'xcodebuild' ? 'Xcode 26.0\nBuild version 17A324' : resolve(root, 'mobile/synthetic-sdk'),
      stderr: '',
    }),
  };
  assert.doesNotThrow(() => checkNativeToolchain('ios', tools));
  assert.throws(() => checkNativeToolchain('ios', { ...tools, platform: 'win32' }), /macOS/);
  assert.throws(() => checkNativeToolchain('ios', {
    ...tools, probe: () => ({ status: 0, stdout: 'Xcode 16.4', stderr: '' }),
  }), /Xcode 26/);
  assert.throws(() => checkNativeToolchain('ios', { ...tools, exists: () => false }), /Simulator SDK/);
});

test('missing native tools cause actionable nonzero command failure, not IDE-open success', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/mobile.ts', 'android'], {
    cwd: root,
    env: { ...process.env, ANDROID_HOME: '', ANDROID_SDK_ROOT: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Android SDK 36 is required/);
  assert.doesNotMatch(result.stdout, /built under|Sync finished/);
  const packageJson = JSON.parse(text('package.json'));
  assert.match(packageJson.scripts['build:android'], /mobile\.ts build:android$/);
  assert.match(packageJson.scripts['build:ios'], /mobile\.ts build:ios$/);
  const script = readFileSync(resolve(root, 'scripts/mobile.ts'), 'utf8');
  assert.doesNotMatch(script, /'cap', 'open'/);
  assert.match(script, /:app:assembleRelease/);
  assert.match(script, /'xcodebuild', \[/);
});
