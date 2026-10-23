package app.shadow.mobile;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.security.KeyStore;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ShadowCredentialsTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final ShadowCredentialsPlugin plugin = new ShadowCredentialsPlugin() {
        @Override public Context getContext() { return context; }
    };

    private static class Call extends PluginCall {
        JSObject result;
        String error;
        boolean resolved;

        Call(JSObject data) { super(null, "ShadowCredentials", "test", "test", data); }
        Call() { this(new JSObject()); }
        @Override public void resolve() { resolved = true; }
        @Override public void resolve(JSObject data) { result = data; resolved = true; }
        @Override public void reject(String message, String code) { error = code; }
    }

    @Before @After
    public void clear() {
        Call call = new Call();
        plugin.remove(call);
        assertTrue(call.resolved);
        assertNull(call.error);
    }

    @Test
    public void roundTripEncryptsAndRemoves() throws Exception {
        assertEquals("app.shadow.mobile", context.getPackageName());
        Call missing = new Call();
        plugin.get(missing);
        assertTrue(missing.result.isNull("value"));
        Call write = new Call(new JSObject().put("value", "synthetic-secret-😀"));
        plugin.set(write);
        assertTrue(write.resolved);
        String record = context.getSharedPreferences("shadow_credentials", Context.MODE_PRIVATE).getString("record", "");
        assertFalse(record.contains("synthetic-secret"));
        Call read = new Call();
        plugin.get(read);
        assertEquals("synthetic-secret-😀", read.result.getString("value"));
        clear();
        plugin.get(missing = new Call());
        assertTrue(missing.result.isNull("value"));
    }

    @Test
    public void utf8LimitIsEnforcedWithoutReplacingExistingRecord() throws Exception {
        String boundary = new String(new char[4096]).replace("\0", "😀");
        Call write = new Call(new JSObject().put("value", boundary));
        plugin.set(write);
        assertTrue(write.resolved);
        Call oversized = new Call(new JSObject().put("value", boundary + "x"));
        plugin.set(oversized);
        assertEquals("INVALID_CREDENTIAL", oversized.error);
        Call read = new Call();
        plugin.get(read);
        assertEquals(boundary, read.result.getString("value"));
        Call wrongType = new Call(new JSObject().put("value", 42));
        plugin.set(wrongType);
        assertEquals("INVALID_CREDENTIAL", wrongType.error);
    }

    @Test
    public void corruptRecordFailsClosed() {
        context.getSharedPreferences("shadow_credentials", Context.MODE_PRIVATE)
            .edit().putString("record", "not-an-envelope").commit();
        Call read = new Call();
        plugin.get(read);
        assertEquals("SECURE_STORAGE_READ_FAILED", read.error);
        assertFalse(read.resolved);
    }

    @Test
    public void missingKeyRequiresExplicitRemovalBeforeRePairing() throws Exception {
        plugin.set(new Call(new JSObject().put("value", "synthetic")));
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        store.deleteEntry("app.shadow.mobile.credentials.v1");
        Call read = new Call();
        plugin.get(read);
        assertEquals("SECURE_STORAGE_READ_FAILED", read.error);
        Call write = new Call(new JSObject().put("value", "replacement"));
        plugin.set(write);
        assertEquals("SECURE_STORAGE_WRITE_FAILED", write.error);
        clear();
        write = new Call(new JSObject().put("value", "replacement"));
        plugin.set(write);
        assertTrue(write.resolved);
    }
}
