package com.screengoblin.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Best-effort restart hook. Managed Android TV deployments should also set this app as persistent kiosk/home. */
public final class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "ScreenGoblinBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        // An explicit intent can bypass the manifest filter, so make the
        // received action an explicit runtime authorization boundary before
        // performing any side effect. Keep the constant-first comparison
        // directly in onReceive so null actions fail closed and static analysis
        // can follow the received Intent to the verification.
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        Intent player = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(player);
        } catch (RuntimeException exception) {
            // Android 10+ may block background activity starts on unmanaged devices.
            Log.w(TAG, "Android deferred player launch; device-owner policy should relaunch it", exception);
        }
    }
}
