package com.screengoblin.player;

import android.content.pm.ApplicationInfo;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NativeAssetCache")
public final class MediaCachePlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private volatile MediaCacheStore store;

    @Override
    public void load() {
        executor.execute(() -> {
            try {
                store();
            } catch (MediaCacheStore.CacheException ignored) {
                // The foreground operation retries initialization and reports a stable error.
            }
        });
    }

    @PluginMethod
    public void prefetch(PluginCall call) {
        onBackground(call, () -> {
            MediaCacheStore.Asset asset = MediaCacheStore.Asset.forPrefetch(
                call.getString("assetId"),
                call.getString("url"),
                call.getString("mediaCapability"),
                call.getString("mimeType"),
                call.getString("checksumSha256"),
                call.getLong("sizeBytes"),
                isDebuggable()
            );
            File file = store().prefetch(asset);
            JSObject result = new JSObject();
            result.put("path", Uri.fromFile(file).toString());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void resolve(PluginCall call) {
        onBackground(call, () -> {
            File file = store().resolve(
                call.getString("assetId"),
                call.getString("mimeType"),
                call.getString("checksumSha256"),
                call.getLong("sizeBytes")
            );
            JSObject result = new JSObject();
            result.put("path", Uri.fromFile(file).toString());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void prune(PluginCall call) {
        onBackground(call, () -> {
            JSArray retainedAssets = call.getArray("retainedAssets");
            if (retainedAssets == null) throw invalid("retainedAssets is required");
            Set<String> retainedFileNames = new HashSet<>();
            try {
                for (int index = 0; index < retainedAssets.length(); index++) {
                    Object entry = retainedAssets.get(index);
                    if (!(entry instanceof JSONObject)) throw invalid("retainedAssets entries must be objects");
                    Object digest = ((JSONObject) entry).opt("checksumSha256");
                    Object mimeType = ((JSONObject) entry).opt("mimeType");
                    Object assetId = ((JSONObject) entry).opt("assetId");
                    if (!(digest instanceof String)) throw invalid("retained checksumSha256 is required");
                    if (!(mimeType instanceof String)) throw invalid("retained mimeType is required");
                    if (!(assetId instanceof String)) throw invalid("retained assetId is required");
                    retainedFileNames.add(
                        MediaCacheStore.Asset.retainedFileName((String) assetId, (String) mimeType, (String) digest)
                    );
                }
            } catch (JSONException exception) {
                throw new MediaCacheStore.CacheException("INVALID_ARGUMENT", "retainedAssets is invalid", exception);
            }
            store().prune(retainedFileNames);
            call.resolve();
        });
    }

    @PluginMethod
    public void removeAll(PluginCall call) {
        onBackground(call, () -> {
            store().removeAll();
            call.resolve();
        });
    }

    @PluginMethod
    public void storageStats(PluginCall call) {
        onBackground(call, () -> {
            JSObject result = new JSObject();
            result.put("availableBytes", store().availableBytes());
            call.resolve(result);
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private MediaCacheStore store() throws MediaCacheStore.CacheException {
        MediaCacheStore current = store;
        if (current != null) return current;
        synchronized (this) {
            if (store == null) store = new MediaCacheStore(getContext().getFilesDir());
            return store;
        }
    }

    private boolean isDebuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private void onBackground(PluginCall call, Operation operation) {
        try {
            executor.execute(() -> {
                try {
                    operation.run();
                } catch (MediaCacheStore.CacheException exception) {
                    call.reject(exception.getMessage(), exception.code);
                } catch (Exception exception) {
                    call.reject("Native media cache operation failed", "CACHE_IO");
                }
            });
        } catch (RuntimeException exception) {
            call.reject("Native media cache is unavailable", "CACHE_IO");
        }
    }

    private static MediaCacheStore.CacheException invalid(String message) {
        return new MediaCacheStore.CacheException("INVALID_ARGUMENT", message);
    }

    private interface Operation {
        void run() throws Exception;
    }
}
