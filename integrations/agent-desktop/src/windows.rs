//! Win32 metadata safety gate, independent of upstream enumeration.
use serde_json::{Value, json};
use std::{collections::{HashMap, HashSet}, ffi::c_void, time::{Duration, Instant}};
type Handle = *mut c_void;
#[repr(C)] #[derive(Default, PartialEq, Eq, Clone, Copy)]
struct FileTime { low: u32, high: u32 }
#[repr(C)] #[derive(Default)]
#[derive(Clone,Copy)]
struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
#[link(name = "user32")]
unsafe extern "system" {
 fn EnumWindows(callback: unsafe extern "system" fn(Handle, isize) -> i32, data: isize) -> i32;
 fn IsWindowVisible(hwnd: Handle) -> i32;
 fn IsWindow(hwnd: Handle) -> i32;
 fn IsIconic(hwnd: Handle) -> i32;
 fn GetForegroundWindow() -> Handle;
 fn GetLastInputInfo(info: *mut LastInput) -> i32;
 fn GetWindowThreadProcessId(hwnd: Handle, pid: *mut u32) -> u32;
 fn GetWindowTextW(hwnd: Handle, text: *mut u16, count: i32) -> i32;
 fn GetWindowRect(hwnd: Handle, rect: *mut Rect) -> i32;
 fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> Handle;
 fn CloseDesktop(desktop: Handle) -> i32;
 fn GetUserObjectInformationW(handle: Handle, index: i32, output: *mut c_void, length: u32, needed: *mut u32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
 fn GetCurrentProcessId() -> u32;
 fn GetTickCount() -> u32;
 fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
 fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
 fn CloseHandle(handle: Handle) -> i32;
 fn QueryFullProcessImageNameW(process: Handle, flags: u32, name: *mut u16, size: *mut u32) -> i32;
 fn GetProcessTimes(process: Handle, created: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
 fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
 fn GetTokenInformation(token: Handle, class: i32, output: *mut c_void, size: u32, needed: *mut u32) -> i32;
}
#[repr(C, align(4))]
struct GuidBytes([u8; 16]);
#[link(name = "ole32")]
unsafe extern "system" { fn CoCreateGuid(guid: *mut GuidBytes) -> i32; }
struct Owned(Handle);
impl Drop for Owned { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
#[derive(Clone)]
struct Window { hwnd: usize, pid: u32, created: FileTime, app: String, expires: Instant, runtime_id: Option<Vec<i32>> }
#[derive(Clone)]
struct Snapshot { id: String, created: Instant, signature: String, action_window: Value, evidence: HashMap<Vec<i32>, String>, bindings: HashMap<String, Vec<i32>>, frame: Option<(String,i32,i32)>, bounds: Rect }
#[derive(Default)]
pub(crate) struct State { guard_path: Option<String>, guard: Option<crate::input::Guard>, owner: u32, candidates: HashMap<String, Window>, targets: HashMap<String, Window>, snapshots: HashMap<String, Snapshot>, actions: HashSet<String> }
type Result<T> = std::result::Result<T, &'static str>;
// Only our fixed diagnostic vocabulary may leave the native boundary.
fn uia_error(error: agent_desktop_core::AdapterError) -> &'static str {
 match error.message.as_str() {
  "uia_verification_failed" => "uia_verification_failed",
  "uia_client_init" => "uia_client_init",
  "uia_tree_navigation" => "uia_tree_navigation",
  "uia_root_unavailable" => "uia_root_unavailable",
  "uia_identity_unavailable" => "uia_identity_unavailable",
  "uia_deadline" => "uia_deadline",
  "uia_budget" => "uia_budget",
  "uia_process_unavailable" => "uia_process_unavailable",
  "uia_process_mismatch" => "uia_process_mismatch",
  "uia_root_protected_or_unknown" => "uia_root_protected_or_unknown",
  "uia_geometry" => "uia_geometry",
  "uia_state_unavailable" => "uia_state_unavailable",
  "uia_value_read" => "uia_value_read",
  "uia_text_read" => "uia_text_read",
  "uia_password_recheck" => "uia_password_recheck",
  _ => "uia_verification_failed",
 }
}
fn error_body(code: &'static str) -> Value {
 match code {
  "uia_verification_failed" => json!({"error":{"code":"observation_failed","reason":"uia_verification_failed"}}),
  "uia_client_init" => json!({"error":{"code":"observation_failed","reason":"uia_client_init"}}),
  "uia_tree_navigation" => json!({"error":{"code":"observation_failed","reason":"uia_tree_navigation"}}),
  "uia_root_unavailable" => json!({"error":{"code":"observation_failed","reason":"uia_root_unavailable"}}),
  "uia_identity_unavailable" => json!({"error":{"code":"observation_failed","reason":"uia_identity_unavailable"}}),
  "uia_deadline" => json!({"error":{"code":"observation_failed","reason":"uia_deadline"}}),
  "uia_budget" => json!({"error":{"code":"observation_failed","reason":"uia_budget"}}),
  "uia_process_unavailable" => json!({"error":{"code":"observation_failed","reason":"uia_process_unavailable"}}),
  "uia_process_mismatch" => json!({"error":{"code":"observation_failed","reason":"uia_process_mismatch"}}),
  "uia_root_protected_or_unknown" => json!({"error":{"code":"observation_failed","reason":"uia_root_protected_or_unknown"}}),
  "uia_geometry" => json!({"error":{"code":"observation_failed","reason":"uia_geometry"}}),
  "uia_state_unavailable" => json!({"error":{"code":"observation_failed","reason":"uia_state_unavailable"}}),
  "uia_value_read" => json!({"error":{"code":"observation_failed","reason":"uia_value_read"}}),
  "uia_text_read" => json!({"error":{"code":"observation_failed","reason":"uia_text_read"}}),
  "uia_password_recheck" => json!({"error":{"code":"observation_failed","reason":"uia_password_recheck"}}),
  "desktop_session" | "desktop_open" | "desktop_name" | "desktop_not_default" => json!({"error":{"code":"desktop_unavailable","reason":code}}),
  _ => json!({"error":{"code":code}}),
 }
}
fn desktop() -> Result<()> {
 unsafe {
  let mut session = 0;
  if ProcessIdToSessionId(GetCurrentProcessId(), &mut session) == 0 || session == 0 { return Err("desktop_session"); }
  let handle = OpenInputDesktop(0, 0, 1);
  if handle.is_null() { return Err("desktop_open"); }
  let mut name = [0u16; 256]; let mut needed = 0;
  let ok = GetUserObjectInformationW(handle, 2, name.as_mut_ptr().cast(), 512, &mut needed);
  CloseDesktop(handle);
  let length = name.iter().position(|v| *v == 0).unwrap_or(name.len());
  if ok == 0 { return Err("desktop_name"); }
  if !String::from_utf16_lossy(&name[..length]).eq_ignore_ascii_case("Default") { return Err("desktop_not_default"); }
 }
 Ok(())
}
fn process(pid: u32, owner: u32) -> Result<(FileTime, String)> {
 unsafe {
  let current = GetCurrentProcessId(); let (mut ours, mut theirs) = (0, 0);
  if pid == current || pid == owner || ProcessIdToSessionId(current, &mut ours) == 0 || ProcessIdToSessionId(pid, &mut theirs) == 0 || ours != theirs { return Err("protected_target"); }
  let handle = Owned(OpenProcess(0x1000, 0, pid)); if handle.0.is_null() { return Err("protected_target"); }
  let mut path = [0u16; 32768]; let mut size = path.len() as u32;
  if QueryFullProcessImageNameW(handle.0, 0, path.as_mut_ptr(), &mut size) == 0 { return Err("protected_target"); }
  let path = String::from_utf16_lossy(&path[..size as usize]).to_lowercase();
  let app = path.rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_owned();
  if ["shadow", "electron", "node", "chrome", "msedge", "brave", "firefox", "opera", "vivaldi", "iexplore", "applicationframehost"].contains(&app.as_str()) { return Err("protected_target"); }
  let mut token = std::ptr::null_mut(); if OpenProcessToken(handle.0, 8, &mut token) == 0 { return Err("protected_target"); }
  let token = Owned(token); let (mut elevated, mut needed) = (0u32, 0u32);
  if GetTokenInformation(token.0, 20, (&mut elevated as *mut u32).cast(), 4, &mut needed) == 0 || elevated != 0 { return Err("protected_target"); }
  let (mut created, mut exit, mut kernel, mut user) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
  if GetProcessTimes(handle.0, &mut created, &mut exit, &mut kernel, &mut user) == 0 { return Err("protected_target"); }
  if created == FileTime::default() { return Err("protected_target"); }
  Ok((created, app))
 }
}
fn validate(window: &Window, owner: u32) -> Result<()> {
 desktop()?;
 unsafe {
  let mut pid = 0;
  if IsWindow(window.hwnd as Handle) == 0 || IsWindowVisible(window.hwnd as Handle) == 0 || GetWindowThreadProcessId(window.hwnd as Handle, &mut pid) == 0 || pid != window.pid { return Err("window_unavailable"); }
 }
 let (created, app) = process(window.pid, owner)?;
 if created != window.created || app != window.app { return Err("window_unavailable"); }
 Ok(())
}
pub(crate) fn uuid() -> Result<String> {
 let mut guid = GuidBytes([0u8; 16]); if unsafe { CoCreateGuid(&mut guid) } < 0 { return Err("unavailable"); }
 let bytes = guid.0;
 let a = u32::from_le_bytes(bytes[0..4].try_into().map_err(|_| "unavailable")?);
 let b = u16::from_le_bytes([bytes[4], bytes[5]]); let c = u16::from_le_bytes([bytes[6], bytes[7]]);
 Ok(format!("{a:08x}-{b:04x}-{c:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
}
fn describe(id: &str, window: &Window, owner: u32, bounds: bool) -> Result<Value> {
 validate(window, owner)?;
 let mut title = [0u16; 513]; let length = unsafe { GetWindowTextW(window.hwnd as Handle, title.as_mut_ptr(), title.len() as i32) };
 if length < 0 { return Err("window_unavailable"); }
 let mut value = json!({"id":id,"title":String::from_utf16_lossy(&title[..length as usize]),"app":window.app,"pid":window.pid});
 if bounds {
  let mut rect = Rect::default(); if unsafe { GetWindowRect(window.hwnd as Handle, &mut rect) } == 0 { return Err("window_unavailable"); }
  value["bounds"] = json!({"x":rect.left,"y":rect.top,"width":rect.right.saturating_sub(rect.left).max(0),"height":rect.bottom.saturating_sub(rect.top).max(0)});
 }
 validate(window, owner)?; Ok(value)
}
struct Census<'a> { state: &'a mut State, windows: Vec<Value>, excluded: u32, pid: u32, failed: bool }
unsafe extern "system" fn enumerate(hwnd: Handle, data: isize) -> i32 {
 let census = unsafe { &mut *(data as *mut Census<'_>) };
 let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
  let mut pid = 0;
  if unsafe { GetWindowThreadProcessId(hwnd, &mut pid) } == 0 || unsafe { IsWindowVisible(hwnd) } == 0 || (census.pid != 0 && census.pid != pid) { return; }
  if census.windows.len() >= 256 { census.excluded += 1; return; }
  let result = (|| {
   let (created, app) = process(pid, census.state.owner)?;
   let window = Window { hwnd: hwnd as usize, pid, created, app, expires: Instant::now() + Duration::from_secs(30), runtime_id: None };
   let id = uuid()?; let value = describe(&id, &window, census.state.owner, false)?;
   if value["title"].as_str().unwrap_or("").trim().is_empty() { return Ok(()); }
   census.state.candidates.insert(id, window); census.windows.push(value); Ok::<(), &'static str>(())
  })();
  if result.is_err() { census.excluded += 1; }
 }));
 if outcome.is_err() { census.failed = true; 0 } else { 1 }
}
pub fn dispatch(input: Value, adapter: &agent_desktop_windows::WindowsAdapter, state: &mut State) -> Value {
 match execute(input, adapter, state) { Ok(value) => json!({"result":value}), Err(code) => error_body(code) }
}
fn execute(input: Value, adapter: &agent_desktop_windows::WindowsAdapter, state: &mut State) -> Result<Value> {
 let method = input["method"].as_str().ok_or("unsupported_action")?;
 if !["list", "bind", "release", "observe", "act"].contains(&method) { return Err("unsupported_action"); }
 let owner = input["ownerPid"].as_u64().and_then(|v| u32::try_from(v).ok()).filter(|v| *v > 0).ok_or("protected_target")?;
 const GUARD_NAME: &str = "shadow-input-guard.exe";
 let path=input["guardPath"].as_str().filter(|p|std::path::Path::new(p).is_absolute() && std::path::Path::new(p).file_name().and_then(|s|s.to_str())==Some(GUARD_NAME)).ok_or("invalid_request")?;
 if state.guard_path.as_deref().is_some_and(|p|p!=path) { return Err("protected_target"); }
 if state.guard_path.is_none() { state.guard_path=Some(path.to_owned()); }
 if state.owner == 0 { state.owner = owner; }
 if state.owner != owner { return Err("protected_target"); }
 if method == "release" {
  let id = input["targetId"].as_str().ok_or("window_unavailable")?;
  state.targets.remove(id); state.snapshots.remove(id); return Ok(json!({"released":true}));
 }
 desktop()?;
 match method {
  "list" => {
   let pid = match input.get("processId") { None => 0, Some(v) => v.as_u64().and_then(|v| u32::try_from(v).ok()).ok_or("unsupported_action")? };
   state.candidates.clear();
   let mut census = Census { state, windows: Vec::new(), excluded: 0, pid, failed: false };
   let ok = unsafe { EnumWindows(enumerate, (&mut census as *mut Census<'_>) as isize) };
   if ok == 0 || census.failed { census.state.candidates.clear(); return Err("unavailable"); }
   desktop()?; Ok(json!({"windows":census.windows,"excluded":census.excluded}))
  }
  "bind" => {
   let id = input["windowId"].as_str().ok_or("window_unavailable")?;
   let mut window = state.candidates.get(id).cloned().ok_or("window_unavailable")?;
   if window.expires < Instant::now() || state.targets.len() >= 32 { return Err("window_unavailable"); }
   validate(&window, owner)?;
   window.runtime_id = Some(adapter.shadow_root_identity(window.hwnd as isize, window.pid).map_err(uia_error)?);
   let target = uuid()?; let description = describe(&target, &window, owner, true)?;
   if Some(adapter.shadow_root_identity(window.hwnd as isize, window.pid).map_err(uia_error)?) != window.runtime_id { return Err("window_unavailable"); }
   state.candidates.remove(id); state.targets.insert(target, window); Ok(description)
  }
  "observe" => {
   let id = input["targetId"].as_str().ok_or("window_unavailable")?;
   observe(id, input["screenshot"].as_bool().unwrap_or(false), adapter, state)
  }
  "act" => {
   let id = input["targetId"].as_str().ok_or("window_unavailable")?;
   let previous = state.snapshots.remove(id).ok_or("stale_observation")?;
   let action_id = input["actionId"].as_str().filter(|s| valid_uuid(s)).ok_or("invalid_request")?;
   if state.actions.len() >= 10000 || !state.actions.insert(action_id.to_owned()) { return Err("stale_observation"); }
   if previous.id != input["observationId"] || previous.created.elapsed() > Duration::from_secs(120) { return Err("stale_observation"); }
   let action = &input["action"];
   validate_action(action)?;
   let pointer=is_pointer(action);
   if is_foreground(action) {
    let window=state.targets.get(id).cloned().ok_or("window_unavailable")?;
    wait_for_quiet(window.hwnd)?;
    observe(id,pointer,adapter,state)?;
    let current=state.snapshots.remove(id).ok_or("stale_observation")?;
    if previous.signature!=current.signature || pointer && (previous.frame.is_none() || previous.frame!=current.frame) { return Err("stale_observation"); }
    let mut started=false;
    let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| foreground_act(id,&window,&previous,&current,action_id,action,adapter,state,&mut started)));
    return action_outcome(started,outcome);
   }
   let element_id = action["elementId"].as_str().ok_or("invalid_request")?;
   let runtime = previous.bindings.get(element_id).ok_or("stale_observation")?;
   wait_for_quiet(state.targets.get(id).ok_or("window_unavailable")?.hwnd)?;
   observe(id, false, adapter, state)?;
   let current = state.snapshots.remove(id).ok_or("stale_observation")?;
   if !pattern_matches(&previous, &current, runtime) { return Err("stale_observation"); }
   let window = state.targets.get(id).cloned().ok_or("window_unavailable")?;
   validate(&window, owner)?;
   let mut started = false;
   let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    let verified = adapter.shadow_action(window.hwnd as isize, window.pid, window.runtime_id.as_deref().ok_or("window_unavailable")?, runtime, action, &mut started, &crate::input::is_cancelled).map_err(|_| if crate::input::is_cancelled() { "user_interrupted" } else { "unsupported_action" })?;
    if crate::input::is_cancelled() { return Err("user_interrupted"); }
    let observation = observe(id, false, adapter, state)?;
    if crate::input::is_cancelled() { return Err("user_interrupted"); }
    Ok::<Value, &'static str>(json!({"actionId":action_id,"outcome":"executed","verified":verified,"observation":observation}))
   }));
   action_outcome(started, outcome)
  }
  _ => Err("unsupported_action")
 }
}
fn truncated(node: &agent_desktop_core::AccessibilityNode) -> bool {
 node.subtree_truncated || node.children.iter().any(truncated)
}
fn flatten(node: &agent_desktop_core::AccessibilityNode, parent: Option<String>, output: &mut Vec<Value>, bindings: &mut HashMap<String, Vec<i32>>) {
 if node.presentation.states.iter().any(|s|s=="protected") { return; }
 let id = output.len().to_string(); let states = &node.presentation.states;
 if let Some(raw) = &node.identity.retained_object {
  if let Ok(metadata) = serde_json::from_str::<Value>(raw) {
   if let Ok(runtime) = serde_json::from_value::<Vec<i32>>(metadata["runtime"].clone()) { bindings.insert(id.clone(), runtime); }
  }
 }
 let mut value = json!({"id":id,"parentId":parent,"role":format!("ControlType.{}",node.role),"name":node.identity.name.as_deref().unwrap_or(""),"protected":false,"enabled":states.iter().any(|s|s=="enabled"),"offscreen":states.iter().any(|s|s=="offscreen"),"focusable":states.iter().any(|s|s=="focusable"),"actions":node.presentation.available_actions,"bounds":node.presentation.bounds});
 if let Some(text) = &node.identity.value { value["value"] = json!(text); }
 for state in states {
  if let Some(toggle) = state.strip_prefix("toggle:") { value["toggleState"] = json!(match toggle { "Off" => 0, "On" => 1, _ => 2 }); }
  if let Some(selected) = state.strip_prefix("selected:") { value["selected"] = json!(selected == "true"); }
 }
 output.push(value);
 for child in &node.children { flatten(child, Some(id.clone()), output, bindings); }
}
// Compare only the selected control, not its descendants or traversal-budget
// metadata. Full hidden name/value fingerprints and every safety property remain
// part of the evidence. Runtime lookup survives unrelated sibling insertion.
fn action_evidence(node: &agent_desktop_core::AccessibilityNode, output: &mut HashMap<Vec<i32>, String>) {
 if node.presentation.states.iter().any(|s| s == "protected") { return; }
 if let Some(raw) = &node.identity.retained_object {
  if let Ok(metadata) = serde_json::from_str::<Value>(raw) {
   if let Ok(runtime) = serde_json::from_value::<Vec<i32>>(metadata["runtime"].clone()) {
    let mut own = node.clone();
    own.children.clear(); own.children_count = None; own.subtree_truncated = false;
    output.insert(runtime, format!("{:?}", own));
   }
  }
 }
 for child in &node.children { action_evidence(child, output); }
}
fn pattern_matches(previous: &Snapshot, current: &Snapshot, runtime: &[i32]) -> bool {
 previous.action_window == current.action_window &&
 previous.evidence.get(runtime).is_some_and(|e| current.evidence.get(runtime) == Some(e))
}
fn observe(id: &str, screenshot: bool, adapter: &agent_desktop_windows::WindowsAdapter, state: &mut State) -> Result<Value> {
 state.snapshots.remove(id);
 let window = state.targets.get(id).cloned().ok_or("window_unavailable")?;
 validate(&window, state.owner)?;
 if unsafe { IsIconic(window.hwnd as Handle) } != 0 { return Err("window_unavailable"); }
 let description = describe(id, &window, state.owner, true)?;
 let deadline = agent_desktop_core::Deadline::after(5000).map_err(|_| "uia_deadline")?;
 let root = window.runtime_id.as_deref().ok_or("window_unavailable")?;
 let tree = adapter.shadow_observe_window(window.hwnd as isize, window.pid, root, deadline).map_err(uia_error)?;
 let mut elements = Vec::new(); let mut bindings = HashMap::new(); flatten(&tree, None, &mut elements, &mut bindings);
 let observation_id = uuid()?;
 let mut data = json!({"id":observation_id,"targetId":id,"title":description["title"],"bounds":description["bounds"],"elements":elements,"truncated":truncated(&tree)});
 if screenshot { data["screenshot"] = capture(&window, &description, adapter)?; }
 validate(&window, state.owner)?;
 if describe(id, &window, state.owner, true)? != description || adapter.shadow_root_identity(window.hwnd as isize, window.pid).map_err(uia_error)? != root { return Err("stale_observation"); }
 let frame=if screenshot { use sha2::{Digest,Sha256}; let shot=&data["screenshot"]; Some((format!("{:x}",Sha256::digest(shot["base64"].as_str().ok_or("capture_failed")?.as_bytes())),shot["width"].as_i64().ok_or("capture_failed")? as i32,shot["height"].as_i64().ok_or("capture_failed")? as i32)) } else { None };
 let b=&description["bounds"];
 let left=i32::try_from(b["x"].as_i64().ok_or("capture_failed")?).map_err(|_|"capture_failed")?;
 let top=i32::try_from(b["y"].as_i64().ok_or("capture_failed")?).map_err(|_|"capture_failed")?;
 let bounds=Rect { left,top,right:left.checked_add(b["width"].as_i64().ok_or("capture_failed")? as i32).ok_or("capture_failed")?,bottom:top.checked_add(b["height"].as_i64().ok_or("capture_failed")? as i32).ok_or("capture_failed")? };
 // Debug includes bounded metadata: SHA-256/length fingerprints and runtime IDs, never wire-visible.
 let signature = format!("{}|{:?}", description, tree);
 let mut evidence = HashMap::new(); action_evidence(&tree, &mut evidence);
 state.snapshots.insert(id.to_owned(), Snapshot { id: observation_id, created: Instant::now(), signature, action_window: description, evidence, bindings,frame,bounds });
 Ok(data)
}
fn valid_uuid(value: &str) -> bool {
 value.len() == 36 && value.bytes().enumerate().all(|(i,b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
#[link(name="dwmapi")]
unsafe extern "system" { fn DwmGetWindowAttribute(hwnd:Handle,attribute:u32,rect:*mut Rect,size:u32)->i32; }
fn frame_offset(x:i32,y:i32,width:i32,height:i32,frame:&Rect,image_width:u32,image_height:u32)->Result<(i32,i32)> {
 let dx=i64::from(frame.left)-i64::from(x); let dy=i64::from(frame.top)-i64::from(y);
 let w=i64::from(frame.right)-i64::from(frame.left); let h=i64::from(frame.bottom)-i64::from(frame.top);
 if dx<0 || dy<0 || w<=0 || h<=0 || w!=i64::from(image_width) || h!=i64::from(image_height)
  || dx+w>i64::from(width) || dy+h>i64::from(height) { return Err("capture_failed"); }
 Ok((dx as i32,dy as i32))
}
fn capture(window: &Window, description: &Value, adapter: &agent_desktop_windows::WindowsAdapter) -> Result<Value> {
 use agent_desktop_core::{SystemOps, ScreenshotTarget, WindowInfo, WindowState};
 use base64::Engine;
 let deadline = agent_desktop_core::Deadline::after(5000).map_err(|_| "capture_failed")?;
 let ticks = (u64::from(window.created.high) << 32) | u64::from(window.created.low);
 if ticks == 0 { return Err("window_unavailable"); }
 let width = description["bounds"]["width"].as_i64().ok_or("capture_failed")?;
 let height = description["bounds"]["height"].as_i64().ok_or("capture_failed")?;
 if width <= 0 || height <= 0 || width > 8192 || height > 8192 || width*height > 16_000_000 { return Err("capture_failed"); }
 let info = WindowInfo { id: format!("w-{}",window.hwnd), title: description["title"].as_str().unwrap_or("").into(), app: window.app.clone(), pid: window.pid.into(), process_instance: Some(format!("windows-proc-v1:{}:{}",ticks/10_000_000,ticks%10_000_000)), bounds: None, state: WindowState::default() };
 let captured = adapter.screenshot(ScreenshotTarget::ExactWindow(info), deadline).map_err(|_| "capture_failed")?;
 if deadline.is_expired() { return Err("capture_failed"); }
 let decoded = image::load_from_memory_with_format(&captured.data, image::ImageFormat::Png).map_err(|_| "capture_failed")?;
 // WGC can omit invisible resize margins (DWM extended frame); PrintWindow
 // uses GetWindowRect. Normalize both to the exact outer-bound coordinate space.
 let outer=Rect { left:description["bounds"]["x"].as_i64().ok_or("capture_failed")? as i32, top:description["bounds"]["y"].as_i64().ok_or("capture_failed")? as i32, right:0,bottom:0 };
 let decoded=if decoded.width()==width as u32 && decoded.height()==height as u32 { decoded } else {
  let mut frame=Rect::default();
  if unsafe { DwmGetWindowAttribute(window.hwnd as Handle,9,&mut frame,std::mem::size_of::<Rect>() as u32) }<0 { return Err("capture_failed"); }
  let offset=frame_offset(outer.left,outer.top,width as i32,height as i32,&frame,decoded.width(),decoded.height())?;
  let mut canvas=image::RgbaImage::new(width as u32,height as u32);
  image::imageops::overlay(&mut canvas,&decoded.to_rgba8(),i64::from(offset.0),i64::from(offset.1));
  image::DynamicImage::ImageRgba8(canvas)
 };
 let scaled = decoded.thumbnail(1600,1600);
 let (width,height) = (scaled.width(),scaled.height());
 let mut bytes = std::io::Cursor::new(Vec::new());
 scaled.write_to(&mut bytes, image::ImageFormat::Png).map_err(|_| "capture_failed")?;
 let base64 = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
 if base64.len() > 4*1024*1024 { return Err("capture_failed"); }
 if deadline.is_expired() { return Err("capture_failed"); }
 Ok(json!({"mime":"image/png","base64":base64,"width":width,"height":height}))
}

#[cfg(test)]
mod pure_tests {
 use super::*;
 #[test] fn uuid_validation_rejects_non_wire_ids() {
  assert!(valid_uuid("12345678-1234-1234-1234-123456789abc"));
  for invalid in ["", "0", "12345678123412341234123456789abc", "12345678-1234-1234-1234-123456789abz"] { assert!(!valid_uuid(invalid)); }
 }
 #[test] fn runtime_bindings_are_snapshot_local_and_secret_nodes_pruned() {
  let mut node = agent_desktop_core::AccessibilityNode { ref_id: None, role: "Edit".into(), identity: Default::default(), presentation: Default::default(), children_count: None, subtree_truncated: false, children: vec![] };
  node.identity.retained_object = Some(json!({"runtime":[42,1],"rawValue":"private signature tail"}).to_string());
  node.identity.value = Some("visible".into());
  let mut output = Vec::new(); let mut bindings = HashMap::new();
  flatten(&node,None,&mut output,&mut bindings);
  assert_eq!(bindings["0"],vec![42,1]);
  assert_eq!(output[0]["value"],"visible");
  assert_eq!(output[0]["role"],"ControlType.Edit");
  assert!(!output[0].to_string().contains("private signature tail"));
  node.presentation.states.push("protected".into());
  flatten(&node,None,&mut output,&mut bindings);
  assert_eq!(output.len(),1);
 }
 #[test] fn hidden_raw_content_participates_in_signature() {
  let mut node = agent_desktop_core::AccessibilityNode { ref_id: None, role: "Edit".into(), identity: Default::default(), presentation: Default::default(), children_count: None, subtree_truncated: false, children: vec![] };
  node.identity.name = Some("same truncated prefix".into());
  node.identity.retained_object = Some("tail-a".into()); let a = format!("{:?}",node);
  node.identity.retained_object = Some("tail-b".into()); assert_ne!(a,format!("{:?}",node));
 }
 #[test] fn process_generation_keeps_subsecond_ticks() {
  let ticks = (u64::from(0x12345678u32)<<32)|u64::from(0x87654321u32);
  let seconds=ticks/10_000_000; let subtick=ticks%10_000_000;
  assert_eq!(seconds*10_000_000+subtick,ticks);
  assert_ne!(format!("windows-proc-v1:{seconds}:{subtick}"),format!("windows-proc-v1:{seconds}:{}",subtick+1));
 }
}

fn action_outcome(started: bool, outcome: std::thread::Result<Result<Value>>) -> Result<Value> {
 match outcome { Ok(Ok(value)) => Ok(value), _ if started => Err("outcome_unknown"), Ok(Err(e)) => Err(e), Err(_) => Err("unavailable") }
}
#[cfg(test)]
mod effect_tests {
 use super::*;
 #[test] fn all_post_dispatch_errors_and_panics_are_unknown() {
  for code in ["unsupported_action","stale_observation","window_unavailable","unavailable"] {
   assert_eq!(action_outcome(true,Ok(Err(code))).unwrap_err(),"outcome_unknown");
   assert_eq!(action_outcome(false,Ok(Err(code))).unwrap_err(),code);
  }
  assert_eq!(action_outcome(true,Err(Box::new("synthetic panic"))).unwrap_err(),"outcome_unknown");
  assert_eq!(action_outcome(false,Err(Box::new("synthetic panic"))).unwrap_err(),"unavailable");
 }
 #[test] fn snapshot_consumption_and_action_replay_guard_are_one_use() {
  let mut state = State::default();
  state.snapshots.insert("target".into(),Snapshot { id:"observation".into(),created:Instant::now(),signature:"same".into(),action_window:json!({}),evidence:HashMap::new(),bindings:HashMap::new(),frame:None,bounds:Rect::default() });
  assert!(state.snapshots.remove("target").is_some());
  assert!(state.snapshots.remove("target").is_none());
  assert!(state.actions.insert("action".into()));
  assert!(!state.actions.insert("action".into()));
 }
}
fn validate_action(action: &Value) -> Result<()> {
 let map = action.as_object().ok_or("invalid_request")?;
 let kind = action["kind"].as_str().ok_or("invalid_request")?;
 if is_foreground(action) { return validate_foreground(action); }
 let id = action["elementId"].as_str().filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).ok_or("invalid_request")?;
 if id.len() > 3 { return Err("invalid_request"); }
 let keys: &[&str] = match kind {
  "invoke" | "toggle" | "select" => &["kind","elementId"],
  "set_value" => {
   let value=action["value"].as_str().ok_or("invalid_request")?;
   if value.encode_utf16().count()>4000 || value.contains('\0') { return Err("invalid_request"); }
   &["kind","elementId","value"]
  },
  "scroll" => {
   if !matches!(action["direction"].as_str(),Some("up"|"down"|"left"|"right")) { return Err("invalid_request"); }
   &["kind","elementId","direction"]
  },
  _ => return Err("unsupported_action")
 };
 if map.len()!=keys.len() || map.keys().any(|k| !keys.contains(&k.as_str())) { return Err("invalid_request"); }
 Ok(())
}
#[cfg(test)]
mod action_wire_tests {
 use super::*;
 #[test] fn only_existing_single_pattern_wire_is_accepted() {
  for kind in ["invoke","toggle","select"] { assert!(validate_action(&json!({"kind":kind,"elementId":"0"})).is_ok()); }
  assert!(validate_action(&json!({"kind":"scroll","elementId":"0","direction":"down"})).is_ok());
  for invalid in [json!({"kind":"click","elementId":"0"}),json!({"kind":"invoke","elementId":"0","fallback":true}),json!({"kind":"invoke","elementId":"w-42"}),json!({"kind":"scroll","elementId":"0","direction":"any"})] { assert!(validate_action(&invalid).is_err()); }
 }
 #[test] fn set_value_counts_utf16_and_rejects_nul() {
  assert!(validate_action(&json!({"kind":"set_value","elementId":"0","value":"😀".repeat(2000)})).is_ok());
  assert!(validate_action(&json!({"kind":"set_value","elementId":"0","value":"😀".repeat(2001)})).is_err());
  assert!(validate_action(&json!({"kind":"set_value","elementId":"0","value":"a\0b"})).is_err());
 }
}
#[repr(C)]
struct LastInput { size: u32, time: u32 }
fn wait_for_quiet(hwnd: usize) -> Result<()> {
 for _ in 0..20 {
  let foreground = unsafe { GetForegroundWindow() } as usize == hwnd;
  if !foreground { return Ok(()); }
  let mut info = LastInput { size: std::mem::size_of::<LastInput>() as u32, time:0 };
  if unsafe { GetLastInputInfo(&mut info) } == 0 { return Err("unavailable"); }
  if crate::safety_gate::quiet(foreground,Some(unsafe { GetTickCount() }.wrapping_sub(info.time))) { return Ok(()); }
  std::thread::sleep(Duration::from_millis(50));
 }
 Err("stale_observation")
}
fn is_pointer(action:&Value)->bool { matches!(action["kind"].as_str(),Some("click"|"move"|"drag"|"wheel")) }
fn is_foreground(action:&Value)->bool { is_pointer(action)||matches!(action["kind"].as_str(),Some("press_key"|"type_text")) }
fn validate_foreground(action:&Value)->Result<()> {
 let kind=action["kind"].as_str().ok_or("invalid_request")?;
 let map=action.as_object().ok_or("invalid_request")?;
 let keys:&[&str]=match kind {
  "click"=> &["kind","x","y","button","count","modifiers"],
  "move"=> &["kind","x","y"],
  "drag"=> &["kind","x","y","toX","toY","durationMs","modifiers"],
  "wheel"=> &["kind","x","y","axis","steps","modifiers"],
  "press_key"=> &["kind","elementId","key","modifiers"],
  "type_text"=> &["kind","elementId","text"], _=>return Err("invalid_request")
 };
 if map.len()!=keys.len() || map.keys().any(|k|!keys.contains(&k.as_str())) { return Err("invalid_request"); }
 if is_pointer(action) { for key in if kind=="drag" { &["x","y","toX","toY"][..] } else { &["x","y"][..] } { integer(action,key,0,1599)?; } }
 else { let id=action["elementId"].as_str().ok_or("invalid_request")?; if id.is_empty() || id.len()>3 || !id.bytes().all(|b|b.is_ascii_digit()) { return Err("invalid_request"); } }
 if !matches!(kind,"move"|"type_text") {
  let modifiers=action["modifiers"].as_array().ok_or("invalid_request")?;
  let mut seen=HashSet::new();
  if modifiers.len()>3 { return Err("invalid_request"); }
  for v in modifiers { let key=v.as_str().ok_or("invalid_request")?; if !matches!(key,"CTRL"|"ALT"|"SHIFT") || !seen.insert(key) { return Err("invalid_request"); } }
 }
 match kind {
  "click"=> { if !matches!(action["button"].as_str(),Some("left"|"right"|"middle")) { return Err("invalid_request"); } integer(action,"count",1,2)?; },
  "drag"=> { integer(action,"durationMs",100,800)?; if action["x"]==action["toX"] && action["y"]==action["toY"] { return Err("invalid_request"); } },
  "wheel"=> { if integer(action,"steps",-10,10)?==0 || !matches!(action["axis"].as_str(),Some("horizontal"|"vertical")) { return Err("invalid_request"); } },
  "press_key"=> {
   let key=action["key"].as_str().ok_or("invalid_request")?;
   let single=key.len()==1 && key.bytes().all(|b|b.is_ascii_uppercase()||b.is_ascii_digit());
   if !single && !["ENTER","TAB","ESCAPE","SPACE","BACKSPACE","DELETE","INSERT","HOME","END","PAGE_UP","PAGE_DOWN","ARROW_UP","ARROW_DOWN","ARROW_LEFT","ARROW_RIGHT","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"].contains(&key) { return Err("invalid_request"); }
   let m=action["modifiers"].as_array().ok_or("invalid_request")?; let alt=m.contains(&json!("ALT")); let ctrl=m.contains(&json!("CTRL"));
   if alt && ["TAB","ESCAPE","SPACE","F6"].contains(&key) || ctrl && key=="ESCAPE" || ctrl && alt && key=="DELETE" { return Err("unsupported_shortcut"); }
  },
  "type_text"=> { let text=action["text"].as_str().ok_or("invalid_request")?; if text.is_empty() || text.encode_utf16().count()>1000 || text.chars().any(|c|c.is_control()||matches!(c,'\u{2028}'|'\u{2029}')) { return Err("invalid_request"); } }, _=>{}
 }
 Ok(())
}
fn integer(action:&Value,key:&str,min:i64,max:i64)->Result<i64> { action[key].as_i64().filter(|v|*v>=min && *v<=max).ok_or("invalid_request") }
fn map_point(snapshot:&Snapshot,action:&Value,x:&str,y:&str)->Result<(i32,i32)> {
 let (_,width,height)=snapshot.frame.as_ref().ok_or("stale_observation")?;
 let x=integer(action,x,0,i64::from(*width)-1)?; let y=integer(action,y,0,i64::from(*height)-1)?;
 let b=snapshot.bounds;
 if *width<=0 || *height<=0 || b.right<=b.left || b.bottom<=b.top { return Err("invalid_request"); }
 Ok((b.left+(((x as f64+0.5)*f64::from(b.right-b.left)/f64::from(*width)).floor() as i32),b.top+(((y as f64+0.5)*f64::from(b.bottom-b.top)/f64::from(*height)).floor() as i32)))
}
fn dotnet_ticks(time:FileTime)->Result<String> { let ticks=(u64::from(time.high)<<32)|u64::from(time.low); ticks.checked_add(504911232000000000).filter(|v|*v<=i64::MAX as u64).map(|v|v.to_string()).ok_or("window_unavailable") }
#[repr(C)] struct Point { x:i32,y:i32 }
#[repr(C)] struct GuiThread { size:u32,flags:u32,active:Handle,focus:Handle,capture:Handle,menu_owner:Handle,move_size:Handle,caret:Handle,rect:Rect }
#[link(name="user32")]
unsafe extern "system" {
 fn GetGUIThreadInfo(thread:u32,info:*mut GuiThread)->i32;
 fn GetAncestor(hwnd:Handle,kind:u32)->Handle;
 fn SendMessageTimeoutW(hwnd:Handle,message:u32,wparam:usize,lparam:isize,flags:u32,timeout:u32,result:*mut usize)->isize;
 fn WindowFromPoint(point:Point)->Handle;
}
fn allowed_hit(hit:i32)->bool { matches!(hit,1|2|4|6..=18|20) }
fn input_point(window:&Window,point:(i32,i32))->Result<()> {
 let mut bounds=Rect::default();
 unsafe {
  if GetWindowRect(window.hwnd as Handle,&mut bounds)==0 { return Err("window_unavailable"); }
  if point.0<bounds.left || point.0>=bounds.right || point.1<bounds.top || point.1>=bounds.bottom
   || i16::try_from(point.0).is_err() || i16::try_from(point.1).is_err()
   || GetAncestor(WindowFromPoint(Point{x:point.0,y:point.1}),2) as usize!=window.hwnd { return Err("input_outside_window"); }
  let packed=((point.1 as u32 & 0xffff)<<16)|(point.0 as u32 & 0xffff);
  let mut hit=0usize;
  if SendMessageTimeoutW(window.hwnd as Handle,0x84,0,packed as i32 as isize,0x22,200,&mut hit)==0 { return Err("window_unavailable"); }
  if !allowed_hit(hit as i32) || GetAncestor(WindowFromPoint(Point{x:point.0,y:point.1}),2) as usize!=window.hwnd { return Err("input_outside_window"); }
 } Ok(())
}
fn focus(window:&Window)->Result<String> {
 let mut info:GuiThread=unsafe { std::mem::zeroed() }; info.size=std::mem::size_of::<GuiThread>() as u32; let mut pid=0;
 unsafe { let thread=GetWindowThreadProcessId(window.hwnd as Handle,&mut pid); if thread==0 || pid!=window.pid || GetGUIThreadInfo(thread,&mut info)==0 || info.focus.is_null() || GetAncestor(info.focus,2) as usize!=window.hwnd { return Err("keyboard_focus_changed"); } }
 Ok((info.focus as isize).to_string())
}
#[allow(clippy::too_many_arguments)]
fn foreground_act(id:&str,window:&Window,previous:&Snapshot,current:&Snapshot,action_id:&str,action:&Value,adapter:&agent_desktop_windows::WindowsAdapter,state:&mut State,started:&mut bool)->Result<Value> {
 let pointer=is_pointer(action); let kind=action["kind"].as_str().ok_or("invalid_request")?;
 let root=window.runtime_id.as_deref().ok_or("window_unavailable")?;
 let runtime=if pointer { None } else { let element=action["elementId"].as_str().ok_or("invalid_request")?; let runtime=previous.bindings.get(element).ok_or("stale_observation")?; if current.bindings.get(element)!=Some(runtime) { return Err("stale_observation"); } Some(runtime.as_slice()) };
 let start=if pointer { map_point(previous,action,"x","y")? } else { (0,0) };
 let end=if kind=="drag" { map_point(previous,action,"toX","toY")? } else { start };
 let helper=|mode,point| adapter.shadow_foreground(window.hwnd as isize,window.pid,root,runtime,kind=="type_text",mode,point,&crate::input::is_cancelled).map_err(|_|"protected_target");
 helper(0,start)?; validate(window,state.owner)?;
 let ticks=dotnet_ticks(window.created)?;
 if state.guard.is_none() { state.guard=Some(crate::input::Guard::start(state.guard_path.as_deref().ok_or("input_unavailable")?)?); }
 // Temporarily own guard without holding any global cancellation mutex across UIA/IPC.
 let mut guard=state.guard.take().ok_or("input_unavailable")?;
 let outcome=(|| {
  let b=previous.bounds;
  let begin=guard.request("begin",json!({"handle":(window.hwnd as isize).to_string(),"pid":window.pid,"started":ticks,"bounds":{"left":b.left,"top":b.top,"right":b.right,"bottom":b.bottom}}),started)?;
  let activated=begin["activated"].as_bool().ok_or("input_unavailable")?;
  if begin.as_object().map(|m|m.len())!=Some(1) { return Err("input_unavailable"); }
  ready(&mut guard,"activation",started)?;
  guard.check()?; validate(window,state.owner)?;
  if !pointer || !activated { helper(1,start)?; }
  guard.check()?; validate(window,state.owner)?;
  ready(&mut guard,"check",started)?;
  observe(id,false,adapter,state)?; let focused=state.snapshots.remove(id).ok_or("stale_observation")?;
  if focused.signature!=previous.signature { return Err("stale_observation"); }
  if pointer { input_point(window,start)?; helper(3,start)?; if kind=="drag" { input_point(window,end)?; helper(3,end)?; } } else { helper(2,start)?; }
  let focus=if pointer { "0".to_owned() } else { focus(window)? };
  validate(window,state.owner)?; guard.check()?;
  let result=guard.request("execute",json!({"action":action,"x":start.0,"y":start.1,"toX":end.0,"toY":end.1,"focus":focus}),started)?;
  let restored=result.get("focusRestored").filter(|v|v.is_null()||v.is_boolean()).cloned().ok_or("outcome_unknown")?;
  if result.as_object().map(|m|m.len())!=Some(1) { return Err("outcome_unknown"); }
  guard.check()?;
  let observation=observe(id,false,adapter,state)?;
  guard.check()?;
  Ok(json!({"actionId":action_id,"outcome":"executed","verified":false,"focusRestored":restored,"observation":observation}))
 })();
 if outcome.is_err() { if guard.request("cancel",json!({}),started).and_then(|v|if v==json!({"cancelled":true}) { Ok(()) } else { Err("outcome_unknown") }).is_err() { *started=true; crate::input::cancel(); } }
 if crate::input::is_cancelled() { drop(guard); } else { state.guard=Some(guard); }
 outcome
}
fn ready(guard:&mut crate::input::Guard,method:&str,started:&mut bool)->Result<()> { if guard.request(method,json!({}),started)?!=json!({"ready":true}) { return Err("input_unavailable"); } Ok(()) }

#[cfg(test)] mod foreground_tests {
 use super::*;
 fn snapshot()->Snapshot { Snapshot { id:"one".into(),created:Instant::now(),signature:"signature".into(),action_window:json!({}),evidence:HashMap::new(),bindings:HashMap::new(),frame:Some(("hash".into(),1600,800)),bounds:Rect{left:-200,top:10,right:3000,bottom:1610} } }
 #[test] fn nonclient_hit_codes_are_explicit() {
  for hit in [1,2,4,6,7,8,9,10,11,12,13,14,15,16,17,18,20] { assert!(allowed_hit(hit)); }
  for hit in [-2,-1,0,3,5,19,21,22] { assert!(!allowed_hit(hit)); }
 }
 #[test] fn dwm_capture_is_placed_not_stretched() {
  let frame=Rect{left:-1592,top:-100,right:-8,bottom:692};
  assert_eq!(frame_offset(-1600,-100,1600,800,&frame,1584,792),Ok((8,0)));
  assert!(frame_offset(-1600,-100,1600,800,&frame,1600,800).is_err());
  assert!(frame_offset(-1590,-100,1600,800,&frame,1584,792).is_err());
  assert!(frame_offset(-1600,-100,1500,800,&frame,1584,792).is_err());
 }
 #[test] fn all_six_contract_actions_validate_without_os_calls() {
  let cases=[json!({"kind":"click","x":0,"y":1599,"button":"left","count":2,"modifiers":["CTRL","SHIFT"]}),json!({"kind":"move","x":0,"y":0}),json!({"kind":"drag","x":0,"y":0,"toX":1,"toY":1,"durationMs":300,"modifiers":[]}),json!({"kind":"wheel","x":1,"y":1,"axis":"horizontal","steps":-10,"modifiers":[]}),json!({"kind":"press_key","elementId":"0","key":"F12","modifiers":[]}),json!({"kind":"type_text","elementId":"0","text":"a😀"})];
  for action in cases { assert!(validate_action(&action).is_ok(),"{action}"); let mut extra=action.clone(); extra["fallback"]=json!(true); assert!(validate_action(&extra).is_err()); }
 }
 #[test] fn strict_bounds_modifiers_keys_text_and_shortcuts() {
  for invalid in [json!({"kind":"move","x":-1,"y":0}),json!({"kind":"move","x":1600,"y":0}),json!({"kind":"move","x":0.5,"y":0}),json!({"kind":"press_key","elementId":"0","key":"WIN","modifiers":[]}),json!({"kind":"press_key","elementId":"0","key":"A","modifiers":["CTRL","CTRL"]}),json!({"kind":"press_key","elementId":"0","key":"DELETE","modifiers":["CTRL","ALT"]}),json!({"kind":"press_key","elementId":"0","key":"TAB","modifiers":["ALT"]}),json!({"kind":"wheel","x":0,"y":0,"axis":"vertical","steps":0,"modifiers":[]}),json!({"kind":"drag","x":0,"y":0,"toX":0,"toY":0,"durationMs":300,"modifiers":[]})] { assert!(validate_action(&invalid).is_err(),"{invalid}"); }
  for text in ["".to_owned(),"x\n".into(),"\u{85}".into(),"\u{2028}".into(),"😀".repeat(501)] { assert!(validate_action(&json!({"kind":"type_text","elementId":"0","text":text})).is_err()); }
  assert!(validate_action(&json!({"kind":"type_text","elementId":"0","text":"😀".repeat(500)})).is_ok());
 }
 #[test] fn pixel_center_mapping_matches_inputlease_and_requires_frame() {
  let mut s=snapshot(); assert_eq!(map_point(&s,&json!({"x":0,"y":0}),"x","y").unwrap(),(-199,11));
  assert_eq!(map_point(&s,&json!({"x":1599,"y":799}),"x","y").unwrap(),(2999,1609));
  assert!(map_point(&s,&json!({"x":0,"y":800}),"x","y").is_err());
  s.frame=None; assert!(map_point(&s,&json!({"x":0,"y":0}),"x","y").is_err());
 }
 #[test] fn filetime_conversion_is_checked_and_exact() {
  assert_eq!(dotnet_ticks(FileTime{low:1,high:0}).unwrap(),"504911232000000001");
  assert!(dotnet_ticks(FileTime{low:u32::MAX,high:u32::MAX}).is_err());
 }
 #[test] fn frame_identity_includes_hash_and_dimensions() {
  let a=snapshot(); let mut b=snapshot(); assert!(a.frame==b.frame); b.frame.as_mut().unwrap().0="changed".into(); assert!(a.frame!=b.frame); b=snapshot(); b.frame.as_mut().unwrap().1=1599; assert!(a.frame!=b.frame);
 }
}

#[cfg(test)] mod removed_permission_tests {
 use super::*;
 #[test] fn obsolete_permission_method_is_rejected_without_touching_desktop() {
  let adapter=agent_desktop_windows::WindowsAdapter::new();
  let mut state=State::default();
  assert_eq!(execute(json!({"method":"foreground"}),&adapter,&mut state),Err("unsupported_action"));
  assert!(state.targets.is_empty()); assert!(state.guard.is_none());
 }
}

#[cfg(test)] mod offscreen_signature_tests {
 use super::*;
 #[test] fn nonsecret_offscreen_content_changes_signature_without_actions() {
  let mut node=agent_desktop_core::AccessibilityNode { ref_id:None,role:"Edit".into(),identity:Default::default(),presentation:Default::default(),children_count:None,subtree_truncated:false,children:vec![] };
  node.presentation.states=vec!["enabled".into(),"offscreen".into()];
  node.identity.name=Some("hidden name".into()); node.identity.value=Some("before".into());
  node.identity.retained_object=Some(json!({"runtime":[1],"rawValue":crate::safety_gate::fingerprint("before")}).to_string());
  let before=format!("{:?}",node);
  node.identity.value=Some("after".into()); node.identity.retained_object=Some(json!({"runtime":[1],"rawValue":crate::safety_gate::fingerprint("after")}).to_string());
  assert_ne!(before,format!("{:?}",node));
  assert!(!crate::safety_gate::action_allowed(Some(false),true,true,true));
  assert!(!crate::safety_gate::value_allowed(Some(false),true,true,true,true,Some(false),5));
  let mut output=vec![]; flatten(&node,None,&mut output,&mut HashMap::new());
  assert_eq!(output[0]["value"],"after"); assert_eq!(output[0]["name"],"hidden name"); assert_eq!(output[0]["actions"],json!([]));
 }
}

#[cfg(test)] mod diagnostic_tests {
 use super::*;
 #[test] fn provider_content_is_never_published() {
  let error=agent_desktop_core::AdapterError::new(agent_desktop_core::ErrorCode::Internal,"private title/value");
  assert_eq!(uia_error(error),"uia_verification_failed");
  let error=agent_desktop_core::AdapterError::new(agent_desktop_core::ErrorCode::Internal,"uia_root_protected_or_unknown");
  assert_eq!(error_body(uia_error(error)),json!({"error":{"code":"observation_failed","reason":"uia_root_protected_or_unknown"}}));
  assert_eq!(error_body("desktop_open"),json!({"error":{"code":"desktop_unavailable","reason":"desktop_open"}}));
  assert_eq!(error_body("capture_failed"),json!({"error":{"code":"capture_failed"}}));
 }
}

#[cfg(test)]
mod truncated_binding_tests {
 use super::*;
 #[test] fn omitted_target_has_no_binding_and_cannot_survive_action_revalidation() {
  fn node(runtime: i32) -> agent_desktop_core::AccessibilityNode {
   let mut n = agent_desktop_core::AccessibilityNode { ref_id: None, role: "Edit".into(), identity: Default::default(), presentation: Default::default(), children_count: None, subtree_truncated: false, children: vec![] };
   n.identity.retained_object = Some(json!({"runtime":[runtime]}).to_string());
   n.presentation.available_actions.push("invoke".into());
   n
  }
  let mut tree = node(1); tree.children.push(node(2)); tree.children.push(node(3));
  let old_signature = format!("{:?}",tree);
  let mut previous = HashMap::new(); flatten(&tree,None,&mut Vec::new(),&mut previous);
  let target = previous.get("2").unwrap();
  // Soft traversal publishes only the first fully verified child.
  tree.children.pop(); tree.subtree_truncated = true;
  let mut current = HashMap::new(); let mut output = Vec::new();
  flatten(&tree,None,&mut output,&mut current);
  assert!(truncated(&tree)); assert_eq!(output.len(),2);
  assert!(!current.contains_key("2"));
  // The omitted control cannot be rebound by its old ordinal or runtime ID.
  assert_ne!(current.get("2"),Some(target));
  assert_ne!(format!("{:?}",tree),old_signature);
  assert_eq!(current.get("2").ok_or("stale_observation"),Err("stale_observation"));
 }
}

#[cfg(test)] mod pattern_evidence_tests {
 use super::*;
 fn node(runtime:i32, name:&str) -> agent_desktop_core::AccessibilityNode {
  let mut n=agent_desktop_core::AccessibilityNode { ref_id:None,role:"Button".into(),identity:Default::default(),presentation:Default::default(),children_count:None,subtree_truncated:false,children:vec![] };
  n.identity.name=Some(name.into());
  n.identity.retained_object=Some(json!({"runtime":[runtime],"rawName":crate::safety_gate::fingerprint(name)}).to_string());
  n.presentation.states=vec!["enabled".into()]; n.presentation.available_actions=vec!["invoke".into()]; n
 }
 fn snapshot(tree:&agent_desktop_core::AccessibilityNode)->Snapshot {
  let mut evidence=HashMap::new(); action_evidence(tree,&mut evidence);
  Snapshot { id:"observation".into(),created:Instant::now(),signature:format!("{:?}",tree),action_window:json!({"pid":7,"bounds":{"x":1}}),evidence,bindings:HashMap::new(),frame:None,bounds:Rect::default() }
 }
 #[test] fn unrelated_timer_siblings_descendants_and_budget_do_not_expire_invoke() {
  let mut tree=node(1,"window"); let mut target=node(27,"Pin"); target.children.push(node(28,"00:01"));
  tree.children=vec![node(2,"00:01"),target]; let before=snapshot(&tree);
  tree.children[0]=node(3,"00:02"); tree.children.insert(0,node(4,"new unrelated sibling"));
  tree.children[2].children[0]=node(28,"00:02"); tree.children[2].subtree_truncated=true; tree.subtree_truncated=true;
  let after=snapshot(&tree); assert_ne!(before.signature,after.signature);
  assert!(pattern_matches(&before,&after,&[27]));
 }
 #[test] fn target_identity_content_geometry_safety_and_window_changes_stay_stale() {
  let original=node(27,"Pin"); let before=snapshot(&original);
  let mutations:Vec<Box<dyn Fn(&mut agent_desktop_core::AccessibilityNode)>>=vec![
   Box::new(|n| n.identity.name=Some("Close".into())),
   Box::new(|n| n.identity.value=Some("changed".into())),
   Box::new(|n| n.identity.retained_object=Some(json!({"runtime":[28]}).to_string())),
   Box::new(|n| n.identity.retained_object=Some(json!({"runtime":[27],"rawName":"changed hidden tail"}).to_string())),
   Box::new(|n| n.role="Edit".into()),
   Box::new(|n| n.presentation.bounds=Some(agent_desktop_core::Rect{x:1.,y:2.,width:3.,height:4.})),
   Box::new(|n| n.presentation.states.clear()),
   Box::new(|n| n.presentation.states.push("offscreen".into())),
   Box::new(|n| n.presentation.states.push("protected".into())),
   Box::new(|n| n.presentation.available_actions.clear())];
  for mutate in mutations { let mut changed=original.clone(); mutate(&mut changed); assert!(!pattern_matches(&before,&snapshot(&changed),&[27])); }
  let mut after=snapshot(&original); after.action_window["bounds"]["x"]=json!(2); assert!(!pattern_matches(&before,&after,&[27]));
  after=snapshot(&original); after.action_window["pid"]=json!(8); assert!(!pattern_matches(&before,&after,&[27]));
  after=snapshot(&original); after.evidence.clear(); assert!(!pattern_matches(&before,&after,&[27]));
 }
}
