package com.screengoblin.player;

import android.app.Activity;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(name = "DeviceCommandJournal")
public final class DeviceCommandJournalPlugin extends Plugin {
    private static final String PREFERENCES = "device-command-journal-v1";
    private final String rendererLifecycleId = UUID.randomUUID().toString();
    private volatile DeviceCommandJournal journal;

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSArray actions = new JSArray();
        actions.put(DeviceCommandJournal.REFRESH_CONTENT);
        actions.put(DeviceCommandJournal.RESTART_RENDERER);
        JSObject result = new JSObject();
        result.put("actions", actions);
        result.put("schemaVersion", DeviceCommandJournal.SCHEMA_VERSION);
        call.resolve(result);
    }

    @PluginMethod
    public void accept(PluginCall call) {
        try {
            long generation = decimal(call, "credentialGeneration");
            long sequence = decimal(call, "sequence");
            String action = call.getString("action");
            Activity restartActivity = null;
            if (DeviceCommandJournal.RESTART_RENDERER.equals(action)) {
                restartActivity = requireRendererActivity();
            }
            DeviceCommandJournal.Result accepted = journal().accept(
                generation,
                sequence,
                call.getString("commandId"),
                action,
                rendererLifecycleId
            );
            if (accepted.restartRequired &&
                rendererLifecycleId.equals(accepted.acceptedRendererLifecycleId)) {
                Activity activity = restartActivity;
                activity.runOnUiThread(activity::recreate);
            }
            call.resolve(result(accepted));
        } catch (DeviceCommandJournal.JournalException exception) {
            call.reject(exception.getMessage(), exception.code);
        } catch (RuntimeException exception) {
            call.reject("Native device command journal is unavailable", "JOURNAL_IO");
        }
    }

    DeviceCommandJournal.Result confirmRendererReady(
        long sequence,
        String commandId
    ) throws DeviceCommandJournal.JournalException {
        requireRendererActivity();
        return journal().confirmRendererRestarted(
            sequence,
            commandId,
            rendererLifecycleId
        );
    }

    @PluginMethod
    public void completeRefresh(PluginCall call) {
        try {
            Boolean succeeded = call.getBoolean("succeeded");
            if (succeeded == null) throw invalid("succeeded is required");
            call.resolve(result(journal().completeRefresh(
                decimal(call, "sequence"),
                call.getString("commandId"),
                succeeded
            )));
        } catch (DeviceCommandJournal.JournalException exception) {
            call.reject(exception.getMessage(), exception.code);
        } catch (RuntimeException exception) {
            call.reject("Native device command journal is unavailable", "JOURNAL_IO");
        }
    }

    @PluginMethod
    public void pendingAcknowledgement(PluginCall call) {
        try {
            DeviceCommandJournal.Result pending = journal().pendingAcknowledgement();
            JSObject result = new JSObject();
            result.put("pending", pending != null);
            if (pending != null) result.put("acknowledgement", result(pending));
            call.resolve(result);
        } catch (DeviceCommandJournal.JournalException exception) {
            call.reject(exception.getMessage(), exception.code);
        } catch (RuntimeException exception) {
            call.reject("Native device command journal is unavailable", "JOURNAL_IO");
        }
    }

    @PluginMethod
    public void markAcknowledgementDelivered(PluginCall call) {
        try {
            call.resolve(result(journal().markAcknowledgementDelivered(
                decimal(call, "sequence"),
                call.getString("commandId")
            )));
        } catch (DeviceCommandJournal.JournalException exception) {
            call.reject(exception.getMessage(), exception.code);
        } catch (RuntimeException exception) {
            call.reject("Native device command journal is unavailable", "JOURNAL_IO");
        }
    }

    private DeviceCommandJournal journal() {
        DeviceCommandJournal current = journal;
        if (current != null) return current;
        synchronized (this) {
            if (journal == null) journal = new DeviceCommandJournal(new PreferencesPersistence());
            return journal;
        }
    }

    private Activity requireRendererActivity()
        throws DeviceCommandJournal.JournalException {
        Activity activity = getActivity();
        if (activity == null) {
            throw new DeviceCommandJournal.JournalException(
                "RENDERER_UNAVAILABLE",
                "Renderer activity is unavailable"
            );
        }
        return activity;
    }

    private long decimal(PluginCall call, String name)
        throws DeviceCommandJournal.JournalException {
        String value = call.getString(name);
        if (value == null || !value.matches("^(0|[1-9][0-9]{0,15})$")) {
            throw invalid(name + " must be a canonical decimal string");
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException exception) {
            throw invalid(name + " is out of range");
        }
    }

    private static DeviceCommandJournal.JournalException invalid(String message) {
        return new DeviceCommandJournal.JournalException("INVALID_ARGUMENT", message);
    }

    private static JSObject result(DeviceCommandJournal.Result value) {
        JSObject result = new JSObject();
        result.put("duplicate", value.duplicate);
        result.put("credentialGeneration", Long.toString(value.credentialGeneration));
        result.put("sequence", Long.toString(value.sequence));
        result.put("commandId", value.commandId);
        result.put("action", value.action);
        result.put("state", value.state.name());
        result.put("pendingTerminalAck", value.pendingTerminalAck);
        result.put("restartRequired", value.restartRequired);
        return result;
    }

    private final class PreferencesPersistence implements DeviceCommandJournal.Persistence {
        @Override
        public String storageKey() {
            return PREFERENCES;
        }

        @Override
        public Map<String, String> read() throws DeviceCommandJournal.JournalException {
            Map<String, ?> stored = preferences().getAll();
            Map<String, String> values = new LinkedHashMap<>();
            for (Map.Entry<String, ?> entry : stored.entrySet()) {
                if (!(entry.getValue() instanceof String)) {
                    throw new DeviceCommandJournal.JournalException(
                        "STATE_CORRUPT",
                        "Durable device command state is corrupt"
                    );
                }
                values.put(entry.getKey(), (String) entry.getValue());
            }
            return values;
        }

        @Override
        public boolean replace(Map<String, String> values) {
            SharedPreferences.Editor editor = preferences().edit().clear();
            for (Map.Entry<String, String> entry : values.entrySet()) {
                editor.putString(entry.getKey(), entry.getValue());
            }
            return editor.commit();
        }

        private SharedPreferences preferences() {
            return getContext().getSharedPreferences(PREFERENCES, 0);
        }
    }
}
