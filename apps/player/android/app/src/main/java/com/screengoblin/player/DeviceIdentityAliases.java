package com.screengoblin.player;

import java.util.UUID;
import java.util.regex.Pattern;

final class DeviceIdentityAliases {
    private static final String LEGACY_ALIAS = "screengoblin-device-identity-v1";
    private static final String ROTATED_PREFIX = "screengoblin-device-identity-v2-";
    private static final Pattern ROTATED = Pattern.compile(
        "^screengoblin-device-identity-v2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    );

    private DeviceIdentityAliases() {}

    static String freshAlias() {
        return ROTATED_PREFIX + UUID.randomUUID().toString();
    }

    static boolean isManagedAlias(String alias) {
        return LEGACY_ALIAS.equals(alias) || ROTATED.matcher(alias).matches();
    }

    static boolean shouldDeleteAfterActivation(String alias, String activeAlias) {
        return isManagedAlias(alias) && !alias.equals(activeAlias);
    }
}
