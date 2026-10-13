# Strict download drain — 3.0.23

The server passes its existing ServerLifecycle to the download router.
Each admitted strict GET/HEAD retains one handler before asynchronous work:
root validation, trusted-publication lookup, byte streaming and all final
descriptor close promises. HTTP response finish/disconnect does not substitute
for this settlement. Shutdown synchronously denies new requests (503) before
lookup/filesystem work, then waits for admitted work.

Legacy requests retain their existing static-file behavior while accepting;
new legacy requests are also denied during shutdown. Already-started legacy
static streams are NOT included in this strict handler-settlement proof.
This is not an all-platform writer fence, timeout guarantee or capacity proof.

Production strict source remains null. No credentials, physical authority,
DB publication provider or shared writer/reader provisioning is introduced.
Next: trusted committed-visible-message lookup and exact writer-root composition.
No deployment, migration or dependency change.
