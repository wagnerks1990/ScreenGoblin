package com.screengoblin.player;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class DeviceIdentityAliasesTest {
    @Test
    public void replacementAliasesAreFreshAndManaged() {
        String first = DeviceIdentityAliases.freshAlias();
        String second = DeviceIdentityAliases.freshAlias();

        assertTrue(DeviceIdentityAliases.isManagedAlias(first));
        assertTrue(DeviceIdentityAliases.isManagedAlias(second));
        assertFalse(first.equals(second));
    }

    @Test
    public void onlyKnownAliasesCanBeLoadedFromPreferences() {
        assertTrue(DeviceIdentityAliases.isManagedAlias("screengoblin-device-identity-v1"));
        assertFalse(DeviceIdentityAliases.isManagedAlias("../../unexpected"));
        assertFalse(DeviceIdentityAliases.isManagedAlias("screengoblin-device-identity-v2-not-a-uuid"));
    }

    @Test
    public void finalizationDeletesOnlySupersededManagedAliases() {
        String active = DeviceIdentityAliases.freshAlias();
        String prior = DeviceIdentityAliases.freshAlias();

        assertFalse(DeviceIdentityAliases.shouldDeleteAfterActivation(active, active));
        assertTrue(DeviceIdentityAliases.shouldDeleteAfterActivation(prior, active));
        assertTrue(DeviceIdentityAliases.shouldDeleteAfterActivation("screengoblin-device-identity-v1", active));
        assertFalse(DeviceIdentityAliases.shouldDeleteAfterActivation("another-app-key", active));
    }
}
