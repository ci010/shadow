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
        let soft = std::time::Instant::now();
        // Own the client locally, not upstream's thread-local cache, so every
        // COM interface is released before the host balances CoInitializeEx.
        use windows::{core::Interface, Win32::{System::Com::{CoCreateInstance, CLSCTX_ALL}, UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2}}};
        let bounded: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }.map_err(|_| diagnostic("uia_client_init"))?;
        unsafe { bounded.SetConnectionTimeout(2000).map_err(|_| diagnostic("uia_client_init"))?; bounded.SetTransactionTimeout(5000).map_err(|_| diagnostic("uia_client_init"))?; }
        let base: IUIAutomation = bounded.cast().map_err(|_| diagnostic("uia_client_init"))?;
        let client = uiautomation::UIAutomation::from(base);
        let walker = client.get_control_view_walker().map_err(|_| diagnostic("uia_tree_navigation"))?;
        let root = UIAElement::from(client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| diagnostic("uia_root_unavailable"))?);
        let pid = root.0.get_process_id().map_err(|_| refused())?;
        if pid != expected_pid || root.0.get_runtime_id().map_err(|_| diagnostic("uia_identity_unavailable"))? != expected_runtime_id { return Err(refused()); }
        let boundary = WindowBoundary::new(&client, hwnd, expected_pid, expected_runtime_id, deadline)?;
        let mut remaining = 64usize;
        let tree = visit(&root, &walker, deadline, 0, &mut remaining, &boundary, &mut 0, Some(soft))?;
        let after = UIAElement::from(client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| diagnostic("uia_root_unavailable"))?);
        if after.0.get_process_id().ok() != Some(expected_pid) || after.0.get_runtime_id().map_err(|_| diagnostic("uia_identity_unavailable"))? != expected_runtime_id { return Err(refused()); }
        if deadline.is_expired() { return Err(diagnostic("uia_deadline")); }
        // A budget-exhausted root alone is not a useful observation.
        if tree.subtree_truncated && tree.children.iter().all(|child| child.presentation.states.iter().any(|s| s == "protected")) { return Err(diagnostic("uia_budget")); }
        Ok(tree)
    }
}
fn refused() -> AdapterError { diagnostic("uia_verification_failed") }
// Static codes only: never include provider exception text, names or values.
fn diagnostic(reason: &'static str) -> AdapterError { AdapterError::new(ErrorCode::Internal, reason) }
fn visit(element: &UIAElement, walker: &uiautomation::core::UITreeWalker, deadline: Deadline, depth: u8, remaining: &mut usize, boundary: &WindowBoundary, characters: &mut usize, soft: Option<std::time::Instant>) -> Result<AccessibilityNode, AdapterError> {
    if deadline.is_expired() { return Err(diagnostic("uia_deadline")); }
    if *remaining == 0 { return Err(diagnostic("uia_budget")); }
    *remaining -= 1;
    boundary.verify(&element.0)?;
    // Any unreadable/unsupported password status fails closed BEFORE name/value.
    let secret = read_one(element, TreeProperty::IsPassword).flag().unwrap_or(true);
    let mut node = AccessibilityNode {
        ref_id: None, role: "control".into(),
        identity: NodeIdentity::default(), presentation: NodePresentation::default(),
        children_count: None, subtree_truncated: false, children: Vec::new(),
    };
    if secret {
        if depth == 0 { return Err(diagnostic("uia_root_protected_or_unknown")); }
        node.identity.name = Some("[Protected field]".into());
        node.presentation.states.push("protected".into());
        // Protected placeholders contain no provider content or runtime binding.
        // Still complete the second boundary proof before publishing the node.
        boundary.verify(&element.0)?;
        let _ = read_one(element, TreeProperty::IsPassword).flag();
        if deadline.is_expired() { return Err(diagnostic("uia_deadline")); }
        // Do not enumerate or visit descendants of a secret control.
        return Ok(node);
    }
    let raw = element.0.get_bounding_rectangle().map_err(|_| diagnostic("uia_geometry"))?;
    let width = i64::from(raw.get_right()) - i64::from(raw.get_left());
    let height = i64::from(raw.get_bottom()) - i64::from(raw.get_top());
    if width < 0 || height < 0 || width > i32::MAX as i64 || height > i32::MAX as i64 { return Err(diagnostic("uia_geometry")); }
    let bounds = agent_desktop_core::Rect { x: f64::from(raw.get_left()), y: f64::from(raw.get_top()), width: width as f64, height: height as f64 };
    node.presentation.bounds = Some(bounds);
    let enabled = read_one(element, TreeProperty::IsEnabled).flag().ok_or_else(|| diagnostic("uia_state_unavailable"))?;
    let offscreen = read_one(element, TreeProperty::IsOffscreen).flag().ok_or_else(|| diagnostic("uia_state_unavailable"))?;
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
    let runtime = element.0.get_runtime_id().map_err(|_| diagnostic("uia_identity_unavailable"))?;
    if runtime.is_empty() { return Err(refused()); }
    node.role = format!("{:?}", element.0.get_control_type().map_err(|_| refused())?);
    let mut raw_value = None;
    {
        if let Ok(pattern) = element.0.get_pattern::<UIValuePattern>() {
            let value = pattern.get_value().map_err(|_| diagnostic("uia_value_read"))?;
            let complete = value.encode_utf16().count() < 2000;
            if !complete { node.subtree_truncated = true; }
            node.identity.value = Some(truncate_utf16(&value, 2000));
            raw_value = Some(fingerprint(&value));
            if gate::value_allowed(Some(false),enabled,offscreen,true,node.role == "Edit",pattern.is_readonly().ok(),value.encode_utf16().count()) { node.presentation.available_actions.push("set_value".into()); }
        }
        else if let Ok(pattern) = element.0.get_pattern::<UITextPattern>() {
            let value = pattern.get_document_range().map_err(|_| diagnostic("uia_text_read"))?.get_text(2001).map_err(|_| diagnostic("uia_text_read"))?;
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
    if read_one(element, TreeProperty::IsPassword).flag() != Some(false) { return Err(diagnostic("uia_password_recheck")); }
    boundary.verify(&element.0)?;
    if element.0.get_runtime_id().map_err(|_| refused())? != runtime { return Err(refused()); }
    *characters += serde_json::to_string(&node).map_err(|_| refused())?.len();
    // Admit new work only while the soft budget permits. The current node has
    // completed BOTH boundary/password/identity checks; never return a half-read
    // node or turn a failed verification into truncation. Reserve ~2.5s of the
    // unchanged 5s hard budget for the last admitted node and final root check.
    if !continue_traversal(deadline, soft)? || depth >= 20 || *remaining == 0 || *characters >= 32000 { node.subtree_truncated = true; return Ok(node); }
    let mut child = match walker.get_first_child(&element.0) {
        Ok(value) => Some(value),
        Err(error) if failure_of(&error).is_exhaustion() => None,
        Err(_) => return Err(diagnostic("uia_tree_navigation")),
    };
    while let Some(value) = child {
        if !continue_traversal(deadline, soft)? || *remaining == 0 || *characters >= 32000 { node.subtree_truncated = true; break; }
        let wrapped = UIAElement::from(value);
        node.children.push(visit(&wrapped, walker, deadline, depth + 1, remaining, boundary, characters, soft)?);
        // Do not spend the reserve discovering a sibling we cannot verify.
        if !continue_traversal(deadline, soft)? || *remaining == 0 || *characters >= 32000 { node.subtree_truncated = true; break; }
        child = match walker.get_next_sibling(&wrapped.0) {
            Ok(value) => Some(value),
            Err(error) if failure_of(&error).is_exhaustion() => None,
            Err(_) => return Err(diagnostic("uia_tree_navigation")),
        };
    }
    Ok(node)
}

impl crate::WindowsAdapter {
    /// Authorized bind-time identity read only: no names, values or descendants.
    pub fn shadow_root_identity(&self, hwnd: isize, expected_pid: u32) -> Result<Vec<i32>, AdapterError> {
        use windows::{core::Interface, Win32::{System::Com::{CoCreateInstance, CLSCTX_ALL}, UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2}}};
        let bounded: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }.map_err(|_| diagnostic("uia_client_init"))?;
        unsafe { bounded.SetConnectionTimeout(2000).map_err(|_| diagnostic("uia_client_init"))?; bounded.SetTransactionTimeout(5000).map_err(|_| diagnostic("uia_client_init"))?; }
        let base: IUIAutomation = bounded.cast().map_err(|_| diagnostic("uia_client_init"))?;
        let client = uiautomation::UIAutomation::from(base);
        let element = client.element_from_handle(uiautomation::types::Handle::from(hwnd)).map_err(|_| diagnostic("uia_root_unavailable"))?;
        if element.get_process_id().ok() != Some(expected_pid) { return Err(refused()); }
        let id = element.get_runtime_id().map_err(|_| diagnostic("uia_identity_unavailable"))?;
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

        let boundary = WindowBoundary::new(&client, hwnd, pid, root_id, deadline)?;
        let mut remaining = 200;
        let target = find_runtime(&root, &walker, runtime, &boundary, deadline, 0, &mut remaining)?.ok_or_else(refused)?;
        let wrapped = UIAElement::from(target.clone());
        let mut budget = 1;
        let evidence = visit(&wrapped, &walker, deadline, 20, &mut budget, &boundary, &mut 0, None)?;
        if target.get_runtime_id().map_err(|_| refused())? != runtime || root.get_runtime_id().map_err(|_| refused())? != root_id { return Err(refused()); }
        let kind = action["kind"].as_str().ok_or_else(refused)?;
        if !evidence.presentation.available_actions.iter().any(|s| s == kind) { return Err(refused()); }
        if !gate::action_allowed(read_one(&wrapped, TreeProperty::IsPassword).flag(),target.is_enabled().ok() == Some(true),target.is_offscreen().ok() != Some(false),true) { return Err(refused()); }
        let result = match kind {
            "invoke" => { let p = target.get_pattern::<UIInvokePattern>().map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.invoke().map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } Ok(false) }
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
                boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.set_value(value).map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
                if read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); }
                Ok(p.get_value().map_err(|_| refused())? == value)
            }
            "toggle" => { let p = target.get_pattern::<UITogglePattern>().map_err(|_| refused())?; let before = p.get_toggle_state().map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.toggle().map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } Ok(p.get_toggle_state().map_err(|_| refused())? != before) }
            "select" => { let p = target.get_pattern::<UISelectionItemPattern>().map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.select().map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } p.is_selected().map_err(|_| refused()) }
            "scroll" => {
                let p = target.get_pattern::<UIScrollPattern>().map_err(|_| refused())?;
                let before = (p.get_horizontal_scroll_percent().map_err(|_| refused())?, p.get_vertical_scroll_percent().map_err(|_| refused())?);
                let (x,y) = match action["direction"].as_str() { Some("up") => (ScrollAmount::NoAmount, ScrollAmount::SmallDecrement), Some("down") => (ScrollAmount::NoAmount, ScrollAmount::SmallIncrement), Some("left") => (ScrollAmount::SmallDecrement, ScrollAmount::NoAmount), Some("right") => (ScrollAmount::SmallIncrement, ScrollAmount::NoAmount), _ => return Err(refused()) };
                boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); } *started = true; p.scroll(x,y).map_err(|_| refused())?; boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
                Ok(before != (p.get_horizontal_scroll_percent().map_err(|_| refused())?, p.get_vertical_scroll_percent().map_err(|_| refused())?))
            }
            _ => Err(refused())
        };
        boundary.verify(&target)?; if target.get_runtime_id().map_err(|_| refused())? != runtime || read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); } if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
        result
    }
}
fn find_runtime(element: &uiautomation::UIElement, walker: &uiautomation::core::UITreeWalker, runtime: &[i32], boundary: &WindowBoundary, deadline: Deadline, depth: u8, remaining: &mut usize) -> Result<Option<uiautomation::UIElement>, AdapterError> {
    if deadline.is_expired() || *remaining == 0 || depth > 20 { return Err(refused()); }
    *remaining -= 1;
    boundary.verify(element)?;
    let wrapped = UIAElement::from(element.clone());
    if read_one(&wrapped, TreeProperty::IsPassword).flag() != Some(false) { return Ok(None); }
    if element.get_runtime_id().map_err(|_| refused())? == runtime { return Ok(Some(element.clone())); }
    let mut child = match walker.get_first_child(element) { Ok(v) => Some(v), Err(e) if failure_of(&e).is_exhaustion() => None, Err(_) => return Err(refused()) };
    while let Some(value) = child {
        if let Some(found) = find_runtime(&value, walker, runtime, boundary, deadline, depth+1, remaining)? { return Ok(Some(found)); }
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
        let boundary=WindowBoundary::new(&client,hwnd,pid,root_id,deadline)?;
        let target=if let Some(id)=runtime { find_runtime(&root,&walker,id,&boundary,deadline,0,&mut 200)?.ok_or_else(refused)? } else { root.clone() };
        ancestry(&boundary,&target,runtime,deadline)?;
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
            1=> { check_root(&root,pid,root_id,deadline)?; ancestry(&boundary,&target,runtime,deadline)?; if !gate::dispatch_allowed(deadline.is_expired(),cancelled()) { return Err(refused()); }
                let already=client.get_focused_element().ok().and_then(|e|e.get_runtime_id().ok())==target.get_runtime_id().ok();
                if !already {
                    check_root(&root,pid,root_id,deadline)?;
                    ancestry(&boundary,&target,runtime,deadline)?;
                    if cancelled() || deadline.is_expired() { return Err(refused()); }
                    target.set_focus().map_err(|_|refused())?;
                    if cancelled() || deadline.is_expired() { return Err(refused()); }
                } },
            2=> { let focused=client.get_focused_element().map_err(|_|refused())?; ancestry(&boundary,&focused,runtime,deadline)?; },
            3=> { let hit=client.element_from_point(uiautomation::types::Point::new(point.0,point.1)).map_err(|_|refused())?; ancestry(&boundary,&hit,None,deadline)?; },
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
fn ancestry(boundary:&WindowBoundary,element:&uiautomation::UIElement,required:Option<&[i32]>,deadline:Deadline)->Result<(),AdapterError> {
 boundary.verify(element)?;
 let walker=&boundary.walker;
 let mut current=element.clone(); let mut found=required.is_none();
 for _ in 0..64 {
  if deadline.is_expired() { return Err(refused()); }
  // Unknown-secret is rejected immediately, before any names, values or patterns.
  if read_one(&UIAElement::from(current.clone()),TreeProperty::IsPassword).flag()!=Some(false) { return Err(refused()); }
  let runtime=current.get_runtime_id().map_err(|_|refused())?;
  if required==Some(runtime.as_slice()) { found=true; }
  if runtime==boundary.root_id { return if found { Ok(()) } else { Err(refused()) }; }
  current=walker.get_parent(&current).map_err(|_|refused())?;
 }
 Err(refused())
}

// UIA ProcessId is the provider's process, not a window-membership proof.
// Membership requires a bounded raw-parent chain to the freshly HWND-resolved
// root (both runtime identity and UIA CompareElements), and every nonzero native
// HWND along that chain must have this exact GA_ROOT. Owned top-level popups are
// intentionally NOT included. No executable-name/process-family trust is used.
#[link(name = "user32")]
unsafe extern "system" {
    fn GetAncestor(hwnd: isize, flags: u32) -> isize;
    fn IsWindow(hwnd: isize) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
}
struct WindowBoundary<'a> {
    client: &'a uiautomation::UIAutomation,
    walker: uiautomation::core::UITreeWalker,
    hwnd: isize,
    pid: u32,
    root_id: &'a [i32],
    deadline: Deadline,
}
impl<'a> WindowBoundary<'a> {
    fn new(client: &'a uiautomation::UIAutomation, hwnd: isize, pid: u32, root_id: &'a [i32], deadline: Deadline) -> Result<Self, AdapterError> {
        Ok(Self { client, walker: client.get_raw_view_walker().map_err(|_| refused())?, hwnd, pid, root_id, deadline })
    }
    fn root(&self) -> Result<uiautomation::UIElement, AdapterError> {
        let mut pid = 0;
        if self.deadline.is_expired() || self.root_id.is_empty() || unsafe { IsWindow(self.hwnd) } == 0
            || unsafe { GetAncestor(self.hwnd, 2) } != self.hwnd
            || unsafe { GetWindowThreadProcessId(self.hwnd, &mut pid) } == 0 || pid != self.pid { return Err(refused()); }
        let root = self.client.element_from_handle(uiautomation::types::Handle::from(self.hwnd)).map_err(|_| refused())?;
        check_root(&root, self.pid, self.root_id, self.deadline)?;
        let native: isize = root.get_native_window_handle().map_err(|_| refused())?.into();
        if native != self.hwnd { return Err(refused()); }
        Ok(root)
    }
    fn verify(&self, element: &uiautomation::UIElement) -> Result<(), AdapterError> {
        // No membership cache: every raw edge, HWND and ancestor password is
        // read live on BOTH sides of content reads. Resolve the root once, at
        // the end of this proof, rather than twice per node-side. In particular
        // do not CompareElements against the root for every noncandidate: the
        // bound runtime ID is a cheap filter, NEVER sufficient positive proof.
        let mut current = element.clone();
        let mut seen = Vec::new();
        for depth in 0..64 {
            if self.deadline.is_expired() { return Err(diagnostic("uia_deadline")); }
            let runtime = current.get_runtime_id().map_err(|_| refused())?;
            if runtime.is_empty() || seen.contains(&runtime) { return Err(refused()); }
            seen.push(runtime.clone());
            if depth > 0 && read_one(&UIAElement::from(current.clone()), TreeProperty::IsPassword).flag() != Some(false) { return Err(refused()); }
            if root_candidate(&runtime, self.root_id) {
                // Re-resolve HWND now; verify PID/native HWND/runtime against
                // selection, then compare the reached ancestor to that fresh
                // COM root. No root object/evidence survives this verification.
                let fresh = self.root()?;
                let same = self.client.compare_elements(&current, &fresh).map_err(|_| refused())?;
                return if root_matches(&runtime, self.root_id, same) { Ok(()) } else { Err(refused()) };
            }
            let provider_pid = current.get_process_id().map_err(|_| diagnostic("uia_process_unavailable"))?;
            let native: isize = current.get_native_window_handle().map_err(|_| refused())?.into();
            let native_root = if native == 0 { None } else {
                if unsafe { IsWindow(native) } == 0 { return Err(refused()); }
                Some(unsafe { GetAncestor(native, 2) })
            };
            if !provider_belongs(provider_pid, native_root, self.hwnd) { return Err(refused()); }
            current = self.walker.get_parent(&current).map_err(|_| refused())?;
        }
        Err(refused())
    }
}
fn provider_belongs(provider_pid: u32, native_root: Option<isize>, selected: isize) -> bool {
    provider_pid != 0 && native_root.map_or(true, |root| root != 0 && root == selected)
}
fn root_candidate(actual: &[i32], selected: &[i32]) -> bool {
    !selected.is_empty() && actual == selected
}
fn root_matches(actual: &[i32], selected: &[i32], same_element: bool) -> bool {
    root_candidate(actual, selected) && same_element
}
#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test] fn windowless_provider_and_same_window_native_child_are_allowed() {
        // Provider 999 need not equal the HWND owner PID; structural proof is mandatory.
        assert!(provider_belongs(999, None, 100));
        assert!(!provider_belongs(0, None, 100));
        assert!(provider_belongs(999, Some(100), 100));
    }
    #[test] fn foreign_window_owned_popup_and_invalid_hwnd_are_rejected() {
        assert!(!provider_belongs(999, Some(200), 100));
        assert!(!provider_belongs(999, Some(0), 100));
    }
    #[test] fn only_root_candidate_requires_resolution_and_comparison_regardless_of_depth() {
        // Uses the production candidate predicate. IDs filter calls only; a
        // matching but forged ID must still fail the separate CompareElements.
        for depth in [0, 1, 20, 63] {
            let mut resolutions = 0;
            let mut comparisons = 0;
            for index in 0..=depth {
                let id = if index == depth { vec![1000] } else { vec![index] };
                if root_candidate(&id, &[1000]) {
                    resolutions += 1;
                    comparisons += 1;
                    assert!(!root_matches(&id, &[1000], false));
                }
            }
            assert_eq!((resolutions, comparisons), (1, 1));
            // Before AND after the content: no reuse of a previous result.
            assert_eq!((2 * resolutions, 2 * comparisons), (2, 2));
        }
    }
    #[test] fn root_identity_change_or_forged_runtime_is_rejected() {
        assert!(root_matches(&[1,2], &[1,2], true));
        assert!(!root_matches(&[1,3], &[1,2], true));
        assert!(!root_matches(&[1,2], &[1,2], false));
        assert!(!root_matches(&[], &[], true));
    }
}

// Hard expiry always wins over soft truncation. This function only controls
// admission at completed-node boundaries, not exception recovery.
fn traversal_admission(hard_expired: bool, elapsed_ms: Option<u128>) -> Result<bool, AdapterError> {
    if hard_expired { return Err(diagnostic("uia_deadline")); }
    Ok(elapsed_ms.map_or(true, |elapsed| elapsed < 2500))
}
fn continue_traversal(deadline: Deadline, soft: Option<std::time::Instant>) -> Result<bool, AdapterError> {
    traversal_admission(deadline.is_expired(), soft.map(|start| start.elapsed().as_millis()))
}
#[cfg(test)]
mod traversal_budget_tests {
    use super::*;
    #[test] fn soft_budget_stops_admission_without_extending_hard_deadline() {
        assert!(traversal_admission(false, Some(2499)).unwrap());
        assert!(!traversal_admission(false, Some(2500)).unwrap());
        assert!(!traversal_admission(false, Some(4000)).unwrap());
        assert!(traversal_admission(false, None).unwrap());
        assert!(traversal_admission(true, Some(2500)).is_err());
        assert!(traversal_admission(true, None).is_err());
    }
    #[test] fn failed_node_validation_is_not_soft_truncation() {
        fn admit_completed_node(validation: Result<(), AdapterError>, elapsed: u128) -> Result<bool, AdapterError> {
            validation?;
            traversal_admission(false, Some(elapsed))
        }
        assert!(!admit_completed_node(Ok(()), 3000).unwrap());
        assert!(admit_completed_node(Err(refused()), 3000).is_err());
        assert!(admit_completed_node(Err(diagnostic("uia_password_recheck")), 3000).is_err());
    }
}
