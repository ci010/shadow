namespace Shadow {
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Runtime.InteropServices;
    using System.Security.Cryptography;

    public static class InputFixture {
        private sealed class Monitor : InputMonitor {
            internal bool TakenOver;
            public bool Interrupted { get { return TakenOver; } }
            public string Reason { get { return TakenOver ? "mouse_input_detected" : null; } }
            public void Dispose() { }
        }
        private sealed class Environment : InputEnvironment {
            internal readonly Monitor Observer = new Monitor();
            internal readonly List<InputPacket> Packets = new List<InputPacket>();
            internal readonly List<IntPtr> Activations = new List<IntPtr>();
            internal IntPtr Active = new IntPtr(20), Focused = new IntPtr(11);
            internal uint Clock = 1000, Activity = 1;
            internal bool Held, Cancelled, Stale, Covered, CanActivate = true, Partial;
            internal bool DelayedActivation, CoveredMiddle;
            private IntPtr pendingActivation;
            private uint activationAt;
            internal Action<InputPacket[]> OnEmit;
            internal override uint Tick { get { return Clock; } }
            internal override uint LastActivity { get { return Activity; } }
            internal override IntPtr Foreground { get { return Active; } }
            internal override IntPtr Focus(IntPtr window) { return Focused; }
            internal override InputPoint Cursor { get { return new InputPoint(-100, 50); } }
            internal override InputRect Screen { get { return new InputRect { Left = -1000, Top = -500, Right = 2000, Bottom = 1000 }; } }
            internal override void Sleep(int milliseconds) {
                Clock += (uint)milliseconds;
                if (pendingActivation != IntPtr.Zero && Clock >= activationAt) { Active = pendingActivation; pendingActivation = IntPtr.Zero; }
            }
            internal override void CheckDesktop() { }
            internal override void CheckHeldInput() { if (Held) throw new InputFailure("user_interrupted"); }
            internal override InputMonitor Monitor(UIntPtr marker) { return Observer; }
            internal override bool Activate(IntPtr handle) {
                Activations.Add(handle);
                if (CanActivate) {
                    if (DelayedActivation) { pendingActivation = handle; activationAt = Clock + 30; }
                    else Active = handle;
                }
                return CanActivate;
            }
            internal override void Validate(InputWindow window) { if (Stale) throw new InputFailure("stale_observation"); }
            internal override void CheckPoint(InputWindow window, InputPoint point) {
                if (Covered || CoveredMiddle && point.X == 0 || !window.Bounds.Contains(point)) throw new InputFailure("input_outside_window");
            }
            internal override uint Emit(InputPacket[] packets) {
                int count = Partial ? 1 : packets.Length;
                Partial = false;
                Packets.AddRange(packets.Take(count));
                if (OnEmit != null) OnEmit(packets.Take(count).ToArray());
                return (uint)count;
            }
        }
        private sealed class GeometryEnvironment : InputEnvironment {
            internal IntPtr Root = new IntPtr(10);
            internal int Hit = 1;
            internal override IntPtr PointRoot(InputPoint point) { return Root; }
            internal override int HitTest(IntPtr handle, InputPoint point) { return Hit; }
        }
        private static int assertions;
        private static void Assert(bool value, string label) {
            if (!value) throw new Exception("Input fixture: " + label);
            assertions++;
        }
        private static void Fails(string code, Action action) {
            try { action(); } catch (InputFailure error) { Assert(error.Code == code, code + " error"); return; }
            throw new Exception("Input fixture: expected " + code);
        }
        private static InputLease Lease(Environment environment) {
            return new InputLease(environment, new InputWindow { Handle = new IntPtr(10),
                Bounds = new InputRect { Left = -500, Top = 0, Right = 500, Bottom = 500 } },
                () => environment.Cancelled, new UIntPtr(12345));
        }
        private static Dictionary<string, object> Action(string kind) {
            return new Dictionary<string, object> { { "kind", kind }, { "modifiers", new string[0] } };
        }
        private static bool Mouse(InputPacket packet, uint flag) { return packet.Type == 0 && packet.Data.Mouse.Flags == flag; }
        private static bool Key(InputPacket packet, ushort key, bool up) {
            return packet.Type == 1 && packet.Data.Keyboard.Key == key && ((packet.Data.Keyboard.Flags & 2) != 0) == up;
        }
        public static int Run() {
            Assert(Marshal.SizeOf(typeof(InputPacket)) == (IntPtr.Size == 8 ? 40 : 28), "SendInput ABI");
            using (var random = RandomNumberGenerator.Create()) {
                for (int i = 0; i < 32; i++) {
                    ulong marker = ForegroundInputHost.CreateMarker(random).ToUInt64();
                    Assert(marker > 0 && marker <= Int32.MaxValue, "marker survives narrowing and sign extension");
                }
            }
            var geometry = new GeometryEnvironment();
            var selected = new InputWindow { Handle = new IntPtr(10), Bounds = new InputRect { Left = -500, Top = -100, Right = 500, Bottom = 500 } };
            foreach (int hit in new[] { 1, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20 }) {
                geometry.Hit = hit;
                geometry.CheckPoint(selected, new InputPoint(-500, -100));
                geometry.CheckPoint(selected, new InputPoint(499, 499));
                Assert(true, "client/titlebar/border/control hit allowed");
            }
            foreach (int hit in new[] { -2, -1, 0, 3, 5, 19, 21, 22 }) {
                geometry.Hit = hit;
                Fails("input_outside_window", () => geometry.CheckPoint(selected, new InputPoint(0, 0)));
            }
            geometry.Hit = 1;
            foreach (InputPoint outside in new[] { new InputPoint(-501, 0), new InputPoint(500, 0), new InputPoint(0, -101), new InputPoint(0, 500) })
                Fails("input_outside_window", () => geometry.CheckPoint(selected, outside));
            foreach (int foreign in new[] { 0, 11, 20 }) {
                geometry.Root = new IntPtr(foreign);
                Fails("input_outside_window", () => geometry.CheckPoint(selected, new InputPoint(0, 0)));
            }
            InputPoint mapped = InputLease.Map(799, 399, 800, 400, new InputRect { Left = -1600, Top = -200, Right = 0, Bottom = 600 });
            Assert(mapped.X == -1 && mapped.Y == 599, "scaled screenshot and negative monitor origin");
            Fails("invalid_request", () => InputLease.Map(800, 0, 800, 400, new InputRect { Right = 1000, Bottom = 500 }));
            var obstruction = new Environment { CoveredMiddle = true };
            using (var lease = Lease(obstruction)) {
                Assert(lease.Begin(), "drag preflight activated");
                var drag = Action("drag"); drag["durationMs"] = 100;
                Fails("input_outside_window", () => lease.Execute(drag, new InputPoint(-100, 10), new InputPoint(100, 10)));
                Assert(obstruction.Packets.Count == 0, "foreign intermediate path refused before button down");
            }
            var asynchronous = new Environment { DelayedActivation = true };
            using (var lease = Lease(asynchronous)) {
                Assert(lease.Begin(), "wait for queued foreground activation");
                lease.ConfirmForeground();
                lease.Dispose();
                Assert(lease.FocusRestored == true && asynchronous.Active == new IntPtr(20), "wait for queued restoration");
                Assert(asynchronous.Activations.Count == 2, "never fight activation by repeating it");
            }
            foreach (string reason in new[] { "held", "active", "focus", "covered", "expiry" }) {
                var environment = new Environment();
                using (var lease = Lease(environment)) {
                    if (reason == "held") {
                        environment.Held = true;
                        Fails("user_interrupted", () => lease.Begin());
                    } else {
                        if (reason == "active") environment.CanActivate = false;
                        bool activated = lease.Begin();
                        if (reason == "active") { Assert(!activated, "activation denied"); Fails("focus_denied", () => lease.Check()); }
                        if (reason == "focus") {
                            lease.RequireFocus(environment.Focused); environment.Focused = new IntPtr(99);
                            Fails("keyboard_focus_changed", () => lease.Check());
                        }
                        if (reason == "covered") { environment.Covered = true; Fails("input_outside_window", () => lease.Point(new InputPoint(20, 20))); }
                        if (reason == "expiry") { environment.Clock += 10001; Fails("user_interrupted", () => lease.Check()); }
                    }
                    Assert(environment.Packets.Count == 0, reason + " sends no input");
                }
            }
            var textEnvironment = new Environment();
            using (var lease = Lease(textEnvironment)) {
                lease.Begin(); lease.RequireFocus(textEnvironment.Focused);
                var text = Action("type_text"); text["text"] = "A\u4e2d\ud83d\ude00";
                lease.Execute(text, new InputPoint(), new InputPoint());
                Assert(textEnvironment.Packets.Count == 8, "Unicode scalar down/up pairs");
                Assert(textEnvironment.Packets.All(packet => packet.Type == 1 && (packet.Data.Keyboard.Flags & 4) != 0), "Unicode input without clipboard");
                Assert(textEnvironment.Packets.All(packet => packet.Data.Keyboard.Extra == new UIntPtr(12345)), "injection marker");
                foreach (string invalid in new[] { "line\n", "\t", "\u0085", "\u2028", "\u2029", "\ud800", "\udc00" }) {
                    text["text"] = invalid;
                    Fails("invalid_request", () => lease.Execute(text, new InputPoint(), new InputPoint()));
                }
                lease.Dispose();
                Assert(lease.FocusRestored == true && textEnvironment.Active == new IntPtr(20), "restore previous focus");
            }
            var keyEnvironment = new Environment();
            using (var lease = Lease(keyEnvironment)) {
                lease.Begin(); lease.RequireFocus(keyEnvironment.Focused);
                var key = Action("press_key"); key["key"] = "ARROW_LEFT"; key["modifiers"] = new[] { "CTRL", "SHIFT" };
                lease.Execute(key, new InputPoint(), new InputPoint());
                Assert(keyEnvironment.Packets.Count == 6, "bounded full chord");
                Assert(keyEnvironment.Packets[2].Data.Keyboard.Flags == 1, "extended arrow key");
                Assert(Key(keyEnvironment.Packets[4], 0x10, true) && Key(keyEnvironment.Packets[5], 0x11, true), "reverse modifier release");
                foreach (string blocked in new[] { "TAB", "ESCAPE", "SPACE", "F6" }) {
                    key["key"] = blocked; key["modifiers"] = new[] { "ALT" };
                    Fails("unsupported_shortcut", () => lease.Execute(key, new InputPoint(), new InputPoint()));
                }
                key["key"] = "ESCAPE"; key["modifiers"] = new[] { "CTRL", "SHIFT" };
                Fails("unsupported_shortcut", () => lease.Execute(key, new InputPoint(), new InputPoint()));
                key["key"] = "DELETE"; key["modifiers"] = new[] { "CTRL", "ALT" };
                Fails("unsupported_shortcut", () => lease.Execute(key, new InputPoint(), new InputPoint()));
                key["key"] = "WIN"; key["modifiers"] = new string[0];
                Fails("invalid_request", () => lease.Execute(key, new InputPoint(), new InputPoint()));
            }
            foreach (string kind in new[] { "click", "move", "drag", "wheel" }) {
                var environment = new Environment();
                using (var lease = Lease(environment)) {
                    lease.Begin();
                    var action = Action(kind);
                    action["button"] = "right"; action["count"] = 2;
                    action["durationMs"] = 300; action["axis"] = "vertical"; action["steps"] = 2;
                    lease.Execute(action, new InputPoint(-400, 20), new InputPoint(300, 300));
                    if (kind == "click") Assert(environment.Packets.Count(packet => Mouse(packet, 8)) == 2 && environment.Packets.Count(packet => Mouse(packet, 16)) == 2, "right double click pairs");
                    if (kind == "wheel") Assert(environment.Packets.Any(packet => Mouse(packet, 0x800) && unchecked((int)packet.Data.Mouse.Data) == -240), "positive vertical wheel is down");
                    if (kind == "drag") Assert(environment.Packets.Count(packet => Mouse(packet, 2)) == 1 && environment.Packets.Count(packet => Mouse(packet, 4)) == 1, "bounded drag button pair");
                    Assert(environment.Packets.Any(packet => Mouse(packet, 0xC001)), "absolute virtual-desktop movement");
                    lease.Dispose();
                    Assert(lease.FocusRestored == true, "pointer focus restoration");
                }
            }
            foreach (string reason in new[] { "human", "cancel", "geometry" }) {
                var environment = new Environment();
                using (var lease = Lease(environment)) {
                    lease.Begin();
                    var action = Action("drag"); action["durationMs"] = 300; action["modifiers"] = new[] { "SHIFT" };
                    environment.OnEmit = packets => {
                        if (!packets.Any(packet => Mouse(packet, 2))) return;
                        if (reason == "human") { environment.Observer.TakenOver = true; environment.Active = new IntPtr(99); }
                        if (reason == "cancel") environment.Cancelled = true;
                        if (reason == "geometry") environment.Stale = true;
                    };
                    Fails(reason == "geometry" ? "stale_observation" : "user_interrupted", () => lease.Execute(action, new InputPoint(20, 20), new InputPoint(200, 200)));
                    lease.Dispose();
                    Assert(environment.Packets.Any(packet => Mouse(packet, 4)), reason + " releases mouse");
                    Assert(environment.Packets.Any(packet => Key(packet, 0x10, true)), reason + " releases modifier");
                    Assert(lease.EffectStarted, reason + " reports possible partial effects");
                    if (reason == "human") Assert(environment.Active == new IntPtr(99) && lease.FocusRestored == null && environment.Activations.Count == 1, "no focus fight after takeover");
                }
            }
            var partialEnvironment = new Environment();
            using (var lease = Lease(partialEnvironment)) {
                lease.Begin();
                var key = Action("press_key"); key["key"] = "A"; key["modifiers"] = new[] { "CTRL" };
                partialEnvironment.Partial = true;
                Fails("outcome_unknown", () => lease.Execute(key, new InputPoint(), new InputPoint()));
                lease.Dispose();
                Assert(partialEnvironment.Packets.Count == 2 && Key(partialEnvironment.Packets[1], 0x11, true), "partial chord releases accepted modifier");
            }
            return assertions;
        }
    }
}
