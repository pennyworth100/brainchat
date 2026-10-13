# Non-migrating runtime boundary (3.0.42)

The trusted in-process `main({preinstalledAuthorities})` path accepts a separate
maintenance pool and mandatory asynchronous verifier. It never accepts or uses
a migration pool, runs Drizzle, or falls back to runtime migrations. The verifier
settles before upload-directory creation, Next preparation or listener startup.
Mixing migrating and preinstalled authorities, aliasing runtime/maintenance,
missing verification or missing publication tables is refused.

This is one production-composition prerequisite, **not a production launcher or
activation token**. No environment bypass or start:production command exists.
Ordinary npm start and private candidate behavior remain unchanged. The final
trusted composition must implement exact release/catalog/owner/ACL and verified
TLS identity checks under an actual DDL/all-writer fence, finite capacity policy
and physical upload authority, preserving that fence through activation.
A callback that resolves without those checks is not a production preflight.

The existing owned TLS/SCRAM candidate fixture now also launches the real server
with only restricted runtime and maintenance LOGINs, an invalid migration URL,
and no access to Drizzle history or schema creation. It proves pending/rejected
verification prevents filesystem/listener startup, successful runtime room
creation, unchanged history/CLOSED message budget, no migrator backend, and one
settled shutdown. This fixture's narrow verifier is deliberately not exported as
a deployment command. Physical uploads remain disabled/503; no provider, managed
startup, fresh paired backup or production cutover PASS is implied.
