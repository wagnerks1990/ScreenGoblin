package com.screengoblin.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public final class DeviceCommandJournalTest {
    private static final AtomicInteger STORAGE_IDS = new AtomicInteger();
    private static final String FIRST = "11111111-1111-4111-8111-111111111111";
    private static final String SECOND = "22222222-2222-4222-8222-222222222222";
    private static final String LIFECYCLE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String LIFECYCLE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    @Test
    public void reportsOnlyBoundedNonShellActions() {
        assertEquals(2, DeviceCommandJournal.SUPPORTED_ACTIONS.size());
        assertTrue(DeviceCommandJournal.SUPPORTED_ACTIONS.contains("REFRESH_CONTENT"));
        assertTrue(DeviceCommandJournal.SUPPORTED_ACTIONS.contains("RESTART_RENDERER"));
        assertFalse(DeviceCommandJournal.SUPPORTED_ACTIONS.contains("REBOOT"));
        assertFalse(DeviceCommandJournal.SUPPORTED_ACTIONS.contains("SHELL"));
    }

    @Test
    public void refreshPersistsTerminalAcknowledgementAcrossInstances() throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        DeviceCommandJournal first = new DeviceCommandJournal(persistence);

        DeviceCommandJournal.Result accepted = first.accept(3, 7, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);
        assertFalse(accepted.duplicate);
        assertEquals(DeviceCommandJournal.CommandState.REFRESH_REQUIRED, accepted.state);
        assertNull(first.pendingAcknowledgement());

        first.completeRefresh(7, FIRST, true);
        DeviceCommandJournal.Result recovered =
            new DeviceCommandJournal(persistence).pendingAcknowledgement();
        assertNotNull(recovered);
        assertEquals(DeviceCommandJournal.CommandState.SUCCEEDED, recovered.state);
        assertEquals("7", Long.toString(recovered.sequence));

        new DeviceCommandJournal(persistence).markAcknowledgementDelivered(7, FIRST);
        assertNull(new DeviceCommandJournal(persistence).pendingAcknowledgement());
        DeviceCommandJournal.Result next =
            new DeviceCommandJournal(persistence).accept(3, 8, SECOND, "REFRESH_CONTENT", LIFECYCLE_A);
        assertEquals(8, next.sequence);
    }

    @Test
    public void identicalRedeliveryIsIdempotentButEqualSequenceConflictFails() throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);
        journal.accept(4, 12, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);

        DeviceCommandJournal.Result duplicate =
            new DeviceCommandJournal(persistence).accept(4, 12, FIRST, "REFRESH_CONTENT", LIFECYCLE_B);
        assertTrue(duplicate.duplicate);
        assertEquals(DeviceCommandJournal.CommandState.REFRESH_REQUIRED, duplicate.state);

        assertCode(
            "SEQUENCE_CONFLICT",
            () -> journal.accept(4, 12, SECOND, "REFRESH_CONTENT", LIFECYCLE_A)
        );
        assertCode(
            "SEQUENCE_CONFLICT",
            () -> journal.accept(4, 12, FIRST, "RESTART_RENDERER", LIFECYCLE_A)
        );
    }

    @Test
    public void rejectsSequenceAndCredentialGenerationRollback() throws Exception {
        DeviceCommandJournal journal = new DeviceCommandJournal(new MemoryPersistence());
        journal.accept(9, 20, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);

        assertCode(
            "SEQUENCE_ROLLBACK",
            () -> journal.accept(9, 19, SECOND, "REFRESH_CONTENT", LIFECYCLE_A)
        );
        assertCode(
            "GENERATION_ROLLBACK",
            () -> journal.accept(8, 21, SECOND, "REFRESH_CONTENT", LIFECYCLE_A)
        );
    }

    @Test
    public void higherGenerationSupersedesPendingRefreshAndResetsSequence() throws Exception {
        assertGenerationSupersedes(DeviceCommandJournal.CommandState.REFRESH_REQUIRED);
    }

    @Test
    public void higherGenerationSupersedesPendingRestartAndResetsSequence() throws Exception {
        assertGenerationSupersedes(DeviceCommandJournal.CommandState.RESTART_REQUIRED);
    }

    @Test
    public void higherGenerationSupersedesSucceededPendingAckAndResetsSequence() throws Exception {
        assertGenerationSupersedes(DeviceCommandJournal.CommandState.SUCCEEDED);
    }

    @Test
    public void higherGenerationSupersedesFailedPendingAckAndResetsSequence() throws Exception {
        assertGenerationSupersedes(DeviceCommandJournal.CommandState.FAILED);
    }

    @Test
    public void blocksNewWorkUntilPendingCommandAndAckAreFinished() throws Exception {
        DeviceCommandJournal journal = new DeviceCommandJournal(new MemoryPersistence());
        journal.accept(1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);
        assertCode(
            "COMMAND_BUSY",
            () -> journal.accept(1, 2, SECOND, "REFRESH_CONTENT", LIFECYCLE_A)
        );

        journal.completeRefresh(1, FIRST, false);
        assertCode(
            "COMMAND_BUSY",
            () -> journal.accept(1, 2, SECOND, "REFRESH_CONTENT", LIFECYCLE_A)
        );
    }

    @Test
    public void restartRemainsPendingAcrossDeathAndReloadUntilNewLifecycleReportsReady() throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        DeviceCommandJournal original = new DeviceCommandJournal(persistence);
        DeviceCommandJournal.Result accepted =
            original.accept(2, 5, FIRST, "RESTART_RENDERER", LIFECYCLE_A);
        assertTrue(accepted.restartRequired);
        assertEquals(DeviceCommandJournal.CommandState.RESTART_REQUIRED, accepted.state);

        DeviceCommandJournal afterReload = new DeviceCommandJournal(persistence);
        assertNull(afterReload.pendingAcknowledgement());
        DeviceCommandJournal.Result duplicate = afterReload.accept(
            2, 5, FIRST, "RESTART_RENDERER", LIFECYCLE_B
        );
        assertTrue(duplicate.duplicate);
        assertTrue(duplicate.restartRequired);
        assertEquals(LIFECYCLE_A, duplicate.acceptedRendererLifecycleId);
        assertCode(
            "LIFECYCLE_NOT_ADVANCED",
            () -> afterReload.confirmRendererRestarted(5, FIRST, LIFECYCLE_A)
        );

        DeviceCommandJournal.Result completed =
            afterReload.confirmRendererRestarted(5, FIRST, LIFECYCLE_B);
        assertFalse(completed.restartRequired);
        assertTrue(completed.pendingTerminalAck);
        assertEquals(DeviceCommandJournal.CommandState.SUCCEEDED, completed.state);

        assertNotNull(new DeviceCommandJournal(persistence).pendingAcknowledgement());
    }

    @Test
    public void rejectsUnsupportedActionsAndNoncanonicalIds() {
        DeviceCommandJournal journal = new DeviceCommandJournal(new MemoryPersistence());
        assertCode("UNSUPPORTED_ACTION", () -> journal.accept(1, 1, FIRST, "REBOOT", LIFECYCLE_A));
        assertCode("INVALID_ARGUMENT", () ->
            journal.accept(1, 1, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "REFRESH_CONTENT", LIFECYCLE_A)
        );
    }

    @Test
    public void corruptOrPartiallyWrittenStateFailsClosedWithoutRepair() {
        MemoryPersistence persistence = new MemoryPersistence();
        persistence.values.put("schemaVersion", "1");
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);

        assertCode("STATE_CORRUPT", journal::pendingAcknowledgement);
        assertEquals(1, persistence.values.size());
        assertEquals("1", persistence.values.get("schemaVersion"));
    }

    @Test
    public void everyMalformedStoredFieldAndActionStateMismatchIsCorrupt() throws Exception {
        assertStoredCorruption("credentialGeneration", "-1");
        assertStoredCorruption("credentialGeneration", "01");
        assertStoredCorruption("highestSequence", "9007199254740992");
        assertStoredCorruption("commandId", "not-a-uuid");
        assertStoredCorruption("acceptedRendererLifecycleId", "not-a-uuid");
        assertStoredCorruption("action", "SHELL");
        assertStoredCorruption("action", "RESTART_RENDERER");
    }

    @Test
    public void actionStateAndPendingFlagMatrixFailsClosed() throws Exception {
        MemoryPersistence restartFailed = new MemoryPersistence();
        DeviceCommandJournal restart = new DeviceCommandJournal(restartFailed);
        restart.accept(1, 1, FIRST, "RESTART_RENDERER", LIFECYCLE_A);
        restartFailed.values.put("state", "FAILED");
        restartFailed.values.put("pendingTerminalAck", "true");
        restartFailed.values.put("restartRequired", "false");
        assertCode("STATE_CORRUPT", restart::pendingAcknowledgement);

        MemoryPersistence pendingAck = new MemoryPersistence();
        DeviceCommandJournal refresh = new DeviceCommandJournal(pendingAck);
        refresh.accept(1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);
        pendingAck.values.put("pendingTerminalAck", "true");
        assertCode("STATE_CORRUPT", refresh::pendingAcknowledgement);

        MemoryPersistence refreshRestartFlag = new MemoryPersistence();
        DeviceCommandJournal refreshWithRestartFlag =
            new DeviceCommandJournal(refreshRestartFlag);
        refreshWithRestartFlag.accept(
            1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A
        );
        refreshRestartFlag.values.put("restartRequired", "true");
        assertCode("STATE_CORRUPT", refreshWithRestartFlag::pendingAcknowledgement);

        MemoryPersistence missingRestartFlag = new MemoryPersistence();
        DeviceCommandJournal restartWithoutFlag =
            new DeviceCommandJournal(missingRestartFlag);
        restartWithoutFlag.accept(
            1, 1, FIRST, "RESTART_RENDERER", LIFECYCLE_A
        );
        missingRestartFlag.values.put("restartRequired", "false");
        assertCode("STATE_CORRUPT", restartWithoutFlag::pendingAcknowledgement);
    }

    @Test
    public void refreshMayPersistBothSucceededAndFailedTerminalStates() throws Exception {
        for (boolean succeeded : new boolean[] { true, false }) {
            MemoryPersistence persistence = new MemoryPersistence();
            DeviceCommandJournal journal = new DeviceCommandJournal(persistence);
            journal.accept(1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);
            DeviceCommandJournal.Result completed = journal.completeRefresh(1, FIRST, succeeded);
            assertEquals(
                succeeded
                    ? DeviceCommandJournal.CommandState.SUCCEEDED
                    : DeviceCommandJournal.CommandState.FAILED,
                completed.state
            );
            assertNotNull(new DeviceCommandJournal(persistence).pendingAcknowledgement());
        }
    }

    @Test
    public void processLockSerializesTwoJournalInstancesAcrossReadModifyWrite() throws Exception {
        BlockingPersistence persistence = new BlockingPersistence();
        DeviceCommandJournal first = new DeviceCommandJournal(persistence);
        DeviceCommandJournal second = new DeviceCommandJournal(persistence);
        AtomicReference<DeviceCommandJournal.Result> firstResult = new AtomicReference<>();
        AtomicReference<DeviceCommandJournal.JournalException> firstError = new AtomicReference<>();
        AtomicReference<DeviceCommandJournal.JournalException> secondError = new AtomicReference<>();

        Thread firstThread = new Thread(() -> acceptInto(
            first,
            1,
            1,
            FIRST,
            firstResult,
            firstError
        ));
        firstThread.start();
        assertTrue(persistence.firstReadEntered.await(2, TimeUnit.SECONDS));

        Thread secondThread = new Thread(() -> acceptInto(
            second,
            1,
            2,
            SECOND,
            new AtomicReference<>(),
            secondError
        ));
        secondThread.start();
        boolean secondEnteredBeforeRelease =
            persistence.secondReadEntered.await(200, TimeUnit.MILLISECONDS);
        persistence.releaseFirstRead.countDown();
        assertFalse(
            "a second journal instance must not enter persistence during the first transaction",
            secondEnteredBeforeRelease
        );
        firstThread.join(2_000);
        secondThread.join(2_000);
        assertFalse(firstThread.isAlive());
        assertFalse(secondThread.isAlive());
        assertNotNull(firstResult.get());
        assertNull(firstError.get());
        assertNotNull(secondError.get());
        assertEquals("COMMAND_BUSY", secondError.get().code);
        assertEquals("1", persistence.values.get("highestSequence"));
    }

    @Test
    public void falseCommitAfterMutatingNewStatePoisonsEveryAdapterForTheProcess() {
        MemoryPersistence persistence = new MemoryPersistence();
        persistence.failAfterMutation = true;
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);

        assertCode(
            "PERSISTENCE_UNCERTAIN",
            () -> journal.accept(1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A)
        );
        assertEquals("REFRESH_REQUIRED", persistence.values.get("state"));
        int readsBeforeRetry = persistence.reads;
        MemoryPersistence secondAdapter = persistence.newAdapterForSameStorage();
        assertCode(
            "STATE_UNCERTAIN",
            () -> new DeviceCommandJournal(secondAdapter).pendingAcknowledgement()
        );
        assertEquals(readsBeforeRetry, secondAdapter.reads);
    }

    @Test
    public void falseCommitAfterMutatingExistingTransitionPoisonsWithoutTrustingNewState()
        throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);
        journal.accept(1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A);
        persistence.failAfterMutation = true;

        assertCode(
            "PERSISTENCE_UNCERTAIN",
            () -> journal.completeRefresh(1, FIRST, true)
        );
        assertEquals("SUCCEEDED", persistence.values.get("state"));
        assertEquals("true", persistence.values.get("pendingTerminalAck"));
        int readsBeforeRetry = persistence.reads;
        assertCode("STATE_UNCERTAIN", journal::pendingAcknowledgement);
        assertEquals(readsBeforeRetry, persistence.reads);
    }

    @Test
    public void exceptionAfterMutatingStatePoisonsWithoutTrustingTheMutation() {
        MemoryPersistence persistence = new MemoryPersistence();
        persistence.throwAfterMutation = true;
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);

        assertCode(
            "PERSISTENCE_UNCERTAIN",
            () -> journal.accept(1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A)
        );
        assertEquals("REFRESH_REQUIRED", persistence.values.get("state"));
        int readsBeforeRetry = persistence.reads;
        assertCode("STATE_UNCERTAIN", journal::pendingAcknowledgement);
        assertEquals(readsBeforeRetry, persistence.reads);
    }

    @Test
    public void uncertainHigherGenerationSupersessionNeverReportsAcceptance()
        throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);
        journal.accept(9, 20, FIRST, "RESTART_RENDERER", LIFECYCLE_A);
        persistence.failAfterMutation = true;

        assertCode(
            "PERSISTENCE_UNCERTAIN",
            () -> journal.accept(10, 0, SECOND, "REFRESH_CONTENT", LIFECYCLE_B)
        );
        assertEquals("10", persistence.values.get("credentialGeneration"));
        assertEquals("0", persistence.values.get("highestSequence"));
        int readsBeforeRetry = persistence.reads;
        assertCode("STATE_UNCERTAIN", journal::pendingAcknowledgement);
        assertEquals(readsBeforeRetry, persistence.reads);
    }

    @Test
    public void poisoningOneStorageNamespaceDoesNotDisableAnother() throws Exception {
        MemoryPersistence poisoned = new MemoryPersistence();
        poisoned.failAfterMutation = true;
        assertCode(
            "PERSISTENCE_UNCERTAIN",
            () -> new DeviceCommandJournal(poisoned).accept(
                1, 1, FIRST, "REFRESH_CONTENT", LIFECYCLE_A
            )
        );

        MemoryPersistence independent = new MemoryPersistence();
        DeviceCommandJournal.Result accepted = new DeviceCommandJournal(independent).accept(
            1, 1, SECOND, "REFRESH_CONTENT", LIFECYCLE_B
        );
        assertFalse(accepted.duplicate);
        assertEquals(DeviceCommandJournal.CommandState.REFRESH_REQUIRED, accepted.state);
    }

    private static void assertCode(String code, ThrowingOperation operation) {
        try {
            operation.run();
            fail("Expected " + code);
        } catch (DeviceCommandJournal.JournalException exception) {
            assertEquals(code, exception.code);
        } catch (Exception exception) {
            throw new AssertionError(exception);
        }
    }

    private static void assertStoredCorruption(String key, String value) throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        new DeviceCommandJournal(persistence).accept(
            1,
            1,
            FIRST,
            "REFRESH_CONTENT",
            LIFECYCLE_A
        );
        persistence.values.put(key, value);
        assertCode(
            "STATE_CORRUPT",
            () -> new DeviceCommandJournal(persistence).pendingAcknowledgement()
        );
        assertEquals(value, persistence.values.get(key));
    }

    private static void assertGenerationSupersedes(
        DeviceCommandJournal.CommandState oldState
    ) throws Exception {
        MemoryPersistence persistence = new MemoryPersistence();
        DeviceCommandJournal journal = new DeviceCommandJournal(persistence);
        String oldAction = oldState == DeviceCommandJournal.CommandState.RESTART_REQUIRED
            ? "RESTART_RENDERER"
            : "REFRESH_CONTENT";
        journal.accept(9, 20, FIRST, oldAction, LIFECYCLE_A);
        if (oldState == DeviceCommandJournal.CommandState.SUCCEEDED) {
            journal.completeRefresh(20, FIRST, true);
        } else if (oldState == DeviceCommandJournal.CommandState.FAILED) {
            journal.completeRefresh(20, FIRST, false);
        }

        DeviceCommandJournal.Result rotated =
            journal.accept(10, 0, SECOND, "REFRESH_CONTENT", LIFECYCLE_B);
        assertEquals(10, rotated.credentialGeneration);
        assertEquals(0, rotated.sequence);
        assertEquals(DeviceCommandJournal.CommandState.REFRESH_REQUIRED, rotated.state);
        assertFalse(rotated.pendingTerminalAck);
        assertFalse(rotated.restartRequired);
        assertCode(
            "GENERATION_ROLLBACK",
            () -> journal.accept(9, 21, FIRST, "REFRESH_CONTENT", LIFECYCLE_A)
        );
    }

    private static void acceptInto(
        DeviceCommandJournal journal,
        long generation,
        long sequence,
        String commandId,
        AtomicReference<DeviceCommandJournal.Result> result,
        AtomicReference<DeviceCommandJournal.JournalException> error
    ) {
        try {
            result.set(journal.accept(
                generation,
                sequence,
                commandId,
                "REFRESH_CONTENT",
                LIFECYCLE_A
            ));
        } catch (DeviceCommandJournal.JournalException exception) {
            error.set(exception);
        }
    }

    private interface ThrowingOperation {
        void run() throws Exception;
    }

    private static final class MemoryPersistence
        implements DeviceCommandJournal.Persistence {
        final Map<String, String> values;
        final String storageKey;
        boolean failAfterMutation;
        boolean throwAfterMutation;
        int reads;

        MemoryPersistence() {
            this(
                "memory-journal-" + STORAGE_IDS.incrementAndGet(),
                new LinkedHashMap<>()
            );
        }

        private MemoryPersistence(String storageKey, Map<String, String> values) {
            this.storageKey = storageKey;
            this.values = values;
        }

        MemoryPersistence newAdapterForSameStorage() {
            MemoryPersistence adapter = new MemoryPersistence(storageKey, values);
            adapter.reads = reads;
            return adapter;
        }

        @Override
        public String storageKey() {
            return storageKey;
        }

        @Override
        public Map<String, String> read() {
            reads += 1;
            return new LinkedHashMap<>(values);
        }

        @Override
        public boolean replace(Map<String, String> replacement) {
            values.clear();
            values.putAll(replacement);
            if (throwAfterMutation) {
                throw new IllegalStateException("simulated replace exception after mutation");
            }
            return !failAfterMutation;
        }
    }

    private static final class BlockingPersistence
        implements DeviceCommandJournal.Persistence {
        final Map<String, String> values = new LinkedHashMap<>();
        final CountDownLatch firstReadEntered = new CountDownLatch(1);
        final CountDownLatch secondReadEntered = new CountDownLatch(1);
        final CountDownLatch releaseFirstRead = new CountDownLatch(1);
        final AtomicInteger reads = new AtomicInteger();

        @Override
        public String storageKey() {
            return "blocking-journal-" + System.identityHashCode(this);
        }

        @Override
        public Map<String, String> read() throws DeviceCommandJournal.JournalException {
            int read = reads.incrementAndGet();
            if (read == 1) {
                firstReadEntered.countDown();
                try {
                    if (!releaseFirstRead.await(2, TimeUnit.SECONDS)) {
                        throw new DeviceCommandJournal.JournalException(
                            "TEST_TIMEOUT",
                            "Timed out waiting to release the first read"
                        );
                    }
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new DeviceCommandJournal.JournalException(
                        "TEST_INTERRUPTED",
                        "Interrupted while waiting to release the first read"
                    );
                }
            } else if (read == 2) {
                secondReadEntered.countDown();
            }
            return new LinkedHashMap<>(values);
        }

        @Override
        public boolean replace(Map<String, String> replacement) {
            values.clear();
            values.putAll(replacement);
            return true;
        }
    }
}
