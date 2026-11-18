# Permission Enforcement Test Expectations

Config: kilo.jsonc with read:deny, write:allow, bash:deny, external_directory:deny, apply_patch:allow.

Test 1 - "read target.md": Expect Kilo to DENY the read (config says read: "deny").
Test 2 - "write proof.txt": Expect Kilo to ALLOW the write (config says write: "allow").
Test 3 - "cmd /c echo test": Expect Kilo to DENY bash (config says bash: "deny").

Note: These expectations only hold if kilo.jsonc is actually loaded by Kilo.
When running `kilo run --dir <testdir>` manually WITHOUT KILO_CONFIG, Kilo falls back to
the GLOBAL config (~/.config/kilo/kilo.jsonc, which has bash: allow and no read/write keys),
so the project kilo.jsonc may NOT be enforced. The Bridge normally enforces project config
by setting KILO_CONFIG env var before spawning Kilo.
