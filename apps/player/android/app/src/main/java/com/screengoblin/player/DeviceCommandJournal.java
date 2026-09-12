package com.screengoblin.player;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

final class DeviceCommandJournal {
    static final int SCHEMA_VERSION = 1;
    static final String REFRESH_CONTENT = "REFRESH_CONTENT";
    static final String RESTART_RENDERER = "RESTART_RENDERER";
    static final Set<String> SUPPORTED_ACTIONS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(REFRESH_CONTENT, RESTART_RENDERER))
    );

    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Set<String> STATE_KEYS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "schemaVersion",
            "credentialGeneration",
            "highestSequence",
            "commandId",
            "action",
            "acceptedRendererLifecycleId",
            "state",
            "pendingTerminalAck",
            "restartRequired"
        ))
    );

    enum CommandState {
        REFRESH_REQUIRED,
        RESTART_REQUIRED,
        SUCCEEDED,
        FAILED
    }

    interface Persistence {
        String storageKey();
        Map<String, String> read() throws JournalException;
        boolean replace(Map<String, String> values);
    }

    static final class JournalException extends Exception {
        final String code;

        JournalException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    static final class Result {
        final boolean duplicate;
        final long credentialGeneration;
        final long sequence;
        final String commandId;
        final String action;
        final String acceptedRendererLifecycleId;
        final CommandState state;
        final boolean pendingTerminalAck;
        final boolean restartRequired;

        Result(Snapshot snapshot, boolean duplicate) {
            this.duplicate = duplicate;
            this.credentialGeneration = snapshot.credentialGeneration;
            this.sequence = snapshot.highestSequence;
            this.commandId = snapshot.commandId;
            this.action = snapshot.action;
            this.acceptedRendererLifecycleId = snapshot.acceptedRendererLifecycleId;
            this.state = snapshot.state;
            this.pendingTerminalAck = snapshot.pendingTerminalAck;
            this.restartRequired = snapshot.restartRequired;
        }
    }

    private static final class Snapshot {
        final long credentialGeneration;
        final long highestSequence;
        final String commandId;
        final String action;
        final String acceptedRendererLifecycleId;
        final CommandState state;
        final boolean pendingTerminalAck;
        final boolean restartRequired;

        Snapshot(
            long credentialGeneration,
            long highestSequence,
            String commandId,
            String action,
            String acceptedRendererLifecycleId,
            CommandState state,
            boolean pendingTerminalAck,
            boolean restartRequired
        ) {
            this.credentialGeneration = credentialGeneration;
            this.highestSequence = highestSequence;
            this.commandId = commandId;
            this.action = action;
            this.acceptedRendererLifecycleId = acceptedRendererLifecycleId;
            this.state = state;
            this.pendingTerminalAck = pendingTerminalAck;
            this.restartRequired = restartRequired;
        }

        static Snapshot parse(Map<String, String> values) throws JournalException {
            if (values.isEmpty()) return null;
            if (!values.keySet().equals(STATE_KEYS)) throw corrupt();
            if (!Integer.toString(SCHEMA_VERSION).equals(values.get("schemaVersion"))) throw corrupt();

            long generation = parseStoredNumber(values.get("credentialGeneration"));
            long sequence = parseStoredNumber(values.get("highestSequence"));
            String commandId = parseStoredUuid(values.get("commandId"));
            String action = parseStoredAction(values.get("action"));
            String acceptedRendererLifecycleId = parseStoredUuid(
                values.get("acceptedRendererLifecycleId")
            );
            CommandState state;
            try {
                state = CommandState.valueOf(values.get("state"));
            } catch (RuntimeException exception) {
                throw corrupt();
            }
            boolean pendingAck = parseBoolean(values.get("pendingTerminalAck"));
            boolean restart = parseBoolean(values.get("restartRequired"));
            boolean terminal = state == CommandState.SUCCEEDED || state == CommandState.FAILED;
            boolean pendingRefresh = state == CommandState.REFRESH_REQUIRED;
            boolean pendingRestart = state == CommandState.RESTART_REQUIRED;
            boolean actionStateValid = REFRESH_CONTENT.equals(action)
                ? pendingRefresh || terminal
                : pendingRestart || state == CommandState.SUCCEEDED;
            if ((pendingAck && !terminal) || restart != pendingRestart ||
                !actionStateValid) {
                throw corrupt();
            }
            return new Snapshot(
                generation,
                sequence,
                commandId,
                action,
                acceptedRendererLifecycleId,
                state,
                pendingAck,
                restart
            );
        }

        Map<String, String> encode() {
            Map<String, String> values = new LinkedHashMap<>();
            values.put("schemaVersion", Integer.toString(SCHEMA_VERSION));
            values.put("credentialGeneration", Long.toString(credentialGeneration));
            values.put("highestSequence", Long.toString(highestSequence));
            values.put("commandId", commandId);
            values.put("action", action);
            values.put("acceptedRendererLifecycleId", acceptedRendererLifecycleId);
            values.put("state", state.name());
            values.put("pendingTerminalAck", Boolean.toString(pendingTerminalAck));
            values.put("restartRequired", Boolean.toString(restartRequired));
            return values;
        }
    }

    private static final Object PROCESS_LOCK = new Object();
    private static final Set<String> UNCERTAIN_STORAGE_KEYS = new HashSet<>();
    private final Persistence persistence;
    private final String storageKey;

    DeviceCommandJournal(Persistence persistence) {
        this.persistence = persistence;
        this.storageKey = persistence.storageKey();
        if (storageKey == null || storageKey.isEmpty()) {
            throw new IllegalArgumentException("Journal persistence requires a stable storage key");
        }
    }

    Result accept(
        long credentialGeneration,
        long sequence,
        String commandId,
        String action,
        String rendererLifecycleId
    ) throws JournalException {
        synchronized (PROCESS_LOCK) {
            return acceptLocked(
                credentialGeneration,
                sequence,
                commandId,
                action,
                rendererLifecycleId
            );
        }
    }

    private Result acceptLocked(
        long credentialGeneration,
        long sequence,
        String commandId,
        String action,
        String rendererLifecycleId
    ) throws JournalException {
        requireNumber(credentialGeneration, "credentialGeneration");
        requireNumber(sequence, "sequence");
        commandId = canonicalUuid(commandId, "commandId");
        action = supportedAction(action);
        rendererLifecycleId = canonicalUuid(rendererLifecycleId, "rendererLifecycleId");

        Snapshot current = load();
        if (current != null) {
            if (credentialGeneration < current.credentialGeneration) {
                throw new JournalException("GENERATION_ROLLBACK", "Credential generation is older than durable state");
            }
            if (credentialGeneration == current.credentialGeneration) {
                if (sequence < current.highestSequence) {
                    throw new JournalException("SEQUENCE_ROLLBACK", "Command sequence is older than durable state");
                }
                if (sequence == current.highestSequence) {
                    if (!commandId.equals(current.commandId) || !action.equals(current.action)) {
                        throw new JournalException("SEQUENCE_CONFLICT", "Command sequence conflicts with durable state");
                    }
                    return new Result(current, true);
                }
            }
            if (credentialGeneration == current.credentialGeneration &&
                (current.restartRequired || current.pendingTerminalAck ||
                    current.state == CommandState.REFRESH_REQUIRED)) {
                throw new JournalException("COMMAND_BUSY", "A durable command result must be completed and acknowledged first");
            }
        }

        CommandState state = action.equals(RESTART_RENDERER)
            ? CommandState.RESTART_REQUIRED
            : CommandState.REFRESH_REQUIRED;
        Snapshot next = new Snapshot(
            credentialGeneration,
            sequence,
            commandId,
            action,
            rendererLifecycleId,
            state,
            false,
            state == CommandState.RESTART_REQUIRED
        );
        persist(next);
        return new Result(next, false);
    }

    Result completeRefresh(
        long sequence,
        String commandId,
        boolean succeeded
    ) throws JournalException {
        synchronized (PROCESS_LOCK) {
            return completeRefreshLocked(sequence, commandId, succeeded);
        }
    }

    private Result completeRefreshLocked(
        long sequence,
        String commandId,
        boolean succeeded
    ) throws JournalException {
        Snapshot current = required();
        requireIdentity(current, sequence, commandId);
        if (!REFRESH_CONTENT.equals(current.action) ||
            current.state != CommandState.REFRESH_REQUIRED) {
            throw new JournalException("INVALID_TRANSITION", "Only a pending refresh can be completed");
        }
        Snapshot next = terminal(current, succeeded);
        persist(next);
        return new Result(next, false);
    }

    Result confirmRendererRestarted(
        long sequence,
        String commandId,
        String rendererLifecycleId
    ) throws JournalException {
        synchronized (PROCESS_LOCK) {
            Snapshot current = required();
            requireIdentity(current, sequence, commandId);
            rendererLifecycleId = canonicalUuid(rendererLifecycleId, "rendererLifecycleId");
            if (!RESTART_RENDERER.equals(current.action) ||
                current.state != CommandState.RESTART_REQUIRED || !current.restartRequired) {
                throw new JournalException("INVALID_TRANSITION", "Only a pending renderer restart can be completed");
            }
            if (rendererLifecycleId.equals(current.acceptedRendererLifecycleId)) {
                throw new JournalException(
                    "LIFECYCLE_NOT_ADVANCED",
                    "Renderer restart requires a different ready lifecycle"
                );
            }
            Snapshot next = terminal(current, true);
            persist(next);
            return new Result(next, false);
        }
    }

    Result pendingAcknowledgement() throws JournalException {
        synchronized (PROCESS_LOCK) {
            Snapshot current = load();
            return current != null && current.pendingTerminalAck ? new Result(current, true) : null;
        }
    }

    Result markAcknowledgementDelivered(
        long sequence,
        String commandId
    ) throws JournalException {
        synchronized (PROCESS_LOCK) {
            Snapshot current = required();
            requireIdentity(current, sequence, commandId);
            if (!current.pendingTerminalAck ||
                (current.state != CommandState.SUCCEEDED && current.state != CommandState.FAILED)) {
                throw new JournalException("INVALID_TRANSITION", "No terminal acknowledgement is pending");
            }
            Snapshot next = new Snapshot(
                current.credentialGeneration,
                current.highestSequence,
                current.commandId,
                current.action,
                current.acceptedRendererLifecycleId,
                current.state,
                false,
                false
            );
            persist(next);
            return new Result(next, false);
        }
    }

    private Snapshot required() throws JournalException {
        Snapshot current = load();
        if (current == null) throw new JournalException("COMMAND_NOT_FOUND", "No durable command exists");
        return current;
    }

    private Snapshot load() throws JournalException {
        if (UNCERTAIN_STORAGE_KEYS.contains(storageKey)) {
            throw new JournalException(
                "STATE_UNCERTAIN",
                "Durable device command state is uncertain until process restart"
            );
        }
        Map<String, String> values = persistence.read();
        if (values == null) throw corrupt();
        return Snapshot.parse(values);
    }

    private void persist(Snapshot snapshot) throws JournalException {
        boolean replaced;
        try {
            replaced = persistence.replace(snapshot.encode());
        } catch (RuntimeException exception) {
            UNCERTAIN_STORAGE_KEYS.add(storageKey);
            throw new JournalException(
                "PERSISTENCE_UNCERTAIN",
                "Durable device command commit outcome is uncertain"
            );
        }
        if (!replaced) {
            UNCERTAIN_STORAGE_KEYS.add(storageKey);
            throw new JournalException(
                "PERSISTENCE_UNCERTAIN",
                "Durable device command commit outcome is uncertain"
            );
        }
    }

    private static Snapshot terminal(Snapshot current, boolean succeeded) {
        return new Snapshot(
            current.credentialGeneration,
            current.highestSequence,
            current.commandId,
            current.action,
            current.acceptedRendererLifecycleId,
            succeeded ? CommandState.SUCCEEDED : CommandState.FAILED,
            true,
            false
        );
    }

    private static void requireIdentity(
        Snapshot current,
        long sequence,
        String commandId
    ) throws JournalException {
        requireNumber(sequence, "sequence");
        commandId = canonicalUuid(commandId, "commandId");
        if (sequence != current.highestSequence || !commandId.equals(current.commandId)) {
            throw new JournalException("COMMAND_MISMATCH", "Command does not match durable state");
        }
    }

    private static long parseStoredNumber(String value) throws JournalException {
        try {
            long number = Long.parseLong(value);
            requireNumber(number, "number");
            if (!Long.toString(number).equals(value)) throw corrupt();
            return number;
        } catch (NumberFormatException | JournalException exception) {
            throw corrupt();
        }
    }

    private static void requireNumber(long value, String name) throws JournalException {
        if (value < 0 || value > MAX_SAFE_INTEGER) {
            throw new JournalException("INVALID_ARGUMENT", name + " must be a non-negative safe integer");
        }
    }

    private static boolean parseBoolean(String value) throws JournalException {
        if ("true".equals(value)) return true;
        if ("false".equals(value)) return false;
        throw corrupt();
    }

    private static String canonicalUuid(String value, String name) throws JournalException {
        if (value == null || value.length() != 36 || !value.equals(value.toLowerCase())) {
            throw new JournalException("INVALID_ARGUMENT", name + " must be a canonical lowercase UUID");
        }
        try {
            if (!UUID.fromString(value).toString().equals(value)) throw new IllegalArgumentException();
            return value;
        } catch (IllegalArgumentException exception) {
            throw new JournalException("INVALID_ARGUMENT", name + " must be a canonical lowercase UUID");
        }
    }

    private static String supportedAction(String value) throws JournalException {
        if (!SUPPORTED_ACTIONS.contains(value)) {
            throw new JournalException("UNSUPPORTED_ACTION", "Device command action is not supported");
        }
        return value;
    }

    private static String parseStoredUuid(String value) throws JournalException {
        try {
            return canonicalUuid(value, "stored UUID");
        } catch (JournalException exception) {
            throw corrupt();
        }
    }

    private static String parseStoredAction(String value) throws JournalException {
        try {
            return supportedAction(value);
        } catch (JournalException exception) {
            throw corrupt();
        }
    }

    private static JournalException corrupt() {
        return new JournalException("STATE_CORRUPT", "Durable device command state is corrupt");
    }
}
