// Static contract regression checks, NOT Rust compilation or desktop tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const read = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
test('source has one definition per safety helper and real adapter calls', () => {
 const windows = read('src/windows.rs');
 for (const name of ['process', 'validate', 'uuid', 'describe']) assert.equal((windows.match(new RegExp(`fn ${name}\\(`, 'g')) ?? []).length, 1);
 assert.match(windows, /adapter\.shadow_observe_window/);
 assert.match(windows, /adapter\.shadow_root_identity/);
 assert.match(windows, /"bounds":node.presentation.bounds/);
 assert.match(windows, /EnumWindows\(enumerate/);
});
test('password-first extension has no bulk read, cache, value or input operation', () => {
 const patch = read('patches/shadow_observe.rs');
 const gate = patch.indexOf('let secret = read_one');
 const name = patch.indexOf('TreeProperty::Name');
 assert.ok(gate > 0 && name > gate);
 assert.match(patch, /if secret \{[\s\S]*?return Ok\(node\);/);
 assert.doesNotMatch(patch, /read_cached\(|read_live\(|read_label\(|TreeProperty::Value\b|SendInput\(|execute_action\(/);
 assert.match(patch, /expected_runtime_id/);
 assert.match(patch, /get_process_id\(\)\.ok\(\) != Some\(pid\)/);
});
test('adapter lives inside persistent owner receive loop with explicit cleanup', () => {
 const owner = read('src/owner.rs');
 assert.match(owner, /WindowsAdapter::new\(\)/);
 assert.match(owner, /while let Ok\(command\) = receiver.recv\(\)/);
 assert.match(owner, /drop\(state\); drop\(adapter\); drop\(dpi\); drop\(apartment\);/);
 assert.match(owner, /join\.join\(\)/);
 const identity = read('src/lib.rs').split('pub fn identity()')[1].split('fn error')[0];
 assert.doesNotMatch(identity, /WindowsAdapter|spawn|dispatch|run\(/);
});
test('distribution path, GUID alignment and UTF-16 truncation stay explicit', () => {
 const build = read('scripts/build.mjs');
 assert.match(build, /resolve\(root, 'artifacts'/);
 assert.match(build, /shadow-agent-desktop\.node/);
 assert.match(read('README.md'), /artifacts\/win32-x64\/shadow-agent-desktop\.node/);
 assert.match(read('src/windows.rs'), /#\[repr\(C, align\(4\)\)\]\s*struct GuidBytes/);
 assert.match(read('src/windows.rs'), /CoCreateGuid\(guid: \*mut GuidBytes\)/);
 const patch = read('patches/shadow_observe.rs');
 assert.match(patch, /truncate_utf16\(&name, 512\)/);
 assert.match(patch, /character\.len_utf16\(\)/);
 assert.doesNotMatch(patch, /name\.chars\(\)\.take\(512\)/);
});

test('single-pattern actions have no fallback and every effect sets started first', () => {
 const patch = read('patches/shadow_observe.rs');
 assert.doesNotMatch(patch.split("/// Restricted foreground extension.")[0], /SendInput|SetForegroundWindow|set_focus\(|do_default_action|type_text_steps|select_steps|execute_chain/);
 for (const call of ['p.invoke()', 'p.set_value(value)', 'p.toggle()', 'p.select()', 'p.scroll(x,y)']) {
  assert.ok(patch.includes(`*started = true; ${call}`), call);
 }
 assert.match(patch, /get_runtime_id\(\).*!= runtime/);
 assert.match(patch, /gate::value_allowed/);
 assert.match(read("patches/shadow_gate.rs"), /units < 2000/);
 const host = read('src/windows.rs');
 assert.match(host, /state\.snapshots\.remove\(id\)/);
 assert.match(host, /state\.actions\.insert\(action_id\.to_owned\(\)\)/);
 assert.match(host, /Duration::from_secs\(120\)/);
 assert.match(host, /_ if started => Err\("outcome_unknown"\)/);
 assert.match(host, /current\.signature != previous\.signature/);
});
test('capture uses generation-bound ExactWindow and caps encoded wire bytes', () => {
 const host = read('src/windows.rs');
 assert.match(host, /adapter\.screenshot\(ScreenshotTarget::ExactWindow\(info\)/);
 assert.match(host, /id: format!\("w-\{\}",window.hwnd\)/);
 assert.match(host, /windows-proc-v1:\{\}:\{\}/);
 assert.match(host, /thumbnail\(1600,1600\)/);
 assert.match(host, /base64\.len\(\) > 4\*1024\*1024/);
 assert.doesNotMatch(host, /CopyFromScreen|BitBlt|FullScreen|ScreenshotTarget::Screen/);
 const backend = read('.upstream/crates/windows/src/system/capture_backend.rs');
 assert.match(backend, /CaptureSubject::Window \{[\s\S]*?capture_modern::capture_window/);
 assert.match(backend, /CaptureSubject::Window \{[\s\S]*?=> capture_window\(handle, scale_factor, deadline\)/);
 const legacy = read('.upstream/crates/windows/src/system/capture_window.rs');
 assert.match(legacy, /PrintWindow\(/);
 assert.doesNotMatch(legacy, /BitBlt|CopyFromScreen|capture_display_at/);
});

test('set_value password gate returns before eager original-value read', () => {
 const patch = read('patches/shadow_observe.rs');
 const action = patch.slice(patch.indexOf('pub fn shadow_action'));
 const branch = action.slice(action.indexOf('"set_value" =>'), action.indexOf('"toggle" =>'));
 assert.match(branch, /let password = read_one\(&wrapped, TreeProperty::IsPassword\)\.flag\(\);\s*if password != Some\(false\) \{ return Err\(refused\(\)\); \}\s*let original_units = p\.get_value\(\)/);
 assert.match(branch, /gate::value_allowed\(password,true,false,true,evidence\.role == "Edit",p\.is_readonly\(\)\.ok\(\),original_units\)/);
 // No sensitive provider read may be evaluated as an eager boolean-gate argument.
 for (const call of patch.matchAll(/gate::(?:value_allowed|action_allowed)\([^\n]*/g)) {
  assert.doesNotMatch(call[0], /get_value\(|get_text\(|TreeProperty::Name/);
 }
});

test('foreground uses independent AOT guard, sticky cancellation and no upstream input', () => {
 const input=read('src/input.rs'), host=read('src/windows.rs'), patch=read('patches/shadow_observe.rs');
 assert.match(input,/STOPPED\.store\(true/);
 assert.match(input,/let handle = CANCEL\.lock\(\)\.ok\(\)\.and_then\(\|slot\|slot\.clone\(\)\)/);
 assert.match(input,/Command::new\(path\)\.arg\(std::process::id\(\)\.to_string\(\)\)/);
 assert.match(input,/SHADOW_INPUT_CANCEL_EVENT/);
 assert.match(input,/method=="execute" \{ \*started=true; \}/);
 assert.match(input,/\*started \|= effect/);
 assert.doesNotMatch(input,/powershell|cmd\.exe|\.shell\(/i);
 assert.doesNotMatch(host,/foreground_not_allowed|foregroundInput|window\.foreground/);
 assert.match(host,/state\.targets\.get\(id\)\.cloned\(\)\.ok_or\("window_unavailable"\)/);
 assert.match(host,/previous\.frame!=current\.frame/);
 assert.match(host,/focused\.signature!=previous\.signature/);
 assert.match(host,/GetGUIThreadInfo/);
 assert.match(patch,/get_raw_view_walker/);
 assert.match(patch,/if read_one\(&UIAElement::from\(current.clone\(\)\),TreeProperty::IsPassword\).flag\(\)!=Some\(false\) \{ return Err\(refused\(\)\); \}/);
 assert.doesNotMatch(host+patch,/AttachThreadInput|keyboard_send|mouse_send|ActionOps::execute_action/);
});

test('offscreen nonsecret content participates in the same fingerprint without advertising actions', () => {
 const patch=read('patches/shadow_observe.rs');
 const visit=patch.slice(patch.indexOf('fn visit('),patch.indexOf('/// Authorized bind-time'));
 assert.doesNotMatch(visit,/if !offscreen/);
 assert.ok(visit.indexOf('if secret')<visit.indexOf('TreeProperty::Name'));
 assert.match(visit,/raw_name = Some\(fingerprint\(&name\)\)/);
 assert.match(visit,/raw_value = Some\(fingerprint\(&value\)\)/);
 assert.match(visit,/gate::value_allowed\(Some\(false\),enabled,offscreen/);
 assert.match(visit,/gate::action_allowed\(Some\(false\),enabled,offscreen,true\)/);
});
test('ordinary actions gate every dispatch and successful return on sticky cancellation', () => {
 const patch=read('patches/shadow_observe.rs');
 const action=patch.slice(patch.indexOf('pub fn shadow_action'),patch.indexOf('fn find_runtime'));
 assert.match(action,/cancelled: &dyn Fn\(\)->bool/);
 assert.match(action,/if cancelled\(\) \{ return Err\(refused\(\)\); \}/);
 assert.equal((action.match(/\*started = true;/g)??[]).length,5);
 assert.equal((action.match(/dispatch_allowed\(deadline.is_expired\(\),cancelled\(\)\) \{ return Err\(refused\(\)\); \} \*started = true;/g)??[]).length,5);
 assert.match(action,/dispatch_allowed\(deadline.is_expired\(\),cancelled\(\)\)[\s\S]*?\n        result/);
 const input=read('src/input.rs');
 assert.match(input,/verify_identity\(path\)\.map_err/);
 assert.match(input,/sync_channel\(1\)/);
 assert.match(input,/validate_result\(method,result\)\?/);
});
