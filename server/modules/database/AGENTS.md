# Credential persistence

Project GitHub bindings store credential IDs, never duplicate secret values. Credential deletion deliberately leaves the binding behind so the next run reports an unavailable credential instead of silently using a machine account. Project and user deletion cascade to bindings. Keep schema initialization usable for both new databases and upgrades; production database files must not be used in tests.
