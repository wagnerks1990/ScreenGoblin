import {
  canonicalJson,
  canonicalPairingTranscript,
  type DeviceManifestRequest,
  type HeartbeatRequest,
  type PairingChallengeRequest,
} from "@screengoblin/contracts";
import { createHmac } from "node:crypto";
import { sha256Hex } from "./crypto.js";

export const canonicalPairingDigest = (
  input: PairingChallengeRequest,
  pepper: string,
): string =>
  createHmac("sha256", pepper)
    .update("ScreenGoblin pairing transcript MAC v1\0", "utf8")
    .update(canonicalPairingTranscript(input), "utf8")
    .digest("hex");

export const canonicalHeartbeatDigest = (input: HeartbeatRequest): string =>
  sha256Hex(Buffer.from(canonicalJson(input), "utf8"));

export const canonicalManifestDigest = (input: DeviceManifestRequest): string =>
  sha256Hex(Buffer.from(canonicalJson(input), "utf8"));

export const EMPTY_BODY_SHA256 = sha256Hex(new Uint8Array());
