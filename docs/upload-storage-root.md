# Private strict storage root binding

This is the first bounded implementation step toward the strict reservation /
storage bridge. It does not complete that bridge and has no runtime consumer.

The trusted provisioner supplies an absolute canonical root, device/inode and
startup effective UID/GID. The process-local opaque binding snapshots these and
retains the exact strict policy pin, hence immutable namespace/domain/adapter,
generation and limit inputs. It never adopts the identity discovered at a path.
Before read-only open it rejects copied bindings, other pins, different logical
limits and effective identity drift. O_NOFOLLOW/O_DIRECTORY and fstat reject
symlinks, replaced roots, changed ownership and modes other than 0700.

A successful call returns only a read-only directory descriptor. It is NOT a
reservation, physical-capacity grant, parser permission or mkdir/write authority.
An accounting COMMIT cannot be passed as this token. No DB, policy seed, route,
legacy reservation, migration, admission release or file writer was changed.

Stable server-controlled ancestors and absence of hostile same-UID mutations
remain prerequisites. Node path operations are not openat confinement; this
helper does not solve a concurrent path swap or privileged administrator attack.
Deployment must independently establish the expected identity and physical cost
authority. Synthetic policy tests are not physical evidence.

Next: compose strict SQL accounting and a separate reviewed physical authority
with this binding and the exact admission object; unknown COMMIT / expired grants
must never consume parser/source or create filesystem objects. Retain grants until
actual settlement. Do not wire ResumeFileStorage's old singleton reservation
interface into the strict path or activate the still-disabled recovery policy.
