#[allow(dead_code)]
mod gate { include!("shadow_gate.rs"); }
use gate::fingerprint;
// Shadow modification to agent-desktop v0.10.1, Apache-2.0.
// Password-first restricted observation and single-pattern actions. No cache or physical fallback.
use agent_desktop_core::{AccessibilityNode, AdapterError, Deadline, ErrorCode, NodeIdentity, NodePresentation};
use crate::tree::{automation::failure_of, element::UIAElement, properties::read_one, property_ids::TreeProperty};

impl crate::WindowsAdapter {
    /// A bounded, password-first walker; does not invoke renderer activation.
    /// Caller must enforce process/desktop/authorization before and after.
    pub fn shadow_observe_window(&self, hwnd: isize, expected_pid: u32, expected_runtime_id: &[i32], deadline: Deadline) -> Result<AccessibilityNode, AdapterError> {
        // Own the client locally, not upstream's thread-local cache, so every
        // COM interface is released before the host balances CoInitializeEx.
        use windows::{core::Interface, Win32::{System::Com::{CoCreateInstance, CLSCTX_ALL}, UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2}}};
        let bounded: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }.map_err(|_| refused())?;
        unsafe { bounded.SetConnectionTimeout(2000).map_err(|_| refused())?; bounded.SetTransactionTimeout(5000).map_err(|_| refused())?; }
        let base: IUIAutomation = bounded.cast().map_err(|_| refused())?;
        let client = uiautomation::UIAutomation::from(base);
        let walker = client.get_control_view_walker().map_err(|_| refused())?;
        let root = UIAElement::from(client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| refused())?);
        let pid = root.0.get_process_id().map_err(|_| refused())?;
        if pid != expected_pid || root.0.get_runtime_id().map_err(|_| refused())? != expected_runtime_id { return Err(refused()); }
        let mut remaining = 200usize;
        let tree = visit(&root, &walker, deadline, 0, &mut remaining, pid, &mut 0)?;
        let after = UIAElement::from(client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| refused())?);
        if after.0.get_process_id().ok() != Some(expected_pid) || after.0.get_runtime_id().map_err(|_| refused())? != expected_runtime_id { return Err(refused()); }
        if deadline.is_expired() { return Err(refused()); }
        Ok(tree)
    }
}
fn refused() -> AdapterError {
    AdapterError::new(ErrorCode::Internal, "Restricted observation could not be verified")
}
fn visit(element: &UIAElement, walker: &uiautomation::core::UITreeWalker, deadline: Deadline, depth: u8, remaining: &mut usize, pid: u32, characters: &mut usize) -> Result<AccessibilityNode, AdapterError> {
    if deadline.is_expired() || *remaining == 0 { return Err(refused()); }
    *remaining -= 1;
    if element.0.get_process_id().ok() != Some(pid) { return Err(refused()); }
    // Any unreadable/unsupported password status fails closed BEFORE name/value.
    let secret = read_one(element, TreeProperty::IsPassword).flag().unwrap_or(true);
    let mut node = AccessibilityNode {
        ref_id: None, role: "control".into(),
        identity: NodeIdentity::default(), presentation: NodePresentation::default(),
        children_count: None, subtree_truncated: false, children: Vec::new(),
    };
    if secret {
        if depth == 0 { return Err(refused()); }
        node.identity.name = Some("[Protected field]".into());
        node.presentation.states.push("protected".into());
        // Do not enumerate or visit descendants of a secret control.
        return Ok(node);
    }
    let raw = element.0.get_bounding_rectangle().map_err(|_| refused())?;
    let width = i64::from(raw.get_right()) - i64::from(raw.get_left());
    let height = i64::from(raw.get_bottom()) - i64::from(raw.get_top());
    if width < 0 || height < 0 || width > i32::MAX as i64 || height > i32::MAX as i64 { return Err(refused()); }
    let bounds = agent_desktop_core::Rect { x: f64::from(raw.get_left()), y: f64::from(raw.get_top()), width: width as f64, height: height as f64 };
    node.presentation.bounds = Some(bounds);
    let enabled = read_one(element, TreeProperty::IsEnabled).flag().ok_or_else(refused)?;
    let offscreen = read_one(element, TreeProperty::IsOffscreen).flag().ok_or_else(refused)?;
    if read_one(element, TreeProperty::IsKeyboardFocusable).flag() == Some(true) { node.presentation.states.push("focusable".into()); }
    if enabled { node.presentation.states.push("enabled".into()); }
    if offscreen { node.presentation.states.push("offscreen".into()); }
    // Names and values are only read after a known nonsecret classification.
    let mut raw_name = None;
    {
        if let agent_desktop_core::LocatorField::Known(name) = read_one(element, TreeProperty::Name).text() {
            node.identity.name = Some(truncate_utf16(&name, 512));
            raw_name = Some(fingerprint(&name));
        }
    }
    use uiautomation::patterns::{UIInvokePattern, UIValuePattern, UITogglePattern, UISelectionItemPattern, UIScrollPattern, UITextPattern};
    let runtime = element.0.get_runtime_id().map_err(|_| refused())?;
    if runtime.is_empty() { return Err(refused()); }
    node.role = format!("{:?}", element.0.get_control_type().map_err(|_| refused())?);
    let mut raw_value = None;
    {
        if let Ok(pattern) = element.0.get_pattern::<UIValuePattern>() {
            let value = pattern.get_value().map_err(|_| refused())?;
            let complete = value.encode_utf16().count() < 2000;
            if !complete { node.subtree_truncated = true; }
            node.identity.value = Some(truncate_utf16(&value, 2000));
            raw_value = Some(fingerprint(&value));
            if gate::value_allowed(Some(false),enabled,offscreen,true,node.role == "Edit",pattern.is_readonly().ok(),value.encode_utf16().count()) { node.presentation.available_actions.push("set_value".into()); }
        }
        else if let Ok(pattern) = element.0.get_pattern::<UITextPattern>() {
            let value = pattern.get_document_range().map_err(|_| refused())?.get_text(2001).map_err(|_| refused())?;
            if value.encode_utf16().count() > 2000 { node.subtree_truncated = true; }
            node.identity.value = Some(truncate_utf16(&value,2000));
            raw_value = Some(fingerprint(&value));
        }
        if gate::action_allowed(Some(false),enabled,offscreen,true) {
            if element.0.get_pattern::<UIInvokePattern>().is_ok() { node.presentation.available_actions.push("invoke".into()); }
            if let Ok(p) = element.0.get_pattern::<UITogglePattern>() { node.presentation.available_actions.push("toggle".into()); node.presentation.states.push(format!("toggle:{:?}",p.get_toggle_state().map_err(|_| refused())?)); }
            if let Ok(p) = element.0.get_pattern::<UISelectionItemPattern>() { node.presentation.available_actions.push("select".into()); node.presentation.states.push(format!("selected:{}",p.is_selected().map_err(|_| refused())?)); }
            if element.0.get_pattern::<UIScrollPattern>().is_ok() { node.presentation.available_actions.push("scroll".into()); }
        }
    }
    // Hidden identity/signature material, never included in the wire observation.
    node.identity.retained_object = Some(serde_json::json!({"runtime":runtime,"rawName": raw_name, "rawValue":raw_value}).to_string());
    // Recheck after content read. On races, discard the complete observation.
    if read_one(element, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); }
    *characters += serde_json::to_string(&node).map_err(|_| refused())?.len();
    if depth >= 20 || *remaining == 0 || *characters >= 32000 { node.subtree_truncated = true; return Ok(node); }
    let mut child = match walker.get_first_child(&element.0) {
        Ok(value) => Some(value),
        Err(error) if failure_of(&error).is_exhaustion() => None,
        Err(_) => return Err(refused()),
    };
    while let Some(value) = child {
        if deadline.is_expired() || *remaining == 0 || *characters >= 32000 { node.subtree_truncated = true; break; }
        let wrapped = UIAElement::from(value);
        node.children.push(visit(&wrapped, walker, deadline, depth + 1, remaining, pid, characters)?);
        child = match walker.get_next_sibling(&wrapped.0) {
            Ok(value) => Some(value),
            Err(error) if failure_of(&error).is_exhaustion() => None,
            Err(_) => return Err(refused()),
        };
    }
    Ok(node)
}

impl crate::WindowsAdapter {
    /// Authorized bind-time identity read only: no names, values or descendants.
    pub fn shadow_root_identity(&self, hwnd: isize, expected_pid: u32) -> Result<Vec<i32>, AdapterError> {
        use windows::{core::Interface, Win32::{System::Com::{CoCreateInstance, CLSCTX_ALL}, UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2}}};
        let bounded: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }.map_err(|_| refused())?;
        unsafe { bounded.SetConnectionTimeout(2000).map_err(|_| refused())?; bounded.SetTransactionTimeout(5000).map_err(|_| refused())?; }
        let base: IUIAutomation = bounded.cast().map_err(|_| refused())?;
        let client = uiautomation::UIAutomation::from(base);
        let element = client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| refused())?;
        if element.get_process_id().ok() != Some(expected_pid) { return Err(refused()); }
        let id = element.get_runtime_id().map_err(|_| refused())?;
        if id.is_empty() { return Err(refused()); }
        Ok(id)
    }
}

// The wire schema uses JavaScript string length (UTF-16 code units), not
// Unicode scalar count. Never split a scalar/surrogate pair at the limit.
fn truncate_utf16(value: &str, maximum: usize) -> String {
    let mut units = 0usize;
    value.chars().take_while(|character| {
        let next = units + character.len_utf16();
        if next > maximum { return false; }
        units = next;
        true
    }).collect()
}
#[cfg(test)]
mod shadow_tests {
    use super::truncate_utf16;
    #[test]
    fn names_respect_javascript_length_without_splitting_emoji() {
        let emoji = "\u{1f600}".repeat(300);
        let result = truncate_utf16(&emoji, 512);
        assert_eq!(result.encode_utf16().count(), 512);
        assert_eq!(result.chars().count(), 256);
        assert_eq!(truncate_utf16(&format!("{}\u{1f600}", "x".repeat(511)), 512), "x".repeat(511));
        assert_eq!(truncate_utf16("abc", 512), "abc");
    }
}

impl crate::WindowsAdapter {
    /// Single UIA pattern only. `started` is set immediately BEFORE a mutation;
    /// caller must treat every subsequent failure/panic as outcome_unknown.
    pub fn shadow_action(&self, hwnd: isize, pid: u32, root_id: &[i32], runtime: &[i32], action: &serde_json::Value, started: &mut bool, cancelled: &dyn Fn()->bool) -> Result<bool, AdapterError> {
        use windows::{core::Interface, Win32::{System::Com::{CoCreateInstance, CLSCTX_ALL}, UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2}}};
        use uiautomation::patterns::{UIInvokePattern, UIValuePattern, UITogglePattern, UISelectionItemPattern, UIScrollPattern};
        use uiautomation::types::ScrollAmount;
        if cancelled() { return Err(refused()); }
        let deadline = Deadline::after(5000)?;
        let bounded: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }.map_err(|_| refused())?;
        unsafe { bounded.SetConnectionTimeout(2000).map_err(|_| refused())?; bounded.SetTransactionTimeout(5000).map_err(|_| refused())?; }
        let base: IUIAutomation = bounded.cast().map_err(|_| refused())?;
        let client = uiautomation::UIAutomation::from(base);
        let root = client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| refused())?;
        if root.get_process_id().ok() != Some(pid) || root.get_runtime_id().map_err(|_| refused())? != root_id { return Err(refused()); }
        let walker = client.get_control_view_walker().map_err(|_| refused())?;

        let mut remaining = 200;
        let target = find_runtime(&root, &walker, runtime, pid, deadline, 0, &mut remaining)?.ok_or_else(refused)?;
        let wrapped = UIAElement::from(target.clone());
        let mut budget = 1;
        let evidence = visit(&wrapped, &walker, deadline, 20, &mut budget, pid, &mut 0)?;
        if target.get_runtime_id().map_err(|_| refused())? != runtime || root.get_runtime_id().map_err(|_| refused())? != root_id { return Err(refused()); }
        let kind = action["kind"].as_str().ok_or_else(refused)?;
        if !evidence.presentation.available_actions.iter().any(|s| s == kind) { return Err(refused()); }
        if !gate::action_allowed(read_one(&wrapped, TreeProperty::IsPassword).flag(),target.is_enabled().ok() == Some(true),target.is_offscreen().ok() != Some(false),true) { return Err(refused()); }
        let result = match kind {
            "invoke" => { let p = target.get_pattern::<UIInvokePattern>().map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.invoke().map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } Ok(false) }
            "set_value" => {
                let value = action["value"].as_str().ok_or_else(refused)?;
                if value.encode_utf16().count() > 4000 || value.contains('\0') { return Err(refused()); }
                let p = target.get_pattern::<UIValuePattern>().map_err(|_| refused())?;
                // Never place content reads in eager gate arguments: password
                // must fail closed BEFORE evaluating any ValuePattern content.
                let password = read_one(&wrapped, TreeProperty::IsPassword).flag();
                if password != Some(false) { return Err(refused()); }
                let original_units = p.get_value().map_err(|_| refused())?.encode_utf16().count();
                if !gate::value_allowed(password,true,false,true,evidence.role == "Edit",p.is_readonly().ok(),original_units) { return Err(refused()); }
                if read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); }
                if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.set_value(value).map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
                if read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); }
                Ok(p.get_value().map_err(|_| refused())? == value)
            }
            "toggle" => { let p = target.get_pattern::<UITogglePattern>().map_err(|_| refused())?; let before = p.get_toggle_state().map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.toggle().map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } Ok(p.get_toggle_state().map_err(|_| refused())? != before) }
            "select" => { let p = target.get_pattern::<UISelectionItemPattern>().map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.select().map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } p.is_selected().map_err(|_| refused()) }
            "scroll" => {
                let p = target.get_pattern::<UIScrollPattern>().map_err(|_| refused())?;
                let before = (p.get_horizontal_scroll_percent().map_err(|_| refused())?, p.get_vertical_scroll_percent().map_err(|_| refused())?);
                let (x,y) = match action["direction"].as_str() { Some("up") => (ScrollAmount::NoAmount, ScrollAmount::SmallDecrement), Some("down") => (ScrollAmount::NoAmount, ScrollAmount::SmallIncrement), Some("left") => (ScrollAmount::SmallDecrement, ScrollAmount::NoAmount), Some("right") => (ScrollAmount::SmallIncrement, ScrollAmount::NoAmount), _ => return Err(refused()) };
                if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.scroll(x,y).map_err(|_| refused())?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
                Ok(before != (p.get_horizontal_scroll_percent().map_err(|_| refused())?, p.get_vertical_scroll_percent().map_err(|_| refused())?))
            }
            _ => Err(refused())
        };
        if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
        result
    }
}
fn find_runtime(element: &uiautomation::UIElement, walker: &uiautomation::core::UITreeWalker, runtime: &[i32], pid: u32, deadline: Deadline, depth: u8, remaining: &mut usize) -> Result<Option<uiautomation::UIElement>, AdapterError> {
    if deadline.is_expired() || *remaining == 0 || depth > 20 { return Err(refused()); }
    *remaining -= 1;
    if element.get_process_id().ok() != Some(pid) { return Err(refused()); }
    let wrapped = UIAElement::from(element.clone());
    if read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Ok(None); }
    if element.get_runtime_id().map_err(|_| refused())? == runtime { return Ok(Some(element.clone())); }
    let mut child = match walker.get_first_child(element) { Ok(v) => Some(v), Err(e) if failure_of(&e).is_exhaustion() => None, Err(_) => return Err(refused()) };
    while let Some(value) = child {
        if let Some(found) = find_runtime(&value, walker, runtime, pid, deadline, depth+1, remaining)? { return Ok(Some(found)); }
        child = match walker.get_next_sibling(&value) { Ok(v) => Some(v), Err(e) if failure_of(&e).is_exhaustion() => None, Err(_) => return Err(refused()) };
    }
    Ok(None)
}

impl crate::WindowsAdapter {
    /// Restricted foreground extension. No upstream dispatcher or pattern fallback.
    /// mode 0 validates keyboard eligibility, 1 focuses verified target/root,
    /// 2 verifies focused ancestry, 3 verifies point ancestry.
    pub fn shadow_foreground(&self, hwnd:isize, pid:u32, root_id:&[i32], runtime:Option<&[i32]>, typing:bool, mode:u8, point:(i32,i32), cancelled:&dyn Fn()->bool) -> Result<(),AdapterError> {
        use windows::{core::Interface, Win32::{System::Com::{CoCreateInstance, CLSCTX_ALL}, UI::Accessibility::{CUIAutomation8,IUIAutomation,IUIAutomation2}}};
        if cancelled() { return Err(refused()); }
        let deadline=Deadline::after(5000)?;
        let bounded:IUIAutomation2=unsafe { CoCreateInstance(&CUIAutomation8,None,CLSCTX_ALL) }.map_err(|_|refused())?;
        unsafe { bounded.SetConnectionTimeout(2000).map_err(|_|refused())?; bounded.SetTransactionTimeout(5000).map_err(|_|refused())?; }
        let base:IUIAutomation=bounded.cast().map_err(|_|refused())?;
        let client=uiautomation::UIAutomation::from(base);
        let root=client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_|refused())?;
        check_root(&root,pid,root_id,deadline)?;
        let walker=client.get_control_view_walker().map_err(|_|refused())?;
        let target=if let Some(id)=runtime { find_runtime(&root,&walker,id,pid,deadline,0,&mut 200)?.ok_or_else(refused)? } else { root.clone() };
        ancestry(&client,&target,pid,root_id,runtime,deadline)?;
        if runtime.is_some() {
            let wrapped=UIAElement::from(target.clone());
            if read_one(&wrapped,TreeProperty::IsPassword).flag()!=Some(false) { return Err(refused()); }
            if target.is_enabled().ok()!=Some(true) || target.is_offscreen().ok()!=Some(false) || read_one(&wrapped,TreeProperty::IsKeyboardFocusable).flag()!=Some(true) { return Err(refused()); }
            if cancelled() || deadline.is_expired() { return Err(refused()); }
            if typing {
                use uiautomation::{types::ControlType,patterns::UIValuePattern};
                if !matches!(target.get_control_type().map_err(|_|refused())?,ControlType::Edit|ControlType::Document) { return Err(refused()); }
                if cancelled() || deadline.is_expired() { return Err(refused()); }
                if read_one(&wrapped,TreeProperty::IsPassword).flag()!=Some(false) { return Err(refused()); }
                let available=read_one(&wrapped,TreeProperty::ValueAvailable).flag();
                let readonly=match available {
                    Some(false)=>None,
                    Some(true)=> { let p=target.get_pattern::<UIValuePattern>().map_err(|_|refused())?; Some(p.is_readonly().map_err(|_|refused())?) },
                    None=>return Err(refused())
                };
                if !gate::typing_value_allowed(available,readonly) { return Err(refused()); }
            }
        }
        match mode {
            0=>{},
            1=> { check_root(&root,pid,root_id,deadline)?; ancestry(&client,&target,pid,root_id,runtime,deadline)?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
                let already=client.get_focused_element().ok().and_then(|e|e.get_runtime_id().ok())==target.get_runtime_id().ok();
                if !already {
                    check_root(&root,pid,root_id,deadline)?;
                    ancestry(&client,&target,pid,root_id,runtime,deadline)?;
                    if cancelled() || deadline.is_expired() { return Err(refused()); }
                    target.set_focus().map_err(|_|refused())?;
                    if cancelled() || deadline.is_expired() { return Err(refused()); }
                } },
            2=> { let focused=client.get_focused_element().map_err(|_|refused())?; ancestry(&client,&focused,pid,root_id,runtime,deadline)?; },
            3=> { let hit=client.element_from_point(uiautomation::types::Point::new(point.0,point.1)).map_err(|_|refused())?; ancestry(&client,&hit,pid,root_id,None,deadline)?; },
            _=>return Err(refused())
        }
        if cancelled() { return Err(refused()); }
        check_root(&root,pid,root_id,deadline)?;
        let after=client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_|refused())?;
        check_root(&after,pid,root_id,deadline)
    }
}
fn check_root(root:&uiautomation::UIElement,pid:u32,id:&[i32],deadline:Deadline)->Result<(),AdapterError> {
 if deadline.is_expired() || root.get_process_id().ok()!=Some(pid) || root.get_runtime_id().map_err(|_|refused())?!=id { return Err(refused()); } Ok(())
}
fn ancestry(client:&uiautomation::UIAutomation,element:&uiautomation::UIElement,pid:u32,root:&[i32],required:Option<&[i32]>,deadline:Deadline)->Result<(),AdapterError> {
 let walker=client.get_raw_view_walker().map_err(|_|refused())?;
 let mut current=element.clone(); let mut found=required.is_none();
 for _ in 0..64 {
  if deadline.is_expired() || current.get_process_id().ok()!=Some(pid) { return Err(refused()); }
  // Unknown-secret is rejected immediately, before any names, values or patterns.
  if read_one(&UIAElement::from(current.clone()),TreeProperty::IsPassword).flag()!=Some(false) { return Err(refused()); }
  let runtime=current.get_runtime_id().map_err(|_|refused())?;
  if required==Some(runtime.as_slice()) { found=true; }
  if runtime==root { return if found { Ok(()) } else { Err(refused()) }; }
  current=walker.get_parent(&current).map_err(|_|refused())?;
 }
 Err(refused())
}
